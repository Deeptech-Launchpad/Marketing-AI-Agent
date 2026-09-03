import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { audit } from '../platform/audit.js'
import { newId, prisma } from '../platform/db.js'
import { NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { requestCrmSync } from '../crmsync/trigger.js'
import {
  DEFAULT_QUALIFICATION_POLICY,
  DEFAULT_QUALIFICATION_POLICY_VERSION,
  QUALIFICATION_ENGINE_VERSION,
  decide,
  dueAt as dueAtFor,
  validateQualificationPolicy,
} from './policy.js'
import {
  renderAlertText,
  selectAlertProvider,
  type AlertPayload,
} from './providers/alertProvider.js'
import { SalesOwnerResolver } from './providers/ownerResolver.js'
import { renderTaskBody, selectTaskProvider, type TaskPayload } from './providers/taskProvider.js'
import type {
  AlertStatus,
  QualificationEvidence,
  QualificationPolicy,
  QualificationStatus,
  ResolvedOwner,
  TaskStatus,
} from './types.js'

// TASK #985 — evaluating a lead and handing it to a person.
//
// THE SHAPE OF THIS FILE
//
//   read the Task #984 score  →  compare to the threshold  →  persist the
//   decision  →  resolve the owner  →  record an alert  →  create a task
//
// The score is READ ONLY. Nothing here recalculates it, edits an engagement
// event, or changes a scoring policy — this stage consumes Task #984's output
// and adds a business decision on top of it.
//
// Nothing here contacts a prospect. The strongest thing it does is put a task
// on a salesperson's list.

const ownerResolver = new SalesOwnerResolver()

/** Ensures the default provisional policy exists, and returns it. */
export async function ensureDefaultPolicy(): Promise<QualificationPolicy> {
  const problems = validateQualificationPolicy(DEFAULT_QUALIFICATION_POLICY)
  if (problems.length) {
    throw new Error(`The default qualification policy is malformed:\n  ${problems.join('\n  ')}`)
  }

  const existing = await prisma.salesQualificationPolicy.findUnique({
    where: { version: DEFAULT_QUALIFICATION_POLICY_VERSION },
  })
  if (existing) return rowToPolicy(existing)

  const row = await prisma.salesQualificationPolicy.create({
    data: {
      id: newId(),
      version: DEFAULT_QUALIFICATION_POLICY.version,
      status: DEFAULT_QUALIFICATION_POLICY.status,
      description: DEFAULT_QUALIFICATION_POLICY.description,
      threshold: DEFAULT_QUALIFICATION_POLICY.threshold,
      deQualifyBand: DEFAULT_QUALIFICATION_POLICY.deQualifyBand,
      slaMinutes: DEFAULT_QUALIFICATION_POLICY.slaMinutes,
      createAlert: DEFAULT_QUALIFICATION_POLICY.createAlert,
      createFollowUpTask: DEFAULT_QUALIFICATION_POLICY.createFollowUpTask,
      cancelTaskOnDeQualification: DEFAULT_QUALIFICATION_POLICY.cancelTaskOnDeQualification,
      notes: DEFAULT_QUALIFICATION_POLICY.notes as unknown as Prisma.InputJsonValue,
    },
  })
  return rowToPolicy(row)
}

function rowToPolicy(row: {
  version: string
  status: string
  description: string
  threshold: number
  deQualifyBand: number
  slaMinutes: number
  createAlert: boolean
  createFollowUpTask: boolean
  cancelTaskOnDeQualification: boolean
  notes: unknown
}): QualificationPolicy {
  return {
    version: row.version,
    status: row.status as QualificationPolicy['status'],
    description: row.description,
    threshold: row.threshold,
    deQualifyBand: row.deQualifyBand,
    slaMinutes: row.slaMinutes,
    createAlert: row.createAlert,
    createFollowUpTask: row.createFollowUpTask,
    cancelTaskOnDeQualification: row.cancelTaskOnDeQualification,
    notes: row.notes as string[],
  }
}

export async function resolveQualificationPolicy(version?: string | null): Promise<QualificationPolicy> {
  if (!version || version === DEFAULT_QUALIFICATION_POLICY_VERSION) return ensureDefaultPolicy()
  const row = await prisma.salesQualificationPolicy.findUnique({ where: { version } })
  if (!row) throw new NotFoundError(`No qualification policy with version "${version}".`)
  return rowToPolicy(row)
}

export async function listQualificationPolicies(): Promise<QualificationPolicy[]> {
  await ensureDefaultPolicy()
  const rows = await prisma.salesQualificationPolicy.findMany({ orderBy: { activeFrom: 'desc' } })
  return rows.map(rowToPolicy)
}

export interface EvaluateOptions {
  tenantId: string
  crmCompanyId: string
  policyVersion?: string | null
  /** A user id when a person asked for this; null when the worker did. */
  actorCrmUserId?: string | null
  /** Compute and return the decision without persisting or acting. */
  dryRun?: boolean
}

export interface EvaluateResult {
  qualificationId: string | null
  crmCompanyId: string
  companyName: string | null
  status: QualificationStatus
  previousStatus: QualificationStatus | null
  score: number
  threshold: number
  difference: number
  reason: string
  policyVersion: string
  policyStatus: string
  engineVersion: string
  scorePolicyVersion: string
  scoreCalculationVersion: string
  scoreEvaluatedAt: Date
  owner: ResolvedOwner
  alertStatus: AlertStatus
  taskStatus: TaskStatus
  alertId: string | null
  taskId: string | null
  dueAt: Date | null
  evidence: QualificationEvidence[]
  /** True when this evaluation changed nothing. */
  unchanged: boolean
  dryRun: boolean
  /** Set when there is no score to evaluate. */
  blocker?: string
}

/**
 * The strongest observed acts behind the score.
 *
 * Read from Task #984's stored contributions — REFERENCED, never recreated.
 * This stage produces no evidence of its own; it points at what the scoring
 * stage already recorded.
 */
async function topEvidence(snapshotId: string | null, limit = 3): Promise<QualificationEvidence[]> {
  if (!snapshotId) return []
  const rows = await prisma.intentScoreContribution.findMany({
    where: { snapshotId, adjustedPoints: { gt: 0 } },
    orderBy: [{ adjustedPoints: 'desc' }, { occurredAt: 'desc' }],
    take: limit,
  })
  return rows.map((r) => ({
    intentScoreContributionId: r.id,
    engagementEventId: r.engagementEventId,
    eventType: r.eventType,
    channel: r.channel,
    contribution: r.adjustedPoints,
    occurredAt: r.occurredAt,
  }))
}

/** Turns an event type into a sentence a salesperson can read. */
const EVENT_PHRASES: Record<string, string> = {
  workbench_registration_completed: 'completed the registration form to open their personalised demonstration',
  workbench_cta_clicked: 'clicked the walkthrough call-to-action',
  workbench_comparison_used: 'switched between the before and after views of their product page',
  workbench_evidence_viewed: 'opened the page showing where our findings came from',
  workbench_after_viewed: 'looked at the improved version of their product page',
  workbench_before_viewed: 'looked at their product page as it stands today',
  workbench_viewed: 'viewed the before/after comparison',
  workbench_link_opened: 'opened the Workbench link',
  audit_report_qr_scanned: 'scanned the QR code on their audit report',
  audit_report_downloaded: 'downloaded the audit report',
  audit_report_viewed: 'read the audit report',
  email_clicked: 'clicked a link in our email',
  email_opened: 'opened our email',
}

function whyLines(evidence: QualificationEvidence[]): string[] {
  return evidence.map((e) => {
    const phrase = EVENT_PHRASES[e.eventType] ?? `performed "${e.eventType}"`
    return `They ${phrase} (${e.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}).`
  })
}

const RECOMMENDED_ACTION = 'Contact the prospect and offer a 15-minute walkthrough of their product data.'

/**
 * Evaluates one company against the threshold, and hands it off when it passes.
 *
 * Everything the decision rests on is loaded SERVER-SIDE from trusted records:
 * the score from Task #984, the threshold from the policy, the owner from the
 * CRM. A caller supplies a company reference and nothing else.
 */
export async function evaluateCompany(options: EvaluateOptions): Promise<EvaluateResult> {
  const policy = await resolveQualificationPolicy(options.policyVersion)
  const dryRun = options.dryRun ?? false

  // ── The score. Read, never recalculated. ────────────────────────────────
  const score = await prisma.intentScore.findUnique({
    where: { tenantId_crmCompanyId: { tenantId: options.tenantId, crmCompanyId: options.crmCompanyId } },
  })

  const existing = await prisma.salesQualification.findUnique({
    where: { tenantId_crmCompanyId: { tenantId: options.tenantId, crmCompanyId: options.crmCompanyId } },
  })
  const previousStatus = (existing?.status as QualificationStatus | undefined) ?? null

  if (!score) {
    // A lead cannot become high-intent without a valid intent score. Saying so
    // is better than defaulting to zero, which would look like a decision.
    return {
      qualificationId: existing?.id ?? null,
      crmCompanyId: options.crmCompanyId,
      companyName: existing?.companyName ?? null,
      status: previousStatus ?? 'not_qualified',
      previousStatus,
      score: 0,
      threshold: policy.threshold,
      difference: -policy.threshold,
      reason:
        'This company has no intent score, so it cannot be qualified. Engagement must be recorded and scored first.',
      policyVersion: policy.version,
      policyStatus: policy.status,
      engineVersion: QUALIFICATION_ENGINE_VERSION,
      scorePolicyVersion: '',
      scoreCalculationVersion: '',
      scoreEvaluatedAt: new Date(0),
      owner: {
        resolved: false,
        crmUserId: null,
        name: null,
        email: null,
        source: 'none',
        reason: 'No owner was resolved, because there is nothing to qualify.',
      },
      alertStatus: 'pending',
      taskStatus: 'pending',
      alertId: null,
      taskId: null,
      dueAt: null,
      evidence: [],
      unchanged: true,
      dryRun,
      blocker: 'no_intent_score',
    }
  }

  const decision = decide(score.normalizedScore, policy, previousStatus)
  const evidence = await topEvidence(score.latestSnapshotId)

  // ── Owner. Only worth resolving when the lead actually qualifies. ───────
  let owner: ResolvedOwner = {
    resolved: false,
    crmUserId: null,
    name: null,
    email: null,
    source: 'none',
    reason: 'Not resolved: this company is not currently a high-intent lead.',
  }
  if (decision.qualifies) {
    owner = await ownerResolver.resolve(options.crmCompanyId)
  }

  // Prefer the CRM's name. Engagement rows do not always carry one, and an
  // alert that reads "cms7fiyww06..." is not something a salesperson can act on.
  const companyName = owner.companyName ?? score.companyName

  // A qualified lead with nobody responsible is its own state, never hidden
  // behind an arbitrary assignment.
  const status: QualificationStatus = decision.qualifies
    ? owner.resolved
      ? 'qualified'
      : 'qualified_unassigned'
    : decision.status

  const now = new Date()
  const evaluatedDueAt = decision.qualifies ? dueAtFor(now, policy) : null

  const base: EvaluateResult = {
    qualificationId: existing?.id ?? null,
    crmCompanyId: options.crmCompanyId,
    companyName,
    status,
    previousStatus,
    score: score.normalizedScore,
    threshold: policy.threshold,
    difference: decision.difference,
    reason: decision.reason,
    policyVersion: policy.version,
    policyStatus: policy.status,
    engineVersion: QUALIFICATION_ENGINE_VERSION,
    scorePolicyVersion: score.policyVersion,
    scoreCalculationVersion: score.calculationVersion,
    scoreEvaluatedAt: score.evaluatedAt,
    owner,
    alertStatus: (existing?.alertStatus as AlertStatus) ?? 'pending',
    taskStatus: (existing?.taskStatus as TaskStatus) ?? 'pending',
    alertId: null,
    taskId: null,
    dueAt: evaluatedDueAt,
    evidence,
    unchanged: previousStatus === status,
    dryRun,
  }

  if (dryRun) return base

  return persistAndHandOff(base, {
    tenantId: options.tenantId,
    policy,
    score,
    existing,
    now,
    actorCrmUserId: options.actorCrmUserId ?? null,
  })
}

async function persistAndHandOff(
  result: EvaluateResult,
  ctx: {
    tenantId: string
    policy: QualificationPolicy
    score: NonNullable<Awaited<ReturnType<typeof prisma.intentScore.findUnique>>>
    existing: Awaited<ReturnType<typeof prisma.salesQualification.findUnique>>
    now: Date
    actorCrmUserId: string | null
  },
): Promise<EvaluateResult> {
  const { tenantId, policy, score, existing, now } = ctx
  const becameQualified = result.status === 'qualified' || result.status === 'qualified_unassigned'
  const wasQualified = result.previousStatus === 'qualified' || result.previousStatus === 'qualified_unassigned'

  const fields = {
    tenantId,
    crmCompanyId: result.crmCompanyId,
    companyName: result.companyName,
    status: result.status,
    // The snapshot that keeps this decision explainable after everything moves.
    scoreAtQualification: result.score,
    thresholdAtQualification: result.threshold,
    differenceAtQualification: result.difference,
    intentScoreId: score.id,
    intentScoreSnapshotId: score.latestSnapshotId,
    scorePolicyVersion: score.policyVersion,
    scoreCalculationVersion: score.calculationVersion,
    scoreEvaluatedAt: score.evaluatedAt,
    qualificationPolicyVersion: policy.version,
    qualificationEngineVersion: QUALIFICATION_ENGINE_VERSION,
    reason: result.reason,
    ownerCrmUserId: result.owner.crmUserId,
    ownerName: result.owner.name,
    ownerEmail: result.owner.email,
    ownerSource: result.owner.source,
    ownerReason: result.owner.reason,
    // A newly qualified spell starts now; an existing one keeps its start.
    qualifiedAt: becameQualified ? (wasQualified ? existing?.qualifiedAt ?? now : now) : existing?.qualifiedAt ?? null,
    deQualifiedAt: result.status === 'de_qualified' ? now : becameQualified ? null : existing?.deQualifiedAt ?? null,
    dueAt: becameQualified ? (wasQualified ? existing?.dueAt ?? result.dueAt : result.dueAt) : existing?.dueAt ?? null,
    lastEvaluatedAt: now,
  }

  const qualificationId = existing?.id ?? newId()
  await prisma.salesQualification.upsert({
    where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: result.crmCompanyId } },
    create: { id: qualificationId, ...fields, evaluationCount: 1 },
    update: { ...fields, evaluationCount: { increment: 1 } },
  })

  // ── The handoff. Only for a lead that has just become, or remains, high
  //    intent — and only once, because the action rows are idempotent. ─────
  let alertId: string | null = null
  let taskId: string | null = null
  let alertStatus: AlertStatus = (existing?.alertStatus as AlertStatus) ?? 'pending'
  let taskStatus: TaskStatus = (existing?.taskStatus as TaskStatus) ?? 'pending'

  if (becameQualified) {
    if (policy.createAlert) {
      const alert = await ensureAlert(qualificationId, result, ctx)
      alertId = alert.id
      alertStatus = alert.status
    }
    if (policy.createFollowUpTask) {
      const task = await ensureTask(qualificationId, result, ctx)
      taskId = task.id
      taskStatus = task.status
    }

    await prisma.salesQualification.update({
      where: { id: qualificationId },
      data: { alertStatus, taskStatus },
    })
  }

  if (result.status === 'de_qualified' && policy.cancelTaskOnDeQualification) {
    // Off by default: somebody may already be acting on the task.
    await prisma.salesFollowUpTask.updateMany({
      where: { qualificationId, completionStatus: 'open' },
      data: {
        completionStatus: 'cancelled',
        cancelledReason: `The intent score fell to ${result.score}, below the threshold of ${result.threshold}.`,
      },
    })
  }

  // ── History. Append-only, always. ──────────────────────────────────────
  const transition = !existing
    ? becameQualified
      ? 'qualified'
      : 're_evaluated'
    : result.status === result.previousStatus
      ? 're_evaluated'
      : result.status === 'de_qualified'
        ? 'de_qualified'
        : becameQualified && result.previousStatus === 'de_qualified'
          ? 're_qualified'
          : becameQualified
            ? 'qualified'
            : 're_evaluated'

  // A re-evaluation that changed nothing does not deserve a history row —
  // otherwise the worker would bury the real transitions in noise.
  const changed = !existing || result.status !== result.previousStatus || result.score !== existing.scoreAtQualification

  if (changed) {
    await prisma.salesQualificationHistory.create({
      data: {
        id: newId(),
        tenantId,
        qualificationId,
        crmCompanyId: result.crmCompanyId,
        previousStatus: result.previousStatus,
        newStatus: result.status,
        previousScore: existing?.scoreAtQualification ?? null,
        newScore: result.score,
        threshold: result.threshold,
        difference: result.difference,
        transition,
        reason: result.reason,
        qualificationPolicyVersion: policy.version,
        scorePolicyVersion: score.policyVersion,
        intentScoreSnapshotId: score.latestSnapshotId,
        actorType: ctx.actorCrmUserId ? 'user' : 'system',
        actorCrmUserId: ctx.actorCrmUserId,
        alertStatus,
        taskStatus,
        alertId,
        taskId,
      },
    })

    await audit({
      tenantId,
      actorType: ctx.actorCrmUserId ? 'user' : 'agent',
      actorCrmUserId: ctx.actorCrmUserId,
      action: `sales_qualification.${transition}`,
      resourceType: 'SalesQualification',
      resourceId: qualificationId,
      dataClass: 'internal',
      summary: `${result.companyName ?? result.crmCompanyId}: ${result.previousStatus ?? 'new'} → ${result.status} (score ${result.score} vs threshold ${result.threshold})`,
      metadata: {
        score: result.score,
        threshold: result.threshold,
        alertStatus,
        taskStatus,
        ownerSource: result.owner.source,
      },
    })
  }

  // TASK #986: hand the qualified lead to the CRM sync queue. An enqueue and
  // nothing more — no mapping, no payload, no provider is touched here, so
  // Task #985 stays "this lead is qualified" and Task #986 decides what that
  // means for the CRM.
  //
  // Fired whenever the lead IS qualified, not only when its status changed.
  // A steady `qualified` still accrues engagement, so the package would go
  // stale; and a handoff that failed or was never delivered would otherwise
  // never be retried. Task #986 debounces per qualification and refreshes its
  // held package rather than stacking one, so the repetition is absorbed
  // there — which is the stage that knows whether anything needs doing.
  if (becameQualified) {
    await requestCrmSync(tenantId, qualificationId)
  }

  return { ...result, qualificationId, alertId, taskId, alertStatus, taskStatus, unchanged: !changed }
}

/**
 * The idempotency key for one intended action.
 *
 * Includes the owner, so a lead reassigned to a different person legitimately
 * gets a new alert — but a redelivered job for the same owner does not.
 */
function actionKey(qualificationId: string, actionType: string, ownerRef: string | null): string {
  return createHash('sha256')
    .update([qualificationId, actionType, ownerRef ?? 'unassigned'].join('|'))
    .digest('hex')
}

async function ensureAlert(
  qualificationId: string,
  result: EvaluateResult,
  ctx: { tenantId: string; policy: QualificationPolicy },
): Promise<{ id: string; status: AlertStatus }> {
  const key = actionKey(qualificationId, 'alert', result.owner.crmUserId ?? result.owner.name)

  const existing = await prisma.salesAlert.findUnique({ where: { idempotencyKey: key } })
  if (existing) return { id: existing.id, status: existing.status as AlertStatus }

  // No owner means nobody to tell. Recorded as skipped rather than as a
  // failure, and never as a success.
  if (!result.owner.resolved) {
    const row = await prisma.salesAlert.create({
      data: {
        id: newId(),
        tenantId: ctx.tenantId,
        qualificationId,
        crmCompanyId: result.crmCompanyId,
        idempotencyKey: key,
        providerName: 'none',
        destination: 'none',
        providerStatus: 'not_configured',
        status: 'skipped_no_owner',
        delivered: false,
        subject: `High-intent lead: ${result.companyName ?? result.crmCompanyId}`,
        body: 'No alert was sent because no responsible sales owner is configured for this company.',
        scoreAtAlert: result.score,
        threshold: result.threshold,
        reason: result.owner.reason,
      },
    })
    return { id: row.id, status: 'skipped_no_owner' }
  }

  const { provider, skipped } = selectAlertProvider()
  const payload: AlertPayload = {
    qualificationId,
    companyName: result.companyName ?? result.crmCompanyId,
    crmCompanyId: result.crmCompanyId,
    score: result.score,
    threshold: result.threshold,
    whyLines: whyLines(result.evidence),
    recommendedAction: RECOMMENDED_ACTION,
    owner: result.owner,
    internalLink: `${env.SALES_INTERNAL_BASE_URL.replace(/\/+$/, '')}/companies/${result.crmCompanyId}`,
    dueAt: result.dueAt,
  }

  let outcome
  try {
    outcome = await provider.send(payload)
  } catch (err) {
    logger.error({ err, qualificationId }, 'sales qualification: alert provider threw')
    outcome = { status: 'unavailable' as const, delivered: false, reason: 'The alert provider failed.' }
  }

  // `sent` only when a provider confirms a person was reached. An internal
  // record is `recorded_in_app`, which is a different and lesser claim.
  const status: AlertStatus =
    outcome.delivered
      ? 'sent'
      : outcome.status === 'available'
        ? 'recorded_in_app'
        : outcome.status === 'not_configured' || outcome.status === 'disabled_by_policy'
          ? 'blocked_provider_unavailable'
          : 'failed'

  const row = await prisma.salesAlert.create({
    data: {
      id: newId(),
      tenantId: ctx.tenantId,
      qualificationId,
      crmCompanyId: result.crmCompanyId,
      idempotencyKey: key,
      providerName: provider.name,
      destination: provider.destination,
      providerStatus: outcome.status,
      status,
      delivered: outcome.delivered,
      ownerCrmUserId: result.owner.crmUserId,
      ownerName: result.owner.name,
      subject: `HIGH-INTENT LEAD — ${result.companyName ?? result.crmCompanyId} (${result.score}/100)`,
      body: renderAlertText(payload),
      scoreAtAlert: result.score,
      threshold: result.threshold,
      reason: outcome.reason ?? null,
      skipped: (skipped.length ? skipped : undefined) as unknown as Prisma.InputJsonValue,
    },
  })
  return { id: row.id, status }
}

async function ensureTask(
  qualificationId: string,
  result: EvaluateResult,
  ctx: { tenantId: string; policy: QualificationPolicy; now: Date },
): Promise<{ id: string; status: TaskStatus }> {
  const key = actionKey(qualificationId, 'follow_up_task', result.owner.crmUserId ?? result.owner.name)

  const existing = await prisma.salesFollowUpTask.findUnique({ where: { idempotencyKey: key } })
  if (existing) return { id: existing.id, status: existing.status as TaskStatus }

  const due = result.dueAt ?? dueAtFor(ctx.now, ctx.policy)

  if (!result.owner.resolved) {
    const row = await prisma.salesFollowUpTask.create({
      data: {
        id: newId(),
        tenantId: ctx.tenantId,
        qualificationId,
        crmCompanyId: result.crmCompanyId,
        companyName: result.companyName,
        idempotencyKey: key,
        providerName: 'none',
        destination: 'none',
        providerStatus: 'not_configured',
        status: 'skipped_no_owner',
        title: `Follow up — high intent — ${result.companyName ?? result.crmCompanyId}`,
        body: 'No follow-up task was assigned because no responsible sales owner is configured for this company.',
        recommendedAction: RECOMMENDED_ACTION,
        scoreAtCreation: result.score,
        threshold: result.threshold,
        slaMinutes: ctx.policy.slaMinutes,
        slaPolicyVersion: ctx.policy.version,
        dueAt: due,
        reason: result.owner.reason,
      },
    })
    return { id: row.id, status: 'skipped_no_owner' }
  }

  const { provider, skipped } = selectTaskProvider()
  const payload: TaskPayload = {
    qualificationId,
    crmCompanyId: result.crmCompanyId,
    companyName: result.companyName ?? result.crmCompanyId,
    score: result.score,
    threshold: result.threshold,
    owner: result.owner,
    whyLines: whyLines(result.evidence),
    recommendedAction: RECOMMENDED_ACTION,
    dueAt: due,
    slaMinutes: ctx.policy.slaMinutes,
    policyVersion: ctx.policy.version,
  }

  let outcome
  try {
    outcome = await provider.create(payload)
  } catch (err) {
    logger.error({ err, qualificationId }, 'sales qualification: task provider threw')
    outcome = { status: 'unavailable' as const, delivered: false, reason: 'The task provider failed.' }
  }

  const status: TaskStatus = outcome.delivered
    ? provider.name === 'nxt_sales'
      ? 'created_in_crm'
      : 'created'
    : outcome.status === 'not_configured' || outcome.status === 'disabled_by_policy'
      ? 'blocked_provider_unavailable'
      : 'failed'

  const row = await prisma.salesFollowUpTask.create({
    data: {
      id: newId(),
      tenantId: ctx.tenantId,
      qualificationId,
      crmCompanyId: result.crmCompanyId,
      companyName: result.companyName,
      idempotencyKey: key,
      providerName: provider.name,
      destination: provider.destination,
      providerStatus: outcome.status,
      status,
      externalId: outcome.externalId ?? null,
      ownerCrmUserId: result.owner.crmUserId,
      ownerName: result.owner.name,
      title: `Follow up — high intent — ${result.companyName ?? result.crmCompanyId} (${result.score}/100)`,
      body: renderTaskBody(payload),
      recommendedAction: RECOMMENDED_ACTION,
      scoreAtCreation: result.score,
      threshold: result.threshold,
      slaMinutes: ctx.policy.slaMinutes,
      slaPolicyVersion: ctx.policy.version,
      dueAt: due,
      reason: outcome.reason ?? null,
      skipped: (skipped.length ? skipped : undefined) as unknown as Prisma.InputJsonValue,
    },
  })
  return { id: row.id, status }
}

/**
 * Retries the alert and task for an existing qualification.
 *
 * Used when a provider was unavailable and has since been configured. Actions
 * that already succeeded are left alone — the idempotency key sees to that —
 * so a retry cannot notify somebody twice.
 */
export async function retryActions(
  tenantId: string,
  qualificationId: string,
  actorCrmUserId: string,
): Promise<{ alertStatus: AlertStatus; taskStatus: TaskStatus; alertId: string | null; taskId: string | null }> {
  const q = await prisma.salesQualification.findFirst({ where: { id: qualificationId, tenantId } })
  if (!q) throw new NotFoundError('That qualification does not exist.')

  const policy = await resolveQualificationPolicy(q.qualificationPolicyVersion)
  const owner = await ownerResolver.resolve(q.crmCompanyId)

  // Clear only the action rows that did NOT succeed, so a retry can produce a
  // new attempt without disturbing an alert somebody has already acted on.
  await prisma.salesAlert.deleteMany({
    where: { qualificationId, status: { in: ['blocked_provider_unavailable', 'failed', 'skipped_no_owner'] } },
  })
  await prisma.salesFollowUpTask.deleteMany({
    where: { qualificationId, status: { in: ['blocked_provider_unavailable', 'failed', 'skipped_no_owner'] } },
  })

  const result: EvaluateResult = {
    qualificationId,
    crmCompanyId: q.crmCompanyId,
    companyName: q.companyName,
    status: owner.resolved ? 'qualified' : 'qualified_unassigned',
    previousStatus: q.status as QualificationStatus,
    score: q.scoreAtQualification,
    threshold: q.thresholdAtQualification,
    difference: q.differenceAtQualification,
    reason: q.reason,
    policyVersion: policy.version,
    policyStatus: policy.status,
    engineVersion: QUALIFICATION_ENGINE_VERSION,
    scorePolicyVersion: q.scorePolicyVersion,
    scoreCalculationVersion: q.scoreCalculationVersion,
    scoreEvaluatedAt: q.scoreEvaluatedAt,
    owner,
    alertStatus: q.alertStatus as AlertStatus,
    taskStatus: q.taskStatus as TaskStatus,
    alertId: null,
    taskId: null,
    dueAt: q.dueAt,
    evidence: await topEvidence(q.intentScoreSnapshotId),
    unchanged: false,
    dryRun: false,
  }

  const now = new Date()
  const alert = policy.createAlert
    ? await ensureAlert(qualificationId, result, { tenantId, policy })
    : { id: null, status: q.alertStatus as AlertStatus }
  const task = policy.createFollowUpTask
    ? await ensureTask(qualificationId, result, { tenantId, policy, now })
    : { id: null, status: q.taskStatus as TaskStatus }

  await prisma.salesQualification.update({
    where: { id: qualificationId },
    data: {
      alertStatus: alert.status,
      taskStatus: task.status,
      ownerCrmUserId: owner.crmUserId,
      ownerName: owner.name,
      ownerEmail: owner.email,
      ownerSource: owner.source,
      ownerReason: owner.reason,
      status: owner.resolved ? 'qualified' : 'qualified_unassigned',
    },
  })

  await prisma.salesQualificationHistory.create({
    data: {
      id: newId(),
      tenantId,
      qualificationId,
      crmCompanyId: q.crmCompanyId,
      previousStatus: q.status,
      newStatus: owner.resolved ? 'qualified' : 'qualified_unassigned',
      previousScore: q.scoreAtQualification,
      newScore: q.scoreAtQualification,
      threshold: q.thresholdAtQualification,
      difference: q.differenceAtQualification,
      transition: 'actions_retried',
      reason: 'A person asked for the sales handoff actions to be retried.',
      qualificationPolicyVersion: policy.version,
      scorePolicyVersion: q.scorePolicyVersion,
      intentScoreSnapshotId: q.intentScoreSnapshotId,
      actorType: 'user',
      actorCrmUserId,
      alertStatus: alert.status,
      taskStatus: task.status,
      alertId: alert.id,
      taskId: task.id,
    },
  })

  return { alertStatus: alert.status, taskStatus: task.status, alertId: alert.id, taskId: task.id }
}

/** Companies with a score, for the batch evaluation. Not a ranking. */
export async function companiesWithScores(tenantId: string, limit: number): Promise<string[]> {
  const rows = await prisma.intentScore.findMany({
    where: { tenantId },
    orderBy: { evaluatedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 2000),
    select: { crmCompanyId: true },
  })
  return rows.map((r) => r.crmCompanyId)
}

export async function getQualification(tenantId: string, crmCompanyId: string) {
  return prisma.salesQualification.findUnique({
    where: { tenantId_crmCompanyId: { tenantId, crmCompanyId } },
    include: {
      alerts: { orderBy: { createdAt: 'desc' }, take: 5 },
      tasks: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
  })
}

export async function getQualificationById(tenantId: string, id: string) {
  return prisma.salesQualification.findFirst({
    where: { id, tenantId },
    include: {
      alerts: { orderBy: { createdAt: 'desc' } },
      tasks: { orderBy: { createdAt: 'desc' } },
      history: { orderBy: { occurredAt: 'desc' }, take: 50 },
    },
  })
}

export async function qualificationHistory(tenantId: string, crmCompanyId: string, limit = 50) {
  return prisma.salesQualificationHistory.findMany({
    where: { tenantId, crmCompanyId },
    orderBy: { occurredAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  })
}
