import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { loadProductEvidence } from '../../websiteaudit/productEvidence.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_WEBSITE_AUDIT } from '../../platform/queue.js'
import { auditLimits, queueWebsiteAudit } from '../../websiteaudit/audit.js'
import { sortFindingsByPriority } from '../../websiteaudit/findings.js'
import { generateAuditReport } from '../../websiteaudit/report.js'
import { buildCustomerView } from '../../websiteaudit/customerView.js'
import { AssistantTurnSchema, askReportAssistant } from '../../websiteaudit/reportAssistant.js'
import {
  generateCustomerReport,
  planCustomerReportQr,
  type CustomerReportQrState,
} from '../../websiteaudit/customerReport.js'
import { mintLink, workbenchQrUrl } from '../../workbench/links.js'
import { brandedEnrichedPdpHtml } from '../../workbench/enrichedPdpBrand.js'
import type { PdpEnrichment } from '../../websiteaudit/pdpEnrichment.js'
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

/**
 * 1b. The runs this company already has, newest first.
 *
 * Added because selecting a company in Shared Context could not reach its own
 * work. Every run-scoped screen resolves its run from the URL or from a
 * per-company key in the operator's browser, and a colleague — or the same
 * person on another machine — has neither. A company with three completed
 * audits and an approved report therefore read "No audit run open", which is
 * indistinguishable from never having been audited.
 *
 * Scoped by tenant and company, so this can only ever list runs belonging to
 * the company asked about. It lists; it starts nothing.
 */
websiteAuditRoutes.get(
  '/companies/:crmCompanyId/runs',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 50)

    const runs = await prisma.websiteAuditRun.findMany({
      where: { tenantId: p.tenantId, crmCompanyId: req.params.crmCompanyId! },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        crmCompanyId: true,
        companyName: true,
        startUrl: true,
        status: true,
        pagesFetched: true,
        productPages: true,
        categoryPages: true,
        failureReason: true,
        createdAt: true,
        completedAt: true,
      },
    })

    // Which run a screen should open: the newest that actually inspected
    // something. A queued or zero-page run is listed but never preferred —
    // opening one is what put a zero-valued report on screen as if it were a
    // finding. Null when this company has no such run, which the screens say
    // rather than drawing empty counts.
    const usable = runs.find(
      (r) => (r.status === 'completed' || r.status === 'partial') && r.pagesFetched > 0,
    )

    res.json({
      crmCompanyId: req.params.crmCompanyId,
      total: runs.length,
      latestUsableRunId: usable?.id ?? null,
      runs,
    })
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

    // The page photographs are served by their own endpoints, not inlined here.
    const { pdpBeforeCapture, pdpAfterCapture, pdpEnrichment, ...fields } = run
    res.json({
      ...fields,
      pdp: {
        hasBeforeCapture: Boolean(pdpBeforeCapture),
        hasAfterCapture: Boolean(pdpAfterCapture),
        enrichmentStatus: (pdpEnrichment as { status?: string } | null)?.status ?? null,
      },
      summary:
        run.status === 'partial'
          ? `Incomplete: ${run.pagesFetched} page(s) inspected before ${((run.limitsHit ?? []) as string[]).join(', ') || 'errors'} stopped the crawl.`
          : `${run.pagesFetched} page(s) inspected — ${run.productPages} product, ${run.categoryPages} category, ${run.otherPages} other.`,
      // WHICH OF THE FOUR EVIDENCE STATES THIS RUN REACHED.
      //
      // Carried on the RUN, not only on the customer view, because the state
      // that most needs saying is the one the customer view cannot reach: a
      // company with no website never gets a report, so /customer-view 404s
      // and every screen fell back to a generic absence. "This website was
      // not read, so nothing is known about their catalogue" is a different
      // statement from "nothing has been built yet", and the first is only
      // available here.
      productEvidence: await loadProductEvidence(run.id),
    })
  }),
)

/**
 * The End PDP audit: which case the link is in, and the enriched record.
 *
 * `assessment` is null for a run made before the End PDP audit existed.
 */
websiteAuditRoutes.get(
  '/runs/:id/pdp',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true, companyName: true, pdpAssessment: true, pdpEnrichment: true, pdpBeforeCapture: true, pdpAfterCapture: true },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')
    res.json({
      auditRunId: run.id,
      companyName: run.companyName,
      assessment: run.pdpAssessment ?? null,
      enrichment: run.pdpEnrichment ?? null,
      captures: { before: Boolean(run.pdpBeforeCapture), after: Boolean(run.pdpAfterCapture) },
    })
  }),
)

/** The enriched product page — the Workbench "After" view — as a standalone HTML document. */
websiteAuditRoutes.get(
  '/runs/:id/pdp/after.html',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')
    // The Workbench After view: the company's own branding around our
    // enriched product-page structure.
    const html = await brandedEnrichedPdpHtml(run.id)
    if (!html) throw new NotFoundError('No enriched product record exists for this run.')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.send(html)
  }),
)

/** The photograph of the original page (`before`) or the enriched page (`after`). */
websiteAuditRoutes.get(
  '/runs/:id/pdp/:which(before|after).jpg',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { pdpBeforeCapture: true, pdpAfterCapture: true },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')
    const bytes = req.params.which === 'before' ? run.pdpBeforeCapture : run.pdpAfterCapture
    if (!bytes) throw new NotFoundError('No capture of that page exists for this run.')
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.send(Buffer.from(bytes))
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

/**
 * 7b. The CUSTOMER-FACING reading of a run.
 *
 * What the Audit Report and AI Workbench screens render: this company's own
 * products, images, gaps and categories, rather than the audit's internals.
 * Available before approval so an internal preview can be shown; `approved`
 * says whether it may be put in front of a customer, and the caller enforces
 * that.
 */
websiteAuditRoutes.get(
  '/runs/:id/customer-view',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    res.json(await buildCustomerView(p.tenantId, req.params.id!))
  }),
)

/**
 * The Audit Report assistant.
 *
 * Grounded in this one audit, and read-only: it answers, drafts, and may
 * PROPOSE an edit to the report's editable prose. Applying a proposal is a
 * separate call to the existing /report/revise route, which re-validates and
 * leaves approval to a reviewer — so this route has no write path of its own.
 *
 * `operate` rather than `view`: every call spends model budget.
 */
const AssistantBody = z
  .object({
    message: z.string().trim().min(1).max(2000),
    history: z.array(AssistantTurnSchema).max(24).default([]),
  })
  .strict()

websiteAuditRoutes.post(
  '/runs/:id/assistant',
  requirePermission('operate'),
  validateBody(AssistantBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof AssistantBody>
    const answer = await askReportAssistant({
      tenantId: p.tenantId,
      auditRunId: req.params.id!,
      message: body.message,
      history: body.history,
    })

    // Recorded without the conversation text: the audit trail needs to show
    // that the assistant was used and what it offered, not repeat the chat.
    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'website_audit.assistant_asked',
      resourceType: 'WebsiteAuditRun',
      resourceId: req.params.id!,
      summary: `Audit assistant: ${answer.drafts.length} draft(s), ${answer.proposedEdit ? (answer.proposedEdit.blocked ? 'blocked edit proposal' : 'edit proposal') : 'no edit proposal'}`,
      requestId: req.requestId,
    })

    res.json(answer)
  }),
)

/**
 * 8b. The 5-6 page CUSTOMER PDF.
 *
 * Distinct from /report.pdf, which is the internal document. This one is gated
 * on approval by generateCustomerReport itself.
 *
 * THE QR CODE, AND WHY IT IS NOT ALWAYS THERE
 *
 * The QR points at a customer-safe share link for THIS demonstration, and a
 * share link is a bearer credential. The first version of this handler minted
 * one on every request. That was survivable while the only caller was a
 * download button and became link spam the moment the Audit Report screen
 * embedded the PDF in an inline viewer: one live customer credential per page
 * view, all against a single demonstration.
 *
 * So minting is now the exception rather than the default step:
 *
 *   unapproved  mints nothing. A share link is a bearer credential and minting
 *           one is an act of publication, so it sits on the approved side of
 *           the gate alongside the QR and the watermark. It did not, and a
 *           review export therefore spent the one link the approved copy was
 *           going to carry — leaving the document that actually reaches the
 *           customer with no QR on it.
 *   ?qr=0   mints nothing and renders no QR. This is what the inline viewer
 *           asks for, so that merely LOOKING at the report cannot create a
 *           credential.
 *   default at most ONE link per demonstration carries CUSTOMER_REPORT_LABEL.
 *           When a usable one already exists the PDF is rendered WITHOUT a QR,
 *           because mintLink returns the plaintext token exactly once and the
 *           row keeps only its hash — an existing link's URL is genuinely
 *           unrecoverable, and both ways around that (storing the plaintext,
 *           or printing a code built from something other than the real token)
 *           are worse than a page with no QR on it.
 *
 * X-Report-QR says which of those the caller got. A fresh QR is therefore an
 * act rather than a side effect: revoke the labelled link, or let it expire,
 * and the next export mints its replacement.
 */

// The marker that makes "the link this endpoint minted" findable on the next
// request. Label is the only field there is to match on — the token is a hash
// and nothing else on the row says what the link was for.
const CUSTOMER_REPORT_LABEL = 'Customer report QR'

websiteAuditRoutes.get(
  '/runs/:id/customer-report.pdf',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const runId = req.params.id!

    const run = await prisma.websiteAuditRun.findFirst({
      where: { id: runId, tenantId: p.tenantId },
      select: { id: true, companyName: true },
    })
    if (!run) throw new NotFoundError('Website audit run not found.')

    // Opting out is a value, not the presence of the parameter: a stray ?qr=
    // must not silently drop the QR from a document somebody is about to hand
    // to a customer.
    const qrRequested = req.query.qr !== '0' && req.query.qr !== 'false'

    // A link belongs to a demonstration, which belongs to this run, which
    // belongs to one company — so the code cannot resolve to another
    // customer's material.
    const demo = qrRequested
      ? await prisma.workbenchDemo.findFirst({
          where: { auditRunId: runId, tenantId: p.tenantId },
          select: { id: true, status: true },
        })
      : null

    // MINTING IS PUBLICATION, so approval is read BEFORE anything is created.
    // This endpoint used to mint on the demonstration's readiness alone, which
    // let a review export spend the one QR the approved copy was going to
    // carry. The rule itself lives with generateCustomerReport, which applies
    // the same one to the document.
    const reportRow = qrRequested
      ? await prisma.auditReport.findFirst({
          where: { tenantId: p.tenantId, auditRunId: runId },
          select: { status: true },
        })
      : null
    const plan = planCustomerReportQr({
      qrRequested,
      reportStatus: reportRow?.status ?? null,
      demoStatus: demo?.status ?? null,
    })

    let qrTarget: string | null = null
    let qrState: CustomerReportQrState = plan.state

    if (plan.consider && demo) {
      // maxViews is checked in JS because comparing it to viewCount is a
      // column-to-column comparison the query cannot express. This is the same
      // predicate resolveLink applies when the customer arrives, so a link
      // treated as usable here is one that would actually open.
      const existing = await prisma.workbenchLink.findMany({
        where: {
          tenantId: p.tenantId,
          demoId: demo.id,
          label: CUSTOMER_REPORT_LABEL,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, maxViews: true, viewCount: true },
      })
      const usable = existing.find((l) => l.maxViews === null || l.viewCount < l.maxViews)

      if (usable) {
        // No QR on purpose: that link is alive and shareable, but its URL
        // cannot be rebuilt from the stored hash, and a second link for the
        // same demonstration is exactly what this endpoint stopped doing.
        qrState = 'existing-link-not-recoverable'
      } else {
        const minted = await mintLink({
          tenantId: p.tenantId,
          demoId: demo.id,
          createdByCrmUserId: p.crmUserId,
          label: CUSTOMER_REPORT_LABEL,
        })
        qrTarget = workbenchQrUrl(minted.token)
        qrState = 'minted'

        // Recorded the way POST /workbench/link records its own mint. A
        // customer-facing credential created on the side of a PDF export still
        // has to appear in the one place someone would go looking for it.
        await audit({
          tenantId: p.tenantId,
          actorType: 'user',
          actorCrmUserId: p.crmUserId,
          action: 'workbench.link_minted',
          resourceType: 'WorkbenchLink',
          resourceId: minted.linkId,
          dataClass: 'internal',
          summary: `Share link created for the customer report QR, expires ${minted.expiresAt
            .toISOString()
            .slice(0, 10)}`,
          requestId: req.requestId,
        })
      }
    }

    const result = await generateCustomerReport({
      tenantId: p.tenantId,
      auditRunId: runId,
      workbenchUrl: qrTarget,
      sampleCount: 2,
      // The person asking for this copy signs it: the report's "Prepared by"
      // block names them, so the customer knows who handed it over.
      requestedBy: { name: p.name, email: p.email },
    })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'website_audit.customer_report_exported',
      resourceType: 'AuditReport',
      resourceId: runId,
      summary: `Customer report exported: ${result.pdf.pageCount} page(s), audience ${result.audience}, QR ${qrState}`,
      requestId: req.requestId,
    })

    // Said in a header as well as in the bytes. The watermark is what a person
    // sees; this is what the interface reads to decide whether it may call the
    // document customer-ready, so neither has to infer it from the other.
    res.setHeader('X-Report-Audience', result.audience)
    res.setHeader('X-Report-Approval-State', result.approvalState)

    const safeName = (run.companyName ?? 'company')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${safeName}-product-data-health-check.pdf"`)
    res.setHeader('X-Report-SHA256', result.pdf.sha256)
    res.setHeader('X-Report-Pages', String(result.pdf.pageCount))
    // Lets the caller say why a document has no QR on it instead of leaving the
    // reader to guess whether the code failed to render.
    res.setHeader('X-Report-QR', qrState)
    res.send(result.pdf.bytes)
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
