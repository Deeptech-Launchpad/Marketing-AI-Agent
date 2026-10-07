import { Router } from 'express'
import { z } from 'zod'
import { accountUsage, apifyAvailable } from '../../intent/apifyClient.js'
import { failStaleIntentRuns, queueIntentDetection, RUN_IN_FLIGHT_MS } from '../../intent/intentDetection.js'
import { presentSignal, presentSignals } from '../../intent/signalView.js'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, INTENT_JOB_EXPIRE_SECONDS, QUEUE_INTENT_DETECT } from '../../platform/queue.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// Stage 3 — intent detection. Read-only against the CRM and the open web.
// No outreach, no CRM write-back, no publishing.

export const intentRoutes = Router()

type QueuedRun = { id: string; crmCompanyId: string; reused?: true; failed?: true; failureReason?: string }

/**
 * Queues one run per DISTINCT company, never a second one while the first is
 * in flight.
 *
 * Three runs for one company inside three seconds were observed live: a double
 * click, a retry, a second tab. Each ran every provider again and wrote every
 * signal again. A company with a queued or running run created inside the
 * in-flight window gets that run back instead of a new one.
 *
 * A run whose job could not be put on the queue is marked failed immediately,
 * with the reason, rather than left `queued` for ever with nothing to pick it up.
 */
export async function queueRunsFor(input: {
  tenantId: string
  requestedByCrmUserId: string
  prospectSearchId: string | null
  crmCompanyIds: string[]
  now?: Date
}): Promise<{ queued: QueuedRun[]; reused: QueuedRun[]; failed: QueuedRun[] }> {
  const queued: QueuedRun[] = []
  const reused: QueuedRun[] = []
  const failed: QueuedRun[] = []
  const now = input.now ?? new Date()
  const distinct = [...new Set(input.crmCompanyIds.map((id) => id.trim()).filter(Boolean))].slice(0, MAX_BATCH)
  await failStaleIntentRuns(input.tenantId, now)

  for (const crmCompanyId of distinct) {
    const inFlight = await prisma.intentDetectionRun.findFirst({
      where: {
        tenantId: input.tenantId,
        crmCompanyId,
        status: { in: ['queued', 'running'] },
        createdAt: { gte: new Date(now.getTime() - RUN_IN_FLIGHT_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (inFlight) {
      reused.push({ id: inFlight.id, crmCompanyId, reused: true })
      continue
    }

    const { id } = await queueIntentDetection({
      tenantId: input.tenantId,
      crmCompanyId,
      requestedByCrmUserId: input.requestedByCrmUserId,
      prospectSearchId: input.prospectSearchId,
    })
    try {
      await enqueue(QUEUE_INTENT_DETECT, { intentRunId: id }, { expireInSeconds: INTENT_JOB_EXPIRE_SECONDS })
      queued.push({ id, crmCompanyId })
    } catch (err) {
      const reason = `The run could not be put on the job queue: ${(err as Error).message ?? 'unknown error'}`.slice(0, 500)
      await prisma.intentDetectionRun
        .update({
          where: { id },
          data: { status: 'failed', failureReason: reason, completedAt: new Date() },
        })
        .catch(() => undefined)
      failed.push({ id, crmCompanyId, failed: true, failureReason: reason })
    }
  }

  return { queued, reused, failed }
}

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

    const { queued, reused, failed } = await queueRunsFor({
      tenantId: p.tenantId,
      requestedByCrmUserId: p.crmUserId,
      prospectSearchId: body.prospectSearchId ?? null,
      crmCompanyIds: ids,
    })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'intent.queued',
      resourceType: 'IntentDetectionRun',
      summary:
        `${queued.length} company/companies queued for intent detection` +
        (reused.length ? `, ${reused.length} already in flight` : '') +
        (failed.length ? `, ${failed.length} could not be queued` : ''),
      requestId: req.requestId,
    })

    // Remaining external credit, surfaced before a batch is paid for.
    const usage = await accountUsage()

    res.status(202).json({
      queued: queued.length,
      // Every run the request resolved to: newly queued, or the one already in
      // flight for that company (reused: true), or one that could not be put on
      // the queue and was marked failed (failed: true).
      runs: [...queued, ...reused, ...failed],
      reused: reused.length,
      failed: failed.length,
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
    await failStaleIntentRuns(p.tenantId)
    const run = await prisma.intentDetectionRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: { signals: { orderBy: { detectedAt: 'desc' } } },
    })
    if (!run) throw new NotFoundError('Intent detection run not found.')
    // Age and status as of now, not as of detection.
    const now = new Date()
    res.json({ ...run, signals: presentSignals(run.signals, now) })
  }),
)

intentRoutes.get(
  '/runs',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    await failStaleIntentRuns(p.tenantId)
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
      // A SUM OVER RUNS, not a count of distinct signals: a company run three
      // times contributes its signals three times. Named for what it is; the
      // per-company signals endpoint gives the distinct count.
      signalObservationsAcrossRuns: runs.reduce((s, r) => s + r.signalCount, 0),
      /** @deprecated same figure as signalObservationsAcrossRuns; kept for existing readers. */
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
    const storedRows = await prisma.intentSignal.findMany({
      where: {
        tenantId: p.tenantId,
        crmCompanyId: req.params.crmCompanyId,
        ...(typeof req.query.category === 'string' ? { signalCategory: req.query.category } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      // Read wider than the page, because earlier runs stored the same event
      // repeatedly and those copies collapse to one row below.
      take: 1000,
    })

    // One row per event (the most recently seen), with age and status computed
    // now. Stored copies from before in-place refresh are kept in the table and
    // reported as a number, never counted as separate signals.
    const signals = presentSignals(storedRows).slice(0, 200)

    const byCategory: Record<string, number> = {}
    const byPolarity: Record<string, number> = {}
    signals.forEach((s) => {
      byCategory[s.signalCategory] = (byCategory[s.signalCategory] ?? 0) + 1
      byPolarity[s.polarity] = (byPolarity[s.polarity] ?? 0) + 1
    })

    res.json({
      crmCompanyId: req.params.crmCompanyId,
      // Distinct events. `storedRows` is how many rows the table holds for
      // them, which is larger wherever an event was recorded more than once.
      total: signals.length,
      storedRows: storedRows.length,
      byStatus: signals.reduce<Record<string, number>>((acc, s) => {
        acc[s.status] = (acc[s.status] ?? 0) + 1
        return acc
      }, {}),
      byCategory,
      byPolarity,
      signals,
      disclaimers: [
        'These are SIGNALS, not a conclusion. They indicate what evidence exists, not that the company needs any particular solution.',
        'There is deliberately no composite intent score at this stage; scoring is a later stage.',
        'Confidence describes EVIDENCE QUALITY only, computed by deterministic rules — not by a model.',
        'A negative signal (suppression, open opportunity, existing customer) overrides positive ones for outreach purposes — but only while it is active.',
        'A signal a later run observed to be false is marked expired and carries the observation that overtook it. It is kept, because the record that it was once true is itself a fact, and it no longer counts against the company.',
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
    const stored = await prisma.intentSignal.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: {
        run: {
          select: { id: true, companyName: true, status: true, providerResults: true, completedAt: true },
        },
      },
    })
    if (!stored) throw new NotFoundError('Signal not found.')
    const signal = presentSignal(stored)

    res.json({
      ...signal,
      evidenceChain: {
        whatHappened: signal.summary,
        whereFound: signal.sourceUrl ?? `${signal.sourceType} (no URL — internal record)`,
        whenObserved: signal.observedAt
          ? `${signal.observedAt.toISOString()} (${signal.ageDays} days ago, ${signal.freshness})`
          : 'Source provided no date — freshness unknown, confidence demoted.',
        whyItMayIndicateNeed: signal.interpretation,
        // How a seller could open on it. Stated separately from
        // whyItMayIndicateNeed because one is about the company and the other
        // is about our words, and a reader is entitled to reject the second
        // without doubting the first.
        outreachAngle: signal.outreachAngle,
        howStrong: `${signal.confidence} — ${((signal.confidenceReasons ?? []) as string[]).join(' ')}`,
        rawEvidence: signal.evidence,
        corroboration: signal.corroboratingEvidence ?? [],
      },
    })
  }),
)
