import { Router } from 'express'
import { z } from 'zod'
import { confirmManualAct, CONFIRMABLE_ACTS } from '../../engagement/adapters/manualAdapter.js'
import { syncOutreachActions } from '../../engagement/adapters/outreachAdapter.js'
import { companyTimeline, demoTimeline, engagementSummary, getEvent } from '../../engagement/timeline.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { ENGAGEMENT_CHANNELS, ENGAGEMENT_EVENT_TYPES } from '../../engagement/types.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// TASK #983 — the internal engagement API.
//
// Read-only over the history, plus one write that lets a person confirm an act
// the platform cannot observe (a LinkedIn message they sent by hand, a call
// they made).
//
// WHAT IS NOT HERE, AND WHY
//
// There is no score, no ranking, no "hot leads" list, no lead-qualification
// verdict, no routing, no alerting and no CRM write-back. Task #983 stops at
// factual engagement data. Every one of those would be an opinion built on top
// of these rows, and building it here would put the opinion and the evidence in
// the same place — which is exactly how a number ends up being trusted because
// it sits next to a fact.
//
// Sorting is by TIME, never by activity volume. A "most engaged accounts"
// endpoint is a ranking with the scoring hidden in the ORDER BY.

export const engagementRoutes = Router()

const Channels = z.enum(ENGAGEMENT_CHANNELS)
const EventTypes = z.enum(ENGAGEMENT_EVENT_TYPES)

const TimelineQuery = z
  .object({
    channel: Channels.optional(),
    eventType: EventTypes.optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict()

/** 1. One company's engagement history, newest act first. */
engagementRoutes.get(
  '/companies/:crmCompanyId/timeline',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const parsed = TimelineQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues })
      return
    }
    const q = parsed.data

    const page = await companyTimeline({
      // Tenant comes from the token, not the path. A caller cannot read another
      // tenant's history by knowing a company id.
      tenantId: p.tenantId,
      crmCompanyId: String(req.params.crmCompanyId),
      channel: q.channel,
      eventType: q.eventType,
      since: q.since ? new Date(q.since) : undefined,
      until: q.until ? new Date(q.until) : undefined,
      limit: q.limit,
      cursor: q.cursor,
    })

    res.json({
      crmCompanyId: req.params.crmCompanyId,
      events: page.entries,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    })
  }),
)

/** 2. Counts and timestamps for one company. Components only — never a total. */
engagementRoutes.get(
  '/companies/:crmCompanyId/summary',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const summary = await engagementSummary(p.tenantId, String(req.params.crmCompanyId))
    res.json({
      ...summary,
      // Stated in the payload so no consumer mistakes the counts for a rating.
      note:
        'These are counts of observed acts and the times they happened. Nothing here is a score, a rating or a ' +
        'qualification. Acts performed by AltiusNXT are reported separately from acts performed by the prospect.',
    })
  }),
)

/** 3. The history of one Workbench demonstration. */
engagementRoutes.get(
  '/workbench/:demoId/timeline',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const demoId = String(req.params.demoId)

    const demo = await prisma.workbenchDemo.findFirst({
      where: { id: demoId, tenantId: p.tenantId },
      select: { id: true, crmCompanyId: true, companyName: true, productName: true },
    })
    if (!demo) throw new NotFoundError('That Workbench demonstration does not exist.')

    const events = await demoTimeline(p.tenantId, demoId)
    res.json({
      demoId: demo.id,
      crmCompanyId: demo.crmCompanyId,
      companyName: demo.companyName,
      productName: demo.productName,
      // Ascending here: a single visit reads as a sequence.
      events,
    })
  }),
)

/** 4. One event, with its full evidence. */
engagementRoutes.get(
  '/events/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const event = await getEvent(p.tenantId, String(req.params.id))
    if (!event) throw new NotFoundError('That engagement event does not exist.')
    res.json(event)
  }),
)

const ConfirmBody = z
  .object({
    act: z.enum(CONFIRMABLE_ACTS as [string, ...string[]]),
    outreachActionId: z.string().min(1),
    note: z.string().max(200).optional(),
    occurredAt: z.string().datetime().optional(),
  })
  .strict()

/**
 * 5. A person confirming an act the platform could not observe.
 *
 * The confirming user is taken from the authenticated session, never from the
 * body — the same rule Task #980 applies to reviewer identity, for the same
 * reason: an attributable record is only attributable if the attribution cannot
 * be supplied by the caller.
 */
engagementRoutes.post(
  '/confirmations',
  requirePermission('operate'),
  validateBody(ConfirmBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof ConfirmBody>

    const result = await confirmManualAct({
      tenantId: p.tenantId,
      crmUserId: p.crmUserId,
      actorName: p.name,
      act: body.act,
      outreachActionId: body.outreachActionId,
      note: body.note ?? null,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : null,
    })

    res.status(result.status === 'recorded' ? 201 : 200).json(result)
  }),
)

const SyncBody = z
  .object({
    campaignId: z.string().min(1).optional(),
    crmCompanyId: z.string().min(1).optional(),
  })
  .strict()

/**
 * 6. Backfill outreach lifecycle events.
 *
 * Idempotent — the lifecycle types deduplicate on the action id — so this is
 * safe to run repeatedly and is how history recorded before Task #983 existed
 * gets into the timeline.
 */
engagementRoutes.post(
  '/sync/outreach',
  requirePermission('operate'),
  validateBody(SyncBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof SyncBody>
    const result = await syncOutreachActions(p.tenantId, {
      campaignId: body.campaignId,
      crmCompanyId: body.crmCompanyId,
    })
    res.json(result)
  }),
)

/** 7. Ingestion boundary history, including what was refused. */
engagementRoutes.get(
  '/ingestion-runs',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200)
    const runs = await prisma.engagementIngestionRun.findMany({
      where: { OR: [{ tenantId: p.tenantId }, { tenantId: null }] },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    res.json({ runs })
  }),
)
