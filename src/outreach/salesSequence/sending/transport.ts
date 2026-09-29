import nodemailer from 'nodemailer'
import { env } from '../../../config/env.js'
import { assertDeliverable, parseAllowList, type GuardConfig } from './guard.js'

// HOW A TEST EMAIL LEAVES THE PLATFORM (2026-09-28).
//
//   capture — nothing leaves: the email is recorded exactly as it would have
//             been delivered to the test inbox (the default, and what works
//             before any mail credentials exist).
//   smtp    — delivered to the internal test inbox through the SMTP server in
//             .env (Google Workspace and Microsoft 365 both provide one).
//
// Both run assertDeliverable() themselves, immediately before delivery, so an
// address outside the internal test inboxes is refused even if a caller got
// everything else wrong.

export interface OutgoingEmail {
  from: string
  to: string[]
  subject: string
  text: string
}

export interface TransportResult {
  messageId: string
}

export interface MailTransport {
  readonly name: 'capture' | 'smtp'
  send(email: OutgoingEmail, guard: GuardConfig): Promise<TransportResult>
}

export function guardConfig(): GuardConfig {
  return {
    mode: env.OUTREACH_EMAIL_MODE,
    allowList: parseAllowList(env.OUTREACH_TEST_RECIPIENTS),
    testInbox: env.OUTREACH_TEST_INBOX.trim() || null,
  }
}

export class CaptureTransport implements MailTransport {
  readonly name = 'capture' as const
  async send(email: OutgoingEmail, guard: GuardConfig): Promise<TransportResult> {
    assertDeliverable(email.to, guard)
    return { messageId: `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }
  }
}

export class SmtpTransport implements MailTransport {
  readonly name = 'smtp' as const
  private transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  })

  async send(email: OutgoingEmail, guard: GuardConfig): Promise<TransportResult> {
    assertDeliverable(email.to, guard)
    const info = await this.transporter.sendMail({ from: email.from, to: email.to, subject: email.subject, text: email.text })
    // The server's own list of rejected addressees — never counted as sent.
    if (Array.isArray(info.rejected) && info.rejected.length) {
      throw new Error(`The mail server rejected: ${info.rejected.map(String).join(', ')}`)
    }
    return { messageId: String(info.messageId ?? '') }
  }
}

export interface TransportStatus {
  mode: 'off' | 'test'
  transport: 'capture' | 'smtp'
  ready: boolean
  reason: string | null
  testInbox: string | null
  allowList: string[]
}

/** What the screens show about sending, and whether a test send can go now. */
export function transportStatus(): TransportStatus {
  const g = guardConfig()
  const allowList = [...g.allowList.addresses, ...[...g.allowList.domains].map((d) => `@${d}`)]
  const base = { mode: g.mode, transport: env.OUTREACH_TEST_TRANSPORT, testInbox: g.testInbox, allowList }
  if (g.mode !== 'test') return { ...base, ready: false, reason: 'Sending is off. Set OUTREACH_EMAIL_MODE=test to send test emails to internal inboxes.' }
  if (!allowList.length) return { ...base, ready: false, reason: 'No internal test inboxes are configured (OUTREACH_TEST_RECIPIENTS).' }
  if (env.OUTREACH_TEST_TRANSPORT === 'smtp' && !env.SMTP_HOST) {
    return { ...base, ready: false, reason: 'OUTREACH_TEST_TRANSPORT is "smtp" but SMTP_HOST is not set.' }
  }
  return { ...base, ready: true, reason: null }
}

let cached: MailTransport | null = null
export function getTransport(): MailTransport {
  if (!cached || cached.name !== env.OUTREACH_TEST_TRANSPORT) {
    cached = env.OUTREACH_TEST_TRANSPORT === 'smtp' ? new SmtpTransport() : new CaptureTransport()
  }
  return cached
}
