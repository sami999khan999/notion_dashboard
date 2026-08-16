/**
 * Minimal SMTP client over `cloudflare:sockets`.
 *
 * Nodemailer and friends do NOT work on Workers — they need `node:net`,
 * `node:tls` and Node stream internals that nodejs_compat does not fully
 * provide. But the *protocol* is reachable: Cloudflare blocks outbound port 25
 * only. Submission ports 587 (STARTTLS) and 465 (implicit TLS) connect fine,
 * and `socket.startTls()` performs a real upgrade.
 *
 * Verified from a deployed Worker against smtp.gmail.com:
 *   220 greeting -> EHLO -> STARTTLS advertised -> startTls() -> EHLO ->
 *   250-AUTH LOGIN PLAIN XOAUTH2 -> NOOP 250 over the encrypted channel.
 *   Port 25 returns "Connections to port 25 are prohibited".
 *
 * Message construction lives in smtp-message.ts; this file is only the wire
 * conversation. One message per connection: no pipelining, no pooling.
 */
import { connect } from 'cloudflare:sockets'
import { b64utf8, bareAddress, buildMessage } from './smtp-message'
import type { SmtpMessage } from './smtp-message'

export type { SmtpMessage }

export interface SmtpConfig {
  host: string
  port: number
  user: string
  pass: string
  /** 'starttls' upgrades on 587; 'tls' is implicit TLS on 465. */
  mode: 'starttls' | 'tls'
}

const CRLF = '\r\n'

class SmtpSession {
  private socket: Socket
  private reader!: ReadableStreamDefaultReader<Uint8Array>
  private writer!: WritableStreamDefaultWriter<Uint8Array>
  private buf = ''

  constructor(socket: Socket) {
    this.socket = socket
    this.bind(socket)
  }

  private bind(socket: Socket) {
    this.socket = socket
    this.reader = socket.readable.getReader()
    this.writer = socket.writable.getWriter()
    this.buf = ''
  }

  /**
   * Read one complete reply. Continuation lines look like "250-CAP"; the final
   * line has a space in the 4th column ("250 OK"), which terminates the reply.
   */
  async read(): Promise<string> {
    for (;;) {
      const lines = this.buf.split(CRLF)
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const out = lines.slice(0, i + 1).join(CRLF)
          this.buf = lines.slice(i + 1).join(CRLF)
          return out
        }
      }
      const { value, done } = await this.reader.read()
      if (done) throw new Error('SMTP connection closed unexpectedly')
      this.buf += new TextDecoder().decode(value)
    }
  }

  async write(data: string): Promise<void> {
    await this.writer.write(new TextEncoder().encode(data))
  }

  /** Send a command and assert the reply code. */
  async cmd(line: string, expect: string[], label?: string): Promise<string> {
    await this.write(line + CRLF)
    const reply = await this.read()
    assertCode(reply, expect, label ?? line)
    return reply
  }

  /** Swap in the TLS-upgraded socket after STARTTLS. */
  upgrade(): void {
    this.reader.releaseLock()
    this.writer.releaseLock()
    this.bind(this.socket.startTls())
  }

  async close(): Promise<void> {
    try {
      this.reader.releaseLock()
      this.writer.releaseLock()
      await this.socket.close()
    } catch {
      /* already closed */
    }
  }
}

function assertCode(reply: string, expect: string[], label: string): void {
  const code = reply.slice(0, 3)
  if (!expect.includes(code)) {
    throw new Error(`SMTP ${code} at ${label}: ${reply.split(CRLF)[0].slice(0, 160)}`)
  }
}

export interface SendResult {
  ok: boolean
  error?: string
}

/**
 * Send a batch of messages over ONE connection.
 *
 * This matters for latency. An SMTP handshake is connect + EHLO + STARTTLS +
 * EHLO + AUTH — roughly 1.5-2.5s against Gmail, and AUTH is deliberately slow.
 * Paying that per message meant a tick with several alerts sent them serially
 * at ~2s each, and rapid reconnects also invite Gmail's throttling. Reusing the
 * session drops each additional message to a single MAIL/RCPT/DATA round trip.
 *
 * Failures are per-message: a rejected recipient does not abort the rest, and
 * the caller gets one result per input in order.
 */
export async function smtpSendBatch(
  cfg: SmtpConfig,
  messages: SmtpMessage[],
  now: Date = new Date(),
): Promise<SendResult[]> {
  if (messages.length === 0) return []
  const results: SendResult[] = messages.map(() => ({
    ok: false,
    error: 'not attempted',
  }))
  const socket = connect(
    { hostname: cfg.host, port: cfg.port },
    {
      // 'starttls' only ARMS the upgrade; startTls() still has to be called.
      secureTransport: cfg.mode === 'starttls' ? 'starttls' : 'on',
      allowHalfOpen: false,
    },
  )

  const s = new SmtpSession(socket)
  try {
    assertCode(await s.read(), ['220'], 'greeting')

    const ehlo = `EHLO ${bareAddress(messages[0].from).split('@')[1] ?? 'localhost'}`
    let caps = await s.cmd(ehlo, ['250'])

    if (cfg.mode === 'starttls') {
      // Refuse to continue in the clear if the server will not upgrade — the
      // password would otherwise go out base64-encoded but unencrypted.
      if (!/STARTTLS/i.test(caps)) {
        throw new Error(
          'server does not advertise STARTTLS; refusing to send in clear text',
        )
      }
      await s.cmd('STARTTLS', ['220'])
      s.upgrade()
      caps = await s.cmd(ehlo, ['250']) // capabilities must be re-read after TLS
    }

    if (!/AUTH[ =]/i.test(caps)) throw new Error('server does not advertise AUTH')

    // AUTH LOGIN: base64 username, then base64 password, each on its own line.
    // Labels are passed explicitly so a failure never echoes the credential.
    await s.cmd('AUTH LOGIN', ['334'])
    await s.cmd(b64utf8(cfg.user), ['334'], 'AUTH username')
    await s.cmd(b64utf8(cfg.pass), ['235'], 'AUTH password')

    // One transaction per message on the established session.
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      try {
        await s.cmd(`MAIL FROM:<${bareAddress(msg.from)}>`, ['250'])
        await s.cmd(`RCPT TO:<${bareAddress(msg.to)}>`, ['250', '251'])
        await s.cmd('DATA', ['354'])
        await s.write(buildMessage(msg, now) + '.' + CRLF)
        assertCode(await s.read(), ['250'], 'message body')
        results[i] = { ok: true }
      } catch (e) {
        results[i] = { ok: false, error: (e as Error).message }
        // RSET clears the aborted transaction so the next message starts
        // clean. If even that fails the session is unusable — stop here and
        // leave the remaining results as their 'not attempted' default.
        try {
          await s.cmd('RSET', ['250'])
        } catch {
          break
        }
      }
    }

    // Some servers drop the connection instead of replying 221.
    await s.cmd('QUIT', ['221']).catch(() => {})
  } catch (e) {
    // A connection/handshake failure fails every message in the batch.
    const error = (e as Error).message
    for (let i = 0; i < results.length; i++) {
      if (!results[i].ok) results[i] = { ok: false, error }
    }
  } finally {
    await s.close()
  }

  return results
}
