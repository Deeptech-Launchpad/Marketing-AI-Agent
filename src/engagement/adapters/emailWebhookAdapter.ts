import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'
import { prisma } from '../../platform/db.js'
import type { NormalizeInput } from '../normalize.js'
import type { EngagementEventType } from '../types.js'

// TASK #983 — the provider webhook boundary.
//
// STATE OF THE WORLD, VERIFIED NOT ASSUMED
//
// Task #982 established that NO email provider is configured on this
// installation: no SMTP, no SendGrid, Mailgun, Postmark, SES or Resend
// credential exists, and no mail library is installed. No outreach email has
// been sent, so no delivery, open, click or bounce has ever occurred.
//
// This file therefore implements the BOUNDARY, not a live integration. It is
// written against a generic HMAC-signed webhook so that a real provider can be
// connected by supplying a secret and one mapping table, and it is exercised by
// fixtures rather than by traffic. Nothing here fabricates an email event, and
// with no secret configured the endpoint refuses everything.
//
// WHY UNVERIFIED MEANS REJECTED, NOT "ACCEPTED AND FLAGGED"
//
// An unauthenticated caller who can write `email_bounced` into an account has
// rewritten that account's history. The cost of dropping a genuine event when a
// secret is misconfigured is a gap someone notices; the cost of accepting a
// forged one is a record nobody knows to distrust. So verification is a gate.

export type WebhookRejection =
  | 'not_configured'
  | 'missing_signature'
  | 'bad_signature'
  | 'stale_timestamp'
  | 'malformed'
  | 'unknown_event'
  | 'unresolvable_reference'

export interface VerificationResult {
  ok: boolean
  rejection?: WebhookRejection
  reason?: string
  method: string
}

/**
 * Verifies an HMAC-SHA256 signature over `timestamp.rawBody`.
 *
 * The timestamp is inside the signed material on purpose: signing the body
 * alone would let a captured request be replayed forever.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  now = new Date(),
): VerificationResult {
  const method = 'hmac-sha256'

  if (!env.ENGAGEMENT_WEBHOOK_SECRET) {
    return {
      ok: false,
      rejection: 'not_configured',
      reason: 'No webhook secret is configured, so no provider webhook is trusted.',
      method,
    }
  }
  if (!signatureHeader || !timestampHeader) {
    return { ok: false, rejection: 'missing_signature', reason: 'A signature and timestamp header are required.', method }
  }

  const ts = Number(timestampHeader)
  if (!Number.isFinite(ts)) {
    return { ok: false, rejection: 'malformed', reason: 'The timestamp header is not a number.', method }
  }

  const ageSeconds = Math.abs(now.getTime() / 1000 - ts)
  if (ageSeconds > env.ENGAGEMENT_WEBHOOK_TOLERANCE_SECONDS) {
    return {
      ok: false,
      rejection: 'stale_timestamp',
      reason: `The signed timestamp is outside the ${env.ENGAGEMENT_WEBHOOK_TOLERANCE_SECONDS}s tolerance.`,
      method,
    }
  }

  const expected = createHmac('sha256', env.ENGAGEMENT_WEBHOOK_SECRET)
    .update(`${timestampHeader}.${rawBody}`)
    .digest('hex')

  const given = signatureHeader.trim().replace(/^sha256=/i, '')
  // Length is compared first because timingSafeEqual throws on a mismatch, and
  // a thrown error is itself a timing signal.
  if (given.length !== expected.length) {
    return { ok: false, rejection: 'bad_signature', reason: 'The signature did not match.', method }
  }
  if (!timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'))) {
    return { ok: false, rejection: 'bad_signature', reason: 'The signature did not match.', method }
  }

  return { ok: true, method }
}

/**
 * Provider event names we accept, mapped to our own whitelist.
 *
 * Deliberately partial. A provider event with no mapping is REJECTED rather
 * than stored under a generic type: an unrecognised string in the event column
 * is worse than a counted rejection, because it looks like data.
 */
export const PROVIDER_EVENT_MAP: Record<string, EngagementEventType> = {
  sent: 'email_sent',
  delivered: 'email_delivered',
  open: 'email_opened',
  opened: 'email_opened',
  click: 'email_clicked',
  clicked: 'email_clicked',
  bounce: 'email_bounced',
  bounced: 'email_bounced',
  dropped: 'email_bounced',
  unsubscribe: 'email_unsubscribed',
  unsubscribed: 'email_unsubscribed',
  spamreport: 'email_unsubscribed',
}

export interface ProviderEventPayload {
  /** The provider's own event id. The authority on redelivery. */
  eventId?: string
  event: string
  /** The provider's id for the message, which is how we find the action. */
  messageId?: string
  /** Seconds since epoch, per the provider. */
  timestamp?: number
  [key: string]: unknown
}

export interface MappedEvent {
  ok: boolean
  input?: NormalizeInput
  rejection?: WebhookRejection
  reason?: string
}

/**
 * Turns one provider payload into a normalizable event.
 *
 * The company is resolved SERVER-SIDE, from the outreach action that carries
 * the provider's message id. A `companyId` in the payload is ignored entirely —
 * a provider is authoritative about its own delivery, not about which of our
 * accounts it belongs to.
 */
export async function mapProviderEvent(
  payload: ProviderEventPayload,
  providerName: string,
): Promise<MappedEvent> {
  if (!payload || typeof payload.event !== 'string') {
    return { ok: false, rejection: 'malformed', reason: 'The payload has no event name.' }
  }

  const eventType = PROVIDER_EVENT_MAP[payload.event.toLowerCase()]
  if (!eventType) {
    return { ok: false, rejection: 'unknown_event', reason: `Unrecognised provider event "${payload.event}".` }
  }

  if (!payload.messageId || typeof payload.messageId !== 'string') {
    return { ok: false, rejection: 'unresolvable_reference', reason: 'The payload carries no message reference.' }
  }

  const action = await prisma.outreachAction.findFirst({
    where: { providerMessageId: payload.messageId },
    select: { id: true, tenantId: true, crmCompanyId: true, companyName: true, campaignId: true },
  })

  if (!action) {
    return {
      ok: false,
      rejection: 'unresolvable_reference',
      reason: 'No outreach action matches that message reference.',
    }
  }

  const occurredAt =
    typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)
      ? new Date(payload.timestamp * 1000)
      : null

  return {
    ok: true,
    input: {
      eventType,
      source: 'provider_webhook',
      sourceProvider: providerName,
      // Both resolved from OUR row, never from the payload.
      tenantId: action.tenantId,
      crmCompanyId: action.crmCompanyId,
      outreachActionId: action.id,
      occurredAt,
      providerEventId: typeof payload.eventId === 'string' ? payload.eventId : null,
      evidence: {
        what: `The email provider reported "${payload.event}" for a message sent to a contact at ${
          action.companyName ?? 'this company'
        }.`,
        where: providerName,
        how: 'Received on a signed provider webhook and verified before it was recorded.',
        referenceKind: 'outreach_action',
        referenceId: action.id,
      },
      metadata: {
        providerEvent: payload.event,
        campaignId: action.campaignId,
      },
    },
  }
}
