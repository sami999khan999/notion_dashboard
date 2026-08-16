/**
 * Session store (D1).
 *
 * The cookie carries only the opaque id; this table is the source of truth, so
 * deleting a row is immediate server-side revocation.
 */
import type { AppEnv } from '../config'
import { SESSION_COOKIE, parseCookies, randomId, verifyValue } from './cookies'

const SESSION_TTL_DAYS = 30
/** Extend expiry at most once a day, to avoid a D1 write on every request. */
const SLIDING_REFRESH_MS = 24 * 60 * 60 * 1000

export const SESSION_MAX_AGE = SESSION_TTL_DAYS * 24 * 60 * 60

export interface Identity {
  userId: string
  email: string | null
  workspaceId: string | null
  name: string | null
}

export interface Session {
  id: string
  userId: string
  email: string | null
  name: string | null
  authMethod: string
  expiresAt: string
}

const isoNow = () => new Date().toISOString()
const isoPlusDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString()

export async function createSession(
  env: AppEnv,
  identity: Identity,
  method: 'password' | 'notion' = 'password',
): Promise<string> {
  const id = randomId()
  const now = isoNow()
  await env.DB.prepare(
    `INSERT INTO sessions
       (id, user_id, email, workspace_id, name, auth_method, created_at, expires_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      identity.userId,
      identity.email,
      identity.workspaceId,
      identity.name,
      method,
      now,
      isoPlusDays(SESSION_TTL_DAYS),
      now,
    )
    .run()
  return id
}

/** Resolve a session id to a live session, applying throttled sliding refresh. */
export async function getSessionById(
  env: AppEnv,
  id: string,
): Promise<Session | null> {
  const row = await env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`)
    .bind(id)
    .first<any>()
  if (!row) return null

  const now = Date.now()
  if (new Date(row.expires_at).getTime() <= now) {
    // Expired — clean up opportunistically and treat as no session.
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run()
    return null
  }

  if (now - new Date(row.last_seen).getTime() > SLIDING_REFRESH_MS) {
    await env.DB.prepare(
      `UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?`,
    )
      .bind(new Date(now).toISOString(), isoPlusDays(SESSION_TTL_DAYS), id)
      .run()
  }

  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    authMethod: row.auth_method,
    expiresAt: row.expires_at,
  }
}

/** Read + verify the cookie and resolve the session. Null when not signed in. */
export async function getSession(
  request: Request,
  env: AppEnv,
): Promise<Session | null> {
  const signed = parseCookies(request)[SESSION_COOKIE]
  if (!signed) return null

  const id = await verifyValue(signed, env.SESSION_SECRET)
  if (!id) return null // forged or tampered cookie

  return getSessionById(env, id)
}

export async function deleteSession(env: AppEnv, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run()
}

/** Periodic prune of expired rows; called from the cron. */
export async function pruneExpiredSessions(env: AppEnv): Promise<number> {
  const res = await env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= ?`)
    .bind(isoNow())
    .run()
  return res.meta?.changes ?? 0
}
