/**
 * Cross-implementation check: hashes produced by scripts/hash-password.mjs
 * (Node's pbkdf2Sync) MUST verify against src/auth/password.ts (Web Crypto).
 *
 * These are two different PBKDF2 implementations that only ever meet in
 * production, so nothing else in the suite would catch a mismatch in iteration
 * count, key length, salt handling, or base64url encoding. A bug here looks
 * exactly like "the user typed the wrong password", which is unfalsifiable
 * from the outside.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_PBKDF2_ITERATIONS, verifyPassword } from '../src/auth/password'

const ITERATIONS = 100_000
const KEYLEN_BYTES = 32

const b64url = (b: Buffer) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Byte-for-byte the algorithm in scripts/hash-password.mjs. */
function hashLikeScript(password: string, salt = randomBytes(16)): string {
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN_BYTES, 'sha256')
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`
}

describe('hash-password.mjs <-> verifyPassword', () => {
  it('accepts a correct password', async () => {
    const stored = hashLikeScript('correct-horse-battery-staple')
    expect(await verifyPassword('correct-horse-battery-staple', stored)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const stored = hashLikeScript('correct-horse-battery-staple')
    expect(await verifyPassword('correct-horse-battery-stapl', stored)).toBe(false)
  })

  it('produces the documented shape', () => {
    const parts = hashLikeScript('whatever').split('$')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('pbkdf2')
    expect(Number(parts[1])).toBe(100_000)
    expect(parts[2]).toHaveLength(22) // 16 salt bytes, base64url unpadded
    expect(parts[3]).toHaveLength(43) // 32 key bytes, base64url unpadded
  })

  it('round-trips passwords with characters a shell would mangle', async () => {
    for (const pw of [
      'p@ss$word!123',
      'has spaces in it',
      "quote'and\"double",
      'back\\slash and `tick`',
      'unicode: café — 🟢',
      'trailing space ',
      ' leading space',
    ]) {
      const stored = hashLikeScript(pw)
      expect(await verifyPassword(pw, stored), `should accept ${JSON.stringify(pw)}`).toBe(
        true,
      )
      // And whitespace must be significant — a trimmed variant must NOT pass,
      // since that is a real way to lock yourself out.
      if (pw !== pw.trim()) {
        expect(await verifyPassword(pw.trim(), stored)).toBe(false)
      }
    }
  })

  it('is stable across many random salts', async () => {
    for (let i = 0; i < 5; i++) {
      const stored = hashLikeScript('same-password-every-time')
      expect(await verifyPassword('same-password-every-time', stored)).toBe(true)
    }
  })

  /**
   * REGRESSION GUARD. workerd rejects PBKDF2 above 100,000 iterations with
   * NotSupportedError, but Node accepts far more — so a too-high value passes
   * every Node test and then fails 100% of real logins, surfacing as
   * "Incorrect password" for a correct one. This actually happened at 210,000.
   */
  it('generates within the Workers runtime iteration ceiling', () => {
    expect(ITERATIONS).toBeLessThanOrEqual(MAX_PBKDF2_ITERATIONS)
    expect(MAX_PBKDF2_ITERATIONS).toBe(100_000)
  })

  it('rejects a malformed or shell-expanded secret rather than throwing', async () => {
    for (const bad of [
      '',
      'plaintext-password',
      'pbkdf210000$salt$hash', // $210000 eaten by the shell
      'pbkdf2$210000$salt', // truncated
      'pbkdf2$50$c2FsdA$aGFzaA', // iteration count below the floor
      'bcrypt$210000$c2FsdA$aGFzaA',
    ]) {
      expect(await verifyPassword('anything', bad), `bad: ${bad}`).toBe(false)
    }
  })

  it('treats an undefined secret as a failure, not a crash', async () => {
    expect(await verifyPassword('anything', undefined)).toBe(false)
  })
})
