/**
 * Password verification + login rate limiting.
 *
 * PBKDF2-SHA256 via Web Crypto: available on Workers, no dependency, and
 * deliberately slow. Uses 100,000 iterations — the maximum workerd allows.
 * OWASP suggests more, but the runtime throws NotSupportedError above 100k, so
 * this is a platform ceiling rather than a choice. The online attack surface is
 * bounded by the per-IP rate limiter instead; an offline attack would first
 * require compromising the Cloudflare account that holds the hash.
 *
 * The stored secret format is:  pbkdf2$<iterations>$<saltB64url>$<hashB64url>
 * Generate one with `node scripts/hash-password.mjs '<password>'`.
 * The PLAINTEXT is never stored anywhere.
 */
import type { AppEnv } from '../config'
import { num } from '../config'
import { timingSafeEqual, unb64url } from './cookies'

const KEYLEN_BITS = 256

/**
 * Hard ceiling enforced by the Workers runtime. Exceeding it makes
 * crypto.subtle.deriveBits throw NotSupportedError, which — before this was
 * discovered — surfaced as "Incorrect password" for a perfectly correct one.
 */
export const MAX_PBKDF2_ITERATIONS = 100_000

function b64url(buf: ArrayBuffer): string {
  const a = new Uint8Array(buf)
  let s = ''
  for (const b of a) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEYLEN_BITS,
  )
  return b64url(bits)
}

/**
 * Describe the SHAPE of the stored hash for logs — never its contents.
 *
 * A misconfigured PASSWORD_HASH is otherwise undiagnosable: the login page
 * deliberately returns one generic message, so "wrong password" and "the secret
 * is malformed" look identical from outside. Lengths and the iteration count
 * give away nothing useful (an attacker still needs the password), but they
 * instantly distinguish a good hash from a shell-mangled one.
 *
 * A correct value looks like: pbkdf2$100000$<22 chars>$<43 chars>
 */
export function describeHash(stored: string | undefined): Record<string, unknown> {
  if (!stored) return { present: false }
  const parts = stored.split('$')
  return {
    present: true,
    parts: parts.length,
    prefix: parts[0]?.slice(0, 12) ?? null,
    iterations: parts.length === 4 ? Number(parts[1]) : null,
    saltLen: parts[2]?.length ?? null,
    hashLen: parts[3]?.length ?? null,
    wellFormed:
      parts.length === 4 &&
      parts[0] === 'pbkdf2' &&
      Number.isFinite(Number(parts[1])) &&
      Number(parts[1]) >= 1000,
    // The classic failure: `echo "pbkdf2$100000$..."` in a shell expands $100000
    // and friends, collapsing the 4 parts into 2 or 3.
    likelyShellExpanded: parts.length < 4,
    // Above the runtime ceiling the derivation throws and every login fails.
    exceedsRuntimeLimit:
      parts.length === 4 && Number(parts[1]) > MAX_PBKDF2_ITERATIONS,
  }
}

/**
 * Short, non-reversible fingerprint of the stored secret, for logs.
 *
 * SHA-256 truncated to 8 hex chars. Lets you confirm that the value deployed in
 * Cloudflare is the one you intended, by comparing against the same digest
 * computed locally — without ever printing the secret itself.
 */
export async function hashFingerprint(stored: string | undefined): Promise<string> {
  if (!stored) return 'absent'
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stored),
  )
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Verify a candidate against the stored hash string. */
export async function verifyPassword(
  candidate: string,
  stored: string | undefined,
): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false

  const iterations = Number(parts[1])
  // Refuse an implausibly weak stored hash rather than silently accepting it.
  if (!Number.isFinite(iterations) || iterations < 1000) return false

  let actual: string
  try {
    actual = await derive(candidate, unb64url(parts[2]), iterations)
  } catch (e) {
    // Never swallow this. A runtime failure here (CPU limit, unsupported
    // parameters, bad base64) is indistinguishable from a wrong password to
    // the caller, which makes a broken deployment look like user error.
    console.error(
      JSON.stringify({
        event: 'auth.derive_failed',
        iterations,
        saltLen: parts[2].length,
        error: (e as Error).message.slice(0, 200),
        name: (e as Error).name,
      }),
    )
    return false
  }
  return timingSafeEqual(actual, parts[3])
}

/**
 * Fixed-window login rate limit, keyed by IP.
 *
 * Fails CLOSED: if KV is unavailable we refuse the attempt rather than let the
 * limiter silently degrade into a no-op, which is worse than having none
 * because you would believe you were protected.
 *
 * KV is eventually consistent, so a distributed attacker can somewhat exceed
 * the budget. That is acceptable — the limiter exists to make online brute
 * force impractical, and PBKDF2 at 100k iterations already caps throughput.
 */
export async function checkRateLimit(env: AppEnv, ip: string): Promise<boolean> {
  const max = num(env.LOGIN_RATE_LIMIT, 8)
  const windowSec = num(env.LOGIN_RATE_WINDOW, 900)
  const bucket = Math.floor(Date.now() / (windowSec * 1000))
  const key = `login:${ip}:${bucket}`

  try {
    const current = Number((await env.FLAGS.get(key)) ?? 0)
    if (current >= max) return false
    await env.FLAGS.put(key, String(current + 1), { expirationTtl: windowSec + 60 })
    return true
  } catch {
    return false
  }
}

/**
 * Client IP. `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by
 * the client. Never trust X-Forwarded-For here — that would turn a per-IP
 * limiter into no limiter at all.
 */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown'
}
