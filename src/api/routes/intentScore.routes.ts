import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import {
  companiesWithEngagement,
  currentBreakdown,
  currentScore,
  listPolicies,
  resolvePolicy,
  scoreCompany,
  scoreHistory,
} from '../../intentscore/service.js'
import { audit } from '../../platform/audit.js'
import { NotFoundError } from '../../platform/errors.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// TASK #984 — the intent score API.
//
// Authenticated, RBAC-gated, tenant-scoped. Reading a score needs `view`;
// forcing a recalculation needs `operate`.
//
// INTERNAL ONLY. Nothing here is mounted on the public router — a prospect who
// holds a Workbench link must never be able to see what we scored them. The
// public surface (Task #981/#983) has no route into this module.
//
// WHAT IS NOT HERE
//
// No CRM write-back, no routing, no SDR or AE alert, no outreach trigger, no
// campaign change, no opportunity creation, and no "hottest accounts" listing.
// A leaderboard is a routing decision wearing a report's clothes, so there is
// no endpoint that sorts companies by score.

export const intentScoreRoutes = Router()

/**
 * Repeated on every response that carries a number.
 *
 * The weights are not business-approved, and a score that travels without that
 * caveat will eventually be treated as though it were.
 */
function caveat(policyStatus: string): string {
  return policyStatus === 'business_approved'
    ? 'Rule-based intent score derived from observed engagement. Not a prediction.'
    : 'Rule-based intent score derived from observed engagement. The scoring weights are a PROVISIONAL DEFAULT and have not been approved by the business. Not a prediction, not a machine-learning score, and not a probability of conversion.'
}

/** 1. The current score for one company. */
intentScoreRoutes.get(
  '/companies/:crmCompanyId',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const crmCompanyId = String(req.params.crmCompanyId)
    const score = await currentScore(p.tenantId, crmCompanyId)

    if (!score) {
      // A company with no score is not an error. Saying so plainly is better
      // than a 404 that reads as "no such company".
      res.json({
        crmCompanyId,
        scored: false,
        reason: 'This company has not been scored yet. No engagement has been recorded, or no calculation has run.',
      })
      return
    }

    res.json({
      crmCompanyId,
      scored: true,
      score: score.normalizedScore,
      rawScore: score.rawScore,
      scoreRange: { min: score.minScore, max: score.maxScore },
      clamped: score.clamped,
      level: score.level,
      policyVersion: score.policyVersion,
      policyStatus: score.policyStatus,
      calculationVersion: score.calculationVersion,
      evaluatedAt: score.evaluatedAt,
      contactability: { status: score.contactabilityStatus, reasons: score.contactabilityReasons },
      eventsConsidered: score.eventsConsidered,
      eventsScored: score.eventsScored,
      eventsExcluded: score.eventsExcluded,
      note: caveat(score.policyStatus),
    })
  }),
)

/** 2. The full breakdown: every point, and the event that produced it. */
intentScoreRoutes.get(
  '/companies/:crmCompanyId/breakdown',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const crmCompanyId = String(req.params.crmCompanyId)
    const score = await currentBreakdown(p.tenantId, crmCompanyId)

    if (!score || !score.latestSnapshot) {
      throw new NotFoundError('This company has no calculated score to break down.')
    }

    const all = score.latestSnapshot.contributions
    const counted = all.filter((c) => c.adjustedPoints !== 0)
    const setAside = all.filter((c) => c.adjustedPoints === 0)

    res.json({
      crmCompanyId,
      score: score.normalizedScore,
      rawScore: score.rawScore,
      scoreRange: { min: score.minScore, max: score.maxScore },
      clamped: score.clamped,
      level: score.level,
      policyVersion: score.policyVersion,
      policyStatus: score.policyStatus,
      calculationVersion: score.calculationVersion,
      evaluatedAt: score.evaluatedAt,
      contactability: { status: score.contactabilityStatus, reasons: score.contactabilityReasons },

      // Every point, with the event behind it.
      contributions: counted.map(present),

      // The events that were considered and contributed nothing, WITH the
      // reason. A breakdown that omitted these would look complete while
      // hiding the answer to "why isn't it higher".
      setAside: setAside.map(present),

      totals: {
        counted: counted.length,
        setAside: setAside.length,
        pointsFromPositive: counted.filter((c) => c.adjustedPoints > 0).reduce((s, c) => s + c.adjustedPoints, 0),
        pointsFromNegative: counted.filter((c) => c.adjustedPoints < 0).reduce((s, c) => s + c.adjustedPoints, 0),
        byChannel: group(counted, (c) => c.channel),
        byEventType: group(counted, (c) => c.eventType),
      },
      note: caveat(score.policyStatus),
    })
  }),
)

function present(c: {
  engagementEventId: string
  eventType: string
  channel: string
  occurredAt: Date
  ruleId: string
  dimension: string
  basePoints: number
  freshnessMultiplier: unknown
  freshnessLabel: string
  ageDays: number
  adjustedPoints: number
  excluded: boolean
  reason: string
  policyVersion: string
}) {
  return {
    // The traceability requirement: every line names its event.
    engagementEventId: c.engagementEventId,
    eventType: c.eventType,
    channel: c.channel,
    occurredAt: c.occurredAt,
    policyRuleId: c.ruleId,
    dimension: c.dimension,
    basePoints: c.basePoints,
    freshnessMultiplier: Number(c.freshnessMultiplier),
    freshnessLabel: c.freshnessLabel,
    ageDays: c.ageDays,
    contribution: c.adjustedPoints,
    excluded: c.excluded,
    reason: c.reason,
    scoringPolicyVersion: c.policyVersion,
  }
}

function group<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) {
    const k = key(item)
    out[k] = (out[k] ?? 0) + (item as unknown as { adjustedPoints: number }).adjustedPoints
  }
  return out
}

/** 3. How the score moved over time. */
intentScoreRoutes.get(
  '/companies/:crmCompanyId/history',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const crmCompanyId = String(req.params.crmCompanyId)
    const limit = Number(req.query.limit ?? 50) || 50
    const snapshots = await scoreHistory(p.tenantId, crmCompanyId, limit)

    res.json({
      crmCompanyId,
      snapshots: snapshots.map((s) => ({
        snapshotId: s.id,
        score: s.normalizedScore,
        rawScore: s.rawScore,
        level: s.level,
        clamped: s.clamped,
        change: s.deltaFromPrevious,
        policyVersion: s.policyVersion,
        policyStatus: s.policyStatus,
        calculationVersion: s.calculationVersion,
        evaluatedAt: s.evaluatedAt,
        trigger: s.trigger,
        eventsConsidered: s.eventsConsidered,
        eventsScored: s.eventsScored,
        contactability: s.contactabilityStatus,
        recordedAt: s.createdAt,
      })),
      note: 'Each snapshot keeps the policy version that produced it, so an older score stays reproducible after the weights change.',
    })
  }),
)

const RecalculateBody = z
  .object({
    crmCompanyId: z.string().min(1).optional(),
    /** Score every company that has engagement. Bounded by INTENT_SCORE_MAX_BATCH. */
    all: z.boolean().optional(),
    policyVersion: z.string().min(1).optional(),
    /**
     * Score as of a past instant, for deterministic historical checks.
     * The same asOf and policy always reproduce the same score.
     */
    asOf: z.string().datetime().optional(),
    /** Compute and return without writing anything. */
    dryRun: z.boolean().optional(),
  })
  .strict()

/** 4. Recalculate — one company, or everything with engagement. */
intentScoreRoutes.post(
  '/recalculate',
  requirePermission('operate'),
  validateBody(RecalculateBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof RecalculateBody>

    if (!body.crmCompanyId && !body.all) {
      res.status(400).json({ error: 'invalid_request', message: 'Provide crmCompanyId, or all: true.' })
      return
    }

    const asOf = body.asOf ? new Date(body.asOf) : undefined
    const persist = !body.dryRun

    const targets = body.crmCompanyId
      ? [body.crmCompanyId]
      : (await companiesWithEngagement(p.tenantId, env.INTENT_SCORE_MAX_BATCH))

    const results = []
    for (const crmCompanyId of targets) {
      const outcome = await scoreCompany({
        tenantId: p.tenantId,
        crmCompanyId,
        policyVersion: body.policyVersion,
        asOf,
        trigger: body.policyVersion ? 'policy_change' : 'recalculation',
        requestedByCrmUserId: p.crmUserId,
        persist,
      })
      results.push({
        crmCompanyId,
        score: outcome.normalizedScore,
        rawScore: outcome.rawScore,
        level: outcome.level,
        policyVersion: outcome.policyVersion,
        evaluatedAt: outcome.evaluatedAt,
        eventsConsidered: outcome.eventsConsidered,
        eventsScored: outcome.eventsScored,
        unchanged: outcome.unchanged,
        snapshotId: outcome.snapshotId,
      })
    }

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'intent_score.recalculated',
      resourceType: 'IntentScore',
      resourceId: body.crmCompanyId ?? null,
      dataClass: 'internal',
      summary: `${results.length} company score(s) recalculated${persist ? '' : ' (dry run)'}`,
      metadata: { policyVersion: body.policyVersion ?? null, asOf: body.asOf ?? null, dryRun: !persist },
    })

    res.json({
      recalculated: results.length,
      dryRun: !persist,
      results,
      note: 'Recalculation is idempotent. A result identical to the previous one adds no history row.',
    })
  }),
)

/** 5. Every scoring policy, with its weights and its approval status. */
intentScoreRoutes.get(
  '/policies',
  requirePermission('view'),
  asyncHandler(async (_req, res) => {
    const policies = await listPolicies()
    res.json({
      activeVersion: env.INTENT_SCORE_POLICY_VERSION,
      policies: policies.map((p) => ({
        version: p.version,
        status: p.status,
        description: p.description,
        scoreRange: { min: p.minScore, max: p.maxScore },
        ruleCount: p.rules.length,
        scoringActors: p.scoringActors,
      })),
      note: 'A policy marked "provisional" has not been approved by the business. Its weights are a default starting point, not a validated model.',
    })
  }),
)

/** 6. One policy in full — every weight, cap, band and caveat. */
intentScoreRoutes.get(
  '/policies/:version',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const policy = await resolvePolicy(String(req.params.version))
    res.json({
      ...policy,
      note: caveat(policy.status),
    })
  }),
)
