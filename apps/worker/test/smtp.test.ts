/**
 * SMTP message construction.
 *
 * Only the pure builders are tested here — `smtpSend` imports
 * `cloudflare:sockets` and needs the Workers runtime, so protocol behaviour was
 * verified against smtp.gmail.com from a deployed probe instead.
 *
 * These cases matter because every alert subject we generate contains emoji
 * (▶ ⏳ ⏹ 🟢 ❗ 📅) and the bodies contain en-dashes — all illegal raw in a
 * mail header, and all silently mangled if the encoding is wrong.
 */
import { describe, expect, it } from 'vitest'
import { bareAddress, buildMessage } from '../src/alerts/smtp-message'

const NOW = new Date('2026-08-16T04:30:00.000Z')

function build(over: Partial<Parameters<typeof buildMessage>[0]> = {}) {
  return buildMessage(
    {
      from: 'Notion Ops <ops@example.com>',
      to: 'me@example.com',
      subject: 'Plain subject',
      html: '<p>hello</p>',
      ...over,
    },
    NOW,
  )
}

function headers(msg: string): string {
  return msg.split('\r\n\r\n')[0]
}

function body(msg: string): string {
  return msg.split('\r\n\r\n').slice(1).join('\r\n\r\n')
}

function decodeBody(msg: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(body(msg).replace(/\r\n/g, '')), (c) => c.charCodeAt(0)),
  )
}

describe('bareAddress', () => {
  it('extracts the address from a display-name form', () => {
    expect(bareAddress('Notion Ops <ops@example.com>')).toBe('ops@example.com')
  })
  it('passes a bare address through', () => {
    expect(bareAddress('ops@example.com')).toBe('ops@example.com')
  })
})

describe('buildMessage headers', () => {
  it('leaves an ASCII subject unencoded', () => {
    expect(headers(build())).toContain('Subject: Plain subject')
  })

  it('RFC 2047 encodes an emoji subject', () => {
    const h = headers(build({ subject: '🟢 Work — 09:00 – 13:00' }))
    const m = /Subject: (.+)/.exec(h)!
    expect(m[1]).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    // And it must round-trip back to the original.
    const b64 = /=\?UTF-8\?B\?(.+)\?=/.exec(m[1])![1]
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toBe('🟢 Work — 09:00 – 13:00')
  })

  it('never emits a raw non-ASCII byte in the header block', () => {
    const h = headers(build({ subject: '⏳ 30m on: Café ▶' }))
    // eslint-disable-next-line no-control-regex
    expect(h).toMatch(/^[\x00-\x7F]*$/)
  })

  it('encodes a non-ASCII display name but keeps the address literal', () => {
    const h = headers(build({ from: 'Notiøn Øps <ops@example.com>' }))
    expect(h).toContain('<ops@example.com>')
    expect(h).toMatch(/From: =\?UTF-8\?B\?/)
  })

  it('includes the MIME headers a client needs', () => {
    const h = headers(build())
    expect(h).toContain('MIME-Version: 1.0')
    expect(h).toContain('Content-Type: text/html; charset=UTF-8')
    expect(h).toContain('Content-Transfer-Encoding: base64')
    expect(h).toMatch(/Message-ID: <[^>]+@example\.com>/)
    expect(h).toContain('Date: Sun, 16 Aug 2026 04:30:00 +0000')
  })
})

describe('buildMessage body', () => {
  it('base64-encodes the body and round-trips UTF-8 intact', () => {
    const html = '<p>Работа — 🟢 09:00 – 13:00</p>'
    expect(decodeBody(build({ html }))).toBe(html)
  })

  it('wraps base64 within the SMTP line limit', () => {
    const msg = build({ html: '<p>' + 'x'.repeat(5000) + '</p>' })
    for (const line of body(msg).split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76)
    }
  })

  it('cannot terminate DATA early via a leading-dot line', () => {
    // Base64 output has no "." at all, so dot-stuffing is structurally
    // impossible — this is why we encode rather than send raw HTML.
    const msg = build({ html: '<p>ok</p>\r\n.\r\n<p>injected</p>' })
    expect(body(msg)).not.toMatch(/^\.$/m)
    expect(decodeBody(msg)).toContain('.')
  })

  it('separates headers from body with exactly one blank line', () => {
    expect(build().split('\r\n\r\n')).toHaveLength(2)
  })
})
