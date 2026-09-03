import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_PROSPECT_DISCOVER } from '../../platform/queue.js'
import { startProspectSearch } from '../../prospects/prospectDiscovery.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// Stage 1 — prospect discovery. Read-only against the CRM throughout.

export const prospectRoutes = Router()

const StartSearch = z.object({
  objective: z.string().min(1).max(2000),
})

prospectRoutes.post(
  '/searches',
  requirePermission('operate'),
  validateBody(StartSearch),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const { objective } = req.body as z.infer<typeof StartSearch>

    const { id } = await startProspectSearch({
      tenantId: p.tenantId,
      objective,
      requestedByCrmUserId: p.crmUserId,
    })
    await enqueue(QUEUE_PROSPECT_DISCOVER, { searchId: id })

    // 202: parsing, concept mapping and a full CRM export run in the worker.
    res.status(202).json({ id, status: 'queued' })
  }),
)

prospectRoutes.get(
  '/searches',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const searches = await prisma.prospectSearch.findMany({
      where: { tenantId: p.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        objective: true,
        status: true,
        totalMatched: true,
        totalReturned: true,
        mappingStatus: true,
        requiresApproval: true,
        createdAt: true,
        finishedAt: true,
      },
    })
    res.json({ searches })
  }),
)

prospectRoutes.get(
  '/searches/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const search = await prisma.prospectSearch.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
    })
    if (!search) throw new NotFoundError('Prospect search not found.')

    const parsed = search.parsed as { statedNeedHypothesis?: string | null } | null

    res.json({
      ...search,
      // Restated on every read so it cannot be lost by a client that renders
      // only the prospect list.
      disclaimers: [
        'Every prospect is an existing NXT Sales company record. None were generated or sourced externally.',
        parsed?.statedNeedHypothesis
          ? `The stated need ("${parsed.statedNeedHypothesis}") is an UNVERIFIED hypothesis. No prospect has been checked against it.`
          : 'No problem or need has been attributed to any prospect.',
        search.requiresApproval
          ? 'The targeting concept did not map cleanly onto CRM industry values. This list rests on an unconfirmed interpretation and needs review.'
          : 'The targeting concept mapped cleanly onto CRM industry values.',
      ],
    })
  }),
)

/** The prospect list itself, with the reason each company was selected. */
prospectRoutes.get(
  '/searches/:id/prospects',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const search = await prisma.prospectSearch.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true, snapshotId: true, status: true, totalReturned: true },
    })
    if (!search) throw new NotFoundError('Prospect search not found.')
    if (!search.snapshotId) {
      return res.json({ status: search.status, prospects: [], note: 'No snapshot yet — the search has not completed.' })
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
    const offset = Math.max(Number(req.query.offset) || 0, 0)

    const [prospects, total] = await Promise.all([
      prisma.audienceMember.findMany({
        where: { snapshotId: search.snapshotId },
        orderBy: [{ score: 'desc' }, { companyName: 'asc' }],
        skip: offset,
        take: limit,
        select: {
          crmCompanyId: true,
          companyName: true,
          domain: true,
          industry: true,
          country: true,
          ownerCrmUserId: true,
          includeReason: true,
          score: true,
        },
      }),
      prisma.audienceMember.count({ where: { snapshotId: search.snapshotId } }),
    ])

    res.json({ status: search.status, total, limit, offset, prospects })
  }),
)
