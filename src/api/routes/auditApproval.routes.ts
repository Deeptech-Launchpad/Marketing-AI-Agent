import { Router, type Request } from 'express'
import { z } from 'zod'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { ensureRevisionOne, reviseReport, transition, type Reviewer } from '../../websiteaudit/approvalService.js'
import {
  availableActions,
  isEditable,
  type ApprovalAction,
  type ApprovalState,
} from '../../websiteaudit/approvalStateMachine.js'
import { IMMUTABLE_FIELDS, RevisionEditSchema } from '../../websiteaudit/revisionContent.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// TASK #980 — human-in-the-loop approval of an audit report.
//
// Mounted on the same /website-audit prefix as the Task #979 routes, so the
// paths a future UI calls stay in one namespace while the two concerns stay in
// separate files.
//
// Reviewer identity is derived from req.principal on every write and is never
// read from the body. The bodies below carry only a comment, a concurrency
// token, and — for a revision — the narrow set of prose fields the edit schema
// permits.
//
// The workflow ends at a status. Nothing here delivers, sends or publishes.

export const auditApprovalRoutes = Router()

/** Reviewer identity, taken from the verified JWT. Never from the request. */
function reviewerFrom(req: Request): Reviewer {
  const p = req.principal!
  return { crmUserId: p.crmUserId, email: p.email, name: p.name, tenantId: p.tenantId }
}

const ConcurrencyFields = {
  /** The lockVersion the reviewer was shown. A stale value is refused. */
  expectedLockVersion: z.number().int().nonnegative(),
  expectedRevision: z.number().int().positive().optional(),
}

const DecisionBody = z.object({ ...ConcurrencyFields, comment: z.string().min(1).max(4000).optional() }).strict()

const ReviseBody = z
  .object({
    ...ConcurrencyFields,
    changeReason: z.string().min(3).max(1000),
    edit: RevisionEditSchema,
  })
  .strict()

async function reportFor(req: Request) {
  const p = req.principal!
  const report = await prisma.auditReport.findFirst({
    where: { auditRunId: req.params.id!, tenantId: p.tenantId },
  })
  if (!report) throw new NotFoundError('No report has been generated for that audit run yet.')
  return report
}

/** Everything a review UI needs in one call. */
auditApprovalRoutes.get(
  '/runs/:id/approval',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const report = await reportFor(req)
    await ensureRevisionOne(report.id)

    const [revisions, events, findingCount] = await Promise.all([
      prisma.auditReportRevision.findMany({
        where: { auditReportId: report.id },
        orderBy: { revisionNumber: 'asc' },
        select: {
          revisionNumber: true,
          createdAt: true,
          createdByCrmUserId: true,
          createdByEmail: true,
          changeReason: true,
          sourceRevisionNumber: true,
          pdfSha256: true,
          pdfPageCount: true,
          pdfBytesSize: true,
          validationOk: true,
        },
      }),
      prisma.auditApprovalEvent.findMany({
        where: { auditReportId: report.id },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      prisma.catalogFinding.count({ where: { auditRunId: report.auditRunId } }),
    ])

    const status = report.status as ApprovalState
    const current = await prisma.auditReportRevision.findUnique({
      where: { auditReportId_revisionNumber: { auditReportId: report.id, revisionNumber: report.currentRevision } },
      select: { content: true, validation: true, validationOk: true, pdfSha256: true },
    })

    res.json({
      auditRunId: report.auditRunId,
      reportId: report.id,
      companyName: report.companyName,
      website: report.websiteUrl,
      status,
      // A UI renders its buttons from this rather than reimplementing the rules.
      availableActions: availableActions(status),
      canEdit: isEditable(status),
      currentRevision: report.currentRevision,
      approvedRevision: report.approvedRevision,
      // The token that must be echoed on any write to this report.
      lockVersion: report.lockVersion,
      reviewer: report.reviewerCrmUserId
        ? {
            crmUserId: report.reviewerCrmUserId,
            email: report.reviewerEmail,
            reviewedAt: report.reviewedAt,
            comment: report.decisionComment,
          }
        : null,
      findingCount,
      currentContent: current?.content ?? report.collateral,
      currentPdfSha256: current?.pdfSha256 ?? report.pdfSha256,
      validation: report.approvalValidation ?? current?.validation ?? null,
      approvable: Boolean(current?.validationOk),
      revisions,
      recentEvents: events,
      editableFields: Object.keys(RevisionEditSchema.shape),
      immutableFields: IMMUTABLE_FIELDS,
      note: 'Task #980 ends at a status. Delivery of this report to a client is a later task and is not implemented.',
    })
  }),
)

/** The full, append-only approval history. */
auditApprovalRoutes.get(
  '/runs/:id/approval/history',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const report = await reportFor(req)
    const events = await prisma.auditApprovalEvent.findMany({
      where: { auditReportId: report.id },
      orderBy: { createdAt: 'asc' },
    })

    res.json({
      auditRunId: report.auditRunId,
      companyName: report.companyName,
      total: events.length,
      events,
      disclaimers: [
        'This history is append-only: there is no update or delete path for approval events anywhere in the codebase.',
        'Refused approvals appear here too — an "approve_blocked" event means a reviewer attempted approval and validation rejected it.',
      ],
    })
  }),
)

/** Every revision, with its validation result. */
auditApprovalRoutes.get(
  '/runs/:id/report/revisions',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const report = await reportFor(req)
    await ensureRevisionOne(report.id)

    const revisions = await prisma.auditReportRevision.findMany({
      where: { auditReportId: report.id },
      orderBy: { revisionNumber: 'asc' },
      select: {
        revisionNumber: true,
        content: true,
        createdAt: true,
        createdByCrmUserId: true,
        createdByEmail: true,
        changeReason: true,
        sourceRevisionNumber: true,
        pdfSha256: true,
        pdfPageCount: true,
        pdfBytesSize: true,
        validation: true,
        validationOk: true,
      },
    })

    res.json({
      currentRevision: report.currentRevision,
      approvedRevision: report.approvedRevision,
      total: revisions.length,
      revisions,
      disclaimers: [
        'Revision 1 is the report as the audit generated it. It is never rewritten.',
        'Only presentation text differs between revisions. Metrics, counts, evidence references and the scope note are source-controlled and cannot be edited.',
      ],
    })
  }),
)

/** One revision's PDF, with its own digest. */
auditApprovalRoutes.get(
  '/runs/:id/report/revisions/:revision/report.pdf',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const report = await reportFor(req)
    const revisionNumber = Number(req.params.revision)
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) throw new NotFoundError('Revision not found.')

    await ensureRevisionOne(report.id)
    const revision = await prisma.auditReportRevision.findUnique({
      where: { auditReportId_revisionNumber: { auditReportId: report.id, revisionNumber } },
      select: { pdfBytes: true, pdfSha256: true, revisionNumber: true },
    })
    if (!revision?.pdfBytes) throw new NotFoundError('That revision has no rendered PDF.')

    const safeName = (report.companyName ?? 'audit')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${safeName}-r${revision.revisionNumber}.pdf"`)
    if (revision.pdfSha256) res.setHeader('X-Report-SHA256', revision.pdfSha256)
    res.setHeader('X-Report-Revision', String(revision.revisionNumber))
    res.send(Buffer.from(revision.pdfBytes))
  }),
)

/** Create a new revision from reviewer edits. */
auditApprovalRoutes.post(
  '/runs/:id/report/revise',
  requirePermission('approve'),
  validateBody(ReviseBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof ReviseBody>

    const result = await reviseReport({
      tenantId: p.tenantId,
      auditRunId: req.params.id!,
      reviewer: reviewerFrom(req),
      edit: body.edit,
      changeReason: body.changeReason,
      concurrency: { expectedLockVersion: body.expectedLockVersion, expectedRevision: body.expectedRevision },
    })

    // 200, not 201: a revision that fails validation is still stored, and the
    // caller needs to see why before it can be approved.
    res.json({
      ...result,
      approvable: result.validation.ok,
      note: result.validation.ok
        ? 'Revision saved and validated. It can now be approved.'
        : 'Revision saved, but it cannot be approved until the validation errors below are corrected.',
    })
  }),
)

/**
 * The review actions.
 *
 * `reopen` exists because an approved or rejected report is terminal: getting
 * back to review is an explicit new cycle with its own reason and its own audit
 * event, never a silent edit of a signed-off document.
 */
const ACTIONS: Array<{ path: string; action: ApprovalAction }> = [
  { path: 'start', action: 'start' },
  { path: 'approve', action: 'approve' },
  { path: 'request-changes', action: 'request_changes' },
  { path: 'reject', action: 'reject' },
  { path: 'reopen', action: 'reopen' },
]

for (const { path, action } of ACTIONS) {
  auditApprovalRoutes.post(
    `/runs/:id/approval/${path}`,
    requirePermission('approve'),
    validateBody(DecisionBody),
    asyncHandler(async (req, res) => {
      const p = req.principal!
      const body = req.body as z.infer<typeof DecisionBody>

      const outcome = await transition({
        tenantId: p.tenantId,
        auditRunId: req.params.id!,
        reviewer: reviewerFrom(req),
        action,
        comment: body.comment ?? null,
        concurrency: { expectedLockVersion: body.expectedLockVersion, expectedRevision: body.expectedRevision },
        requestId: req.requestId,
      })

      res.json({
        ...outcome,
        reviewer: { crmUserId: p.crmUserId, email: p.email },
        note:
          outcome.status === 'approved'
            ? 'Approved. The report is ready for a future delivery stage, which is not implemented in this task.'
            : undefined,
      })
    }),
  )
}
