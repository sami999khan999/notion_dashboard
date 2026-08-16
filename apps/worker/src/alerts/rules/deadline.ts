/**
 * E4 / E5 / E6 / E7 — Task deadlines.
 *
 * Deadline precision is MIXED in this workspace and the two shapes mean
 * different things:
 *
 *   "2026-03-31T00:00:00.000+06:00"  (len > 10)  an exact moment
 *   "2026-02-22"                     (len == 10) the whole day
 *
 * A date-only deadline resolves to 23:59 local. "One hour before" is
 * meaningless for it, so E5 skips those rows entirely, and E4 anchors to 09:00
 * the previous local day rather than a useless 23:59 midnight ping.
 */
import { card } from '../email'
import { fromLocal, localDate, localStamp } from '../time'
import { notionUrl } from '../types'
import type { Alert, RuleContext, TaskSnapshot } from '../types'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

function isDateOnly(raw: string): boolean {
  return raw.length === 10
}

/** Resolve a raw Notion deadline to a UTC instant. */
function deadlineInstant(raw: string, offset: number): number {
  return isDateOnly(raw)
    ? fromLocal(raw, 23 * 60 + 59, offset).getTime()
    : Date.parse(raw)
}

export function ruleDeadlines(
  ctx: RuleContext,
  rows: TaskSnapshot[],
): Alert[] {
  const cfg = ctx.cfg
  const now = ctx.now.getTime()
  const staleMs = cfg.deadlineStaleHours * HOUR_MS
  const graceMs = cfg.missedGraceMin * 60_000
  const out: Alert[] = []

  for (const r of rows) {
    if (!r.deadline || r.completed || r.archived) continue

    const dueAt = deadlineInstant(r.deadline, ctx.offset)
    if (!Number.isFinite(dueAt)) continue

    const dateOnly = isDateOnly(r.deadline)
    const title = r.title || 'Untitled task'
    const dueLabel = dateOnly
      ? `${r.deadline} (end of day)`
      : localStamp(new Date(dueAt), ctx.offset)

    const push = (
      rule: string,
      threshold: string,
      subject: string,
      heading: string,
      extra: Array<[string, string]> = [],
    ) =>
      out.push({
        rule,
        entityId: r.notion_id,
        threshold,
        subject,
        html: card(
          heading,
          [['Task', title], ['Deadline', dueLabel], ...extra],
          notionUrl(r.notion_id),
        ),
        notionUrl: notionUrl(r.notion_id),
      })

    // --- E4: 24 hours out --------------------------------------------------
    if (cfg.deadline24h) {
      const fireAt = dateOnly
        ? fromLocal(
            localDate(new Date(dueAt - DAY_MS), ctx.offset),
            9 * 60,
            ctx.offset,
          ).getTime()
        : dueAt - DAY_MS
      // Only while still upcoming, and not for deadlines already long past —
      // otherwise importing an old task fires E4/E5/E6 all at once.
      if (now >= fireAt && now < dueAt && now - fireAt < staleMs) {
        push('E4', '24h', `⏰ Due in 24h: ${title}`, 'Deadline approaching')
      }
    }

    // --- E5: 1 hour out — undefined for a date-only deadline ---------------
    if (cfg.deadline1h && !dateOnly) {
      const fireAt = dueAt - HOUR_MS
      if (now >= fireAt && now < dueAt && now - fireAt < staleMs) {
        push('E5', '1h', `⏰ Due in 1 hour: ${title}`, 'Deadline in one hour')
      }
    }

    // --- E6: the deadline itself -------------------------------------------
    if (cfg.deadlineHit) {
      if (now >= dueAt && now - dueAt < staleMs) {
        push('E6', 'hit', `🔔 Deadline reached: ${title}`, 'Deadline reached')
      }
    }

    // --- E7: missed ---------------------------------------------------------
    // Deliberately has NO staleness guard: an overdue task should keep nagging.
    if (cfg.deadlineMissed && now >= dueAt + graceMs) {
      const threshold = cfg.deadlineMissedRenag
        ? `missed:${localDate(ctx.now, ctx.offset)}` // one nag per day
        : 'missed' // one nag ever
      const daysLate = Math.floor((now - dueAt) / DAY_MS)
      push(
        'E7',
        threshold,
        `❗ Overdue${daysLate > 0 ? ` by ${daysLate}d` : ''}: ${title}`,
        'Deadline missed',
        [['Overdue by', daysLate > 0 ? `${daysLate} day(s)` : 'less than a day']],
      )
    }
  }

  return out
}
