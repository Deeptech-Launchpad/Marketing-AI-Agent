import { env } from '../config/env.js'
import type { ApprovalKind } from '../domain/enums.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../platform/errors.js'
import { enqueue, QUEUE_RUN_STEP } from '../platform/queue.js'
import { computePayloadHash } from './payloadHash.js'

// The two human gates.
//
// This honours a standing rule the project already adopted after a real
// incident (docs/PROJECT_DOCUMENTATION.md §2 rule 9): never execute a real
// external-effect action without explicit per-instance approval. Phase 1 has no
// external effects, so the gate is here to be exercised and trusted before it
// has to hold anything back.

export interface CreateApprovalInput {
  tenantId: string
  runId: string
  stepId: string
  campaignId: string
  kind: ApprovalKind
  payload: unknown
}

export async function createApproval(input: CreateApprovalInput): Promise<{ id: string; payloadHash: string }> {
  const payloadHash = computePayloadHash(input.payload)
  const id = newId()

  await prisma.approval.create({
    data: {
      id,
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.stepId,
      campaignId: input.campaignId,
      kind: input.kind,
      status: 'pending',
      payloadHash,
      payloadSnapshot: input.payload as never,
      expiresAt: new Date(Date.now() + env.APPROVAL_TTL_HOURS * 3_600_000),
    },
  })

  await audit({
    tenantId: input.tenantId,
    actorType: 'agent',
    runId: input.runId,
    action: 'approval.requested',
    resourceType: 'Approval',
    resourceId: id,
    summary: `${input.kind} approval requested`,
  })

  return { id, payloadHash }
}

export type Decision = 'approved' | 'rejected' | 'changes_requested'

export interface DecideInput {
  tenantId: string
  approvalId: string
  decision: Decision
  payloadHash: string
  comment?: string | null
  crmUserId: string
  requestId?: string | null
}

/**
 * Which step a "changes_requested" decision re-enters. The rejected step is
 * never mutated — a new step is created at the regeneration target, carrying
 * the reviewer's comment as input.
 */
const REGENERATION_TARGET: Record<ApprovalKind, string> = {
  strategy: 'STRATEGY',
  content: 'CONTENT_GENERATE',
}

export async function decideApproval(input: DecideInput): Promise<{ status: string; runStatus: string }> {
  const approval = await prisma.approval.findFirst({
    where: { id: input.approvalId, tenantId: input.tenantId },
    include: { run: true },
  })
  if (!approval) throw new NotFoundError('Approval not found.')

  if (approval.status !== 'pending') {
    throw new ConflictError(`This approval is already ${approval.status}.`)
  }
  if (approval.expiresAt.getTime() < Date.now()) {
    await prisma.approval.update({ where: { id: approval.id }, data: { status: 'expired' } })
    await prisma.agentRun.update({
      where: { id: approval.runId },
      data: { status: 'cancelled', finishedAt: new Date() },
    })
    throw new ConflictError('This approval has expired; the run was cancelled.')
  }

  // The decision must reference the payload the reviewer actually saw.
  if (approval.payloadHash !== input.payloadHash) {
    throw new ConflictError(
      'The payload changed since it was shown to you. Re-read the approval and decide again.',
      { expected: approval.payloadHash },
    )
  }

  // Whoever ran the campaign should not be the one signing it off.
  if (!env.ALLOW_SELF_APPROVAL && approval.run.requestedByCrmUserId === input.crmUserId) {
    throw new ForbiddenError(
      'Self-approval is disabled: this run was requested by you. Ask another approver to review it.',
    )
  }

  const now = new Date()
  let runStatus: string

  if (input.decision === 'approved') {
    runStatus = 'running'
  } else if (input.decision === 'rejected') {
    runStatus = 'cancelled'
  } else {
    runStatus = 'running'
  }

  await prisma.$transaction(async (tx) => {
    await tx.approval.update({
      where: { id: approval.id },
      data: {
        status: input.decision,
        decidedByCrmUserId: input.crmUserId,
        decidedAt: now,
        comment: input.comment ?? null,
      },
    })

    await tx.agentStep.update({
      where: { id: approval.stepId },
      data: { status: 'completed', finishedAt: now, output: { decision: input.decision } as never },
    })

    if (input.decision === 'rejected') {
      await tx.agentRun.update({
        where: { id: approval.runId },
        data: { status: 'cancelled', finishedAt: now },
      })
    } else if (input.decision === 'changes_requested') {
      await tx.agentRun.update({
        where: { id: approval.runId },
        data: {
          status: 'running',
          currentStepType: REGENERATION_TARGET[approval.kind as ApprovalKind],
          feedback: input.comment ?? 'Changes requested without a comment.',
        },
      })
    } else {
      await tx.agentRun.update({
        where: { id: approval.runId },
        data: { status: 'running', feedback: null },
      })
    }
  })

  await audit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorCrmUserId: input.crmUserId,
    runId: approval.runId,
    action: `approval.${input.decision}`,
    resourceType: 'Approval',
    resourceId: approval.id,
    summary: input.comment ?? null,
    requestId: input.requestId ?? null,
  })

  // Resume the run. Rejection is terminal, so nothing is enqueued.
  if (input.decision !== 'rejected') {
    await enqueue(QUEUE_RUN_STEP, { runId: approval.runId })
  }

  return { status: input.decision, runStatus }
}
