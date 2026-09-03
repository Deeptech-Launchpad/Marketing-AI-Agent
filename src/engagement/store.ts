import { Prisma } from '@prisma/client'
import { newId, prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { requestRescore } from '../intentscore/trigger.js'
import { normalize, type NormalizeInput } from './normalize.js'
import { isKnownEventType, type EngagementSourceKind, type ProcessingStatus } from './types.js'

// TASK #983 — writing one observed act down, exactly once.
//
// Recording is idempotent by construction rather than by checking first. The
// dedupe key carries a unique constraint and the insert is a `createMany` with
// `skipDuplicates`, so the database decides whether this act is already known.
// A read-then-write would race two concurrent page loads into two rows, which
// is exactly the failure this stage exists to prevent.
//
// `skipDuplicates` rather than catching the constraint violation: a duplicate
// is the NORMAL case here — a refresh, a redelivered webhook, a repeated
// backfill — and an exception-driven path makes every one of them surface as a
// database error in the logs, which trains people to ignore real ones.
//
// Nothing here scores, ranks or classifies. The only judgement is the dedupe
// policy, and that is declared in types.ts where it can be read and argued
// with.

export interface RecordResult {
  status: ProcessingStatus
  eventId: string | null
  /** Present when the act was already recorded. */
  existingEventId?: string | null
  reason?: string
}

export interface RecordRejection {
  status: 'rejected'
  eventId: null
  reason: string
}

/**
 * Records one normalized event.
 *
 * Returns `duplicate` rather than throwing when the act is already known: a
 * repeated webhook delivery and a browser refresh are both normal, not errors.
 */
export async function recordEvent(input: NormalizeInput, now = new Date()): Promise<RecordResult> {
  if (!isKnownEventType(input.eventType)) {
    return { status: 'rejected', eventId: null, reason: `Unknown event type "${input.eventType}".` }
  }

  const { event, freshnessLabel, ageHours, receivedAt, timestampNote } = normalize(input, now)

  const id = newId()
  const row = {
    id,
    tenantId: event.tenantId,
    crmCompanyId: event.crmCompanyId,
    eventType: event.eventType,
    channel: event.channel,
    source: event.source,
    sourceProvider: event.sourceProvider,
    occurredAt: event.occurredAt,
    receivedAt,
    freshnessLabel,
    ageHours,
    timestampNote,
    sessionRef: event.sessionRef,
    providerEventId: event.providerEventId,
    workbenchDemoId: event.workbenchDemoId,
    outreachActionId: event.outreachActionId,
    auditRunId: event.auditRunId,
    dedupeKey: event.dedupeKey,
    processingStatus: 'recorded',
    evidence: event.evidence as unknown as Prisma.InputJsonValue,
    metadata: event.metadata as unknown as Prisma.InputJsonValue,
  }

  try {
    const { count } = await prisma.engagementEvent.createMany({ data: [row], skipDuplicates: true })
    if (count === 1) {
      // TASK #984: hand off to the scoring queue. This is an enqueue and
      // nothing more — no weights, no arithmetic, no score is touched here, so
      // Task #983 stays a record of what happened rather than an interpretation
      // of it. A duplicate deliberately does NOT trigger a rescore: nothing new
      // was observed, so nothing can have changed.
      await requestRescore(event.tenantId, event.crmCompanyId)
      return { status: 'recorded', eventId: id }
    }

    // Already known. Return the row we converged on, so a caller that needs to
    // redirect or respond still has an event to cite.
    const existing = await prisma.engagementEvent.findUnique({
      where: { dedupeKey: event.dedupeKey },
      select: { id: true },
    })
    return {
      status: 'duplicate',
      eventId: null,
      existingEventId: existing?.id ?? null,
      reason: 'This act was already recorded.',
    }
  } catch (err) {
    // A reference that no longer resolves — a demo deleted mid-request — must
    // not lose the event. Retry once without the optional relations, keeping
    // the identifiers in the evidence where they are still readable.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      logger.warn(
        { eventType: event.eventType, crmCompanyId: event.crmCompanyId },
        'engagement: dangling reference, recording event without relations',
      )
      try {
        const { count } = await prisma.engagementEvent.createMany({
          data: [
            {
              ...row,
              workbenchDemoId: null,
              outreachActionId: null,
              auditRunId: null,
              evidence: {
                ...event.evidence,
                how: `${event.evidence.how} (reference no longer resolves)`,
              } as unknown as Prisma.InputJsonValue,
            },
          ],
          skipDuplicates: true,
        })
        if (count === 1) {
          await requestRescore(event.tenantId, event.crmCompanyId)
          return { status: 'recorded', eventId: id }
        }
        return { status: 'duplicate', eventId: null, reason: 'This act was already recorded.' }
      } catch {
        return { status: 'rejected', eventId: null, reason: 'The referenced record no longer exists.' }
      }
    }

    throw err
  }
}

export interface IngestionRunInput {
  tenantId: string | null
  source: EngagementSourceKind
  sourceProvider?: string | null
  endpoint?: string | null
  verified: boolean
  verificationMethod?: string | null
  received: number
  accepted: number
  duplicate: number
  rejected: number
  rejectionReason?: string | null
  rejectionDetail?: Record<string, number> | null
  crmCompanyId?: string | null
  durationMs: number
}

/**
 * Records what happened at an ingestion boundary — including what was refused.
 *
 * Never throws. A boundary that fails to write its own audit row must still
 * return the right answer to the caller; losing the audit line is bad, losing
 * the rejection is worse.
 */
export async function recordIngestionRun(input: IngestionRunInput): Promise<void> {
  try {
    await prisma.engagementIngestionRun.create({
      data: {
        id: newId(),
        tenantId: input.tenantId,
        source: input.source,
        sourceProvider: input.sourceProvider ?? null,
        endpoint: input.endpoint ?? null,
        verified: input.verified,
        verificationMethod: input.verificationMethod ?? null,
        received: input.received,
        accepted: input.accepted,
        duplicate: input.duplicate,
        rejected: input.rejected,
        rejectionReason: input.rejectionReason ?? null,
        rejectionDetail: (input.rejectionDetail ?? undefined) as unknown as Prisma.InputJsonValue,
        crmCompanyId: input.crmCompanyId ?? null,
        durationMs: input.durationMs,
      },
    })
  } catch (err) {
    logger.error({ err, source: input.source }, 'engagement: failed to record ingestion run')
  }
}

/**
 * Records several events from one source, reporting per-event outcomes.
 *
 * Sequential on purpose: a provider batch is small, and concurrent inserts of
 * events sharing a dedupe key would produce a spread of P2002s that is harder
 * to report honestly than it is worth.
 */
export async function recordBatch(
  inputs: NormalizeInput[],
  now = new Date(),
): Promise<{ accepted: number; duplicate: number; rejected: number; results: RecordResult[] }> {
  const results: RecordResult[] = []
  let accepted = 0
  let duplicate = 0
  let rejected = 0

  for (const input of inputs) {
    const result = await recordEvent(input, now)
    results.push(result)
    if (result.status === 'recorded') accepted++
    else if (result.status === 'duplicate') duplicate++
    else rejected++
  }

  return { accepted, duplicate, rejected, results }
}
