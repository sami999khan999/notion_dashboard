/**
 * Email channel. Two providers behind one function, chosen by EMAIL_PROVIDER.
 *
 *  - "smtp"   (default) real SMTP over `cloudflare:sockets`. Nodemailer does
 *             not work on Workers, so we speak the protocol directly — see
 *             smtp.ts. Cloudflare blocks port 25 only; 587/465 connect fine.
 *  - "resend" Resend's HTTPS API. No TCP, slightly simpler, third-party.
 *
 * SMTP is the default because it needs no third-party account and no domain:
 * a Gmail App Password sends from your own mailbox to your own inbox.
 */
import type { AppEnv } from '../config'
import { smtpSendBatch } from './smtp'
import type { SendResult } from './smtp'

/** Escape text interpolated into HTML. Notion titles are user-controlled. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  )
}

/** Shared card body used by every rule template. */
export function card(
  heading: string,
  fields: Array<[string, string]>,
  link?: string,
): string {
  const rows = fields
    .map(
      ([k, v]) =>
        `<tr><td style="padding:5px 18px 5px 0;color:#8b93a7;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
        `<td style="padding:5px 0;color:#e6e8ee">${esc(v)}</td></tr>`,
    )
    .join('')
  const cta = link
    ? `<p style="margin:18px 0 0"><a href="${esc(link)}" style="color:#6ea8fe;text-decoration:none">Open in Notion &rarr;</a></p>`
    : ''
  return (
    `<h2 style="font:600 16px system-ui,sans-serif;margin:0 0 14px;color:#e6e8ee">${esc(heading)}</h2>` +
    `<table style="font:14px system-ui,sans-serif;border-collapse:collapse">${rows}</table>${cta}`
  )
}

function shell(inner: string): string {
  return (
    `<div style="background:#0d0f14;padding:24px;font-family:system-ui,sans-serif">` +
    `<div style="max-width:32rem;margin:0 auto;background:#161a22;border:1px solid #232a36;` +
    `border-radius:12px;padding:22px">${inner}</div></div>`
  )
}

/** Which provider this deployment uses. Defaults to SMTP. */
export function provider(env: AppEnv): 'smtp' | 'resend' {
  return env.EMAIL_PROVIDER === 'resend' ? 'resend' : 'smtp'
}

/**
 * Secrets the selected provider needs. The dispatcher checks this BEFORE
 * consuming any dedupe key, so an unconfigured channel delays alerts rather
 * than destroying them.
 */
export function missingEmailConfig(env: AppEnv): string[] {
  const common = (['ALERT_FROM', 'ALERT_TO'] as const).filter((k) => !env[k])
  if (provider(env) === 'resend') {
    return [...(env.RESEND_API_KEY ? [] : ['RESEND_API_KEY']), ...common]
  }
  return [
    ...(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const).filter((k) => !env[k]),
    ...common,
  ]
}

export interface OutgoingEmail {
  subject: string
  html: string
}

async function resendOne(env: AppEnv, m: OutgoingEmail): Promise<SendResult> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.ALERT_FROM,
        to: [env.ALERT_TO],
        subject: m.subject,
        html: shell(m.html),
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, error: `Resend ${res.status}: ${detail.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Send a batch, returning one result per input in order.
 *
 * SMTP reuses a single authenticated session for the whole batch — the
 * handshake is the expensive part, so this is what keeps a multi-alert tick
 * from taking tens of seconds. Resend is HTTP, so its requests just run
 * concurrently.
 */
export async function sendEmails(
  env: AppEnv,
  messages: OutgoingEmail[],
): Promise<SendResult[]> {
  if (messages.length === 0) return []

  if (provider(env) === 'resend') {
    return Promise.all(messages.map((m) => resendOne(env, m)))
  }

  const port = Number(env.SMTP_PORT || 587)
  return smtpSendBatch(
    {
      host: env.SMTP_HOST,
      port,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      // 465 is implicit TLS; everything else (587, 2525) upgrades via STARTTLS.
      mode: port === 465 ? 'tls' : 'starttls',
    },
    messages.map((m) => ({
      from: env.ALERT_FROM,
      to: env.ALERT_TO,
      subject: m.subject,
      html: shell(m.html),
    })),
  )
}

/** Single-message convenience for the /test-email route. */
export async function sendEmail(
  env: AppEnv,
  subject: string,
  html: string,
): Promise<void> {
  const [r] = await sendEmails(env, [{ subject, html }])
  if (!r?.ok) throw new Error(r?.error ?? 'send failed')
}
