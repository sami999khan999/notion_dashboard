/**
 * Alert dispatcher — dedupe, quiet hours, send, audit.
 *
 * Rules produce candidates; everything messy lives here so the rules stay pure.
 */
import type { AppEnv } from '../config'
import { loadConfig } from '../settings/store'
import { missingEmailConfig, provider, sendEmails } from './email'
import { isFcmConfigured, pushToDevices } from './fcm'
import { activeTargets, deactivateToken } from '../devices/store'
import { ruleDeadlines } from './rules/deadline'
import { ruleRoutineDigest, ruleRoutineStart } from './rules/routine'
import { ruleTimerEnded, ruleTimerStarted, ruleTimerTick } from './rules/timer'
import { localMinutes, parseHHMM } from './time'
import type {
  Alert,
  RoutineSnapshot,
  RuleContext,
  TaskSnapshot,
  TimerPrev,
  TimerSnapshot,
} from './types'

interface Snapshot {
  timers: TimerSnapshot[]
  prev: Map<string, TimerPrev>
  tasks: TaskSnapshot[]
  routines: RoutineSnapshot[]
}

async function loadSnapshot(env: AppEnv): Promise<Snapshot> {
  const [timerRows, prevRows, taskRows, routineRows] = await Promise.all([
    env.DB.prepare(
      `SELECT notion_id, name, task_id, status, start_time, end_time,
              total_seconds, notified_bucket
         FROM timer_snapshot`,
    ).all<TimerSnapshot>(),
    env.DB.prepare(`SELECT notion_id, status, end_time FROM timer_prev`).all<{
      notion_id: string
      status: string | null
      end_time: string | null
    }>(),
    env.DB.prepare(
      `SELECT notion_id, title, deadline, completed, archived
         FROM task_snapshot
        WHERE deadline IS NOT NULL AND completed = 0 AND archived = 0`,
    ).all<TaskSnapshot>(),
    env.DB.prepare(
      `SELECT notion_id, activity, time, days, archived, done
         FROM routine_snapshot WHERE archived = 0`,
    ).all<Omit<RoutineSnapshot, 'days'> & { days: string }>(),
  ])

  const prev = new Map<string, TimerPrev>()
  for (const p of prevRows.results ?? []) {
    prev.set(p.notion_id, { status: p.status, end_time: p.end_time })
  }

  return {
    timers: timerRows.results ?? [],
    prev,
    tasks: taskRows.results ?? [],
    routines: (routineRows.results ?? []).map((r) => ({
      ...r,
      days: safeParseDays(r.days),
    })),
  }
}

function safeParseDays(raw: string): string[] {
  try {
    const v = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** True when `now` falls inside the quiet-hours window. Empty => always false. */
function inQuietHours(ctx: RuleContext): boolean {
  const raw = ctx.cfg.quietHours
  if (!raw.includes('-')) return false
  const [a, b] = raw.split('-')
  const from = parseHHMM(a)
  const to = parseHHMM(b)
  if (from === null || to === null) return false
  const n = localMinutes(ctx.now, ctx.offset)
  // Handles a window that wraps past midnight.
  return from <= to ? n >= from && n < to : n >= from || n < to
}

export async function runAlertRules(
  env: AppEnv,
  now: Date = new Date(),
): Promise<{ candidates: number; sent: number; suppressed: number; failed: number }> {
  // Env defaults with any dashboard overrides applied. Read once per tick so
  // a settings change takes effect on the next run without a redeploy.
  const cfg = await loadConfig(env)
  const ctx: RuleContext = { cfg, now, offset: cfg.tzOffsetMinutes }

  const { timers, prev, tasks, routines } = await loadSnapshot(env)

  const candidates: Alert[] = [
    ...ruleTimerStarted(ctx, timers, prev),
    ...ruleTimerTick(ctx, timers),
    ...ruleTimerEnded(ctx, timers, prev),
    ...ruleDeadlines(ctx, tasks),
    ...ruleRoutineStart(ctx, routines),
    ...ruleRoutineDigest(ctx, routines),
  ]

  const quiet = inQuietHours(ctx)
  const stats = { candidates: candidates.length, sent: 0, suppressed: 0, failed: 0 }

  // If the email channel is not configured yet, BAIL OUT WITHOUT consuming any
  // dedupe keys. Treating "no API key" as a send failure would burn the
  // (rule, entity, threshold) key for every routine block on the very first
  // tick after deploy — and because those keys are date-stamped and never
  // retried, the alerts would be lost permanently rather than delayed.
  const missing = missingEmailConfig(env)
  if (missing.length > 0) {
    if (candidates.length > 0) {
      console.warn(
        JSON.stringify({
          event: 'alerts.channel_unconfigured',
          provider: provider(env),
          dropped: candidates.length,
          missing,
          note: 'no dedupe keys consumed; alerts will fire once secrets are set',
        }),
      )
    }
    return stats
  }

  // Pass 1: resolve dedupe and quiet hours, collecting what actually needs
  // sending. Doing this before any network call lets the whole tick go out over
  // one SMTP session instead of one connection per alert.
  const toSend: Alert[] = []
  for (const a of candidates) {
    // Dedupe. This is what makes a rule that stays true for 60 consecutive
    // ticks send exactly one email.
    const seen = await env.DB.prepare(
      `SELECT 1 FROM alerts_sent WHERE rule = ? AND entity_id = ? AND threshold = ?`,
    )
      .bind(a.rule, a.entityId, a.threshold)
      .first()
    if (seen) continue

    if (quiet) {
      // Consume the dedupe key and record WHY nothing arrived. A silent drop
      // is undebuggable three days later.
      await recordSent(env, a, 'suppressed', now)
      stats.suppressed++
      continue
    }
    toSend.push(a)
  }

  if (toSend.length === 0) return stats

  // Pass 2: one batch, one connection. Push runs concurrently with email —
  // the two channels are independent, so one being slow must not delay the
  // other.
  const sendStarted = Date.now()
  const [results] = await Promise.all([
    sendEmails(env, toSend.map((a) => ({ subject: a.subject, html: a.html }))),
    pushAll(env, toSend),
  ])
  const sendMs = Date.now() - sendStarted

  // Pass 3: record outcomes. Written even on failure, so a transient provider
  // outage costs that one notification rather than looping forever.
  for (let i = 0; i < toSend.length; i++) {
    const a = toSend[i]
    const r = results[i]
    const ok = r?.ok === true
    const status = ok ? 'sent' : `error: ${r?.error ?? 'unknown'}`.slice(0, 200)
    if (ok) stats.sent++
    else stats.failed++

    await recordSent(env, a, status, now)

    // E2 only: persist the bucket so a redeploy cannot replay it.
    if (a.rule === 'E2' && ok) {
      const step = cfg.timerTickMinutes
      const mins = Number(a.threshold.replace('m', ''))
      if (Number.isFinite(mins) && step > 0) {
        await env.DB.prepare(
          `UPDATE timer_snapshot SET notified_bucket = ? WHERE notion_id = ?`,
        )
          .bind(Math.floor(mins / step), a.entityId)
          .run()
      }
    }
  }

  console.log(
    JSON.stringify({
      event: 'alerts.batch',
      provider: provider(env),
      count: toSend.length,
      sendMs,
      msPerEmail: Math.round(sendMs / toSend.length),
      sent: stats.sent,
      failed: stats.failed,
    }),
  )

  return stats
}

/**
 * Push every alert in this tick to the registered phones.
 *
 * Deliberately does NOT affect the email dedupe outcome: push is a secondary
 * channel, and a dead phone must not cause an alert to be marked failed or
 * retried. Failures are logged and dead tokens deactivated, nothing else.
 */
async function pushAll(env: AppEnv, alerts: Alert[]): Promise<void> {
  if (!isFcmConfigured(env) || alerts.length === 0) return

  let targets: Array<{ token: string; vibrate: boolean }>
  try {
    targets = await activeTargets(env)
  } catch {
    return
  }
  if (targets.length === 0) return

  let pushed = 0
  let failed = 0
  // Keep one representative failure. A bare count tells you something broke but
  // not whether it was the OAuth exchange, the project id, or a dead handset —
  // the same silent-failure trap the SMTP path had.
  let sampleError: string | undefined
  for (const a of alerts) {
    const results = await pushToDevices(env, targets, {
      // The subject already leads with a glyph and reads well on a lock
      // screen; the body carries the detail for the expanded view.
      title: a.subject,
      body: plainBody(a.html),
      data: { rule: a.rule, url: a.notionUrl ?? '' },
    })
    for (const r of results) {
      if (r.ok) pushed++
      else {
        failed++
        sampleError ??= r.error
        if (r.unregistered) await deactivateToken(env, r.token)
      }
    }
  }

  console.log(
    JSON.stringify({
      event: 'push.batch',
      devices: targets.length,
      pushed,
      failed,
      ...(sampleError ? { sampleError } : {}),
    }),
  )
}

/** Strip the HTML card down to a line of text for the notification body. */
function plainBody(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rarr;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

async function recordSent(
  env: AppEnv,
  a: Alert,
  status: string,
  now: Date,
): Promise<void> {
  const ts = now.toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO alerts_sent (rule, entity_id, threshold, sent_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(a.rule, a.entityId, a.threshold, ts),
    env.DB.prepare(
      `INSERT INTO alert_log (rule, entity_id, channel, message, status, sent_at)
       VALUES (?, ?, 'email', ?, ?, ?)`,
    ).bind(a.rule, a.entityId, a.subject, status, ts),
  ])
}
