import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_WEBSITE_AUDIT } from '../../platform/queue.js'
import { auditLimits, queueWebsiteAudit } from '../../websiteaudit/audit.js'
import { sortFindingsByPriority } from '../../websiteaudit/findings.js'
import { generateAuditReport } from '../../websiteaudit/report.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// TASK #979 — audit website and generate the site audit report. Read-only
// against the CRM and the open web. No CRM write-back, no outreach, no
// publishing.
//
// The evidence endpoints (/pages, /observations, /stats) report OBSERVATIONS
// only and never say whether anything is wrong. The analysis endpoints
// (/findings, /collateral, /report.pdf) are the ones allowed to name a gap, and
// each finding they return carries the observation records behind it.
//
// Keeping the two separate is what makes the findings checkable: the evidence
// exists independently of the conclusion drawn from it.
//
// The chain ends at status "ready_for_approval". Human approval is Task #980
// and is not implemented here.

export const websiteAuditRoutes = Router()

// Small on purpose: each audit is up to 25 requests aimed at someone else's
// server. Raising it is a decision, not a default.
const MAX_BATCH = 10

const AuditBody = z
  .object({
    crmCompanyIds: z.array(z.string().min(1)).min(1).max(MAX_BATCH).optional(),
    prospectSearchId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(MAX_BATCH).optional(),
  })
  .refine((b) => b.crmCompanyIds || b.prospectSearchId, {
    message: 'Provide either crmCompanyIds or prospectSearchId.',
  })

/** 1. Start a website audit. Returns run IDs; never holds the request open. */
websiteAuditRoutes.post(
  '/start',
  requirePermission('operate'),
  validateBody(AuditBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof AuditBody>

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
      const { id } = await queueWebsiteAudit({
        tenantId: p.tenantId,
        crmCompanyId,
        requestedByCrmUserId: p.crmUserId,
        prospectSearchId: body.prospectSearchId ?? null,
      })
      await enqueue(QUEUE_WEBSITE_AUDIT, { auditRunId: id })
      queued.push({ id, crmCompanyId })
    }

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'website_audit.queued',
      resourceType: 'WebsiteAuditRun',
      summary: `${queued.length} company/companies queued for website audit`,
      requestId: req.requestId,
    })

    res.status(202).json({ queued: queued.length, runs: queued, limits: auditLimits() })
  }),
)

/** 2. Run status. */
websiteAuditRoutes.get(
  '/runs/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')

    res.json({
      ...run,
      summary:
        run.status === 'partial'
          ? `Incomplete: ${run.pagesFetched} page(s) inspected before ${((run.limitsHit ?? []) as string[]).join(', ') || 'errors'} stopped the crawl.`
          : `${run.pagesFetched} page(s) inspected — ${run.productPages} product, ${run.categoryPages} category, ${run.otherPages} other.`,
    })
  }),
)

/** 3. Inspected pages. */
websiteAuditRoutes.get(
  '/runs/:id/pages',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true, companyName: true, startUrl: true },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')

    const pages = await prisma.auditedPage.findMany({
      where: {
        auditRunId: run.id,
        ...(typeof req.query.pageType === 'string' ? { pageType: req.query.pageType } : {}),
        ...(typeof req.query.outcome === 'string' ? { outcome: req.query.outcome } : {}),
      },
      orderBy: [{ depth: 'asc' }, { fetchedAt: 'asc' }],
      take: 500,
    })

    const byType: Record<string, number> = {}
    const byOutcome: Record<string, number> = {}
    pages.forEach((x) => {
      byType[x.pageType] = (byType[x.pageType] ?? 0) + 1
      byOutcome[x.outcome] = (byOutcome[x.outcome] ?? 0) + 1
    })

    res.json({
      runId: run.id,
      companyName: run.companyName,
      startUrl: run.startUrl,
      total: pages.length,
      byType,
      byOutcome,
      pages,
      disclaimers: [
        'A page recorded here was VISITED. HTTP 200 is not treated as proof it is a meaningful page — see `outcome` for soft_404 and duplicate.',
        '`pageType` is a classification with its supporting signals in `typeSignals`, not a judgement about the page.',
      ],
    })
  }),
)

/** 4. Extracted evidence, page by page. */
websiteAuditRoutes.get(
  '/runs/:id/observations',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true, companyName: true, startUrl: true },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')

    const observations = await prisma.pageObservation.findMany({
      where: {
        auditRunId: run.id,
        ...(typeof req.query.field === 'string' ? { field: req.query.field } : {}),
        ...(typeof req.query.status === 'string' ? { status: req.query.status } : {}),
        ...(typeof req.query.pageId === 'string' ? { pageId: req.query.pageId } : {}),
      },
      orderBy: [{ pageId: 'asc' }, { field: 'asc' }],
      take: 2000,
      include: {
        page: { select: { requestedUrl: true, finalUrl: true, pageType: true, fetchedAt: true } },
      },
    })

    // Field-level coverage: how often each field was observed versus absent.
    // A count, not a verdict — Stage 6 decides what the absences mean.
    const coverage: Record<string, { observed: number; not_observed: number; could_not_determine: number }> = {}
    observations.forEach((o) => {
      coverage[o.field] ??= { observed: 0, not_observed: 0, could_not_determine: 0 }
      coverage[o.field]![o.status as keyof (typeof coverage)[string]] += 1
    })

    res.json({
      runId: run.id,
      companyName: run.companyName,
      total: observations.length,
      coverage,
      observations: observations.map((o) => ({
        field: o.field,
        status: o.status,
        value: o.value,
        evidence: {
          sourceUrl: o.page.finalUrl ?? o.page.requestedUrl,
          pageType: o.page.pageType,
          extractedAt: o.observedAt,
          method: o.method,
          sourcePath: o.sourcePath,
          fragment: o.fragment,
        },
      })),
      disclaimers: [
        'status "not_observed" means the field was looked for and was not present on the inspected page. It does NOT mean the data is missing from the catalogue.',
        'status "could_not_determine" means something field-shaped was present but could not be attributed with confidence.',
        'Values are exactly as the page stated them — never normalised, inferred, or completed.',
        'This is website evidence collected from an untrusted third-party source. It is recorded, not believed.',
        'Stage 5 reports WHAT WAS OBSERVED. It does not assess catalogue quality.',
      ],
    })
  }),
)

/** 5. Crawl statistics. */
websiteAuditRoutes.get(
  '/runs/:id/stats',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')

    const [observed, notObserved, undetermined] = await Promise.all([
      prisma.pageObservation.count({ where: { auditRunId: run.id, status: 'observed' } }),
      prisma.pageObservation.count({ where: { auditRunId: run.id, status: 'not_observed' } }),
      prisma.pageObservation.count({ where: { auditRunId: run.id, status: 'could_not_determine' } }),
    ])

    res.json({
      runId: run.id,
      crmCompanyId: run.crmCompanyId,
      companyName: run.companyName,
      startUrl: run.startUrl,
      rootHost: run.rootHost,
      status: run.status,
      crawl: {
        pagesFetched: run.pagesFetched,
        pagesSkipped: run.pagesSkipped,
        productPages: run.productPages,
        categoryPages: run.categoryPages,
        otherPages: run.otherPages,
        duplicatePages: run.duplicatePages,
        canonicalDuplicates: run.canonicalDuplicates,
        soft404Pages: run.soft404Pages,
        httpErrors: run.httpErrors,
        unreachablePages: run.unreachablePages,
        structuredDataPages: run.structuredDataPages,
        totalBytes: run.totalBytes,
      },
      observations: { observed, notObserved, couldNotDetermine: undetermined },
      limitsApplied: run.limitsApplied,
      limitsHit: run.limitsHit,
      failureReason: run.failureReason,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })
  }),
)

// ── TASK #979: findings, collateral and the PDF report ─────────────────────
//
// These read artifacts the audit run already produced. Report generation runs
// automatically at the end of a crawl; the POST below re-runs it from the
// stored observations, which is useful after an analyser change and cannot
// re-crawl the prospect's site.

/** 6. Catalog / product-data findings for a run. */
websiteAuditRoutes.get(
  '/runs/:id/findings',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true, companyName: true, startUrl: true, pagesFetched: true, productPages: true, categoryPages: true },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')

    const findings = await prisma.catalogFinding.findMany({
      where: { auditRunId: run.id, ...(typeof req.query.priority === 'string' ? { priority: req.query.priority } : {}) },
      orderBy: [{ priority: 'asc' }, { affectedCount: 'desc' }],
    })

    const byPriority: Record<string, number> = {}
    findings.forEach((f) => (byPriority[f.priority] = (byPriority[f.priority] ?? 0) + 1))

    res.json({
      runId: run.id,
      companyName: run.companyName,
      website: run.startUrl,
      sample: {
        pagesInspected: run.pagesFetched,
        productPagesInspected: run.productPages,
        categoryPagesInspected: run.categoryPages,
      },
      total: findings.length,
      byPriority,
      findings,
      disclaimers: [
        'Every finding is derived from stored observations and carries the observation references behind it.',
        'Every metric names the inspected sample it came from. Nothing here is expressed as a percentage of the catalogue, because only the inspected pages were seen.',
        'Priority is computed from a stated field tier and the share of the inspected sample affected — see priorityReasons on each finding.',
        'These findings describe the inspected pages on the date of the audit run, not the catalogue as a whole.',
      ],
    })
  }),
)

/** 7. Account-specific sales collateral for a run. */
websiteAuditRoutes.get(
  '/runs/:id/collateral',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const report = await prisma.auditReport.findFirst({
      where: { auditRunId: req.params.id, tenantId: p.tenantId },
      select: {
        auditRunId: true,
        companyName: true,
        websiteUrl: true,
        auditDate: true,
        pagesInspected: true,
        productPagesInspected: true,
        categoryPagesInspected: true,
        findingCount: true,
        highPriorityCount: true,
        collateral: true,
        status: true,
        generatedAt: true,
        pdfSha256: true,
        pdfPageCount: true,
        pdfBytesSize: true,
      },
    })
    if (!report) throw new NotFoundError('No report has been generated for that audit run yet.')

    res.json({
      ...report,
      pdfAvailable: Boolean(report.pdfSha256),
      nextStage:
        'Task #979 ends at ready_for_approval. Human approval of this report is Task #980 and is not implemented here.',
    })
  }),
)

/** 8. The rendered PDF. */
websiteAuditRoutes.get(
  '/runs/:id/report.pdf',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const report = await prisma.auditReport.findFirst({
      where: { auditRunId: req.params.id, tenantId: p.tenantId },
      select: { pdfBytes: true, pdfSha256: true, companyName: true, auditDate: true },
    })
    if (!report?.pdfBytes) throw new NotFoundError('No PDF has been generated for that audit run yet.')

    const safeName = (report.companyName ?? 'audit')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${safeName}-product-data-health-check.pdf"`)
    // The digest of the stored bytes, so a served copy can be shown to be the
    // one that was generated.
    if (report.pdfSha256) res.setHeader('X-Report-SHA256', report.pdfSha256)
    res.send(Buffer.from(report.pdfBytes))
  }),
)

/** 9. Regenerate findings, collateral and PDF from the STORED observations. */
websiteAuditRoutes.post(
  '/runs/:id/report',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')

    // No network access: this re-reads AuditedPage and PageObservation only.
    const result = await generateAuditReport(run.id)
    if (!result) throw new NotFoundError('Website audit run not found.')

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'website_audit.report_regenerated',
      resourceType: 'AuditReport',
      resourceId: run.id,
      summary: `Report regenerated from stored observations: ${result.findings.length} finding(s)`,
      requestId: req.requestId,
    })

    res.json({
      runId: run.id,
      findings: result.findings.length,
      highPriority: result.findings.filter((f) => f.priority === 'high').length,
      pdf: { sha256: result.pdfSha256, pageCount: result.pdfPageCount, bytes: result.pdfBytes },
      status: 'ready_for_approval',
      note: 'Regenerated from stored observations only — the prospect site was not contacted again.',
    })
  }),
)
