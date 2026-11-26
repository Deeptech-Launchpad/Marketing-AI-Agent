import { prisma, newId } from './db.js'
import { logger } from './logger.js'

// Append-only audit trail. Nothing here is ever updated or deleted.
//
// dataClass marks whether an event touched customer PII, so "what did the agent
// read about our customers" is answerable without scanning payloads. NXT Sales
// records nothing equivalent; for an autonomous system acting on that data this
// is a baseline requirement.

export type ActorType = 'user' | 'agent' | 'system'
export type DataClass = 'internal' | 'customer_pii'

export interface AuditInput {
  tenantId: string
  actorType: ActorType
  actorCrmUserId?: string | null
  runId?: string | null
  action: string
  resourceType: string
  resourceId?: string | null
  dataClass?: DataClass
  summary?: string | null
  metadata?: Record<string, unknown> | null
  requestId?: string | null
  ip?: string | null
}

/**
 * The audit entry INSIDE a caller's database transaction. Unlike audit() it does not swallow a failure: if the entry cannot be written the
 * error propagates, the transaction rolls back and the change it was meant to record is not made either. Used where "no record, no change"
 * is the rule (a person approving a permanent suppression).
 */
export async function auditInTransaction(tx: { auditEvent: { create(args: { data: Record<string, unknown> }): Promise<unknown> } }, input: AuditInput): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      actorType: input.actorType,
      actorCrmUserId: input.actorCrmUserId ?? null,
      runId: input.runId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      dataClass: input.dataClass ?? 'internal',
      summary: input.summary ?? null,
      metadata: (input.metadata ?? undefined) as never,
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
    },
  })
}

/**
 * Never throws: an audit failure must not take down the operation being
 * audited. It is logged at error level instead, which is loud enough to notice
 * and quiet enough not to cascade.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        id: newId(),
        tenantId: input.tenantId,
        actorType: input.actorType,
        actorCrmUserId: input.actorCrmUserId ?? null,
        runId: input.runId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        dataClass: input.dataClass ?? 'internal',
        summary: input.summary ?? null,
        metadata: (input.metadata ?? undefined) as never,
        requestId: input.requestId ?? null,
        ip: input.ip ?? null,
      },
    })
  } catch (err) {
    logger.error({ err, action: input.action }, 'audit write failed')
  }
}
