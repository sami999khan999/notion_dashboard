/**
 * Firebase Cloud Messaging v1 sender.
 *
 * The legacy server-key API is gone, so v1 requires an OAuth2 access token
 * minted from a service account: build a JWT, sign it RS256, exchange it at
 * Google's token endpoint, then cache the result for its lifetime.
 *
 * All of that is doable on Workers with Web Crypto — no googleapis SDK, which
 * would not run here anyway.
 */
import type { AppEnv } from '../config'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
/** Google issues 1h tokens; refresh a little early to avoid an edge-of-life 401. */
const TOKEN_TTL_SECONDS = 3300
const KV_TOKEN_KEY = 'fcm:access_token'

interface ServiceAccount {
  client_email: string
  private_key: string
  project_id?: string
}

export interface PushMessage {
  title: string
  body: string
  /** Merged into the FCM data payload; values must be strings. */
  data?: Record<string, string>
}

export interface PushTarget {
  token: string
  vibrate: boolean
}

export interface PushResult {
  token: string
  ok: boolean
  /** True when FCM says the token is dead and the row should be deactivated. */
  unregistered?: boolean
  error?: string
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of a) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * PEM (PKCS#8) to raw DER.
 *
 * The `private_key` in a service-account JSON contains literal `\n` escapes
 * when it has been round-tripped through a shell or a secret store. Both forms
 * are accepted here, because getting this wrong produces an opaque
 * "invalid key" from importKey with no hint as to why.
 */
function pemToDer(pem: string): ArrayBuffer {
  const normalised = pem.replace(/\\n/g, '\n')
  const body = normalised
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

function parseServiceAccount(env: AppEnv): ServiceAccount {
  let sa: ServiceAccount
  try {
    sa = JSON.parse(env.FCM_SERVICE_ACCOUNT)
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON')
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT is missing client_email or private_key')
  }
  return sa
}

async function mintAccessToken(env: AppEnv): Promise<string> {
  const sa = parseServiceAccount(env)
  const now = Math.floor(Date.now() / 1000)

  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const claim = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    ),
  )
  const signingInput = `${header}.${claim}`

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  )
  const jwt = `${signingInput}.${b64url(sig)}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`FCM token exchange ${res.status}: ${detail.slice(0, 200)}`)
  }
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new Error('FCM token exchange returned no access_token')
  return json.access_token
}

/** Cached in KV so a burst of alerts does not re-mint per message. */
async function getAccessToken(env: AppEnv): Promise<string> {
  try {
    const cached = await env.FLAGS.get(KV_TOKEN_KEY)
    if (cached) return cached
  } catch {
    /* KV unavailable — fall through and mint a fresh one */
  }
  const token = await mintAccessToken(env)
  try {
    await env.FLAGS.put(KV_TOKEN_KEY, token, { expirationTtl: TOKEN_TTL_SECONDS })
  } catch {
    /* caching is an optimisation, not a requirement */
  }
  return token
}

export function isFcmConfigured(env: AppEnv): boolean {
  return Boolean(env.FCM_SERVICE_ACCOUNT && env.FCM_PROJECT_ID)
}

/**
 * Build the v1 message body.
 *
 * `notification` is omitted deliberately: with a data-only payload the app's
 * background handler always runs, so the phone renders the notification itself
 * with the styling and channel we choose. Letting FCM auto-display it would
 * ignore the vibrate preference, because an Android channel's vibration cannot
 * be changed after the channel is created — the app has to pick the right
 * channel, which means the app has to be the one that posts it.
 */
function buildMessage(target: PushTarget, msg: PushMessage) {
  return {
    message: {
      token: target.token,
      data: {
        title: msg.title,
        body: msg.body,
        vibrate: target.vibrate ? '1' : '0',
        ...(msg.data ?? {}),
      },
      android: {
        // "high" wakes the device so the notification reaches the lock screen
        // promptly instead of waiting for the next maintenance window.
        priority: 'HIGH' as const,
      },
    },
  }
}

/** Send one message to many devices. One result per target, in order. */
export async function pushToDevices(
  env: AppEnv,
  targets: PushTarget[],
  msg: PushMessage,
): Promise<PushResult[]> {
  if (targets.length === 0) return []

  let accessToken: string
  try {
    accessToken = await getAccessToken(env)
  } catch (e) {
    const error = (e as Error).message
    return targets.map((t) => ({ token: t.token, ok: false, error }))
  }

  const url = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`

  // Independent HTTP calls, so they run concurrently rather than serially.
  return Promise.all(
    targets.map(async (t): Promise<PushResult> => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildMessage(t, msg)),
        })
        if (res.ok) return { token: t.token, ok: true }

        const detail = await res.text().catch(() => '')
        // 404 UNREGISTERED / 400 INVALID_ARGUMENT mean the app was uninstalled
        // or the token rotated. Those rows should stop being retried forever.
        const unregistered =
          res.status === 404 ||
          /UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/i.test(detail)
        return {
          token: t.token,
          ok: false,
          unregistered,
          error: `FCM ${res.status}: ${detail.slice(0, 160)}`,
        }
      } catch (e) {
        return { token: t.token, ok: false, error: (e as Error).message }
      }
    }),
  )
}
