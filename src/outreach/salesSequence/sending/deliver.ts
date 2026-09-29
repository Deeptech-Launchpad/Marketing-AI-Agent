import { env } from '../../../config/env.js'
import { newId, prisma } from '../../../platform/db.js'
import { logger } from '../../../platform/logger.js'
import type { SenderConfig } from '../sender.js'
import { resolveTestDelivery } from './guard.js'
import { getTransport, guardConfig, transportStatus } from './transport.js'

// ONE TEST DELIVERY, RECORDED (2026-09-28).
//
// Resolves where the email may go (the guard), hands it to the transport (which
// checks the guard again), and records the attempt — accepted, failed or
// blocked — with the intended recipient kept apart from the address it
// actually went to. Never throws: a failed or refused send is a result.

export interface DeliveryOutcome {
  status: 'accepted' | 'failed' | 'blocked'
  attemptId: string
  to: string[]
  transport: 'capture' | 'smtp'
  messageId: string | null
  error: string | null
}

export async function deliverTestEmail(input: {
  tenantId: string
  actionId: string
  campaignId: string
  kind: 'preview' | 'scheduled'
  intendedRecipient: string | null
  subject: string | null
  body: string
  sender: SenderConfig
  /** The signed-in person asking for a preview; null for scheduled sends. */
  requester?: string | null
  triggeredBy: string
}): Promise<DeliveryOutcome> {
  const transport = getTransport()
  const status = transportStatus()
  const config = guardConfig()
  let outcome: Omit<DeliveryOutcome, 'attemptId'>
  let subject = input.subject

  const delivery = resolveTestDelivery({ config, intendedRecipient: input.intendedRecipient, subject: input.subject, requester: input.requester })
  if (!delivery.ok) {
    outcome = { status: 'blocked', to: [], transport: transport.name, messageId: null, error: delivery.reason }
  } else if (!status.ready) {
    outcome = { status: 'blocked', to: [], transport: transport.name, messageId: null, error: status.reason }
  } else {
    // A "Test email to my inbox" preview arrives exactly as the customer would
    // receive it — same subject, same body — so the reviewer sees the real
    // email. Only the addressee differs, and the guard has already limited that
    // to an internal test inbox. Scheduled batch sends keep the TEST marking.
    const exact = input.kind === 'preview'
    subject = exact ? input.subject : delivery.subject
    const text = exact ? input.body : `${delivery.banner}\n\n${input.body}`
    const fromAddress = env.SMTP_FROM.trim() || input.sender.email.trim() || (transport.name === 'capture' ? 'outreach-test@capture.local' : '')
    if (!fromAddress) {
      outcome = { status: 'blocked', to: [], transport: transport.name, messageId: null, error: 'No From address: set SMTP_FROM or the sender email in Settings.' }
    } else {
      const from = input.sender.fullName.trim() ? `${input.sender.fullName.trim()} <${fromAddress}>` : fromAddress
      try {
        const sent = await transport.send({ from, to: delivery.to, subject: subject ?? '', text }, config)
        outcome = { status: 'accepted', to: delivery.to, transport: transport.name, messageId: sent.messageId || null, error: null }
      } catch (err) {
        const message = (err as Error).message || 'The mail server refused the email.'
        outcome = { status: /^Refused:/.test(message) ? 'blocked' : 'failed', to: delivery.to, transport: transport.name, messageId: null, error: message.slice(0, 500) }
      }
    }
  }

  const attemptId = newId()
  await prisma.outreachSendAttempt.create({
    data: {
      id: attemptId,
      tenantId: input.tenantId,
      actionId: input.actionId,
      campaignId: input.campaignId,
      kind: input.kind,
      mode: 'test',
      intendedRecipient: input.intendedRecipient,
      actualRecipients: outcome.to as never,
      subject,
      transport: outcome.transport,
      status: outcome.status,
      providerMessageId: outcome.messageId,
      error: outcome.error,
      errorKind: outcome.status === 'blocked' ? 'guard' : outcome.status === 'failed' ? 'transient' : null,
      triggeredBy: input.triggeredBy,
    },
  })
  if (outcome.status !== 'accepted') logger.info({ actionId: input.actionId, status: outcome.status, error: outcome.error }, 'test email not delivered')
  return { ...outcome, attemptId }
}
