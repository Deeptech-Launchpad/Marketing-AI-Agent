import { Router } from 'express'
import { z } from 'zod'
import { resolveAudience } from '../../campaign/audienceResolver.js'
import { deriveIcpEvidence } from '../../campaign/icpDeriver.js'
import { getCrm } from '../../crm/index.js'
import { CrmCompanyQuerySchema } from '../../crm/types.js'
import { audit } from '../../platform/audit.js'
import { prisma, newId } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// Segment and ICP endpoints usable on their own, outside a run.
//
// "What does our won-deal data actually say about who buys" is a useful answer
// by itself, before any campaign exists — and it is cheap, because it is
// arithmetic over CRM data with no LLM call at all.

export const segmentRoutes = Router()

segmentRoutes.post(
  '/icp/derive',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const evidence = await deriveIcpEvidence(getCrm())

    const id = newId()
    await prisma.icpProfile.create({
      data: {
        id,
        tenantId: p.tenantId,
        name: `Derived ${new Date().toISOString().slice(0, 10)}`,
        definition: {
          industries: evidence.byIndustry.slice(0, 3).map((f) => f.value),
          countries: evidence.byCountry.slice(0, 3).map((f) => f.value),
          cmsValues: evidence.byCms.slice(0, 3).map((f) => f.value),
        } as never,
        evidence: evidence as never,
        confidence: evidence.totalDeals >= 30 ? 'medium' : 'low',
        sourceDealCount: evidence.totalDeals,
      },
    })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'icp.derived',
      resourceType: 'IcpProfile',
      resourceId: id,
      dataClass: 'customer_pii',
      requestId: req.requestId,
    })

    res.status(201).json({ id, evidence })
  }),
)

segmentRoutes.get(
  '/icp',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const profiles = await prisma.icpProfile.findMany({
      where: { tenantId: p.tenantId },
      orderBy: { derivedAt: 'desc' },
      take: 50,
    })
    res.json({ profiles })
  }),
)

const PreviewBody = z.object({ query: CrmCompanyQuerySchema })

/**
 * Resolves a query against the CRM WITHOUT persisting a snapshot. Lets someone
 * sanity-check filters before committing them to a campaign.
 */
segmentRoutes.post(
  '/preview',
  requirePermission('operate'),
  validateBody(PreviewBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const { query } = req.body as z.infer<typeof PreviewBody>

    const page = await getCrm().exportCompanies(query)

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'segment.previewed',
      resourceType: 'Segment',
      dataClass: 'customer_pii',
      summary: `${page.items.length} companies matched`,
      requestId: req.requestId,
    })

    res.json({
      totalMatched: page.items.length,
      // Suppression is NOT applied here — this is a raw filter check, and
      // saying so avoids the number being mistaken for a sendable audience.
      note: 'Suppression is not applied to a preview. Resolve a segment to get the real included count.',
      sample: page.items.slice(0, 25).map((c) => ({
        id: c.id,
        name: c.name,
        industry: c.industry,
        country: c.country,
        cms: c.cms,
      })),
    })
  }),
)

const ResolveBody = z.object({
  name: z.string().min(1).max(200),
  campaignId: z.string().optional(),
  query: CrmCompanyQuerySchema,
})

segmentRoutes.post(
  '/resolve',
  requirePermission('operate'),
  validateBody(ResolveBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof ResolveBody>

    if (body.campaignId) {
      const campaign = await prisma.campaign.findFirst({
        where: { id: body.campaignId, tenantId: p.tenantId },
        select: { id: true },
      })
      if (!campaign) throw new NotFoundError('Campaign not found.')
    }

    const segmentId = newId()
    await prisma.segment.create({
      data: {
        id: segmentId,
        tenantId: p.tenantId,
        campaignId: body.campaignId ?? null,
        name: body.name,
        definition: body.query as never,
      },
    })

    const result = await resolveAudience({
      tenantId: p.tenantId,
      segmentId,
      campaignId: body.campaignId ?? null,
      query: body.query,
      crm: getCrm(),
    })

    res.status(201).json({ segmentId, ...result })
  }),
)

segmentRoutes.get(
  '/snapshots/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const snapshot = await prisma.audienceSnapshot.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: { members: { orderBy: { score: 'desc' }, take: 500 } },
    })
    if (!snapshot) throw new NotFoundError('Snapshot not found.')
    res.json(snapshot)
  }),
)
