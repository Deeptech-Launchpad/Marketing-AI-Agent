import nodemailer from 'nodemailer'
import { env } from '../../config/env.js'
import { strictEmail } from './extract.js'

// THE BULK EMAIL TRANSPORT (2026-10-08).
//
// The SMTP account that carries the emails — the transport — is set on the
// server: its own BULK_SMTP_* account when one is configured, otherwise the
// system account (SMTP_*). The address the customer sees in From is a
// different thing: the From email the user set on the Bulk email screen,
// which may only be used once the sender check (senders.ts) has shown that
// this account is genuinely allowed to send as it. The transport never puts
// its own address in From unless the user chose exactly that address.

export interface TransportAccount {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  /** 'bulk' = BULK_SMTP_*; 'system' = the platform's own SMTP_* account. */
  source: 'bulk' | 'system'
}

export function bulkTransportAccount(): TransportAccount | null {
  const bulkUser = strictEmail(env.BULK_SMTP_USER)
  if (env.BULK_SMTP_HOST && bulkUser && env.BULK_SMTP_PASS) {
    return { host: env.BULK_SMTP_HOST, port: env.BULK_SMTP_PORT, secure: env.BULK_SMTP_SECURE, user: bulkUser, pass: env.BULK_SMTP_PASS, source: 'bulk' }
  }
  const sysUser = strictEmail(env.SMTP_USER)
  if (env.SMTP_HOST && sysUser && env.SMTP_PASS) {
    return { host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: sysUser, pass: env.SMTP_PASS, source: 'system' }
  }
  return null
}

export interface BulkOutgoing {
  /** The From the user set, already checked as authorized for this account. */
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

export interface BulkSendingStatus {
  enabled: boolean
  mailboxConfigured: boolean
  /** The SMTP account that carries the emails (never shown to customers). */
  account: { email: string; source: 'bulk' | 'system' } | null
  /** Why nothing can be sent, in words; null when the server side is ready. */
  reason: string | null
}

export function bulkSendingStatus(): BulkSendingStatus {
  const account = bulkTransportAccount()
  const reason = !env.BULK_EMAIL_ENABLED
    ? 'Bulk sending is switched off on the server (BULK_EMAIL_ENABLED). You can upload and review, but not start.'
    : !account
      ? 'No SMTP account is configured on the server (BULK_SMTP_HOST, BULK_SMTP_USER, BULK_SMTP_PASS — or the system SMTP_* account).'
      : null
  return { enabled: env.BULK_EMAIL_ENABLED, mailboxConfigured: Boolean(account), account: account ? { email: account.user, source: account.source } : null, reason }
}

/** A header value with no line breaks (no header can be injected). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

export function smtpTransport(a: TransportAccount) {
  return nodemailer.createTransport({
    host: a.host,
    port: a.port,
    secure: a.secure,
    auth: { user: a.user, pass: a.pass },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 45_000,
  })
}

/** The message as handed to the SMTP library — exported so the headers can be tested. */
export function bulkMailOptions(account: TransportAccount, email: BulkOutgoing) {
  const from = strictEmail(email.fromEmail)
  const to = strictEmail(email.to)
  const cc = email.cc.map((c) => strictEmail(c)).filter((c): c is string => Boolean(c))
  if (!from) throw new Error(`"${email.fromEmail}" is not a valid From address.`)
  if (!to) throw new Error(`"${email.to}" is not a valid email address.`)
  return {
    from: email.fromName ? { name: oneLine(email.fromName).slice(0, 80), address: from } : from,
    to,
    ...(cc.length ? { cc } : {}),
    // Replies go to the From the customer sees, never to the transport account.
    replyTo: from,
    subject: oneLine(email.subject),
    text: email.text,
    html: email.html,
    // Lets the recipient's mail program offer a one-click unsubscribe, to the From address.
    headers: { 'List-Unsubscribe': `<mailto:${from}?subject=unsubscribe>` },
    // The SMTP envelope is the account's own (providers require it); bounces return there.
    envelope: { from: account.user, to: [to, ...cc] },
  }
}

class SmtpBulkSender implements BulkSender {
  private cache: { key: string; transporter: ReturnType<typeof smtpTransport> } | null = null

  async send(email: BulkOutgoing): Promise<{ messageId: string }> {
    const account = bulkTransportAccount()
    if (!account) throw new Error('No SMTP account is configured on the server.')
    const key = `${account.host}|${account.port}|${account.user}`
    if (this.cache?.key !== key) this.cache = { key, transporter: smtpTransport(account) }
    const options = bulkMailOptions(account, email)
    const info = await this.cache.transporter.sendMail(options)
    const rejected = Array.isArray(info.rejected) ? info.rejected.map(String) : []
    if (rejected.includes(options.to)) throw new Error(`The mail server rejected ${options.to}.`)
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
