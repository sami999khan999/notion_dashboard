/**
 * Dashboard data — server functions reading the D1 mirror.
 *
 * Runs on the Worker only (SSR and client navigation alike), so
 * `cloudflare:workers` bindings are safe. Reading the mirror rather than Notion
 * means the dashboard never waits on the Notion API and never spends its rate
 * limit on page views.
 *
 * SQLite has no timezone support, so local-day grouping is done with
 * `date(start_time, '+N minutes')` derived from ALERT_TZ_OFFSET_MINUTES.
 */
import { createServerFn } from '@tanstack/react-start'
import { getEnv, num } from '../env'
import {
  fmtDuration,
  formatMinutes,
  localDate,
  localMinutes,
  localWeekday,
  parseWindow,
} from '../alerts/time'
import { SERIES, SERIES_NEUTRAL, kindOf } from './activity'
import type { Kind } from './activity'

/** Analytics windows, in days. `0` means today only; `null` means all time. */
export const RANGES = [
  { id: 'today', label: 'Today', days: 0 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '15d', label: '15 days', days: 15 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
] as const

export type RangeId = (typeof RANGES)[number]['id']

export interface RibbonBlock {
  id: string
  activity: string
  kind: Kind
  startMin: number
  endMin: number
  lengthMin: number
  state: 'past' | 'active' | 'upcoming'
}

export interface DayBar {
  date: string
  /** Weekday initial, for the axis. */
  dow: string
  seconds: number
}

export interface HeatCell {
  date: string
  seconds: number
  level: 0 | 1 | 2 | 3 | 4
  col: number
  row: number
}

export interface CategorySlice {
  label: string
  seconds: number
  sessions: number
  /** Fixed palette slot; "Other" always takes the neutral. */
  color: string
  share: number
}

export interface CalendarDay {
  date: string
  day: number
  seconds: number
  /** 0-4 intensity, 0 = nothing tracked. */
  level: 0 | 1 | 2 | 3 | 4
  inMonth: boolean
  isToday: boolean
}

export interface CalendarMonth {
  label: string
  days: CalendarDay[]
  monthSeconds: number
  monthLabel: string
  prevMonthSeconds: number
  deltaPct: number | null
}

export interface Analytics {
  range: RangeId
  rangeLabel: string
  /** Inclusive local dates covered, for the caption. */
  from: string
  to: string
  days: number

  totalSeconds: number
  totalLabel: string
  sessions: number
  activeDays: number
  /** Mean over days that had any activity — not over the whole window. */
  avgActiveDayLabel: string
  busiestDate: string | null
  busiestLabel: string

  /** Same-length immediately preceding window, for the delta. */
  prevTotalSeconds: number
  deltaPct: number | null

  bars: DayBar[]
  /** True when bars are weekly buckets rather than single days. */
  bucketed: boolean
  categories: CategorySlice[]
}

export interface RunningTimer {
  id: string
  name: string
  startedAt: string
  elapsedLabel: string
}

export interface DeadlineItem {
  id: string
  title: string
  deadline: string
  overdue: boolean
}

export interface RecentAlert {
  rule: string
  message: string
  status: string
  sentAt: string
}

export interface DashboardData {
  today: string
  localDate: string
  localTime: string
  nowMin: number

  ribbon: RibbonBlock[]
  current: RibbonBlock | null
  next: RibbonBlock | null
  routineDoneMin: number
  routineTotalMin: number

  analytics: Analytics
  heat: HeatCell[]
  heatWeeks: number
  calendar: CalendarMonth

  /** Share of alerts that actually left the building. */
  deliveryScore: number
  alertsSent: number
  alertsFailed: number

  running: RunningTimer[]
  deadlines: DeadlineItem[]
  alerts: RecentAlert[]

  todaySeconds: number
  todayLabel: string
  openTasks: number
  completedTasks: number
  lastSync: string | null
}

const HEAT_WEEKS = 26
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

/**
 * Top 4 categories keep a fixed palette slot; everything else collapses into a
 * neutral "Other". Never cycle hues for a 5th series — fold it instead.
 */
function buildSlices(
  rows: Array<{ label: string; secs: number; n: number }>,
  total: number,
): CategorySlice[] {
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0)
  const top: CategorySlice[] = rows.slice(0, 4).map((c, i) => ({
    label: c.label,
    seconds: c.secs ?? 0,
    sessions: c.n ?? 0,
    color: SERIES[i],
    share: pct(c.secs ?? 0),
  }))
  const rest = rows.slice(4)
  if (rest.length > 0) {
    const secs = rest.reduce((s, c) => s + (c.secs ?? 0), 0)
    if (secs > 0) {
      top.push({
        label: 'Other',
        seconds: secs,
        sessions: rest.reduce((s, c) => s + (c.n ?? 0), 0),
        color: SERIES_NEUTRAL,
        share: pct(secs),
      })
    }
  }
  return top
}

function shiftDate(date: string, deltaDays: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + deltaDays * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

export const getDashboardData = createServerFn({ method: 'GET' })
  .inputValidator((range?: RangeId): RangeId => {
    return RANGES.some((r) => r.id === range) ? (range as RangeId) : '30d'
  })
  .handler(async ({ data: range }): Promise<DashboardData> => {
    const env = getEnv()
    const offset = num(env.ALERT_TZ_OFFSET_MINUTES, 360)
    const now = new Date()
    const weekday = localWeekday(now, offset)
    const nowMin = localMinutes(now, offset)
    const todayStr = localDate(now, offset)
    const tzMod = `${offset >= 0 ? '+' : '-'}${Math.abs(offset)} minutes`

    const spec = RANGES.find((r) => r.id === range)!
    // `days: 0` (today) is a one-day window, not a zero-day one.
    const windowDays = spec.days === null ? null : Math.max(1, spec.days)

    const [routineRows, timerRows, taskRows, alertRows, cursorRow, dayRows, taskCounts, alertCounts] =
      await Promise.all([
        env.DB.prepare(
          `SELECT notion_id, activity, time, days FROM routine_snapshot WHERE archived = 0`,
        ).all<{ notion_id: string; activity: string; time: string; days: string }>(),
        env.DB.prepare(
          `SELECT notion_id, name, start_time FROM timer_snapshot
            WHERE status = 'Running' AND end_time IS NULL`,
        ).all<{ notion_id: string; name: string; start_time: string | null }>(),
        env.DB.prepare(
          `SELECT notion_id, title, deadline FROM task_snapshot
            WHERE deadline IS NOT NULL AND completed = 0 AND archived = 0
            ORDER BY deadline ASC LIMIT 8`,
        ).all<{ notion_id: string; title: string; deadline: string }>(),
        env.DB.prepare(
          `SELECT rule, message, status, sent_at FROM alert_log ORDER BY id DESC LIMIT 12`,
        ).all<{ rule: string; message: string; status: string; sent_at: string }>(),
        env.DB.prepare(`SELECT value FROM sync_state WHERE key = 'tasks'`).first<{
          value: string
        }>(),
        // Every tracked day, once. Small enough to slice in memory for both the
        // heatmap and any range, which avoids a query per range change.
        env.DB.prepare(
          `SELECT date(start_time, ?) d, SUM(total_seconds) secs, COUNT(*) n
             FROM timer_snapshot
            WHERE start_time IS NOT NULL AND total_seconds > 0
            GROUP BY d ORDER BY d`,
        )
          .bind(tzMod)
          .all<{ d: string; secs: number; n: number }>(),
        env.DB.prepare(
          `SELECT SUM(CASE WHEN completed = 0 AND archived = 0 THEN 1 ELSE 0 END) open,
                  SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) done
             FROM task_snapshot`,
        ).first<{ open: number; done: number }>(),
        env.DB.prepare(
          `SELECT SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) sent,
                  SUM(CASE WHEN status NOT IN ('sent','suppressed') THEN 1 ELSE 0 END) failed
             FROM alert_log`,
        ).first<{ sent: number; failed: number }>(),
      ])

    const days = dayRows.results ?? []
    const byDay = new Map<string, { secs: number; n: number }>()
    for (const r of days) if (r.d) byDay.set(r.d, { secs: r.secs ?? 0, n: r.n ?? 0 })

    // ---- Day ribbon --------------------------------------------------------
    const ribbon: RibbonBlock[] = []
    for (const r of routineRows.results ?? []) {
      let dayList: string[] = []
      try {
        const v = JSON.parse(r.days ?? '[]')
        if (Array.isArray(v)) dayList = v
      } catch {
        /* malformed row — treat as scheduled on no day */
      }
      if (!dayList.includes(weekday)) continue

      const win = parseWindow(r.time)
      if (!win) continue
      const [startMin, endMin] = win
      const wraps = endMin <= startMin
      const lengthMin = wraps ? 1440 - startMin + endMin : endMin - startMin
      const active = wraps
        ? nowMin >= startMin || nowMin < endMin
        : nowMin >= startMin && nowMin < endMin

      ribbon.push({
        id: r.notion_id,
        activity: r.activity,
        kind: kindOf(r.activity),
        startMin,
        endMin,
        lengthMin,
        state: active ? 'active' : nowMin >= endMin && !wraps ? 'past' : 'upcoming',
      })
    }
    ribbon.sort((a, b) => a.startMin - b.startMin)

    // ---- Analytics for the selected window ---------------------------------
    const from = windowDays === null ? (days[0]?.d ?? todayStr) : shiftDate(todayStr, -(windowDays - 1))
    const spanDays =
      windowDays ??
      Math.max(
        1,
        Math.round((Date.parse(todayStr) - Date.parse(from)) / 86_400_000) + 1,
      )

    const inRange = days.filter((r) => r.d >= from && r.d <= todayStr)
    const totalSeconds = inRange.reduce((s, r) => s + (r.secs ?? 0), 0)
    const sessions = inRange.reduce((s, r) => s + (r.n ?? 0), 0)
    const activeDays = inRange.filter((r) => (r.secs ?? 0) > 0).length
    const busiest = inRange.reduce<{ d: string; secs: number } | null>(
      (best, r) => (!best || (r.secs ?? 0) > best.secs ? { d: r.d, secs: r.secs ?? 0 } : best),
      null,
    )

    // Immediately preceding window of the same length, for a like-for-like delta.
    const prevTo = shiftDate(from, -1)
    const prevFrom = shiftDate(prevTo, -(spanDays - 1))
    const prevTotalSeconds = days
      .filter((r) => r.d >= prevFrom && r.d <= prevTo)
      .reduce((s, r) => s + (r.secs ?? 0), 0)

    // Beyond ~45 days a bar per day is unreadable, so bucket by week.
    const bucketed = spanDays > 45
    const bars: DayBar[] = []
    if (bucketed) {
      const weeks = Math.ceil(spanDays / 7)
      for (let w = 0; w < weeks; w++) {
        const start = shiftDate(from, w * 7)
        if (start > todayStr) break
        let secs = 0
        for (let i = 0; i < 7; i++) {
          const dt = shiftDate(start, i)
          if (dt > todayStr) break
          secs += byDay.get(dt)?.secs ?? 0
        }
        bars.push({ date: start, dow: '', seconds: secs })
      }
    } else {
      for (let i = 0; i < spanDays; i++) {
        const dt = shiftDate(from, i)
        if (dt > todayStr) break
        bars.push({
          date: dt,
          dow: DOW[new Date(`${dt}T00:00:00.000Z`).getUTCDay()],
          seconds: byDay.get(dt)?.secs ?? 0,
        })
      }
    }

    // Categories, scoped to the same window.
    const catRows = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(category, ''), 'Uncategorised') label,
              SUM(total_seconds) secs, COUNT(*) n
         FROM timer_snapshot
        WHERE total_seconds > 0 AND date(start_time, ?) BETWEEN ? AND ?
        GROUP BY label ORDER BY secs DESC LIMIT 8`,
    )
      .bind(tzMod, from, todayStr)
      .all<{ label: string; secs: number; n: number }>()

    const analytics: Analytics = {
      range,
      rangeLabel: spec.label,
      from,
      to: todayStr,
      days: spanDays,
      totalSeconds,
      totalLabel: totalSeconds > 0 ? fmtDuration(totalSeconds) : '0m',
      sessions,
      activeDays,
      avgActiveDayLabel:
        activeDays > 0 ? fmtDuration(Math.round(totalSeconds / activeDays)) : '0m',
      busiestDate: busiest && busiest.secs > 0 ? busiest.d : null,
      busiestLabel: busiest && busiest.secs > 0 ? fmtDuration(busiest.secs) : '—',
      prevTotalSeconds,
      deltaPct:
        prevTotalSeconds > 0
          ? Math.round(((totalSeconds - prevTotalSeconds) / prevTotalSeconds) * 100)
          : null,
      bars,
      bucketed,
      categories: buildSlices(catRows.results ?? [], totalSeconds),
    }

    // ---- Heatmap (always the long view, independent of the range) ----------
    const heat: HeatCell[] = []
    let heatMax = 0
    for (const v of byDay.values()) if (v.secs > heatMax) heatMax = v.secs

    const gridEnd = new Date(`${todayStr}T00:00:00.000Z`)
    const gridStart = new Date(gridEnd.getTime() - (HEAT_WEEKS * 7 - 1) * 86_400_000)
    gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay())

    for (let i = 0; ; i++) {
      const day = new Date(gridStart.getTime() + i * 86_400_000)
      if (day > gridEnd) break
      const date = day.toISOString().slice(0, 10)
      const seconds = byDay.get(date)?.secs ?? 0
      const ratio = heatMax > 0 ? seconds / heatMax : 0
      heat.push({
        date,
        seconds,
        // Level 0 is "nothing", not a light step.
        level: seconds === 0 ? 0 : ratio > 0.66 ? 4 : ratio > 0.33 ? 3 : ratio > 0.12 ? 2 : 1,
        col: Math.floor(i / 7),
        row: day.getUTCDay(),
      })
    }

    // ---- Calendar: the current local month --------------------------------
    const [yy, mm] = todayStr.split('-').map(Number)
    const firstOfMonth = `${todayStr.slice(0, 7)}-01`
    const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
    // Monday-first, matching the reference's M T W T F S S header.
    const firstDow = (new Date(`${firstOfMonth}T00:00:00.000Z`).getUTCDay() + 6) % 7

    const calDays: CalendarDay[] = []
    let monthSeconds = 0
    let monthMax = 0
    for (let d = 1; d <= daysInMonth; d++) {
      const secs = byDay.get(`${todayStr.slice(0, 7)}-${String(d).padStart(2, '0')}`)?.secs ?? 0
      monthSeconds += secs
      if (secs > monthMax) monthMax = secs
    }
    // Leading blanks so the 1st lands under the right weekday.
    for (let i = 0; i < firstDow; i++) {
      calDays.push({ date: '', day: 0, seconds: 0, level: 0, inMonth: false, isToday: false })
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${todayStr.slice(0, 7)}-${String(d).padStart(2, '0')}`
      const seconds = byDay.get(date)?.secs ?? 0
      const ratio = monthMax > 0 ? seconds / monthMax : 0
      calDays.push({
        date,
        day: d,
        seconds,
        level: seconds === 0 ? 0 : ratio > 0.66 ? 4 : ratio > 0.33 ? 3 : ratio > 0.12 ? 2 : 1,
        inMonth: true,
        isToday: date === todayStr,
      })
    }
    // Trailing blanks to complete the final week row.
    while (calDays.length % 7 !== 0) {
      calDays.push({ date: '', day: 0, seconds: 0, level: 0, inMonth: false, isToday: false })
    }

    const prevMonthPrefix = new Date(Date.UTC(yy, mm - 2, 1)).toISOString().slice(0, 7)
    let prevMonthSeconds = 0
    for (const [date, v] of byDay) {
      if (date.startsWith(prevMonthPrefix)) prevMonthSeconds += v.secs
    }

    const calendar: CalendarMonth = {
      label: `${MONTHS[mm - 1]}, ${yy}`,
      days: calDays,
      monthSeconds,
      monthLabel: monthSeconds > 0 ? fmtDuration(monthSeconds) : '0m',
      prevMonthSeconds,
      deltaPct:
        prevMonthSeconds > 0
          ? Math.round(((monthSeconds - prevMonthSeconds) / prevMonthSeconds) * 100)
          : null,
    }

    const sentCount = alertCounts?.sent ?? 0
    const failedCount = alertCounts?.failed ?? 0

    // Elapsed vs total routine minutes, for the progress line.
    const routineTotalMin = ribbon.reduce((s, b) => s + b.lengthMin, 0)
    const routineDoneMin = ribbon
      .filter((b) => b.state === 'past')
      .reduce((s, b) => s + b.lengthMin, 0)

    // Live elapsed computed here: Notion's Total Time In Seconds reads 0 until
    // a timer stops.
    const running: RunningTimer[] = (timerRows.results ?? [])
      .filter((t) => t.start_time)
      .map((t) => ({
        id: t.notion_id,
        name: t.name || 'Untitled timer',
        startedAt: t.start_time!,
        elapsedLabel: fmtDuration(
          Math.max(0, Math.round((now.getTime() - Date.parse(t.start_time!)) / 1000)),
        ),
      }))

    const todaySeconds = byDay.get(todayStr)?.secs ?? 0

    return {
      today: weekday,
      localDate: todayStr,
      localTime: formatMinutes(nowMin),
      nowMin,
      ribbon,
      current: ribbon.find((b) => b.state === 'active') ?? null,
      next: ribbon.find((b) => b.startMin > nowMin) ?? null,
      routineDoneMin,
      routineTotalMin,
      analytics,
      heat,
      heatWeeks: heat.length > 0 ? heat[heat.length - 1].col + 1 : 0,
      calendar,
      deliveryScore:
        sentCount + failedCount > 0
          ? Math.round((sentCount / (sentCount + failedCount)) * 100)
          : 100,
      alertsSent: sentCount,
      alertsFailed: failedCount,
      running,
      deadlines: (taskRows.results ?? []).map((t) => ({
        id: t.notion_id,
        title: t.title || 'Untitled task',
        deadline: t.deadline,
        overdue: t.deadline.slice(0, 10) < todayStr,
      })),
      alerts: (alertRows.results ?? []).map((a) => ({
        rule: a.rule,
        message: a.message,
        status: a.status,
        sentAt: a.sent_at,
      })),
      todaySeconds,
      todayLabel: todaySeconds > 0 ? fmtDuration(todaySeconds) : '0m',
      openTasks: taskCounts?.open ?? 0,
      completedTasks: taskCounts?.done ?? 0,
      lastSync: cursorRow?.value ?? null,
    }
  })
