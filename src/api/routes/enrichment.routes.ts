import { Router } from 'express'
import { z } from 'zod'
import { queueCompanyEnrichment } from '../../enrichment/companyEnrichment.js'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_COMPANY_ENRICH } from '../../platform/queue.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// Stage 2 — company enrichment. Read-only against the CRM and the open web.

export const enrichmentRoutes = Router()

// A deliberately small ceiling. Enrichment makes one outbound request per
// company, so a large batch is both slow and a lot of traffic aimed at other
// people's servers. Raising it is a decision, not a default.
const MAX_BATCH = 25

const EnrichBody = z
  .object({
    crmCompanyIds: z.array(z.string().min(1)).min(1).max(MAX_BATCH).optional(),
    prospectSearchId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(MAX_BATCH).optional(),
  })
  .refine((b) => b.crmCompanyIds || b.prospectSearchId, {
    message: 'Provide either crmCompanyIds or prospectSearchId.',
  })

enrichmentRoutes.post(
  '/companies',
  requirePermission('operate'),
  validateBody(EnrichBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof EnrichBody>

    let ids = body.crmCompanyIds ?? []

    // Enriching straight from a Stage 1 result is the normal path: it keeps the
    // enrichment traceable to the search that produced the prospect.
    if (body.prospectSearchId) {
      const search = await prisma.prospectSearch.findFirst({
        where: { id: body.prospectSearchId, tenantId: p.tenantId },
        select: { id: true, snapshotId: true },
      })
      if (!search) throw new NotFoundError('Prospect search not found.')
      if (!search.snapshotId) throw new NotFoundError('That prospect search has no audience snapshot yet.')

      const members = await prisma.audienceMember.findMany({
        where: { snapshotId: search.snapshotId },
        orderBy: [{ score: 'desc' }, { companyName: 'asc' }],
        take: body.limit ?? 10,
        select: { crmCompanyId: true },
      })
      ids = members.map((m) => m.crmCompanyId)
    }

    if (!ids.length) return res.status(400).json({ error: { code: 'bad_request', message: 'No companies to enrich.' } })

    const queued: Array<{ id: string; crmCompanyId: string }> = []
    for (const crmCompanyId of ids.slice(0, MAX_BATCH)) {
      const { id } = await queueCompanyEnrichment({
        tenantId: p.tenantId,
        crmCompanyId,
        requestedByCrmUserId: p.crmUserId,
        prospectSearchId: body.prospectSearchId ?? null,
      })
      await enqueue(QUEUE_COMPANY_ENRICH, { enrichmentId: id })
      queued.push({ id, crmCompanyId })
    }

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'enrichment.queued',
      resourceType: 'CompanyEnrichment',
      summary: `${queued.length} company/companies queued for enrichment`,
      requestId: req.requestId,
    })

    // 202: each company involves an outbound fetch, run in the worker.
    res.status(202).json({ queued: queued.length, enrichments: queued })
  }),
)

enrichmentRoutes.get(
  '/companies/:crmCompanyId',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    // Most recent attempt wins; earlier attempts are retained, not overwritten.
    const row = await prisma.companyEnrichment.findFirst({
      where: { tenantId: p.tenantId, crmCompanyId: req.params.crmCompanyId },
      orderBy: { createdAt: 'desc' },
    })
    if (!row) throw new NotFoundError('No enrichment found for that company.')

    res.json({
      ...row,
      disclaimers: [
        'Technology signals are observed in the fetched page. Each carries the markup that proved it.',
        'An empty technology list means NOT DETECTED, never "no technology in use" — many platforms leave no trace in delivered markup.',
        'Fields marked UNKNOWN could not be verified. They are not absent values.',
        'No model was called in this stage; nothing here is an AI inference.',
      ],
    })
  }),
)

enrichmentRoutes.get(
  '/companies/:crmCompanyId/history',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const rows = await prisma.companyEnrichment.findMany({
      where: { tenantId: p.tenantId, crmCompanyId: req.params.crmCompanyId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        sourceUrl: true,
        technologyCount: true,
        failureReason: true,
        fetchedAt: true,
        createdAt: true,
      },
    })
    res.json({ attempts: rows })
  }),
)

enrichmentRoutes.get(
  '/',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const where = {
      tenantId: p.tenantId,
      ...(typeof req.query.prospectSearchId === 'string'
        ? { prospectSearchId: req.query.prospectSearchId }
        : {}),
    }

    const rows = await prisma.companyEnrichment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        crmCompanyId: true,
        companyName: true,
        status: true,
        sourceUrl: true,
        technologies: true,
        technologyCount: true,
        failureReason: true,
        createdAt: true,
        finishedAt: true,
      },
    })

    const byStatus: Record<string, number> = {}
    rows.forEach((r) => (byStatus[r.status] = (byStatus[r.status] ?? 0) + 1))

    res.json({
      total: rows.length,
      byStatus,
      totalTechnologiesDetected: rows.reduce((s, r) => s + r.technologyCount, 0),
      enrichments: rows,
    })
  }),
)
