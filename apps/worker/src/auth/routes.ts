/**
 * Auth HTTP handlers.
 *
 * These are handled directly in the Worker entry rather than as framework
 * routes, which gives one central choke point: the entry allow-lists exactly
 * these public paths and guards everything else by default. New routes are
 * therefore protected unless someone explicitly opens them.
 */
import type { AppEnv } from '../config'
import { card } from '../alerts/email'
import { missingEmailConfig, provider, sendEmail } from '../alerts/email'
import {
  SESSION_COOKIE,
  clearCookie,
  parseCookies,
  serializeCookie,
  signValue,
  verifyValue,
} from './cookies'
import {
  checkRateLimit,
  clientIp,
  describeHash,
  hashFingerprint,
  verifyPassword,
} from './password'
import { SESSION_MAX_AGE, createSession, deleteSession } from './session'

/**
 * `Secure` cookies are refused over plain http by some browsers and by curl.
 * Production is always https, so this stays on there; local `vite dev` runs on
 * http://localhost and would otherwise silently drop the session cookie —
 * making a correct password look like a failed login all over again.
 */
function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:'
}

/** Paths served without a session. Everything else requires one. */
export const PUBLIC_PATHS = new Set(['/login', '/logout'])

/**
 * POST /test-email — send one message through the configured channel.
 *
 * Reached only through the Worker's auth gate, so a session is already
 * required. Useful for confirming SMTP credentials without waiting for a
 * routine block, and for diagnosing delivery later.
 */
export async function handleTestEmail(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const missing = missingEmailConfig(env)
  if (missing.length > 0) {
    return Response.json(
      { ok: false, provider: provider(env), missing },
      { status: 400 },
    )
  }

  const stamp = new Date().toISOString()
  try {
    await sendEmail(
      env,
      '✅ Notion Ops — test email',
      card('Test email', [
        ['Provider', provider(env)],
        ['Sent at', stamp],
        ['Meaning', 'Your email channel is configured correctly.'],
      ]),
    )
    return Response.json({ ok: true, provider: provider(env), sentAt: stamp })
  } catch (e) {
    // Surface the real reason — an SMTP failure code is the whole diagnostic.
    return Response.json(
      { ok: false, provider: provider(env), error: (e as Error).message },
      { status: 502 },
    )
  }
}

function loginPage(error?: string): Response {
  const msg = error
    ? `<p class="err"><span aria-hidden="true">&#9888;</span><span>${error}</span></p>`
    : ''
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in &middot; Notion Ops</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;
    background:#0a0a0a;color:#ffffff;-webkit-font-smoothing:antialiased;
    font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    font-size:14px;line-height:1.5}
  .cover{position:fixed;inset:0;
    background:radial-gradient(90% 140% at 15% 0%,rgba(59,130,246,.18) 0%,transparent 60%),
      radial-gradient(90% 140% at 85% 10%,rgba(196,59,160,.14) 0%,transparent 60%),
      linear-gradient(180deg,#111 0%,#0a0a0a 100%)}
  .card{position:relative;width:100%;max-width:352px;padding:28px;
    background:#101010;border:1px solid rgba(255,255,255,.07);border-radius:18px;
    box-shadow:0 24px 60px rgba(0,0,0,.6)}
  .icon{width:44px;height:44px;display:grid;place-items:center;font-size:22px;font-weight:700;
    background:#3b82f6;border-radius:14px;box-shadow:none;margin-bottom:14px}
  h1{margin:0 0 3px;font-size:19px;font-weight:700;letter-spacing:-.01em}
  .sub{margin:0 0 18px;color:#9a9a9a;font-size:13px}
  label{display:block;font-size:12px;font-weight:500;color:#9a9a9a;margin-bottom:5px}
  input{width:100%;padding:9px 13px;border-radius:999px;font:inherit;font-size:14px;color:#ffffff;
    background:#171717;border:1px solid rgba(255,255,255,.07);border-radius:4px;outline:none}
  input:focus{background:#0a0a0a;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.22)}
  button{width:100%;margin-top:14px;padding:10px;font:inherit;font-size:14px;font-weight:600;
    color:#fff;background:#3b82f6;border:0;border-radius:999px;cursor:pointer}
  button:hover{filter:brightness(1.12)}
  .err{display:flex;gap:7px;align-items:flex-start;margin:0 0 14px;padding:8px 10px;
    background:rgba(240,68,56,.16);border-radius:10px;color:#f04438;font-size:13px}
  .foot{margin:16px 0 0;color:#6b6b6b;font-size:11px;text-align:center}
</style></head><body>
<div class="cover" aria-hidden="true"></div>
<main class="card">
  <div class="icon" aria-hidden="true">N</div>
  <h1>Notion Ops</h1>
  <p class="sub">This dashboard is private.</p>
  ${msg}
  <form method="POST" action="/login">
    <label for="pw">Password</label>
    <input id="pw" type="password" name="password" autofocus
           autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
  <p class="foot">Mirrors your Notion workspace every minute.</p>
</main></body></html>`

  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Never let an intermediary or the browser cache a page rendered mid-flow.
      'Cache-Control': 'no-store',
    },
  })
}

export async function handleLogin(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  if (request.method === 'GET') return loginPage()
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const ip = clientIp(request)

  // Rate limit BEFORE the KDF. 210k PBKDF2 iterations per request is a CPU
  // amplification vector if an unauthenticated caller can trigger it freely.
  if (!(await checkRateLimit(env, ip))) {
    console.warn(JSON.stringify({ event: 'auth.ratelimited', ip }))
    // Same message as a wrong password — different text would tell an attacker
    // their probing is working.
    return loginPage('Incorrect password.')
  }

  let password = ''
  let bodyDiag: Record<string, unknown> = {}
  try {
    const ct = request.headers.get('content-type') ?? ''
    const form = await request.formData()
    password = String(form.get('password') ?? '')
    bodyDiag = {
      contentType: ct.split(';')[0],
      fields: [...form.keys()],
      candidateLen: password.length,
    }
  } catch (e) {
    bodyDiag = { parseError: (e as Error).message.slice(0, 80) }
    console.warn(
      JSON.stringify({ event: 'auth.body_unreadable', ip, body: bodyDiag }),
    )
    return loginPage('Incorrect password.')
  }

  if (!password || !(await verifyPassword(password, env.PASSWORD_HASH))) {
    // Shape only, never contents — see describeHash(). This is what makes a
    // malformed secret distinguishable from a genuinely wrong password.
    console.warn(
      JSON.stringify({
        event: 'auth.failed',
        method: 'password',
        ip,
        storedHash: describeHash(env.PASSWORD_HASH),
        fingerprint: await hashFingerprint(env.PASSWORD_HASH),
        body: bodyDiag,
      }),
    )
    return loginPage('Incorrect password.')
  }

  const sessionId = await createSession(
    env,
    { userId: 'owner', email: null, workspaceId: null, name: null },
    'password',
  )
  const cookie = serializeCookie(
    SESSION_COOKIE,
    await signValue(sessionId, env.SESSION_SECRET),
    {
      maxAge: SESSION_MAX_AGE,
      httpOnly: true,
      secure: isSecureRequest(request),
      sameSite: 'Lax',
    },
  )

  console.log(JSON.stringify({ event: 'auth.success', method: 'password', ip }))
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': cookie },
  })
}

/** POST-only, so it cannot be triggered by an <img> tag or a link prefetch. */
export async function handleLogout(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 302, headers: { Location: '/' } })
  }

  const signed = parseCookies(request)[SESSION_COOKIE]
  if (signed) {
    const id = await verifyValue(signed, env.SESSION_SECRET)
    if (id) await deleteSession(env, id) // server-side revocation
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/login',
      'Set-Cookie': clearCookie(SESSION_COOKIE, isSecureRequest(request)),
    },
  })
}
