import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_COMPANY_WEB_DISCOVER } from '../../platform/queue.js'
import { startCompanyWebDiscovery, MAX_CANDIDATES_HARD_CAP } from '../../prospects/companyWebDiscovery.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// Stage 1b — open-web company discovery ("Find New Company"). Additive to
// Stage 1 prospecting. Each company found is checked against NXT Sales (read
// only); adding one to NXT Sales is a separate, explicit action
// (crmLeads.routes.ts).

export const companyDiscoveryRoutes = Router()

const StartSearch = z.object({
  objective: z.string().min(1).max(2000),
  requestedCount: z.number().int().min(1).max(MAX_CANDIDATES_HARD_CAP).optional(),
})

companyDiscoveryRoutes.post(
  '/searches',
  requirePermission('operate'),
  validateBody(StartSearch),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const { objective, requestedCount } = req.body as z.infer<typeof StartSearch>

    if (!env.COMPANY_WEB_DISCOVERY_ENABLED) {
      return res.status(409).json({
        error: {
          code: 'feature_disabled',
          message: 'Open-web company discovery is not enabled on this platform yet.',
        },
      })
    }

    const { id } = await startCompanyWebDiscovery({
      tenantId: p.tenantId,
      objective,
      requestedCount: requestedCount ?? null,
      requestedByCrmUserId: p.crmUserId,
    })

    try {
      await enqueue(QUEUE_COMPANY_WEB_DISCOVER, { searchId: id })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await prisma.companyDiscoverySearch
        .update({
          where: { id },
          data: {
            status: 'failed',
            failureReason: `The search could not be handed to the worker queue, so it never ran: ${reason}`,
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined)
      throw err
    }

    // 202: the actual search and every page fetch run in the worker.
    res.status(202).json({ id, status: 'queued' })
  }),
)

companyDiscoveryRoutes.get(
  '/searches',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    // The signed-in user's own search history (2026-09-25).
    const searches = await prisma.companyDiscoverySearch.findMany({
      where: { tenantId: p.tenantId, requestedByCrmUserId: p.crmUserId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        objective: true,
        requestedCount: true,
        status: true,
        totalCandidatesFound: true,
        totalAssessed: true,
        failureReason: true,
        createdAt: true,
        finishedAt: true,
      },
    })
    res.json({ searches })
  }),
)

companyDiscoveryRoutes.get(
  '/searches/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const search = await prisma.companyDiscoverySearch.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
    })
    if (!search) throw new NotFoundError('Company discovery search not found.')

    res.json({
      ...search,
      disclaimers: [
        'Every company was found via a public web search and verified by fetching its own site. None were invented.',
        'Each company’s need for the service is judged from one genuine individual product on its own website — its description, attributes, values and structure — not from a website audit.',
        'A company whose page, website or product page could not be read is still listed, with the reason, rather than silently dropped.',
        search.status === 'failed'
          ? 'This search did not complete, so no company list was produced.'
          : 'Each fit assessment states only what the fetched page supports — it is a read of that one page, not a verified fact about the company.',
      ],
    })
  }),
)

/**
 * Removes one search from the user's history.
 *
 * Only the user's own search. The companies it found are kept — detached from
 * the search, not deleted — because one of them may already have been carried
 * into Enrichment, Intent or Outreach, whose records refer to it.
 */
companyDiscoveryRoutes.delete(
  '/searches/:id',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const search = await prisma.companyDiscoverySearch.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId, requestedByCrmUserId: p.crmUserId },
      select: { id: true, objective: true, status: true },
    })
    if (!search) throw new NotFoundError('Company discovery search not found in your history.')
    if (search.status === 'queued' || search.status === 'running') {
      return res.status(409).json({
        error: { code: 'search_in_progress', message: 'This search is still running. Delete it once it has finished.' },
      })
    }

    await prisma.companyDiscoverySearch.delete({ where: { id: search.id } })
    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'company_web_discovery.deleted',
      resourceType: 'CompanyDiscoverySearch',
      resourceId: search.id,
      summary: search.objective,
      requestId: req.requestId,
    })
    res.status(204).end()
  }),
)

/** The candidates themselves, each traceable to the page it was read from. */
companyDiscoveryRoutes.get(
  '/searches/:id/companies',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const search = await prisma.companyDiscoverySearch.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true, status: true },
    })
    if (!search) throw new NotFoundError('Company discovery search not found.')

    const companies = await prisma.discoveredCompany.findMany({
      where: { tenantId: p.tenantId, searchId: search.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        companyName: true,
        domain: true,
        websiteUrl: true,
        websiteSummary: true,
        fitAssessment: true,
        discoverySourceUrl: true,
        discoverySourceTitle: true,
        productPageUrl: true,
        productAnalysis: true,
        serviceNeed: true,
        status: true,
        crmCompanyId: true,
        crmCheckedAt: true,
        crmMatchedOn: true,
        crmCheckNote: true,
        crmCreatedAt: true,
        createdAt: true,
      },
    })
    res.json({ status: search.status, companies })
  }),
)
