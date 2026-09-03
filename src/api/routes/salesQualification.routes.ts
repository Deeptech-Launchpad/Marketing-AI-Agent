import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { NotFoundError } from '../../platform/errors.js'
import {
  companiesWithScores,
  evaluateCompany,
  getQualification,
  getQualificationById,
  listQualificationPolicies,
  qualificationHistory,
  resolveQualificationPolicy,
  retryActions,
} from '../../salesqualification/service.js'
import { ALERT_PROVIDERS } from '../../salesqualification/providers/alertProvider.js'
import { TASK_PROVIDERS } from '../../salesqualification/providers/taskProvider.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// TASK #985 — the sales qualification API.
//
// SECURITY: A CLIENT ASKS "EVALUATE THIS COMPANY", NEVER "MARK THIS ONE HOT".
//
// No endpoint accepts a score, a threshold, an owner, or a qualification status
// from the caller. All four are loaded server-side from trusted records — the
// score from Task #984, the threshold from the policy, the owner from the CRM.
// The tenant comes from the token, never from the path, so a company id from
// another tenant resolves to nothing.
//
// Reading needs `view`. Evaluating and retrying need `operate`, because both
// can put work on a salesperson's desk.
//
// Nothing here contacts a prospect.

export const salesQualificationRoutes = Router()

function caveat(policyStatus: string): string {
  return policyStatus === 'business_approved'
    ? 'A high-intent lead means observed engagement crossed the approved threshold.'
    : 'A high-intent lead means observed engagement crossed a PROVISIONAL threshold that has not been approved by the business. It is not a prediction that the company will buy, and not a probability of conversion.'
}

/**
 * The lifecycle stage, DERIVED for a UI rather than stored.
 *
 * Qualification, alert and task each keep their own status, because
 * "qualified, alert blocked, task created" is a real state. This collapses them
 * only for display, and only in one direction.
 */
function stage(q: { status: string; alertStatus: string; taskStatus: string }): string {
  if (q.status === 'not_qualified') return 'not_qualified'
  if (q.status === 'de_qualified') return 'de_qualified'
  if (q.taskStatus === 'created' || q.taskStatus === 'created_in_crm') return 'follow_up_created'
  if (q.alertStatus === 'sent' || q.alertStatus === 'recorded_in_app') return 'alerted'
  if (q.status === 'qualified') return 'assigned'
  return 'qualified_unassigned'
}

function present(q: NonNullable<Awaited<ReturnType<typeof getQualification>>>) {
  return {
    id: q.id,
    crmCompanyId: q.crmCompanyId,
    companyName: q.companyName,

    status: q.status,
    stage: stage(q),

    // The snapshot that made the decision, not a re-read of today's numbers.
    intentScore: q.scoreAtQualification,
    threshold: q.thresholdAtQualification,
    aboveThreshold: q.differenceAtQualification,
    reason: q.reason,

    qualificationPolicyVersion: q.qualificationPolicyVersion,
    qualificationEngineVersion: q.qualificationEngineVersion,
    scorePolicyVersion: q.scorePolicyVersion,
    scoreCalculationVersion: q.scoreCalculationVersion,
    scoreEvaluatedAt: q.scoreEvaluatedAt,
    intentScoreSnapshotId: q.intentScoreSnapshotId,

    owner: {
      crmUserId: q.ownerCrmUserId,
      name: q.ownerName,
      email: q.ownerEmail,
      source: q.ownerSource,
      reason: q.ownerReason,
    },

    // Kept separate, deliberately.
    alert: { status: q.alertStatus },
    followUp: { status: q.taskStatus, dueAt: q.dueAt },

    qualifiedAt: q.qualifiedAt,
    deQualifiedAt: q.deQualifiedAt,
    evaluationCount: q.evaluationCount,
    lastEvaluatedAt: q.lastEvaluatedAt,
  }
}

/** 1. The current qualification for one company. */
salesQualificationRoutes.get(
  '/companies/:crmCompanyId',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const crmCompanyId = String(req.params.crmCompanyId)
    const q = await getQualification(p.tenantId, crmCompanyId)

    if (!q) {
      res.json({
        crmCompanyId,
        evaluated: false,
        reason: 'This company has not been evaluated against the qualification threshold yet.',
      })
      return
    }

    res.json({
      evaluated: true,
      ...present(q),
      alerts: q.alerts.map((a) => ({
        id: a.id,
        status: a.status,
        provider: a.providerName,
        destination: a.destination,
        delivered: a.delivered,
        reason: a.reason,
        createdAt: a.createdAt,
      })),
      followUpTasks: q.tasks.map((t) => ({
        id: t.id,
        status: t.status,
        provider: t.providerName,
        destination: t.destination,
        title: t.title,
        dueAt: t.dueAt,
        slaMinutes: t.slaMinutes,
        completionStatus: t.completionStatus,
        reason: t.reason,
      })),
      note: caveat('provisional'),
    })
  }),
)

/** 2. How this company's qualification changed over time. */
salesQualificationRoutes.get(
  '/companies/:crmCompanyId/history',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const crmCompanyId = String(req.params.crmCompanyId)
    const limit = Number(req.query.limit ?? 50) || 50
    const rows = await qualificationHistory(p.tenantId, crmCompanyId, limit)

    res.json({
      crmCompanyId,
      transitions: rows.map((h) => ({
        id: h.id,
        transition: h.transition,
        from: h.previousStatus,
        to: h.newStatus,
        previousScore: h.previousScore,
        score: h.newScore,
        threshold: h.threshold,
        difference: h.difference,
        reason: h.reason,
        qualificationPolicyVersion: h.qualificationPolicyVersion,
        scorePolicyVersion: h.scorePolicyVersion,
        alertStatus: h.alertStatus,
        taskStatus: h.taskStatus,
        actorType: h.actorType,
        occurredAt: h.occurredAt,
      })),
      note: 'Append-only. A de-qualification adds a row; it never removes the qualification that came before it.',
    })
  }),
)

/** 3. One qualification in full, with its evidence and action history. */
salesQualificationRoutes.get(
  '/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const q = await getQualificationById(p.tenantId, String(req.params.id))
    if (!q) throw new NotFoundError('That qualification does not exist.')

    // The evidence is REFERENCED from Task #984, never recreated here.
    const { prisma } = await import('../../platform/db.js')
    const contributions = q.intentScoreSnapshotId
      ? await prisma.intentScoreContribution.findMany({
          where: { snapshotId: q.intentScoreSnapshotId, adjustedPoints: { gt: 0 } },
          orderBy: [{ adjustedPoints: 'desc' }, { occurredAt: 'desc' }],
          take: 10,
        })
      : []

    res.json({
      ...present(q),
      whyQualified: {
        summary: q.reason,
        intentScore: q.scoreAtQualification,
        threshold: q.thresholdAtQualification,
        aboveThreshold: q.differenceAtQualification,
        keyObservedActions: contributions.map((c) => ({
          engagementEventId: c.engagementEventId,
          intentScoreContributionId: c.id,
          eventType: c.eventType,
          channel: c.channel,
          contribution: c.adjustedPoints,
          occurredAt: c.occurredAt,
        })),
      },
      alerts: q.alerts.map((a) => ({
        id: a.id,
        status: a.status,
        provider: a.providerName,
        destination: a.destination,
        delivered: a.delivered,
        subject: a.subject,
        body: a.body,
        reason: a.reason,
        skipped: a.skipped,
        createdAt: a.createdAt,
      })),
      followUpTasks: q.tasks.map((t) => ({
        id: t.id,
        status: t.status,
        provider: t.providerName,
        destination: t.destination,
        title: t.title,
        body: t.body,
        recommendedAction: t.recommendedAction,
        owner: t.ownerName,
        dueAt: t.dueAt,
        slaMinutes: t.slaMinutes,
        slaPolicyVersion: t.slaPolicyVersion,
        completionStatus: t.completionStatus,
        reason: t.reason,
        skipped: t.skipped,
        createdAt: t.createdAt,
      })),
      actionHistory: q.history.map((h) => ({
        transition: h.transition,
        from: h.previousStatus,
        to: h.newStatus,
        score: h.newScore,
        alertStatus: h.alertStatus,
        taskStatus: h.taskStatus,
        occurredAt: h.occurredAt,
      })),
      note: caveat('provisional'),
    })
  }),
)

const EvaluateBody = z
  .object({
    // A company REFERENCE. Never a score, threshold, owner or status.
    crmCompanyId: z.string().min(1).optional(),
    all: z.boolean().optional(),
    policyVersion: z.string().min(1).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()

/** 4. Evaluate one company, or every company that has a score. */
salesQualificationRoutes.post(
  '/evaluate',
  requirePermission('operate'),
  validateBody(EvaluateBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof EvaluateBody>

    if (!body.crmCompanyId && !body.all) {
      res.status(400).json({ error: 'invalid_request', message: 'Provide crmCompanyId, or all: true.' })
      return
    }

    const targets = body.crmCompanyId
      ? [body.crmCompanyId]
      : await companiesWithScores(p.tenantId, env.SALES_QUALIFICATION_MAX_BATCH)

    const results = []
    for (const crmCompanyId of targets) {
      const r = await evaluateCompany({
        tenantId: p.tenantId,
        crmCompanyId,
        policyVersion: body.policyVersion,
        actorCrmUserId: p.crmUserId,
        dryRun: body.dryRun,
      })
      results.push({
        crmCompanyId,
        companyName: r.companyName,
        status: r.status,
        previousStatus: r.previousStatus,
        score: r.score,
        threshold: r.threshold,
        aboveThreshold: r.difference,
        reason: r.reason,
        owner: { name: r.owner.name, source: r.owner.source, resolved: r.owner.resolved },
        alertStatus: r.alertStatus,
        taskStatus: r.taskStatus,
        dueAt: r.dueAt,
        unchanged: r.unchanged,
        qualificationId: r.qualificationId,
        ...(r.blocker ? { blocker: r.blocker } : {}),
      })
    }

    const qualified = results.filter((r) => r.status === 'qualified' || r.status === 'qualified_unassigned')

    res.json({
      evaluated: results.length,
      qualified: qualified.length,
      dryRun: Boolean(body.dryRun),
      results,
      note: caveat('provisional'),
    })
  }),
)

/** 5. Every qualification policy. */
salesQualificationRoutes.get(
  '/policies',
  requirePermission('view'),
  asyncHandler(async (_req, res) => {
    const policies = await listQualificationPolicies()
    res.json({
      activeVersion: env.SALES_QUALIFICATION_POLICY_VERSION,
      policies: policies.map((p) => ({
        version: p.version,
        status: p.status,
        description: p.description,
        threshold: p.threshold,
        deQualifyBand: p.deQualifyBand,
        slaMinutes: p.slaMinutes,
      })),
      note: 'A policy marked "provisional" has not been approved by the business. The threshold and the SLA are default starting points.',
    })
  }),
)

/** 6. One policy in full, with its caveats and the provider picture. */
salesQualificationRoutes.get(
  '/policies/:version',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const policy = await resolveQualificationPolicy(String(req.params.version))
    res.json({
      ...policy,
      providers: {
        alert: ALERT_PROVIDERS.map((p) => ({
          name: p.name,
          destination: p.destination,
          ...p.availability(),
        })),
        task: TASK_PROVIDERS.map((p) => ({
          name: p.name,
          destination: p.destination,
          ...p.availability(),
        })),
      },
      note: caveat(policy.status),
    })
  }),
)

/** 7. Retry the alert and task for a qualification whose providers failed. */
salesQualificationRoutes.post(
  '/:id/retry-actions',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const result = await retryActions(p.tenantId, String(req.params.id), p.crmUserId)
    res.json({
      ...result,
      note: 'Actions that already succeeded were left untouched. A retry cannot notify a salesperson about the same lead twice.',
    })
  }),
)
