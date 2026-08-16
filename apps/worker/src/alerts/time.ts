/**
 * Local wall-clock helpers.
 *
 * Every Notion datetime in this workspace carries offset +06:00 (Asia/Dhaka),
 * which observes NO DST — so a fixed offset is exact year-round and we can skip
 * `Intl` entirely. The trick used throughout: shift the instant by the offset,
 * then read UTC accessors, which now report local wall-clock fields.
 *
 * If this is ever pointed at a DST zone, replace `shifted()` with an
 * Intl-based implementation and every caller keeps working unchanged.
 */

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

const MS_PER_MIN = 60_000
export const MINUTES_PER_DAY = 1440

function shifted(d: Date, offsetMinutes: number): Date {
  return new Date(d.getTime() + offsetMinutes * MS_PER_MIN)
}

/** Local weekday name — matches the routine `Days` multi-select values. */
export function localWeekday(d: Date, offsetMinutes: number): string {
  return DAY_NAMES[shifted(d, offsetMinutes).getUTCDay()]
}

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d: Date, offsetMinutes: number): string {
  return shifted(d, offsetMinutes).toISOString().slice(0, 10)
}

/** Minutes since local midnight, 0..1439. */
export function localMinutes(d: Date, offsetMinutes: number): number {
  const s = shifted(d, offsetMinutes)
  return s.getUTCHours() * 60 + s.getUTCMinutes()
}

/** Local "HH:MM" of an instant. */
export function localHHMM(d: Date, offsetMinutes: number): string {
  return formatMinutes(localMinutes(d, offsetMinutes))
}

/** Local "YYYY-MM-DD HH:MM" — for email bodies. */
export function localStamp(d: Date, offsetMinutes: number): string {
  return `${localDate(d, offsetMinutes)} ${localHHMM(d, offsetMinutes)}`
}

/** Build the UTC instant for a local wall-clock date + minutes-since-midnight. */
export function fromLocal(
  dateYMD: string,
  minutes: number,
  offsetMinutes: number,
): Date {
  const base = Date.parse(`${dateYMD}T00:00:00.000Z`)
  return new Date(base + minutes * MS_PER_MIN - offsetMinutes * MS_PER_MIN)
}

/** Format minutes-since-midnight as "HH:MM", wrapping at 24h. */
export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60) % 24
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Parse "HH:MM" to minutes since midnight. Null if malformed. */
export function parseHHMM(s: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s ?? '')
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/**
 * Parse a routine `Time` value, "HH:MM - HH:MM", to [startMin, endMin].
 * Returns null for anything malformed so a bad row is skipped, never thrown on.
 */
export function parseWindow(time: string): [number, number] | null {
  const parts = (time ?? '').split('-')
  if (parts.length !== 2) return null
  const a = parseHHMM(parts[0])
  const b = parseHHMM(parts[1])
  return a === null || b === null ? null : [a, b]
}

/** Human duration from seconds: "1h 45m", "30m", "12s". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts: string[] = []
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (!h && !m) parts.push(`${s % 60}s`)
  return parts.join(' ')
}
