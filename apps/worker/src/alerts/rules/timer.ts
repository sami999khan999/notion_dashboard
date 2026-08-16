/**
 * E1 / E2 / E3 — Time Tracker timer lifecycle.
 *
 * Pure functions. `ctx.now` is injected; nothing here reads the clock or the
 * network.
 */
import { card } from '../email'
import { fmtDuration, localStamp } from '../time'
import { notionUrl } from '../types'
import type { Alert, RuleContext, TimerPrev, TimerSnapshot } from '../types'

/** A timer is live when Notion says Running AND no End Time has been set. */
function isRunning(r: TimerSnapshot): boolean {
  return r.status === 'Running' && !r.end_time
}

function wasRunning(p: TimerPrev | undefined): boolean {
  return !!p && p.status === 'Running' && !p.end_time
}

function label(r: TimerSnapshot): string {
  return r.name || 'Untitled timer'
}

/**
 * E1 — a timer we have not seen running before is now running.
 *
 * Fires on the transition into running, including "first sight" (no previous
 * row at all), so a mid-session deploy still announces an in-flight timer.
 */
export function ruleTimerStarted(
  ctx: RuleContext,
  rows: TimerSnapshot[],
  prev: Map<string, TimerPrev>,
): Alert[] {
  if (!ctx.cfg.timerStart) return []

  const out: Alert[] = []
  for (const r of rows) {
    if (!isRunning(r) || !r.start_time) continue
    if (wasRunning(prev.get(r.notion_id))) continue // already announced

    out.push({
      rule: 'E1',
      entityId: r.notion_id,
      threshold: 'start',
      subject: `▶ Started: ${label(r)}`,
      html: card(
        'Timer started',
        [
          ['Activity', label(r)],
          ['Started', localStamp(new Date(r.start_time), ctx.offset)],
        ],
        notionUrl(r.notion_id),
      ),
      notionUrl: notionUrl(r.notion_id),
    })
  }
  return out
}

/**
 * E2 — every N minutes while a timer runs.
 *
 * Emits only the CURRENT highest bucket. If ticks were missed (Worker down,
 * cron skew), intermediate buckets are skipped rather than burst-sent.
 *
 * Elapsed is computed locally because Notion's `Total Time In Seconds` formula
 * returns 0 until End Time exists.
 */
export function ruleTimerTick(
  ctx: RuleContext,
  rows: TimerSnapshot[],
): Alert[] {
  if (!ctx.cfg.timerTick) return []

  const step = ctx.cfg.timerTickMinutes
  if (step <= 0) return []

  const out: Alert[] = []
  for (const r of rows) {
    if (!isRunning(r) || !r.start_time) continue

    const startedAt = Date.parse(r.start_time)
    if (!Number.isFinite(startedAt)) continue

    const elapsedMin = Math.floor((ctx.now.getTime() - startedAt) / 60_000)
    if (elapsedMin < step) continue

    const bucket = Math.floor(elapsedMin / step)
    if (bucket <= r.notified_bucket) continue // already emailed this bucket

    const mins = bucket * step
    out.push({
      rule: 'E2',
      entityId: r.notion_id,
      threshold: `${mins}m`,
      subject: `⏳ ${fmtDuration(mins * 60)} on: ${label(r)}`,
      html: card(
        'Timer still running',
        [
          ['Activity', label(r)],
          ['Elapsed', fmtDuration(elapsedMin * 60)],
          ['Started', localStamp(new Date(startedAt), ctx.offset)],
        ],
        notionUrl(r.notion_id),
      ),
      notionUrl: notionUrl(r.notion_id),
    })
  }
  return out
}

/** E3 — a timer that was running has stopped. */
export function ruleTimerEnded(
  ctx: RuleContext,
  rows: TimerSnapshot[],
  prev: Map<string, TimerPrev>,
): Alert[] {
  if (!ctx.cfg.timerEnd) return []

  const out: Alert[] = []
  for (const r of rows) {
    if (!wasRunning(prev.get(r.notion_id))) continue
    if (isRunning(r)) continue // still going

    // Compute the duration ourselves — see the note on E2.
    const seconds =
      r.start_time && r.end_time
        ? Math.max(
            0,
            Math.round((Date.parse(r.end_time) - Date.parse(r.start_time)) / 1000),
          )
        : r.total_seconds

    out.push({
      rule: 'E3',
      entityId: r.notion_id,
      threshold: 'end',
      subject: `⏹ Finished: ${label(r)} — ${fmtDuration(seconds)}`,
      html: card(
        'Timer ended',
        [
          ['Activity', label(r)],
          ['Duration', fmtDuration(seconds)],
          [
            'Started',
            r.start_time ? localStamp(new Date(r.start_time), ctx.offset) : '—',
          ],
          ['Ended', r.end_time ? localStamp(new Date(r.end_time), ctx.offset) : '—'],
        ],
        notionUrl(r.notion_id),
      ),
      notionUrl: notionUrl(r.notion_id),
    })
  }
  return out
}
