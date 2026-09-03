import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../../platform/audit.js'
import { prisma, newId } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

export const campaignRoutes = Router()

const CreateCampaign = z.object({
  name: z.string().min(1).max(200),
  objective: z.string().min(1).max(2000),
  constraints: z.record(z.unknown()).optional(),
})

campaignRoutes.post(
  '/',
  requirePermission('operate'),
  validateBody(CreateCampaign),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const id = newId()
    const body = req.body as z.infer<typeof CreateCampaign>

    await prisma.campaign.create({
      data: {
        id,
        tenantId: p.tenantId,
        name: body.name,
        objective: body.objective,
        createdByCrmUserId: p.crmUserId,
        constraints: (body.constraints ?? undefined) as never,
      },
    })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'campaign.created',
      resourceType: 'Campaign',
      resourceId: id,
      summary: body.name,
      requestId: req.requestId,
    })

    res.status(201).json({ id, name: body.name, objective: body.objective, status: 'draft' })
  }),
)

campaignRoutes.get(
  '/',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const campaigns = await prisma.campaign.findMany({
      where: { tenantId: p.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, name: true, objective: true, status: true, createdAt: true },
    })
    res.json({ campaigns })
  }),
)

campaignRoutes.get(
  '/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    // Scoped by tenantId in the WHERE, so another tenant's id reads as absent
    // rather than forbidden — the API never confirms that an id exists
    // somewhere the caller cannot see.
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, currentStepType: true, createdAt: true },
        },
        strategies: { orderBy: { version: 'desc' }, take: 1 },
      },
    })
    if (!campaign) throw new NotFoundError('Campaign not found.')
    res.json(campaign)
  }),
)

campaignRoutes.get(
  '/:id/assets',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true },
    })
    if (!campaign) throw new NotFoundError('Campaign not found.')

    const assets = await prisma.asset.findMany({
      where: { campaignId: campaign.id },
      include: { versions: { orderBy: [{ version: 'desc' }, { variantLabel: 'asc' }] } },
    })
    res.json({ assets })
  }),
)

/**
 * The Phase 1 deliverable: everything a human needs to judge and hand off the
 * campaign, including how it was produced and what it cost. Nothing here has
 * been published — that is stated in the payload, not just in the docs.
 */
campaignRoutes.get(
  '/:id/package',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!

    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: {
        strategies: { orderBy: { version: 'desc' }, take: 1 },
        assets: { include: { versions: { orderBy: [{ version: 'desc' }, { variantLabel: 'asc' }] } } },
        approvals: {
          select: {
            id: true,
            kind: true,
            status: true,
            payloadHash: true,
            decidedByCrmUserId: true,
            decidedAt: true,
            comment: true,
          },
        },
        runs: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    if (!campaign) throw new NotFoundError('Campaign not found.')

    const run = campaign.runs[0]
    const steps = run
      ? await prisma.agentStep.findMany({
          where: { runId: run.id },
          orderBy: { seq: 'asc' },
          select: { type: true, status: true, output: true },
        })
      : []

    const outputOf = (type: string) =>
      [...steps].reverse().find((s) => s.type === type && s.status === 'completed')?.output ?? null

    const llmCalls = run
      ? await prisma.llmCall.findMany({
          where: { runId: run.id },
          select: { model: true, totalTokens: true, costUsd: true, priced: true, promptKey: true, promptVersion: true },
        })
      : []

    res.json({
      campaign: {
        id: campaign.id,
        name: campaign.name,
        objective: campaign.objective,
        status: campaign.status,
      },
      intake: outputOf('INTAKE'),
      icpProfile: outputOf('ICP_SYNTHESIS'),
      audience: outputOf('SEGMENT_RESOLVE'),
      research: outputOf('RESEARCH'),
      strategy: campaign.strategies[0] ?? null,
      assets: campaign.assets,
      validation: outputOf('CONTENT_VALIDATE'),
      approvals: campaign.approvals,
      cost: {
        totalTokens: run?.tokensUsed ?? 0,
        totalCostUsd: Number(run?.costUsd ?? 0),
        // False when any model in the run had no published rate — the figure is
        // then an under-estimate and says so, rather than looking complete.
        pricingComplete: llmCalls.length > 0 && llmCalls.every((c) => c.priced),
        calls: llmCalls.length,
      },
      provenance: {
        runId: run?.id ?? null,
        mode: run?.mode ?? null,
        modelsUsed: [...new Set(llmCalls.map((c) => c.model))],
        promptVersions: [...new Set(llmCalls.map((c) => `${c.promptKey}@${c.promptVersion}`))],
      },
      externalEffects: 'none — Phase 1 does not publish, send, or write back to the CRM',
    })
  }),
)
