/**
 * Environment shape and var coercion.
 *
 * Deliberately free of any `cloudflare:workers` import so the entire alert
 * engine can be imported and unit-tested in plain Node with a frozen clock.
 * The live-binding accessor lives in `env.ts`.
 */

export interface AppEnv {
  // --- bindings ---
  DB: D1Database
  FLAGS: KVNamespace

  // --- secrets ---
  NOTION_TOKEN: string
  ALERT_FROM: string
  ALERT_TO: string
  PASSWORD_HASH: string
  SESSION_SECRET: string

  /** "smtp" (default) or "resend". */
  EMAIL_PROVIDER?: string

  // SMTP provider. Port 25 is blocked by Cloudflare; use 587 or 465.
  SMTP_HOST: string
  SMTP_PORT?: string
  SMTP_USER: string
  SMTP_PASS: string

  // Resend provider.
  RESEND_API_KEY: string

  // Firebase Cloud Messaging (mobile push). Both must be set for push to run.
  FCM_SERVICE_ACCOUNT: string
  FCM_PROJECT_ID: string

  // --- Notion data sources ---
  DS_ROUTINE: string
  DS_TASKS: string
  DS_TIMER: string

  // --- time zone ---
  ALERT_TZ_OFFSET_MINUTES: string

  // --- alert tuning ---
  ALERT_MAX_LATENESS_MIN: string
  ALERT_DEADLINE_STALE_HOURS: string
  ALERT_MISSED_GRACE_MIN: string
  ALERT_QUIET_HOURS: string
  DIGEST_AT: string

  // --- rule switches ---
  ALERT_TIMER_START: string
  ALERT_TIMER_TICK: string
  ALERT_TIMER_TICK_MINUTES: string
  ALERT_TIMER_END: string
  ALERT_DEADLINE_24H: string
  ALERT_DEADLINE_1H: string
  ALERT_DEADLINE_HIT: string
  ALERT_DEADLINE_MISSED: string
  ALERT_DEADLINE_MISSED_RENAG: string
  ALERT_ROUTINE_START: string
  ALERT_ROUTINE_DIGEST: string

  // --- auth ---
  LOGIN_RATE_LIMIT: string
  LOGIN_RATE_WINDOW: string
  ENVIRONMENT?: string
}

/** Read a var as a number, falling back when unset or malformed. */
export function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Vars arrive as strings; only the exact string "true" enables a rule. */
export function flag(value: string | undefined): boolean {
  return value === 'true'
}
