/**
 * JSON API for the Flutter app.
 *
 * The browser uses a signed HttpOnly cookie; a mobile app cannot, so these
 * routes take a Bearer token instead. The token IS the session id, signed with
 * the same HMAC as the cookie, resolved against the same `sessions` table —
 * one identity model, two transports. Revoking a session kills both.
 */
import type { AppEnv } from '../config'
import { signValue, verifyValue } from '../auth/cookies'
import { checkRateLimit, clientIp, verifyPassword } from '../auth/password'
import { createSession, deleteSession, getSessionById } from '../auth/session'
import {
  deleteDevicesForSession,
  getPrefs,
  pruneRotatedTokens,
  setPrefs,
  upsertDevice,
} from '../devices/store'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/** Resolve `Authorization: Bearer <signed session id>` to a session. */
async function authenticate(request: Request, env: AppEnv) {
  const header = request.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const id = await verifyValue(header.slice(7).trim(), env.SESSION_SECRET)
  if (!id) return null
  return getSessionById(env, id)
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = await request.json()
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * POST /api/auth — exchange the dashboard password for a bearer token.
 *
 * Shares the rate limiter and the generic failure message with the web login,
 * so the app is not a softer way in.
 */
async function handleAuth(request: Request, env: AppEnv): Promise<Response> {
  const ip = clientIp(request)
  if (!(await checkRateLimit(env, ip))) {
    console.warn(JSON.stringify({ event: 'api.ratelimited', ip }))
    return json({ error: 'Incorrect password.' }, 401)
  }

  const b = await body(request)
  const password = String(b.password ?? '')
  if (!password || !(await verifyPassword(password, env.PASSWORD_HASH))) {
    console.warn(JSON.stringify({ event: 'api.auth_failed', ip }))
    return json({ error: 'Incorrect password.' }, 401)
  }

  const sessionId = await createSession(
    env,
    { userId: 'owner', email: null, workspaceId: null, name: null },
    'password',
  )
  const token = await signValue(sessionId, env.SESSION_SECRET)
  console.log(JSON.stringify({ event: 'api.auth_ok', ip }))
  return json({ token })
}

/** POST /api/devices — register this install's FCM token. */
async function handleRegister(
  request: Request,
  env: AppEnv,
  sessionId: string,
): Promise<Response> {
  const b = await body(request)
  const fcmToken = String(b.fcmToken ?? '').trim()
  if (fcmToken.length < 20) return json({ error: 'fcmToken missing or malformed' }, 400)

  await upsertDevice(env, {
    fcmToken,
    sessionId,
    platform: b.platform ? String(b.platform).slice(0, 32) : undefined,
    label: b.label ? String(b.label).slice(0, 64) : undefined,
  })
  // A rotated token leaves the old row behind, which would double-send.
  await pruneRotatedTokens(env, sessionId, fcmToken)

  const prefs = await getPrefs(env, fcmToken)
  return json({ ok: true, prefs })
}

/** GET/PATCH /api/prefs — the app's notification and vibration switches. */
async function handlePrefs(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url)
  const fcmToken = (url.searchParams.get('fcmToken') ?? '').trim()
  if (!fcmToken) return json({ error: 'fcmToken query parameter required' }, 400)

  if (request.method === 'GET') {
    const prefs = await getPrefs(env, fcmToken)
    return prefs ? json({ prefs }) : json({ error: 'device not registered' }, 404)
  }

  const b = await body(request)
  const patch: { enabled?: boolean; vibrate?: boolean } = {}
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled
  if (typeof b.vibrate === 'boolean') patch.vibrate = b.vibrate

  const prefs = await setPrefs(env, fcmToken, patch)
  return prefs ? json({ prefs }) : json({ error: 'device not registered' }, 404)
}

/** GET /api/alerts — recent notification history for the app's list. */
async function handleAlerts(env: AppEnv): Promise<Response> {
  const res = await env.DB.prepare(
    `SELECT rule, message, status, sent_at FROM alert_log ORDER BY id DESC LIMIT 50`,
  ).all<{ rule: string; message: string; status: string; sent_at: string }>()
  return json({ alerts: res.results ?? [] })
}

/** GET /api/status — a small summary so the app's home screen has substance. */
async function handleStatus(env: AppEnv): Promise<Response> {
  const [running, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT name, start_time FROM timer_snapshot
        WHERE status = 'Running' AND end_time IS NULL LIMIT 1`,
    ).first<{ name: string; start_time: string }>(),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM alert_log WHERE status = 'sent') sent,
         (SELECT COUNT(*) FROM task_snapshot WHERE completed = 0 AND archived = 0) open_tasks`,
    ).first<{ sent: number; open_tasks: number }>(),
  ])
  return json({
    running: running ? { name: running.name, startedAt: running.start_time } : null,
    alertsSent: counts?.sent ?? 0,
    openTasks: counts?.open_tasks ?? 0,
  })
}

/**
 * Route the /api/* surface. Returns null when the path is not ours, so the
 * caller can fall through to the dashboard handler.
 */
export async function handleApi(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  if (!path.startsWith('/api/')) return null

  // Auth is the only unauthenticated route on this surface.
  if (path === '/api/auth') {
    return request.method === 'POST'
      ? handleAuth(request, env)
      : json({ error: 'method not allowed' }, 405)
  }

  const session = await authenticate(request, env)
  if (!session) return json({ error: 'unauthorized' }, 401)

  switch (path) {
    case '/api/devices':
      return request.method === 'POST'
        ? handleRegister(request, env, session.id)
        : json({ error: 'method not allowed' }, 405)

    case '/api/prefs':
      return request.method === 'GET' || request.method === 'PATCH'
        ? handlePrefs(request, env)
        : json({ error: 'method not allowed' }, 405)

    case '/api/alerts':
      return handleAlerts(env)

    case '/api/status':
      return handleStatus(env)

    case '/api/logout':
      // Signing out on the phone must also stop pushes to it.
      await deleteDevicesForSession(env, session.id)
      await deleteSession(env, session.id)
      return json({ ok: true })

    default:
      return json({ error: 'not found' }, 404)
  }
}
