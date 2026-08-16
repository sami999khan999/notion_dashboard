/**
 * E8 / E9 — Daily Routine.
 *
 * E8 deliberately does NOT read Notion's `Active Now` formula. Two reasons:
 *
 *  1. It returns a STRING ("🟢 Active" / "🟡 Starting Soon" / "🔴 Inactive"),
 *     so a truthiness check on it is always true.
 *  2. Notion formulas are evaluated at read time and never bump
 *     `last_edited_time`. The flip to Active produces no edit event, so an
 *     edge trigger built on it would silently never fire.
 *
 * Instead we parse `Time` + `Days` and evaluate them against local wall-clock
 * ourselves — deterministic, minute-exact, and testable with a frozen `now`.
 */
import { card, esc } from '../email'
import {
  MINUTES_PER_DAY,
  formatMinutes,
  localDate,
  localMinutes,
  localWeekday,
  parseWindow,
} from '../time'
import { notionUrl } from '../types'
import type { Alert, RoutineSnapshot, RuleContext } from '../types'

/**
 * E8 — a routine block just started.
 *
 * Fires when local wall-clock sits within ALERT_MAX_LATENESS_MIN *after* a
 * block's start. Using a lateness window rather than an exact minute match
 * means a delayed or skipped cron tick still delivers, while a Worker deployed
 * mid-afternoon does not retroactively announce the whole morning.
 */
export function ruleRoutineStart(
  ctx: RuleContext,
  rows: RoutineSnapshot[],
): Alert[] {
  if (!ctx.cfg.routineStart) return []

  const maxLate = ctx.cfg.maxLatenessMin
  const nowMin = localMinutes(ctx.now, ctx.offset)
  const out: Alert[] = []

  for (const r of rows) {
    if (r.archived) continue

    const win = parseWindow(r.time)
    if (!win) continue // malformed Time — skip the row, never throw
    const [startMin, endMin] = win

    // Minutes since this block's start, wrapping across midnight.
    let since = nowMin - startMin
    if (since < 0) since += MINUTES_PER_DAY
    if (since > maxLate) continue

    // Use the block's OWN start instant, not `now`. For a 23:55 block observed
    // at 00:02 the start belongs to YESTERDAY — both the weekday check and the
    // dedupe key must reflect that, or it double-fires across midnight.
    const startInstant = new Date(ctx.now.getTime() - since * 60_000)
    const startDate = localDate(startInstant, ctx.offset)
    const weekday = localWeekday(startInstant, ctx.offset)
    if (!r.days.includes(weekday)) continue

    const window = `${formatMinutes(startMin)} – ${formatMinutes(endMin)}`
    out.push({
      rule: 'E8',
      entityId: r.notion_id,
      // Date in the key => re-arms daily. Without it the block fires once ever.
      threshold: `${startDate}T${formatMinutes(startMin)}`,
      subject: `🟢 ${r.activity || 'Routine'} — ${window}`,
      html: card(
        'Routine block started',
        [
          ['Activity', r.activity || '—'],
          ['Window', window],
          ['Day', weekday],
        ],
        notionUrl(r.notion_id),
      ),
      notionUrl: notionUrl(r.notion_id),
    })
  }

  return out
}

/** E9 — one digest of the whole day's schedule. Off by default. */
export function ruleRoutineDigest(
  ctx: RuleContext,
  rows: RoutineSnapshot[],
): Alert[] {
  if (!ctx.cfg.routineDigest) return []

  const at = parseWindowStart(ctx.cfg.digestAt)
  if (at === null) return []

  const nowMin = localMinutes(ctx.now, ctx.offset)
  const maxLate = ctx.cfg.maxLatenessMin
  if (nowMin < at || nowMin - at > maxLate) return []

  const today = localWeekday(ctx.now, ctx.offset)
  const blocks = rows
    .filter((r) => !r.archived && r.days.includes(today) && parseWindow(r.time))
    .sort((a, b) => parseWindow(a.time)![0] - parseWindow(b.time)![0])

  // Fri/Sat under the current data — every row is archived. Stay silent.
  if (blocks.length === 0) return []

  const list = blocks
    .map((b) => {
      const [s, e] = parseWindow(b.time)!
      return (
        `<tr><td style="padding:4px 14px 4px 0;color:#8b93a7;white-space:nowrap">` +
        `${formatMinutes(s)} – ${formatMinutes(e)}</td>` +
        `<td style="padding:4px 0;color:#e6e8ee">${esc(b.activity)}</td></tr>`
      )
    })
    .join('')

  return [
    {
      rule: 'E9',
      entityId: 'routine-digest',
      threshold: localDate(ctx.now, ctx.offset),
      subject: `📅 ${today} — ${blocks.length} routine blocks`,
      html:
        `<h2 style="font:600 16px system-ui,sans-serif;margin:0 0 14px;color:#e6e8ee">` +
        `Today's routine — ${esc(today)}</h2>` +
        `<table style="font:14px system-ui,sans-serif;border-collapse:collapse">${list}</table>`,
    },
  ]
}

function parseWindowStart(hhmm: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(hhmm)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}
