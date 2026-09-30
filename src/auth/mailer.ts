import nodemailer from 'nodemailer'
import { env } from '../config/env.js'
import { logger } from '../platform/logger.js'

// SENDING A PASSWORD-RESET LINK.
//
// WHY THIS IS NOT THE OUTREACH SENDER, AND IS NOT SUBJECT TO ITS GUARD.
//
// The outreach guard exists to stop this platform emailing a CUSTOMER by
// accident: it refuses every address that is not an internal test inbox. This
// is a different thing entirely — a reset link goes to someone who already has
// an account here, at an address on the organisation's own allow-list, because
// they asked for it. Routing it through the outreach guard would block it, and
// loosening that guard to let it through would weaken the protection that
// exists for customers. So this is its own small sender, and it can only ever
// send this one kind of message.
//
// With no SMTP configured it sends nothing and says so. The caller then falls
// back to the development behaviour (returning the link) or tells the person
// to ask an administrator — it never pretends an email was sent.

export type MailOutcome =
  | { sent: true; messageId: string | null }
  | { sent: false; reason: string }

export function mailConfigured(): boolean {
  return env.SMTP_HOST.trim().length > 0
}

function fromAddress(): string {
  return env.SMTP_FROM.trim() || env.SMTP_USER.trim()
}

export async function sendPasswordResetEmail(to: string, link: string, expiresMinutes: number): Promise<MailOutcome> {
  if (!mailConfigured()) {
    return { sent: false, reason: 'No mail server is configured on this server (SMTP_HOST).' }
  }
  if (!fromAddress()) {
    return { sent: false, reason: 'No From address is configured (SMTP_FROM or SMTP_USER).' }
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  })

  const text =
    `Someone asked to reset the password for this address on Marketing AI.\n\n` +
    `To choose a new password, open this link:\n${link}\n\n` +
    `The link works once and expires in ${expiresMinutes} minutes.\n\n` +
    `If you did not ask for this, you can ignore this email — your password has not changed.`

  try {
    const info = await transporter.sendMail({
      from: fromAddress(),
      to,
      subject: 'Reset your Marketing AI password',
      text,
    })
    if (Array.isArray(info.rejected) && info.rejected.length) {
      return { sent: false, reason: `The mail server rejected: ${info.rejected.map(String).join(', ')}` }
    }
    return { sent: true, messageId: info.messageId ? String(info.messageId) : null }
  } catch (err) {
    // Never fails the request: the person is told the same thing either way,
    // and the reason is recorded here for whoever runs the server.
    logger.warn({ err: (err as Error).message }, 'password reset email could not be sent')
    return { sent: false, reason: (err as Error).message.slice(0, 300) }
  }
}
