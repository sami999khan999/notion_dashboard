/**
 * SMTP message construction — RFC 5322 headers + MIME body.
 *
 * Deliberately free of any `cloudflare:sockets` import so the encoding rules
 * (which is where the real bugs live) can be unit-tested in plain Node. The
 * socket client that consumes these lives in smtp.ts.
 *
 * Encoding matters here more than it looks: every alert subject we generate
 * contains emoji (▶ ⏳ ⏹ 🟢 ❗ 📅) and the bodies contain en-dashes. Raw
 * non-ASCII bytes are illegal in a mail header and get silently mangled.
 */

export interface SmtpMessage {
  /** "Display Name <addr@host>" or a bare address. */
  from: string
  to: string
  subject: string
  html: string
}

const CRLF = '\r\n'

// --- encoding helpers -------------------------------------------------------

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** base64 of a UTF-8 string. Also used for AUTH LOGIN credentials. */
export function b64utf8(str: string): string {
  return b64(new TextEncoder().encode(str))
}

/** RFC 2047 encoded-word, applied only when the value is not pure ASCII. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?UTF-8?B?${b64utf8(value)}?=`
}

/** Wrap base64 at 76 chars — SMTP lines must stay well under 1000 octets. */
function wrap76(s: string): string {
  return (s.match(/.{1,76}/g) ?? []).join(CRLF)
}

/** Pull the bare address out of "Display Name <addr@host>". */
export function bareAddress(addr: string): string {
  const m = /<([^>]+)>/.exec(addr)
  return (m ? m[1] : addr).trim()
}

/** Encode only the display-name part; the address itself must stay literal. */
function encodeDisplayName(from: string): string {
  const m = /^(.*)<([^>]+)>\s*$/.exec(from)
  if (!m) return from
  const name = m[1].trim().replace(/^"|"$/g, '')
  return name ? `${encodeHeader(name)} <${m[2].trim()}>` : `<${m[2].trim()}>`
}

function messageId(from: string): string {
  const domain = bareAddress(from).split('@')[1] ?? 'localhost'
  return `<${crypto.randomUUID()}@${domain}>`
}

/**
 * Build the RFC 5322 message.
 *
 * The body is base64-encoded, which sidesteps two problems at once:
 * dot-stuffing (a body line consisting of "." would otherwise terminate DATA
 * early, letting content truncate or inject) and the SMTP line-length limit.
 */
export function buildMessage(m: SmtpMessage, now: Date): string {
  const headers = [
    `From: ${encodeDisplayName(m.from)}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId(m.from)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  return headers.join(CRLF) + CRLF + CRLF + wrap76(b64utf8(m.html)) + CRLF
}
