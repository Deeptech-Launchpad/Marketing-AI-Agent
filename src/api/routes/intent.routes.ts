import { Router } from 'express'
import { z } from 'zod'
import { accountUsage, apifyAvailable } from '../../intent/apifyClient.js'
import { queueIntentDetection } from '../../intent/intentDetection.js'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_INTENT_DETECT } from '../../platform/queue.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// Stage 3 — intent detection. Read-only against the CRM and the open web.
// No outreach, no CRM write-back, no publishing.

export const intentRoutes = Router()

// Small on purpose: one of the providers bills per result, and a large batch
// is real money aimed at someone else's servers. Raising it is a decision.
const MAX_BATCH = 20

const DetectBody = z
  .object({
    crmCompanyIds: z.array(z.string().min(1)).min(1).max(MAX_BATCH).optional(),
    prospectSearchId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(MAX_BATCH).optional(),
  })
  .refine((b) => b.crmCompanyIds || b.prospectSearchId, {
    message: 'Provide either crmCompanyIds or prospectSearchId.',
  })

intentRoutes.post(
  '/detect',
  requirePermission('operate'),
  validateBody(DetectBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof DetectBody>

    let ids = body.crmCompanyIds ?? []

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

    if (!ids.length) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'No companies to process.' } })
    }

    const queued: Array<{ id: string; crmCompanyId: string }> = []
    for (const crmCompanyId of ids.slice(0, MAX_BATCH)) {
      const { id } = await queueIntentDetection({
        tenantId: p.tenantId,
        crmCompanyId,
        requestedByCrmUserId: p.crmUserId,
        prospectSearchId: body.prospectSearchId ?? null,
      })
      await enqueue(QUEUE_INTENT_DETECT, { intentRunId: id })
      queued.push({ id, crmCompanyId })
    }

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'intent.queued',
      resourceType: 'IntentDetectionRun',
      summary: `${queued.length} company/companies queued for intent detection`,
      requestId: req.requestId,
    })

    // Remaining external credit, surfaced before a batch is paid for.
    const usage = await accountUsage()

    res.status(202).json({
      queued: queued.length,
      runs: queued,
      apify: {
        ...apifyAvailable(),
        ...(usage ? { usedUsd: usage.usedUsd, limitUsd: usage.limitUsd } : {}),
      },
    })
  }),
)

intentRoutes.get(
  '/runs/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.intentDetectionRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: { signals: { orderBy: { detectedAt: 'desc' } } },
    })
    if (!run) throw new NotFoundError('Intent detection run not found.')
    res.json(run)
  }),
)

intentRoutes.get(
  '/runs',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const runs = await prisma.intentDetectionRun.findMany({
      where: {
        tenantId: p.tenantId,
        ...(typeof req.query.prospectSearchId === 'string'
          ? { prospectSearchId: req.query.prospectSearchId }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        crmCompanyId: true,
        companyName: true,
        status: true,
        signalCount: true,
        duplicatesCollapsed: true,
        costUsd: true,
        failureReason: true,
        createdAt: true,
        completedAt: true,
      },
    })

    const byStatus: Record<string, number> = {}
    runs.forEach((r) => (byStatus[r.status] = (byStatus[r.status] ?? 0) + 1))

    res.json({
      total: runs.length,
      byStatus,
      totalSignals: runs.reduce((s, r) => s + r.signalCount, 0),
      totalCostUsd: runs.reduce((s, r) => s + Number(r.costUsd), 0),
      runs,
    })
  }),
)

/** All signals for one company, newest first. */
intentRoutes.get(
  '/companies/:crmCompanyId/signals',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const signals = await prisma.intentSignal.findMany({
      where: {
        tenantId: p.tenantId,
        crmCompanyId: req.params.crmCompanyId,
        ...(typeof req.query.category === 'string' ? { signalCategory: req.query.category } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      take: 200,
    })

    const byCategory: Record<string, number> = {}
    const byPolarity: Record<string, number> = {}
    signals.forEach((s) => {
      byCategory[s.signalCategory] = (byCategory[s.signalCategory] ?? 0) + 1
      byPolarity[s.polarity] = (byPolarity[s.polarity] ?? 0) + 1
    })

    res.json({
      crmCompanyId: req.params.crmCompanyId,
      total: signals.length,
      byCategory,
      byPolarity,
      signals,
      disclaimers: [
        'These are SIGNALS, not a conclusion. They indicate what evidence exists, not that the company needs any particular solution.',
        'There is deliberately no composite intent score at this stage; scoring is a later stage.',
        'Confidence describes EVIDENCE QUALITY only, computed by deterministic rules — not by a model.',
        'A negative signal (suppression, open opportunity, existing customer) overrides positive ones for outreach purposes.',
        'An absent signal means NOT DETECTED, never that the underlying thing is not happening.',
      ],
    })
  }),
)

/** Full evidence behind one signal, including corroborating sources. */
intentRoutes.get(
  '/signals/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const signal = await prisma.intentSignal.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: {
        run: {
          select: { id: true, companyName: true, status: true, providerResults: true, completedAt: true },
        },
      },
    })
    if (!signal) throw new NotFoundError('Signal not found.')

    res.json({
      ...signal,
      evidenceChain: {
        whatHappened: signal.summary,
        whereFound: signal.sourceUrl ?? `${signal.sourceType} (no URL — internal record)`,
        whenObserved: signal.observedAt
          ? `${signal.observedAt.toISOString()} (${signal.ageDays} days ago, ${signal.freshness})`
          : 'Source provided no date — freshness unknown, confidence demoted.',
        whyItMayIndicateNeed: signal.interpretation,
        howStrong: `${signal.confidence} — ${((signal.confidenceReasons ?? []) as string[]).join(' ')}`,
        rawEvidence: signal.evidence,
        corroboration: signal.corroboratingEvidence ?? [],
      },
    })
  }),
)
