import { Router } from 'express'
import { z } from 'zod'
import { failStaleEnrichments, requestCompanyEnrichments } from '../../enrichment/companyEnrichment.js'
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

/** How many attempts are scanned to find each company's latest run. */
const MAX_INDEXED_RUNS = 10_000
/** How many companies the register returns. */
const MAX_COMPANIES_LISTED = 500

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

    // De-duplicated, in-flight runs reused, stranded rows failed, enqueue
    // failures recorded — see requestCompanyEnrichments.
    const results = await requestCompanyEnrichments({
      tenantId: p.tenantId,
      crmCompanyIds: [...new Set(ids)].slice(0, MAX_BATCH),
      requestedByCrmUserId: p.crmUserId,
      prospectSearchId: body.prospectSearchId ?? null,
      enqueueJob: (enrichmentId) => enqueue(QUEUE_COMPANY_ENRICH, { enrichmentId }),
    })
    const queued = results.filter((r) => !r.existing && r.status === 'queued')
    const alreadyRunning = results.filter((r) => r.existing)
    const failed = results.filter((r) => r.status === 'failed')

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'enrichment.queued',
      resourceType: 'CompanyEnrichment',
      summary: `${queued.length} company/companies queued for enrichment; ${alreadyRunning.length} already in progress; ${failed.length} could not be queued`,
      requestId: req.requestId,
    })

    // 202: each company involves an outbound fetch, run in the worker.
    res.status(202).json({
      queued: queued.length,
      alreadyInProgress: alreadyRunning.length,
      failedToQueue: failed.length,
      enrichments: results,
    })
  }),
)

enrichmentRoutes.get(
  '/companies/:crmCompanyId',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    // A row stranded in queued/running past the in-flight window is failed on
    // read, so the screen never follows a run nothing is working on.
    await failStaleEnrichments(p.tenantId, [req.params.crmCompanyId!])
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

    const select = {
      id: true,
      crmCompanyId: true,
      companyName: true,
      status: true,
      sourceUrl: true,
      technologies: true,
      technologyCount: true,
      failureReason: true,
      fetchedAt: true,
      createdAt: true,
      finishedAt: true,
    } as const

    // `?view=runs` keeps the old shape: every attempt, newest first, capped.
    if (req.query.view === 'runs') {
      const runs = await prisma.companyEnrichment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, select })
      const byStatus: Record<string, number> = {}
      runs.forEach((r) => (byStatus[r.status] = (byStatus[r.status] ?? 0) + 1))
      return res.json({
        view: 'runs',
        total: runs.length,
        byStatus,
        totalTechnologiesDetected: runs.reduce((s, r) => s + r.technologyCount, 0),
        enrichments: runs,
      })
    }

    // DEFAULT: the LATEST run per company. The register answers "which
    // companies has enrichment worked on", and counting attempts as companies
    // (three runs = "3 companies") — or capping attempts so that companies
    // enriched earlier dropped out of the picker — both answered it wrongly.
    const index = await prisma.companyEnrichment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: MAX_INDEXED_RUNS,
      select: { id: true, crmCompanyId: true },
    })
    const latestIds: string[] = []
    const seen = new Set<string>()
    for (const r of index) {
      if (seen.has(r.crmCompanyId)) continue
      seen.add(r.crmCompanyId)
      latestIds.push(r.id)
      if (latestIds.length >= MAX_COMPANIES_LISTED) break
    }

    const rows = latestIds.length
      ? await prisma.companyEnrichment.findMany({
          where: { tenantId: p.tenantId, id: { in: latestIds } },
          orderBy: { createdAt: 'desc' },
          select,
        })
      : []

    const byStatus: Record<string, number> = {}
    rows.forEach((r) => (byStatus[r.status] = (byStatus[r.status] ?? 0) + 1))

    res.json({
      view: 'latest_per_company',
      total: rows.length,
      companies: rows.length,
      runsConsidered: index.length,
      byStatus,
      totalTechnologiesDetected: rows.reduce((s, r) => s + r.technologyCount, 0),
      enrichments: rows,
    })
  }),
)
