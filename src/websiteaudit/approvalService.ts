import { env } from '../config/env.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import {
  availableActions,
  canTransition,
  isEditable,
  type ApprovalAction,
  type ApprovalState,
} from './approvalStateMachine.js'
import type { SalesCollateral } from './collateral.js'
import { sortFindingsByPriority, type CatalogFinding } from './findings.js'
import { renderAuditPdf } from './pdfReport.js'
import { validateRevision, type ValidationResult } from './reportValidation.js'
import { applyEdits, type RevisionEdit } from './revisionContent.js'

// TASK #980 — the human approval workflow.
//
// One module owns every state change and every revision, so the rules are in
// one place rather than spread across route handlers where the next endpoint
// can quietly skip one.
//
// Three things are non-negotiable here:
//
//   Identity comes from the authenticated principal, never from the body. The
//   functions below take a `reviewer` argument that routes populate from
//   req.principal; there is no field a client can send to claim to be someone.
//
//   Approval runs validation FIRST and stores the result on the decision. An
//   approval that did not pass is not recorded as an approval — it is recorded
//   as a refused attempt, which is itself part of the trail.
//
//   Nothing here delivers anything. There is no email, no publish, no CRM
//   write. The workflow ends at a status.

export interface Reviewer {
  crmUserId: string
  email: string
  name: string
  tenantId: string
}

/** Every write names the version the reviewer was looking at. */
export interface ConcurrencyToken {
  expectedLockVersion: number
  expectedRevision?: number
}

async function loadReport(tenantId: string, auditRunId: string) {
  const report = await prisma.auditReport.findFirst({ where: { auditRunId, tenantId } })
  if (!report) throw new NotFoundError('No report has been generated for that audit run yet.')
  return report
}

/**
 * Rejects a write aimed at a version that has since moved on.
 *
 * The scenario this exists for: reviewer A opens revision 2, reviewer B
 * approves it, reviewer A saves an edit. Without this, A's edit would land on
 * an approved report and nobody would know the approved text had changed.
 */
function assertFresh(
  report: { lockVersion: number; currentRevision: number; status: string },
  token: ConcurrencyToken,
): void {
  if (report.lockVersion !== token.expectedLockVersion) {
    throw new ConflictError(
      `This report has changed since you loaded it (you have version ${token.expectedLockVersion}, current is ${report.lockVersion}). Reload the latest revision and try again.`,
      { currentLockVersion: report.lockVersion, currentRevision: report.currentRevision, currentStatus: report.status },
    )
  }
  if (token.expectedRevision !== undefined && report.currentRevision !== token.expectedRevision) {
    throw new ConflictError(
      `Revision ${token.expectedRevision} is no longer the active revision (current is ${report.currentRevision}). Reload and try again.`,
      { currentLockVersion: report.lockVersion, currentRevision: report.currentRevision },
    )
  }
}

/**
 * Whoever asked for the audit should not be the one signing it off.
 *
 * Reuses the existing ALLOW_SELF_APPROVAL control rather than inventing a
 * second one, so the whole platform has one answer to this question.
 */
function assertNotSelfApproval(requestedBy: string, reviewer: Reviewer): void {
  if (!env.ALLOW_SELF_APPROVAL && requestedBy === reviewer.crmUserId) {
    throw new ForbiddenError(
      'Self-approval is disabled: you requested this audit. Ask another approver to review it.',
    )
  }
}

/** Reads the active revision, falling back to the generated original. */
export async function activeRevision(auditReportId: string, revisionNumber: number) {
  return prisma.auditReportRevision.findUnique({
    where: { auditReportId_revisionNumber: { auditReportId, revisionNumber } },
  })
}

/**
 * Ensures revision 1 exists for a report generated before this workflow did.
 *
 * Task #979 reports predate the revision table, and rather than backfilling
 * them in a migration that would have to reason about JSON shapes, revision 1
 * is materialised from the report's own stored artifact the first time the
 * approval workflow touches it. The bytes are the generated ones; nothing is
 * re-rendered, so the original digest is preserved exactly.
 */
export async function ensureRevisionOne(auditReportId: string): Promise<void> {
  const existing = await prisma.auditReportRevision.findUnique({
    where: { auditReportId_revisionNumber: { auditReportId, revisionNumber: 1 } },
  })
  if (existing) return

  const report = await prisma.auditReport.findUniqueOrThrow({ where: { id: auditReportId } })
  await prisma.auditReportRevision.create({
    data: {
      id: newId(),
      tenantId: report.tenantId,
      auditReportId,
      auditRunId: report.auditRunId,
      revisionNumber: 1,
      content: report.collateral as never,
      pdfBytes: report.pdfBytes,
      pdfSha256: report.pdfSha256,
      pdfPageCount: report.pdfPageCount,
      pdfBytesSize: report.pdfBytesSize,
      createdByCrmUserId: null,
      createdByEmail: null,
      changeReason: 'Generated by the website audit (Task #979).',
      sourceRevisionNumber: null,
      validationOk: false,
    },
  })
}

// ── Revisions ──────────────────────────────────────────────────────────────

export interface ReviseInput {
  tenantId: string
  auditRunId: string
  reviewer: Reviewer
  edit: RevisionEdit
  changeReason: string
  concurrency: ConcurrencyToken
}

export interface ReviseResult {
  revisionNumber: number
  sourceRevisionNumber: number
  pdfSha256: string
  pdfPageCount: number
  pdfBytes: number
  validation: ValidationResult
  lockVersion: number
}

/**
 * Creates a new revision from reviewer edits.
 *
 * The previous revision is untouched. A new row is written, a new PDF is
 * rendered through the EXISTING generator, and the result is validated
 * immediately so a reviewer learns about a broken claim at the moment they
 * write it rather than when they try to approve.
 *
 * A revision that fails validation is still SAVED. Refusing to store it would
 * lose the reviewer's work and hide the attempt; instead it is stored with its
 * errors, and approval is what remains blocked.
 */
export async function reviseReport(input: ReviseInput): Promise<ReviseResult> {
  const report = await loadReport(input.tenantId, input.auditRunId)
  await ensureRevisionOne(report.id)

  if (!isEditable(report.status as ApprovalState)) {
    throw new ConflictError(
      `A report in state "${report.status}" cannot be edited. Reopen it for a new review cycle first.`,
      { status: report.status, availableActions: availableActions(report.status as ApprovalState) },
    )
  }

  assertFresh(report, input.concurrency)

  const source = await activeRevision(report.id, report.currentRevision)
  if (!source) throw new NotFoundError(`Revision ${report.currentRevision} could not be loaded.`)

  const sourceContent = source.content as unknown as SalesCollateral
  const nextContent = applyEdits(sourceContent, input.edit)
  const original = report.collateral as unknown as SalesCollateral

  const findings = await loadFindings(input.auditRunId)
  const pdf = await renderAuditPdf(nextContent, findings)

  const validation = await validateRevision({
    auditRunId: input.auditRunId,
    tenantId: input.tenantId,
    content: nextContent,
    original,
    pdfBytes: pdf.bytes,
    pdfSha256: pdf.sha256,
  })

  const nextNumber = report.currentRevision + 1

  const updated = await prisma.$transaction(async (tx) => {
    await tx.auditReportRevision.create({
      data: {
        id: newId(),
        tenantId: input.tenantId,
        auditReportId: report.id,
        auditRunId: input.auditRunId,
        revisionNumber: nextNumber,
        content: nextContent as never,
        pdfBytes: pdf.bytes,
        pdfSha256: pdf.sha256,
        pdfPageCount: pdf.pageCount,
        pdfBytesSize: pdf.bytes.length,
        createdByCrmUserId: input.reviewer.crmUserId,
        createdByEmail: input.reviewer.email,
        changeReason: input.changeReason,
        sourceRevisionNumber: source.revisionNumber,
        validation: validation as never,
        validationOk: validation.ok,
      },
    })

    // The write is guarded on lockVersion so two concurrent revisions cannot
    // both claim the same next number — the second finds zero rows updated.
    const res = await tx.auditReport.updateMany({
      where: { id: report.id, lockVersion: input.concurrency.expectedLockVersion },
      data: { currentRevision: nextNumber, lockVersion: { increment: 1 } },
    })
    if (res.count === 0) {
      throw new ConflictError('Another reviewer changed this report while your revision was being saved. Reload and try again.')
    }

    return tx.auditReport.findUniqueOrThrow({ where: { id: report.id }, select: { lockVersion: true } })
  })

  await recordEvent({
    tenantId: input.tenantId,
    auditReportId: report.id,
    auditRunId: input.auditRunId,
    revisionNumber: nextNumber,
    previousStatus: report.status,
    newStatus: report.status,
    action: 'revise',
    reviewer: input.reviewer,
    comment: input.changeReason,
    validation,
  })

  await audit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorCrmUserId: input.reviewer.crmUserId,
    action: 'audit_report.revised',
    resourceType: 'AuditReportRevision',
    resourceId: report.id,
    dataClass: 'internal',
    summary: `Revision ${nextNumber} created from revision ${source.revisionNumber} — validation ${validation.ok ? 'passed' : 'FAILED'}`,
  })

  logger.info(
    { auditRunId: input.auditRunId, revision: nextNumber, validationOk: validation.ok },
    'audit report revision created',
  )

  return {
    revisionNumber: nextNumber,
    sourceRevisionNumber: source.revisionNumber,
    pdfSha256: pdf.sha256,
    pdfPageCount: pdf.pageCount,
    pdfBytes: pdf.bytes.length,
    validation,
    lockVersion: updated.lockVersion,
  }
}

/**
 * Findings, in the shape and ORDER the PDF generator already expects.
 *
 * The ordering is restored in JS rather than in SQL because `priority` is a
 * string column: `ORDER BY priority ASC` sorts high, low, medium, putting the
 * least important findings above the middling ones. The PDF prints only the
 * first four, so a revision rendered from a SQL-ordered list showed a
 * different set of findings than the original — the revision-2 PDF came out a
 * page shorter, which is how this was noticed.
 */
async function loadFindings(auditRunId: string): Promise<CatalogFinding[]> {
  const rows = sortFindingsByPriority(await prisma.catalogFinding.findMany({ where: { auditRunId } }))
  return rows.map((f) => ({
    code: f.code,
    title: f.title,
    category: f.category,
    priority: f.priority as CatalogFinding['priority'],
    priorityReasons: (f.priorityReasons ?? []) as string[],
    affectedCount: f.affectedCount,
    observedCount: f.observedCount,
    sampleSize: f.sampleSize,
    sampleUnit: f.sampleUnit,
    metric: f.metric,
    finding: f.finding,
    impact: f.impact,
    recommendation: f.recommendation,
    evidence: (f.evidence ?? []) as unknown as CatalogFinding['evidence'],
  }))
}

// ── Transitions ────────────────────────────────────────────────────────────

export interface TransitionInput {
  tenantId: string
  auditRunId: string
  reviewer: Reviewer
  action: ApprovalAction
  comment?: string | null
  concurrency: ConcurrencyToken
  requestId?: string | null
}

export interface TransitionOutcome {
  previousStatus: ApprovalState
  status: ApprovalState
  revisionNumber: number
  lockVersion: number
  validation?: ValidationResult
  availableActions: ApprovalAction[]
}

/** Actions that are meaningless without the reviewer saying why. */
const REASON_REQUIRED: ApprovalAction[] = ['request_changes', 'reject', 'reopen']

/** Readable phrasing for the message a reviewer actually sees. */
const ACTION_PHRASE: Partial<Record<ApprovalAction, string>> = {
  request_changes: 'request changes to',
  reject: 'reject',
  reopen: 'reopen',
}

export async function transition(input: TransitionInput): Promise<TransitionOutcome> {
  const report = await loadReport(input.tenantId, input.auditRunId)
  await ensureRevisionOne(report.id)

  const from = report.status as ApprovalState
  const move = canTransition(from, input.action)
  if (!move.ok) throw new ConflictError(move.reason!, { status: from, availableActions: availableActions(from) })

  if (REASON_REQUIRED.includes(input.action) && !input.comment?.trim()) {
    throw new BadRequestError(`A comment is required in order to ${ACTION_PHRASE[input.action] ?? input.action} this report.`)
  }

  assertFresh(report, input.concurrency)

  const run = await prisma.websiteAuditRun.findUniqueOrThrow({
    where: { id: input.auditRunId },
    select: { requestedByCrmUserId: true },
  })

  let validation: ValidationResult | undefined

  if (input.action === 'approve') {
    assertNotSelfApproval(run.requestedByCrmUserId, input.reviewer)

    const revision = await activeRevision(report.id, report.currentRevision)
    if (!revision) throw new NotFoundError(`Revision ${report.currentRevision} could not be loaded.`)

    validation = await validateRevision({
      auditRunId: input.auditRunId,
      tenantId: input.tenantId,
      content: revision.content as unknown as SalesCollateral,
      original: report.collateral as unknown as SalesCollateral,
      pdfBytes: revision.pdfBytes ? Buffer.from(revision.pdfBytes) : null,
      pdfSha256: revision.pdfSha256,
    })

    if (!validation.ok) {
      // The refused attempt is part of the trail: a reviewer trying to approve
      // an unsupportable report is exactly the event an audit log should keep.
      await recordEvent({
        tenantId: input.tenantId,
        auditReportId: report.id,
        auditRunId: input.auditRunId,
        revisionNumber: report.currentRevision,
        previousStatus: from,
        newStatus: from,
        action: 'approve_blocked',
        reviewer: input.reviewer,
        comment: input.comment ?? null,
        validation,
      })

      throw new ConflictError('This revision cannot be approved: validation failed.', {
        validation: { ok: false, errors: validation.errors, passed: validation.passed },
      })
    }
  }

  const now = new Date()
  const next = move.next!

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.auditReport.updateMany({
      where: { id: report.id, lockVersion: input.concurrency.expectedLockVersion },
      data: {
        status: next,
        lockVersion: { increment: 1 },
        reviewerCrmUserId: input.reviewer.crmUserId,
        reviewerEmail: input.reviewer.email,
        reviewedAt: now,
        decisionComment: input.comment ?? null,
        ...(input.action === 'approve'
          ? { approvedRevision: report.currentRevision, approvalValidation: validation as never }
          : {}),
      },
    })
    if (res.count === 0) {
      throw new ConflictError('Another reviewer changed this report while your decision was being recorded. Reload and try again.')
    }
    if (input.action === 'approve') {
      await tx.auditReportRevision.updateMany({
        where: { auditReportId: report.id, revisionNumber: report.currentRevision },
        data: { validation: validation as never, validationOk: true },
      })
    }
    return tx.auditReport.findUniqueOrThrow({ where: { id: report.id }, select: { lockVersion: true } })
  })

  await recordEvent({
    tenantId: input.tenantId,
    auditReportId: report.id,
    auditRunId: input.auditRunId,
    revisionNumber: report.currentRevision,
    previousStatus: from,
    newStatus: next,
    action: input.action,
    reviewer: input.reviewer,
    comment: input.comment ?? null,
    validation,
  })

  await audit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorCrmUserId: input.reviewer.crmUserId,
    action: `audit_report.${input.action}`,
    resourceType: 'AuditReport',
    resourceId: report.id,
    dataClass: 'internal',
    summary: `${from} -> ${next} on revision ${report.currentRevision}${input.comment ? `: ${input.comment}` : ''}`,
    requestId: input.requestId ?? null,
  })

  logger.info(
    { auditRunId: input.auditRunId, from, to: next, revision: report.currentRevision, reviewer: input.reviewer.crmUserId },
    'audit report approval transition',
  )

  return {
    previousStatus: from,
    status: next,
    revisionNumber: report.currentRevision,
    lockVersion: updated.lockVersion,
    validation,
    availableActions: availableActions(next),
  }
}

interface EventInput {
  tenantId: string
  auditReportId: string
  auditRunId: string
  revisionNumber: number
  previousStatus: string
  newStatus: string
  action: string
  reviewer: Reviewer
  comment: string | null
  validation?: ValidationResult
}

/** Append-only. There is no update or delete path for this table anywhere. */
async function recordEvent(e: EventInput): Promise<void> {
  await prisma.auditApprovalEvent.create({
    data: {
      id: newId(),
      tenantId: e.tenantId,
      auditReportId: e.auditReportId,
      auditRunId: e.auditRunId,
      revisionNumber: e.revisionNumber,
      previousStatus: e.previousStatus,
      newStatus: e.newStatus,
      action: e.action,
      reviewerCrmUserId: e.reviewer.crmUserId,
      reviewerEmail: e.reviewer.email,
      reviewerName: e.reviewer.name,
      comment: e.comment,
      validation: (e.validation ?? undefined) as never,
    },
  })
}
