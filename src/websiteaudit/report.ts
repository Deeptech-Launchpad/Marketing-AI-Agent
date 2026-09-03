import { audit as auditLog } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { ConflictError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { buildCollateral, type SalesCollateral } from './collateral.js'
import { analyseObservations, type AuditContext, type CatalogFinding, type ObservationRow } from './findings.js'
import { renderAuditPdf } from './pdfReport.js'

// TASK #979 — the second half of the task: analysis, collateral, PDF.
//
//   website audit  ->  catalog findings  ->  sales collateral  ->  PDF
//                                                              ->  READY FOR HUMAN APPROVAL
//
// It runs on the stored output of the crawl, never on live pages. That is what
// makes it re-runnable and auditable: the same run analysed twice produces the
// same findings, because the inputs are rows in a table rather than a website
// that changed overnight.
//
// The chain STOPS at ready_for_approval. Nothing here notifies anyone, sends
// anything, or advances an approval state — Task #980 owns that.

export interface ReportResult {
  findings: CatalogFinding[]
  collateral: SalesCollateral
  pdfSha256: string
  pdfPageCount: number
  pdfBytes: number
}

/**
 * Analyses one completed audit run and produces its report artifacts.
 *
 * Idempotent by construction: findings and the report row for this run are
 * replaced, and the analysis is deterministic, so re-running yields the same
 * output rather than accumulating duplicates.
 */
export async function generateAuditReport(auditRunId: string): Promise<ReportResult | null> {
  const run = await prisma.websiteAuditRun.findUnique({ where: { id: auditRunId } })
  if (!run) return null

  const log = logger.child({ auditRunId, crmCompanyId: run.crmCompanyId })

  // Task #980 boundary. Regenerating rebuilds the collateral and resets the
  // revision history, so it must never run over a report a human has started
  // reviewing — that would delete the revision they approved and quietly send
  // an approved report back to ready_for_approval. Once a report is in the
  // workflow, a fresh document comes from a new audit run, not from
  // overwriting this one.
  const existing = await prisma.auditReport.findUnique({
    where: { auditRunId },
    select: { status: true, currentRevision: true, approvedRevision: true },
  })
  if (existing && existing.status !== 'ready_for_approval') {
    throw new ConflictError(
      `This report is "${existing.status}" and cannot be regenerated: doing so would discard revision history and any approval decision. Start a new audit run for a fresh report.`,
      { status: existing.status, currentRevision: existing.currentRevision, approvedRevision: existing.approvedRevision },
    )
  }

  const pages = await prisma.auditedPage.findMany({
    where: { auditRunId },
    select: { id: true, requestedUrl: true, finalUrl: true, pageType: true, outcome: true, httpStatus: true, failureReason: true },
  })
  const pageById = new Map(pages.map((p) => [p.id, p]))

  const stored = await prisma.pageObservation.findMany({
    where: { auditRunId },
    select: {
      id: true,
      pageId: true,
      field: true,
      status: true,
      value: true,
      sourcePath: true,
      fragment: true,
      observedAt: true,
    },
  })

  const observations: ObservationRow[] = stored.map((o) => {
    const page = pageById.get(o.pageId)
    return {
      id: o.id,
      pageId: o.pageId,
      field: o.field,
      status: o.status,
      value: o.value,
      sourcePath: o.sourcePath,
      fragment: o.fragment,
      observedAt: o.observedAt,
      pageUrl: page?.finalUrl ?? page?.requestedUrl ?? '(unknown page)',
      pageType: page?.pageType ?? 'unknown',
    }
  })

  const ctx: AuditContext = {
    pagesFetched: run.pagesFetched,
    productPages: run.productPages,
    categoryPages: run.categoryPages,
    duplicatePages: run.duplicatePages,
    canonicalDuplicates: run.canonicalDuplicates,
    soft404Pages: run.soft404Pages,
    httpErrors: run.httpErrors,
    httpErrorPages: pages
      .filter((p) => p.outcome === 'http_error')
      .map((p) => ({ pageId: p.id, url: p.finalUrl ?? p.requestedUrl, status: p.httpStatus, reason: p.failureReason })),
  }

  const findings = analyseObservations(observations, ctx)

  const collateral = buildCollateral({
    companyName: run.companyName ?? '(company name not recorded)',
    website: run.startUrl,
    auditDate: run.completedAt ?? run.createdAt,
    pagesInspected: run.pagesFetched,
    productPagesInspected: run.productPages,
    categoryPagesInspected: run.categoryPages,
    findings,
    limitsHit: ((run.limitsHit ?? []) as string[]) ?? [],
  })

  const pdf = await renderAuditPdf(collateral, findings)

  // Replace rather than accumulate: re-analysing a run must not double its
  // findings. Deterministic analysis makes the replacement a no-op in content.
  await prisma.catalogFinding.deleteMany({ where: { auditRunId } })
  if (findings.length) {
    await prisma.catalogFinding.createMany({
      data: findings.map((f) => ({
        id: newId(),
        tenantId: run.tenantId,
        auditRunId,
        crmCompanyId: run.crmCompanyId,
        code: f.code,
        title: f.title,
        category: f.category,
        priority: f.priority,
        priorityReasons: f.priorityReasons as never,
        affectedCount: f.affectedCount,
        observedCount: f.observedCount,
        sampleSize: f.sampleSize,
        sampleUnit: f.sampleUnit,
        metric: f.metric,
        finding: f.finding,
        impact: f.impact,
        recommendation: f.recommendation,
        evidence: f.evidence as never,
      })),
    })
  }

  const reportData = {
    tenantId: run.tenantId,
    crmCompanyId: run.crmCompanyId,
    companyName: run.companyName,
    websiteUrl: run.startUrl,
    auditDate: run.completedAt ?? run.createdAt,
    pagesInspected: run.pagesFetched,
    productPagesInspected: run.productPages,
    categoryPagesInspected: run.categoryPages,
    findingCount: findings.length,
    highPriorityCount: findings.filter((f) => f.priority === 'high').length,
    collateral: collateral as never,
    pdfBytes: pdf.bytes,
    pdfSha256: pdf.sha256,
    pdfPageCount: pdf.pageCount,
    pdfBytesSize: pdf.bytes.length,
    // Task #979 ends here. Task #980 owns everything after it.
    status: 'ready_for_approval',
    currentRevision: 1,
    generatedAt: new Date(),
  }

  const saved = await prisma.auditReport.upsert({
    where: { auditRunId },
    create: { id: newId(), auditRunId, ...reportData },
    update: reportData,
  })

  // Task #980: revision 1 is the generated report. Writing it here means the
  // review workflow always has a base to edit from, and re-generating resets
  // the report to a single revision — which is correct, because a regenerated
  // report is a new document and any edits made against the old one described
  // text that no longer exists.
  await prisma.auditReportRevision.deleteMany({ where: { auditReportId: saved.id } })
  await prisma.auditReportRevision.create({
    data: {
      id: newId(),
      tenantId: run.tenantId,
      auditReportId: saved.id,
      auditRunId,
      revisionNumber: 1,
      content: collateral as never,
      pdfBytes: pdf.bytes,
      pdfSha256: pdf.sha256,
      pdfPageCount: pdf.pageCount,
      pdfBytesSize: pdf.bytes.length,
      changeReason: 'Generated by the website audit (Task #979).',
      validationOk: false,
    },
  })

  await auditLog({
    tenantId: run.tenantId,
    actorType: 'agent',
    action: 'website_audit.report_generated',
    resourceType: 'AuditReport',
    resourceId: auditRunId,
    dataClass: 'internal',
    summary: `${run.companyName ?? run.crmCompanyId}: ${findings.length} finding(s), PDF ${pdf.pageCount}pp — ready for approval`,
  })

  log.info(
    { findings: findings.length, high: reportData.highPriorityCount, pdfBytes: pdf.bytes.length },
    'audit report generated — ready for human approval',
  )

  return {
    findings,
    collateral,
    pdfSha256: pdf.sha256,
    pdfPageCount: pdf.pageCount,
    pdfBytes: pdf.bytes.length,
  }
}
