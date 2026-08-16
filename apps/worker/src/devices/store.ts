/**
 * Push device registry.
 *
 * Preferences are authoritative here rather than only on the phone, so the
 * Worker can skip a device entirely when notifications are off — cheaper than
 * pushing something the client discards, and it keeps the toggle working even
 * if the app is never opened again.
 */
import type { AppEnv } from '../config'

export interface DeviceRow {
  fcm_token: string
  session_id: string
  platform: string | null
  label: string | null
  enabled: number
  vibrate: number
  active: number
  created_at: string
  last_seen: string
}

export interface DevicePrefs {
  enabled: boolean
  vibrate: boolean
}

const isoNow = () => new Date().toISOString()

/**
 * Register or refresh a device.
 *
 * FCM tokens rotate, so the app re-registers on every launch and on rotation.
 * Existing preferences are preserved on conflict — a token refresh must never
 * silently switch notifications back on.
 */
export async function upsertDevice(
  env: AppEnv,
  args: { fcmToken: string; sessionId: string; platform?: string; label?: string },
): Promise<void> {
  const now = isoNow()
  await env.DB.prepare(
    `INSERT INTO devices
       (fcm_token, session_id, platform, label, enabled, vibrate, active, created_at, last_seen)
     VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?)
     ON CONFLICT(fcm_token) DO UPDATE SET
       session_id = excluded.session_id,
       platform   = excluded.platform,
       label      = excluded.label,
       active     = 1,
       last_seen  = excluded.last_seen`,
  )
    .bind(args.fcmToken, args.sessionId, args.platform ?? null, args.label ?? null, now, now)
    .run()
}

/** Drop stale rows for this session that are no longer the current token. */
export async function pruneRotatedTokens(
  env: AppEnv,
  sessionId: string,
  keepToken: string,
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM devices WHERE session_id = ? AND fcm_token <> ?`,
  )
    .bind(sessionId, keepToken)
    .run()
}

export async function getPrefs(
  env: AppEnv,
  fcmToken: string,
): Promise<DevicePrefs | null> {
  const row = await env.DB.prepare(
    `SELECT enabled, vibrate FROM devices WHERE fcm_token = ?`,
  )
    .bind(fcmToken)
    .first<{ enabled: number; vibrate: number }>()
  if (!row) return null
  return { enabled: row.enabled === 1, vibrate: row.vibrate === 1 }
}

export async function setPrefs(
  env: AppEnv,
  fcmToken: string,
  prefs: Partial<DevicePrefs>,
): Promise<DevicePrefs | null> {
  const current = await getPrefs(env, fcmToken)
  if (!current) return null
  const next: DevicePrefs = { ...current, ...prefs }
  await env.DB.prepare(
    `UPDATE devices SET enabled = ?, vibrate = ?, last_seen = ? WHERE fcm_token = ?`,
  )
    .bind(next.enabled ? 1 : 0, next.vibrate ? 1 : 0, isoNow(), fcmToken)
    .run()
  return next
}

/** Devices that should actually receive a push right now. */
export async function activeTargets(
  env: AppEnv,
): Promise<Array<{ token: string; vibrate: boolean }>> {
  const res = await env.DB.prepare(
    `SELECT fcm_token, vibrate FROM devices WHERE active = 1 AND enabled = 1`,
  ).all<{ fcm_token: string; vibrate: number }>()
  return (res.results ?? []).map((r) => ({
    token: r.fcm_token,
    vibrate: r.vibrate === 1,
  }))
}

/** Called when FCM reports a token is dead, so we stop retrying it forever. */
export async function deactivateToken(env: AppEnv, fcmToken: string): Promise<void> {
  await env.DB.prepare(`UPDATE devices SET active = 0 WHERE fcm_token = ?`)
    .bind(fcmToken)
    .run()
}

export async function deleteDevicesForSession(
  env: AppEnv,
  sessionId: string,
): Promise<void> {
  await env.DB.prepare(`DELETE FROM devices WHERE session_id = ?`).bind(sessionId).run()
}
