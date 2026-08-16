/**
 * Check a password against a stored hash, locally.
 *
 *   pnpm verify-password '<password>' 'pbkdf2$210000$...'
 *
 * Use this when a login fails and you want to know whether the password or the
 * secret is at fault, without deploying anything. It runs the exact algorithm
 * the Worker runs.
 *
 * Note: you cannot read a Worker secret back out of Cloudflare. Verify against
 * the hash string you generated — if it matches here but the login still fails,
 * the value stored in Cloudflare is not the one you are testing.
 */
import { pbkdf2Sync, timingSafeEqual } from 'node:crypto'

const [password, stored] = process.argv.slice(2)

if (!password || !stored) {
  console.error("usage: pnpm verify-password '<password>' '<pbkdf2$...hash>'")
  process.exit(1)
}

const parts = stored.split('$')
if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
  console.error(
    `MALFORMED hash: got ${parts.length} part(s), prefix ${JSON.stringify(parts[0])}.\n` +
      `Expected 4 parts like pbkdf2$210000$<22 chars>$<43 chars>.\n` +
      (parts.length < 4
        ? 'This looks shell-expanded — the $ segments were eaten. Quote it, or\n' +
          'paste it into the interactive `wrangler secret put` prompt instead.'
        : ''),
  )
  process.exit(2)
}

const iterations = Number(parts[1])
if (iterations > 100_000) {
  console.error(
    `WARNING: ${iterations} iterations exceeds the workerd limit of 100000.
` +
      `This hash will verify here (Node) but ALWAYS fail in the Worker.
` +
      `Regenerate it with: pnpm hash-password --stdin
`,
  )
}
const salt = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const b64url = (b) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const actual = b64url(pbkdf2Sync(password, salt, iterations, 32, 'sha256'))
const ok =
  actual.length === parts[3].length &&
  timingSafeEqual(Buffer.from(actual), Buffer.from(parts[3]))

console.log(`hash shape : ${parts.length} parts, ${iterations} iterations, ` +
  `salt ${parts[2].length}, key ${parts[3].length}`)
console.log(`password   : ${password.length} characters`)
console.log(`result     : ${ok ? 'MATCH' : 'NO MATCH'}`)
process.exit(ok ? 0 : 1)
