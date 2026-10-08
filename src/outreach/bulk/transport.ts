import nodemailer from 'nodemailer'
import { env } from '../../config/env.js'
import { strictEmail } from './extract.js'

// THE BULK EMAIL MAILBOX (2026-10-07).
//
// Its own SMTP account (BULK_SMTP_*), never the login-code mailbox. The From
// address must be one this mailbox is allowed to send as (BULK_FROM_ADDRESSES,
// or the login itself), so the customer always receives the email from the
// sender chosen on the screen and nothing else. Every address is strict — no
// spaces, quotes, commas or line breaks — before it reaches the mail library.

export interface BulkOutgoing {
  fromEmail: string
  fromName: string | null
  to: string
  cc: string[]
  subject: string
  text: string
  html: string
}

export interface BulkSender {
  send(email: BulkOutgoing): Promise<{ messageId: string }>
}

/** The From addresses the screen may offer. */
export function bulkSenders(): string[] {
  const list = env.BULK_FROM_ADDRESSES.split(',')
    .map((s) => strictEmail(s))
    .filter((s): s is string => Boolean(s))
  const login = strictEmail(env.BULK_SMTP_USER)
  return [...new Set(list.length ? list : login ? [login] : [])]
}

export interface BulkSendingStatus {
  enabled: boolean
  mailboxConfigured: boolean
  senders: string[]
  /** Why nothing can be sent, in words; null when it can. */
  reason: string | null
}

export function bulkSendingStatus(): BulkSendingStatus {
  const mailboxConfigured = Boolean(env.BULK_SMTP_HOST && env.BULK_SMTP_USER && env.BULK_SMTP_PASS)
  const senders = bulkSenders()
  const reason = !env.BULK_EMAIL_ENABLED
    ? 'Bulk sending is switched off on the server (BULK_EMAIL_ENABLED). You can upload and review, but not start.'
    : !mailboxConfigured
      ? 'No sending mailbox is configured on the server (BULK_SMTP_HOST, BULK_SMTP_USER, BULK_SMTP_PASS).'
      : senders.length === 0
        ? 'No From address is configured on the server (BULK_FROM_ADDRESSES).'
        : null
  return { enabled: env.BULK_EMAIL_ENABLED, mailboxConfigured, senders, reason }
}

/** A header value with no line breaks (no header can be injected). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

class SmtpBulkSender implements BulkSender {
  private transporter = nodemailer.createTransport({
    host: env.BULK_SMTP_HOST,
    port: env.BULK_SMTP_PORT,
    secure: env.BULK_SMTP_SECURE,
    auth: { user: env.BULK_SMTP_USER, pass: env.BULK_SMTP_PASS },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 45_000,
  })

  async send(email: BulkOutgoing): Promise<{ messageId: string }> {
    const from = strictEmail(email.fromEmail)
    const to = strictEmail(email.to)
    const cc = email.cc.map((c) => strictEmail(c)).filter((c): c is string => Boolean(c))
    if (!from || !bulkSenders().includes(from)) throw new Error(`${email.fromEmail} is not a configured sending address.`)
    if (!to) throw new Error(`"${email.to}" is not a valid email address.`)
    const info = await this.transporter.sendMail({
      from: email.fromName ? { name: oneLine(email.fromName).slice(0, 80), address: from } : from,
      to,
      ...(cc.length ? { cc } : {}),
      replyTo: from,
      subject: oneLine(email.subject),
      text: email.text,
      html: email.html,
      // Lets the recipient's mail program offer a one-click unsubscribe.
      headers: { 'List-Unsubscribe': `<mailto:${from}?subject=unsubscribe>` },
      envelope: { from, to: [to, ...cc] },
    })
    const rejected = Array.isArray(info.rejected) ? info.rejected.map(String) : []
    if (rejected.includes(to)) throw new Error(`The mail server rejected ${to}.`)
    return { messageId: String(info.messageId ?? '') }
  }
}

let override: BulkSender | null = null
let real: BulkSender | null = null

/** The mailbox sender. Tests put a stand-in here; nothing else should. */
export function bulkSender(): BulkSender {
  if (override) return override
  real ??= new SmtpBulkSender()
  return real
}

export function setBulkSenderForTests(s: BulkSender | null): void {
  override = s
}
