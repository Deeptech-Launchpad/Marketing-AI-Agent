import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import { ConflictError, NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { buildCollateral, type SalesCollateral } from './collateral.js'
import { buildComparison, type ComparisonResult, type PeerAudit } from './comparison.js'
import { loadBeforeAfterExamples } from './examples.js'
import type { CatalogFinding } from './findings.js'
import { renderAuditPdf, type PdfResult } from './pdfReport.js'

const log = logger.child({ module: 'customer-report' })

// PHASE 6 — the only way to produce a customer-facing report.
//
// Before this file existed, the customer rendering was reachable only by
// calling buildCollateral with audience:'customer' directly, which meant the
// approval rule was a convention rather than a control. This is the gate.
//
// THE INVARIANT
//
//   A customer report may be produced ONLY from a report whose approval state
//   is `approved`, and only when the legal disclaimer has been configured.
//
// Both are checked here, before any content is assembled, and both fail
// closed. `REPORT_ALLOW_UNAPPROVED` relaxes them for local development and is
// refused at process start in production (see config/env.ts), so there is no
// arrangement of settings in which a production process can send an unreviewed
// document.
//
// WHAT THIS FUNCTION NEVER DOES
//
//   It writes nothing. No revision is created, no status changes, no PDF is
//   stored over an approved one. Generating a customer copy is a READ of an
//   approved report, and a read cannot damage the thing it read. That is why
//   the Task #980 state machine is untouched by this file: it is not a
//   transition, so it does not belong in the transition table.

export interface CustomerReportInput {
  tenantId: string
  auditRunId: string
  /** Overrides the configured example count for this generation. */
  sampleCount?: number
  /** A Workbench link to render as a QR code. */
  workbenchUrl?: string | null
  /**
   * A peer to compare against. Supplied by the CALLER, never chosen here —
   * see the note on peer policy below.
   */
  peer?: PeerAudit | null
}

export interface CustomerReportResult {
  collateral: SalesCollateral
  pdf: PdfResult
  /** The approved revision this was rendered from, for attribution. */
  revisionNumber: number
  approvalState: string
  /** Stated so a caller can report why there is only one, or none. */
  exampleNote: string | null
}

/**
 * Peer selection is deliberately not implemented.
 *
 * The Team Answer requires every comparative observation to have a source and
 * forbids inventing rankings, but it does not say WHICH company counts as a
 * comparable peer, or who authorises auditing them. Those are business
 * decisions, and guessing at them would produce exactly the unsupported
 * comparison the requirement prohibits.
 *
 * So the hook is here and the policy is absent: a caller may pass a peer that
 * has genuinely been audited by this platform, and until somebody defines the
 * rule, nothing does. The comparison engine refuses everything else.
 */
export function resolvePeer(explicit: PeerAudit | null | undefined): PeerAudit | null {
  return explicit ?? null
}

export async function generateCustomerReport(input: CustomerReportInput): Promise<CustomerReportResult> {
  const report = await prisma.auditReport.findFirst({
    where: { tenantId: input.tenantId, auditRunId: input.auditRunId },
  })
  if (!report) {
    throw new NotFoundError('No audit report exists for that run, so there is nothing to send.')
  }

  // ── GATE 1: approval ───────────────────────────────────────────────────
  if (report.status !== 'approved') {
    if (!env.REPORT_ALLOW_UNAPPROVED) {
      throw new ConflictError(
        `This report is "${report.status}". A customer report may only be produced from a report approved in ` +
          'Task #980.',
        {
          status: report.status,
          hint: 'Approve the report, or set REPORT_ALLOW_UNAPPROVED=true in development only.',
        },
      )
    }
    log.warn(
      { status: report.status, auditRunId: input.auditRunId },
      'customer report generated from an UNAPPROVED report — development bypass is enabled',
    )
  }

  // ── GATE 2: the legal disclaimer ───────────────────────────────────────
  const disclaimer = env.REPORT_LEGAL_DISCLAIMER.trim()
  if (!disclaimer && !env.REPORT_ALLOW_UNAPPROVED) {
    throw new ConflictError(
      'REPORT_LEGAL_DISCLAIMER is not configured. A customer-facing report must carry the disclaimer wording ' +
        'confirmed by legal and compliance (Team Answer, Section F.6), and this platform will not invent it.',
      { hint: 'Set REPORT_LEGAL_DISCLAIMER, or set REPORT_ALLOW_UNAPPROVED=true in development only.' },
    )
  }

  // ── The approved content ───────────────────────────────────────────────
  //
  // Findings come from the store, which is what the approved report was built
  // from. Reviewer EDITS live on the approved revision, so those are carried
  // across: a reviewer who rewrote the summary approved their wording, not
  // ours, and regenerating from findings alone would silently discard it.
  const revision = await prisma.auditReportRevision.findFirst({
    where: { auditReportId: report.id, revisionNumber: report.currentRevision },
  })
  const approvedContent = (revision?.content ?? report.collateral) as unknown as SalesCollateral | null

  const rows = await prisma.catalogFinding.findMany({
    where: { auditRunId: input.auditRunId },
    orderBy: { affectedCount: 'desc' },
  })
  const findings: CatalogFinding[] = rows.map((r) => ({
    code: r.code,
    title: r.title,
    category: r.category,
    priority: r.priority as CatalogFinding['priority'],
    priorityReasons: r.priorityReasons as string[],
    affectedCount: r.affectedCount,
    observedCount: r.observedCount,
    sampleSize: r.sampleSize,
    sampleUnit: r.sampleUnit,
    metric: r.metric,
    finding: r.finding,
    impact: r.impact,
    recommendation: r.recommendation,
    evidence: (r.evidence ?? []) as unknown as CatalogFinding['evidence'],
  }))

  const run = await prisma.websiteAuditRun.findUniqueOrThrow({ where: { id: input.auditRunId } })

  const examples = await loadBeforeAfterExamples(input.tenantId, input.auditRunId, {
    maxFieldsPerExample: 4,
  })

  const peer = resolvePeer(input.peer)
  const comparison: ComparisonResult = buildComparison({
    prospectLabel: run.companyName ?? 'This company',
    prospectProductPages: run.productPages,
    prospectFindings: findings,
    peer,
    maxRows: env.REPORT_COMPARISON_ROWS,
  })

  const collateral = buildCollateral({
    audience: 'customer',
    companyName: run.companyName ?? '(company name not recorded)',
    website: run.startUrl,
    auditDate: run.completedAt ?? run.createdAt,
    pagesInspected: run.pagesFetched,
    productPagesInspected: run.productPages,
    categoryPagesInspected: run.categoryPages,
    findings,
    limitsHit: ((run.limitsHit ?? []) as string[]) ?? [],
    examples: examples.examples,
    comparison,
    sampleCount: input.sampleCount,
    hasWorkbenchDemo: examples.examples.length > 0,
    legalDisclaimer: disclaimer || null,
  })

  // Reviewer edits, carried across from the approved revision.
  if (approvedContent) {
    if (approvedContent.headline) collateral.headline = approvedContent.headline
    if (approvedContent.summary) collateral.summary = approvedContent.summary
    if (approvedContent.nextStep) collateral.nextStep = approvedContent.nextStep
    if (approvedContent.businessImpact?.length) collateral.businessImpact = [...approvedContent.businessImpact]
  }

  const pdf = await renderAuditPdf(collateral, findings, {
    workbenchUrl: input.workbenchUrl ?? null,
    logoPath: env.REPORT_BRAND_LOGO_PATH,
  })

  return {
    collateral,
    pdf,
    revisionNumber: report.currentRevision,
    approvalState: report.status,
    exampleNote: examples.reason,
  }
}
