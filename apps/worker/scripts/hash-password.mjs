/**
 * Generate the PASSWORD_HASH secret.
 *
 *   pnpm hash-password 'your password here'
 *   pnpm hash-password --stdin          (prompts; best for tricky characters)
 *
 * Output is byte-compatible with src/auth/password.ts — verified by
 * test/password.test.ts, which hashes here and verifies with Web Crypto.
 *
 * The reported character count is the important bit: if it does not match the
 * password you think you typed, your shell ate part of it. That is the single
 * most common reason a correct-looking password fails to log in.
 */
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { createInterface } from 'node:readline'

// workerd caps PBKDF2 at 100,000 iterations and throws NotSupportedError above
// it. Node's pbkdf2Sync accepts far more, so a higher value here produces a
// hash that verifies fine locally and ALWAYS fails in production. Do not raise
// this without checking the runtime limit first — test/password.test.ts guards it.
const ITERATIONS = 100_000
const KEYLEN_BYTES = 32

const b64url = (b) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function derive(password, salt) {
  return pbkdf2Sync(password, salt, ITERATIONS, KEYLEN_BYTES, 'sha256')
}

function readStdin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question('Password (visible): ', (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/** Masked preview: enough to spot truncation, not enough to shoulder-surf. */
function preview(pw) {
  if (pw.length <= 2) return '*'.repeat(pw.length)
  return `${pw[0]}${'*'.repeat(Math.min(pw.length - 2, 10))}${pw[pw.length - 1]}`
}

const args = process.argv.slice(2)
let password

if (args[0] === '--stdin') {
  password = await readStdin()
} else if (args.length === 0) {
  console.error(`usage: pnpm hash-password '<password>'
       pnpm hash-password --stdin

Quote the password. Without quotes your shell splits it on spaces and only the
first word is hashed.`)
  process.exit(1)
} else {
  // Unquoted multi-word input arrives as several argv entries. Rejoining is
  // friendlier than hashing only the first word, but it is almost certainly a
  // quoting mistake, so say so loudly.
  password = args.join(' ')
  if (args.length > 1) {
    console.error(
      `WARNING: received ${args.length} arguments, joined with single spaces.\n` +
        `         Quote the password to be sure: pnpm hash-password 'a b c'\n`,
    )
  }
}

if (!password) {
  console.error('refusing: empty password.')
  process.exit(1)
}
if (password !== password.trim()) {
  console.error(
    `WARNING: password has leading/trailing whitespace (it will be significant).\n`,
  )
}
if (password.length < 12) {
  console.error(
    `refusing: password is ${password.length} character(s). Use at least 12 —\n` +
      `this is the only thing between the internet and your dashboard.`,
  )
  process.exit(1)
}

const salt = randomBytes(16)
const stored = `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(derive(password, salt))}`

// Self-check: re-derive and compare, so a broken build never emits a hash that
// cannot possibly verify.
const parts = stored.split('$')
const check = b64url(derive(password, Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')))
if (
  check.length !== parts[3].length ||
  !timingSafeEqual(Buffer.from(check), Buffer.from(parts[3]))
) {
  console.error('internal error: self-verification failed; not emitting a hash.')
  process.exit(1)
}

console.error(`Hashed ${password.length} characters: ${preview(password)}`)
console.error(`If that length is not what you expected, your shell mangled it.\n`)
console.log(stored)
