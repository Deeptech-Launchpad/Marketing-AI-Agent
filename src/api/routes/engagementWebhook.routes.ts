import { Router, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { env } from '../../config/env.js'
import {
  mapProviderEvent,
  verifySignature,
  type ProviderEventPayload,
  type WebhookRejection,
} from '../../engagement/adapters/emailWebhookAdapter.js'
import { recordBatch, recordIngestionRun } from '../../engagement/store.js'
import { logger } from '../../platform/logger.js'

// TASK #983 — the provider webhook endpoint.
//
// This is the SECOND unauthenticated surface in the platform, after the public
// Workbench, and it is the more dangerous of the two: the Workbench only shows
// things, whereas this writes to an account's history. So it is gated on a
// signature rather than on anything the caller can assert.
//
// WHAT A CALLER CANNOT DO HERE
//
//   Name a company. The company is resolved from the outreach action carrying
//   the provider's message id. A `companyId` in the payload is ignored.
//   Name a tenant. Same resolution, same reason.
//   Invent an event type. Unmapped provider events are rejected and counted.
//   Backdate freely. A provider timestamp is clamped (see normalize.ts).
//   Replay a captured request. The timestamp is inside the signed material and
//   must be within tolerance.
//
// CURRENT STATE: no email provider is configured on this installation, so
// ENGAGEMENT_WEBHOOK_SECRET is empty and this endpoint refuses everything with
// `not_configured`. That is the correct behaviour for a boundary with nothing
// behind it — not an outage, and not a reason to relax the gate.

export const engagementWebhookRoutes = Router()

/** Tighter than the Workbench: a provider batches, a prober does not. */
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.ENGAGEMENT_PUBLIC_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'rate_limited' }),
})

/** HTTP status for each refusal. Deliberately uniform for anything that looks
 * like a forgery, so the endpoint cannot be used to probe what exists. */
const STATUS: Record<WebhookRejection, number> = {
  not_configured: 503,
  missing_signature: 401,
  bad_signature: 401,
  stale_timestamp: 401,
  malformed: 400,
  unknown_event: 202,
  unresolvable_reference: 202,
}

engagementWebhookRoutes.post(
  '/engagement/webhooks/:provider',
  webhookLimiter,
  async (req: Request, res: Response) => {
    const startedAt = Date.now()
    const provider = String(req.params.provider ?? '').slice(0, 40)
    const endpoint = `/engagement/webhooks/${provider}`

    const raw = req.rawBody ?? ''
    const verification = verifySignature(
      raw,
      req.header('x-signature') ?? undefined,
      req.header('x-timestamp') ?? undefined,
    )

    if (!verification.ok) {
      const rejection = verification.rejection ?? 'bad_signature'
      // The refusal is recorded, not just returned. "Someone tried to write
      // events into this account and was turned away" has to be answerable.
      await recordIngestionRun({
        tenantId: null,
        source: 'provider_webhook',
        sourceProvider: provider,
        endpoint,
        verified: false,
        verificationMethod: verification.method,
        received: 1,
        accepted: 0,
        duplicate: 0,
        rejected: 1,
        rejectionReason: verification.reason ?? 'The request could not be verified.',
        rejectionDetail: { [rejection]: 1 },
        durationMs: Date.now() - startedAt,
      })
      logger.warn({ provider, rejection }, 'engagement: webhook rejected')
      res.status(STATUS[rejection]).json({ error: rejection, message: verification.reason })
      return
    }

    // A provider may batch. Both shapes are accepted; neither is trusted.
    const body = req.body as unknown
    const payloads: ProviderEventPayload[] = Array.isArray(body)
      ? (body as ProviderEventPayload[]).slice(0, 200)
      : [body as ProviderEventPayload]

    const mapped = []
    const detail: Record<string, number> = {}
    let rejected = 0

    for (const payload of payloads) {
      const result = await mapProviderEvent(payload, provider)
      if (result.ok && result.input) {
        mapped.push(result.input)
      } else {
        rejected++
        const key = result.rejection ?? 'malformed'
        detail[key] = (detail[key] ?? 0) + 1
      }
    }

    const outcome = await recordBatch(mapped)

    await recordIngestionRun({
      tenantId: mapped[0]?.tenantId ?? null,
      source: 'provider_webhook',
      sourceProvider: provider,
      endpoint,
      verified: true,
      verificationMethod: verification.method,
      received: payloads.length,
      accepted: outcome.accepted,
      duplicate: outcome.duplicate,
      rejected: rejected + outcome.rejected,
      rejectionReason: rejected ? 'Some events could not be mapped or resolved.' : null,
      rejectionDetail: rejected ? detail : null,
      crmCompanyId: mapped[0]?.crmCompanyId ?? null,
      durationMs: Date.now() - startedAt,
    })

    // 200 even with partial rejections: a provider that receives an error
    // retries the whole batch, which would redeliver the events we did accept.
    res.status(200).json({
      received: payloads.length,
      accepted: outcome.accepted,
      duplicate: outcome.duplicate,
      rejected: rejected + outcome.rejected,
      ...(rejected ? { rejectionDetail: detail } : {}),
    })
  },
)
