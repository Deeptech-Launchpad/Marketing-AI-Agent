import { Prisma } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { startRun } from '../../orchestrator/runner.js'
import { audit } from '../../platform/audit.js'
import { prisma, newId } from '../../platform/db.js'
import { ConflictError, NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_RUN_STEP } from '../../platform/queue.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

export const runRoutes = Router()

const StartRun = z.object({
  campaignId: z.string().optional(),
  objective: z.string().min(1).max(2000),
  // Present so the field is explicit in the API, but Phase 1 accepts only
  // dry_run. A live mode is not expressible anywhere in this codebase.
  mode: z.literal('dry_run').optional(),
})

runRoutes.post(
  '/',
  requirePermission('operate'),
  validateBody(StartRun),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof StartRun>

    let campaignId = body.campaignId
    if (campaignId) {
      const campaign = await prisma.campaign.findFirst({
        where: { id: campaignId, tenantId: p.tenantId },
        select: { id: true },
      })
      if (!campaign) throw new NotFoundError('Campaign not found.')
    } else {
      // Starting a run without a campaign creates one, so "generate
      // infrastructure leads" is a single call rather than two.
      campaignId = newId()
      await prisma.campaign.create({
        data: {
          id: campaignId,
          tenantId: p.tenantId,
          name: body.objective.slice(0, 80),
          objective: body.objective,
          createdByCrmUserId: p.crmUserId,
        },
      })
    }

    const { runId } = await startRun({
      tenantId: p.tenantId,
      campaignId,
      objective: body.objective,
      requestedByCrmUserId: p.crmUserId,
    })

    // 202: the work is queued, not done. The HTTP call returns in milliseconds
    // and the run continues in the worker.
    res.status(202).json({ runId, campaignId, status: 'queued', mode: 'dry_run' })
  }),
)

runRoutes.get(
  '/',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const runs = await prisma.agentRun.findMany({
      where: { tenantId: p.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        campaignId: true,
        objective: true,
        status: true,
        currentStepType: true,
        tokensUsed: true,
        costUsd: true,
        createdAt: true,
        finishedAt: true,
      },
    })
    res.json({ runs })
  }),
)

runRoutes.get(
  '/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.agentRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: {
        steps: {
          orderBy: { seq: 'asc' },
          select: {
            id: true,
            seq: true,
            type: true,
            status: true,
            tokensUsed: true,
            costUsd: true,
            retryCount: true,
            error: true,
            startedAt: true,
            finishedAt: true,
          },
        },
        approvals: { select: { id: true, kind: true, status: true, requestedAt: true } },
      },
    })
    if (!run) throw new NotFoundError('Run not found.')
    res.json(run)
  }),
)

/** Full step detail including inputs, outputs and every tool call made. */
runRoutes.get(
  '/:id/trace',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.agentRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true },
    })
    if (!run) throw new NotFoundError('Run not found.')

    const [steps, toolCalls, llmCalls] = await Promise.all([
      prisma.agentStep.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } }),
      prisma.toolCall.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } }),
      prisma.llmCall.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } }),
    ])

    res.json({
      steps,
      toolCalls,
      llmCalls,
      // Worth stating plainly on the trace: if this is ever non-zero in Phase 1
      // something is wrong with the dispatcher, not with the report.
      writeToolCalls: toolCalls.filter((t) => t.sideEffectClass !== 'read').length,
    })
  }),
)

runRoutes.post(
  '/:id/cancel',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.agentRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true, status: true },
    })
    if (!run) throw new NotFoundError('Run not found.')
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      throw new ConflictError(`Run is already ${run.status}.`)
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'cancelled', finishedAt: new Date() },
    })
    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      runId: run.id,
      action: 'run.cancelled',
      resourceType: 'AgentRun',
      resourceId: run.id,
      requestId: req.requestId,
    })
    res.json({ id: run.id, status: 'cancelled' })
  }),
)

/**
 * Re-enqueues a run; it resumes from its last COMPLETED step, so nothing
 * already done is redone. `running` is accepted as well as `failed`: a run can
 * be stranded in `running` if a worker died between pg-boss exhausting its
 * retries, and this is the manual escape hatch for that.
 */
runRoutes.post(
  '/:id/retry',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.agentRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true, status: true },
    })
    if (!run) throw new NotFoundError('Run not found.')
    if (!['failed', 'running'].includes(run.status)) {
      throw new ConflictError(`Cannot retry a run that is ${run.status}.`)
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'running', error: Prisma.DbNull },
    })
    await enqueue(QUEUE_RUN_STEP, { runId: run.id })
    res.status(202).json({ id: run.id, status: 'running' })
  }),
)
