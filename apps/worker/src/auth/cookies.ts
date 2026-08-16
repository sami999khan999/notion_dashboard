/**
 * Cookie signing / parsing (Web Crypto HMAC-SHA256).
 *
 * The cookie carries `value.signature`, where the signature is
 * HMAC-SHA256(SESSION_SECRET, value), base64url-encoded. We sign-and-compare
 * rather than using crypto.subtle.verify so the comparison can be
 * constant-time-ish and the key usage stays limited to ["sign"].
 */

export const SESSION_COOKIE = 'sid'

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of a) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unb64url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/**
 * Comparison that does not short-circuit on the first mismatch.
 * A plain `===` on a digest is a timing oracle for cookie forgery.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function hmacSign(value: string, secret: string): Promise<string> {
  const key = await importKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return b64url(sig)
}

/** Produce the cookie value `value.signature`. */
export async function signValue(value: string, secret: string): Promise<string> {
  return `${value}.${await hmacSign(value, secret)}`
}

/** Verify `value.signature`; returns the value, or null if tampered. */
export async function verifyValue(
  signed: string,
  secret: string,
): Promise<string | null> {
  const dot = signed.lastIndexOf('.')
  if (dot <= 0) return null
  const value = signed.slice(0, dot)
  const presented = signed.slice(dot + 1)
  const expected = await hmacSign(value, secret)
  return timingSafeEqual(presented, expected) ? value : null
}

/** Random opaque id (128 bits, base64url). */
export function randomId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)))
}

export interface CookieOpts {
  maxAge?: number
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
}

export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOpts = {},
): string {
  const {
    maxAge,
    path = '/',
    httpOnly = true,
    secure = true,
    // Lax, not Strict: it must survive a top-level redirect back into the app.
    sameSite = 'Lax',
  } = opts
  let out = `${name}=${value}; Path=${path}; SameSite=${sameSite}`
  if (httpOnly) out += '; HttpOnly'
  if (secure) out += '; Secure'
  if (maxAge != null) out += `; Max-Age=${maxAge}`
  return out
}

/**
 * A clearing cookie must match the attributes it was set with (notably
 * `Secure`), otherwise the browser treats it as a different cookie and the old
 * one survives logout.
 */
export function clearCookie(name: string, secure = true): string {
  return serializeCookie(name, '', { maxAge: 0, secure })
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('Cookie') ?? ''
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k) out[k] = part.slice(i + 1).trim()
  }
  return out
}
