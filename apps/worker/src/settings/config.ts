/**
 * Alert configuration — env defaults with runtime overrides from D1.
 *
 * The vars in wrangler.jsonc remain the DEFAULTS; a row in `settings` overrides
 * one. That means the deployed config is still self-documenting and a fresh
 * database behaves exactly as before, while changes made in the dashboard take
 * effect on the next cron tick with no redeploy.
 *
 * No `cloudflare:workers` import here — the merge and validation logic is pure
 * so it can be unit-tested in plain Node alongside the rules.
 */
import type { AppEnv } from '../config'
import { flag, num } from '../config'

export interface AlertConfig {
  tzOffsetMinutes: number
  maxLatenessMin: number
  deadlineStaleHours: number
  missedGraceMin: number
  /** "" (disabled) or "HH:MM-HH:MM", may wrap past midnight. */
  quietHours: string
  digestAt: string

  timerStart: boolean
  timerTick: boolean
  timerTickMinutes: number
  timerEnd: boolean

  deadline24h: boolean
  deadline1h: boolean
  deadlineHit: boolean
  deadlineMissed: boolean
  deadlineMissedRenag: boolean

  routineStart: boolean
  routineDigest: boolean
}

/** Field metadata drives validation, the settings form, and the D1 round-trip. */
type FieldSpec =
  | { kind: 'bool'; envKey: keyof AppEnv }
  | { kind: 'int'; envKey: keyof AppEnv; min: number; max: number; fallback: number }
  | { kind: 'time'; envKey: keyof AppEnv; fallback: string }
  | { kind: 'window'; envKey: keyof AppEnv; fallback: string }

export const FIELDS: Record<keyof AlertConfig, FieldSpec> = {
  tzOffsetMinutes: {
    kind: 'int',
    envKey: 'ALERT_TZ_OFFSET_MINUTES',
    min: -720,
    max: 840,
    fallback: 360,
  },
  maxLatenessMin: {
    kind: 'int',
    envKey: 'ALERT_MAX_LATENESS_MIN',
    min: 0,
    max: 120,
    fallback: 10,
  },
  deadlineStaleHours: {
    kind: 'int',
    envKey: 'ALERT_DEADLINE_STALE_HOURS',
    min: 1,
    max: 8760,
    fallback: 24,
  },
  missedGraceMin: {
    kind: 'int',
    envKey: 'ALERT_MISSED_GRACE_MIN',
    min: 0,
    max: 10080,
    fallback: 60,
  },
  quietHours: { kind: 'window', envKey: 'ALERT_QUIET_HOURS', fallback: '' },
  digestAt: { kind: 'time', envKey: 'DIGEST_AT', fallback: '07:45' },

  timerStart: { kind: 'bool', envKey: 'ALERT_TIMER_START' },
  timerTick: { kind: 'bool', envKey: 'ALERT_TIMER_TICK' },
  timerTickMinutes: {
    kind: 'int',
    envKey: 'ALERT_TIMER_TICK_MINUTES',
    min: 1,
    max: 1440,
    fallback: 30,
  },
  timerEnd: { kind: 'bool', envKey: 'ALERT_TIMER_END' },

  deadline24h: { kind: 'bool', envKey: 'ALERT_DEADLINE_24H' },
  deadline1h: { kind: 'bool', envKey: 'ALERT_DEADLINE_1H' },
  deadlineHit: { kind: 'bool', envKey: 'ALERT_DEADLINE_HIT' },
  deadlineMissed: { kind: 'bool', envKey: 'ALERT_DEADLINE_MISSED' },
  deadlineMissedRenag: { kind: 'bool', envKey: 'ALERT_DEADLINE_MISSED_RENAG' },

  routineStart: { kind: 'bool', envKey: 'ALERT_ROUTINE_START' },
  routineDigest: { kind: 'bool', envKey: 'ALERT_ROUTINE_DIGEST' },
}

export const FIELD_KEYS = Object.keys(FIELDS) as Array<keyof AlertConfig>

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function clampInt(raw: unknown, spec: Extract<FieldSpec, { kind: 'int' }>): number {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return spec.fallback
  return Math.min(spec.max, Math.max(spec.min, n))
}

/** "" disables; otherwise both halves must be HH:MM or the window is rejected. */
function normalizeWindow(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const parts = s.split('-')
  if (parts.length !== 2) return fallback
  const [a, b] = parts.map((p) => p.trim())
  return HHMM.test(a) && HHMM.test(b) ? `${a}-${b}` : fallback
}

function normalizeTime(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').trim()
  return HHMM.test(s) ? s : fallback
}

/** The baseline: whatever wrangler.jsonc says. */
export function configFromEnv(env: AppEnv): AlertConfig {
  const out = {} as AlertConfig
  for (const key of FIELD_KEYS) {
    const spec = FIELDS[key]
    const raw = env[spec.envKey] as string | undefined
    switch (spec.kind) {
      case 'bool':
        ;(out as any)[key] = flag(raw)
        break
      case 'int':
        ;(out as any)[key] = clampInt(num(raw, spec.fallback), spec)
        break
      case 'time':
        ;(out as any)[key] = normalizeTime(raw, spec.fallback)
        break
      case 'window':
        ;(out as any)[key] = normalizeWindow(raw, spec.fallback)
        break
    }
  }
  return out
}

/**
 * Overlay stored overrides onto the env baseline.
 *
 * Every value is re-validated on read, not just on write — a hand-edited D1 row
 * or a schema change must not be able to put a nonsense interval into the
 * alert engine.
 */
export function mergeOverrides(
  base: AlertConfig,
  overrides: Record<string, string>,
): AlertConfig {
  const out: AlertConfig = { ...base }
  for (const key of FIELD_KEYS) {
    if (!(key in overrides)) continue
    const raw = overrides[key]
    const spec = FIELDS[key]
    switch (spec.kind) {
      case 'bool':
        ;(out as any)[key] = raw === 'true'
        break
      case 'int':
        ;(out as any)[key] = clampInt(raw, spec)
        break
      case 'time':
        ;(out as any)[key] = normalizeTime(raw, base[key] as string)
        break
      case 'window':
        ;(out as any)[key] = normalizeWindow(raw, base[key] as string)
        break
    }
  }
  return out
}

/** Coerce arbitrary input (a form post) into storable, validated strings. */
export function sanitizeForStorage(
  base: AlertConfig,
  input: Record<string, unknown>,
): Record<string, string> {
  const merged = mergeOverrides(
    base,
    Object.fromEntries(
      Object.entries(input)
        .filter(([k]) => (FIELD_KEYS as string[]).includes(k))
        .map(([k, v]) => [k, String(v)]),
    ),
  )
  return Object.fromEntries(
    FIELD_KEYS.map((k) => [k, String(merged[k])]),
  ) as Record<string, string>
}
