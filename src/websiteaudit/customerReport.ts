import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import { ConflictError, NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { buildCollateral, type SalesCollateral } from './collateral.js'
import { buildComparison, type ComparisonResult, type PeerAudit } from './comparison.js'
import { loadBeforeAfterExamples } from './examples.js'
import type { CatalogFinding } from './findings.js'
import { type PdfResult } from './pdfReport.js'
import { getCrm } from '../crm/index.js'
import { renderPdpReport } from './pdpReport.js'
import { loadProductEvidence } from './productEvidence.js'
import { buildRemediation, buildScorecard, NO_SUBJECT_SCORECARD } from './discoverabilityScore.js'
import { loadScorecardInput } from './scorecardInput.js'
import { fetchProductImages } from './productImages.js'
import { buildCustomerView } from './customerView.js'
import { captureAvailable, captureHtml } from '../research/pageCapture.js'
import { AFTER_PAGE_RECIPE, brandedEnrichedPdpHtml } from '../workbench/enrichedPdpBrand.js'
import { renderEnrichmentReport } from './enrichmentReport.js'
import type { PdpEnrichment } from './pdpEnrichment.js'
import type { PdpAssessment } from './pdpTarget.js'

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
   * The signed-in person asking for this copy. Their name goes on the report's
   * "Prepared by" block, because they are the person handing it over.
   */
  requestedBy?: { name?: string | null; email?: string | null } | null
  /**
   * A peer to compare against. Supplied by the CALLER, never chosen here —
   * see the note on peer policy below.
   */
  peer?: PeerAudit | null
}

/**
 * Who a rendered copy is for.
 *
 * `internal_review` is the same document, watermarked and without a QR, for
 * the person deciding whether it may be sent. `customer` is the copy that may
 * leave the building. Nothing but an approved report yields the second.
 */
export type CustomerReportAudience = 'internal_review' | 'customer'

/**
 * The one definition of who a rendered copy is for.
 *
 * Exported because the QR decision has to be made BEFORE the document is
 * generated, and a second copy of `status === 'approved'` written at the call
 * site is exactly how the two drift apart.
 */
export function audienceFor(reportStatus: string | null | undefined): CustomerReportAudience {
  return reportStatus === 'approved' ? 'customer' : 'internal_review'
}

/** Why a customer report did or did not get a QR code. Reported in a header. */
export type CustomerReportQrState =
  | 'minted'
  | 'existing-link-not-recoverable'
  | 'suppressed'
  | 'unavailable'
  | 'not-approved'

/**
 * Whether this export may mint a customer share link at all.
 *
 * MINTING IS PUBLICATION. A share link is a bearer credential: anyone holding
 * it opens the customer's demonstration without signing in. So it belongs on
 * the approved side of the publication gate, with the QR and the watermark —
 * and it was on the wrong side.
 *
 * The export endpoint minted on `demo.status === 'ready'` alone, before the
 * report's approval state was consulted at all. `generateCustomerReport` then
 * correctly withheld the QR from an unapproved copy, so nothing ever reached a
 * customer. The damage was quieter than that:
 *
 *   · a live credential was created, and audit-logged, for a document nobody
 *     had approved — an act of publication performed by an act of review
 *   · `mintLink` returns the plaintext token exactly once and stores only its
 *     hash, so that link's URL is unrecoverable afterwards
 *   · the next export — the APPROVED one, the copy that actually goes to the
 *     customer — found that link usable, took the "existing link, not
 *     recoverable" branch, and shipped with NO QR ON IT
 *
 * So merely previewing a draft silently spent the one QR the finished report
 * was going to carry. Deciding here, before anything is written, is what makes
 * that unreachable.
 *
 * Pure on purpose: every branch is a fact the caller already holds, so the
 * rule can be checked exhaustively without a database or an HTTP request.
 */
export function planCustomerReportQr(facts: {
  /** False when the caller passed ?qr=0 — the inline viewer does. */
  qrRequested: boolean
  /** The audit report's approval status, or null when there is no report yet. */
  reportStatus: string | null | undefined
  /** The demonstration's status, or null when this run has none. */
  demoStatus: string | null | undefined
}): { consider: boolean; state: CustomerReportQrState } {
  if (!facts.qrRequested) return { consider: false, state: 'suppressed' }
  // The gate, ahead of every other reason. An unapproved export must not be
  // able to create a customer-facing credential, whatever else is ready.
  if (audienceFor(facts.reportStatus) !== 'customer') return { consider: false, state: 'not-approved' }
  if (facts.demoStatus !== 'ready') return { consider: false, state: 'unavailable' }
  return { consider: true, state: 'unavailable' }
}

export interface CustomerReportResult {
  collateral: SalesCollateral
  pdf: PdfResult
  /** The approved revision this was rendered from, for attribution. */
  revisionNumber: number
  approvalState: string
  /**
   * Which copy this is. A caller that shows a document to anyone outside the
   * business must check this rather than assuming a rendered PDF is sendable.
   */
  audience: CustomerReportAudience
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

/** The "Prepared by" block on the PDP Enrichment Report. */
export interface ReportSignatory {
  name: string
  role: string
  company: string
  phone: string | null
  email: string | null
  web: string | null
}

/**
 * Who the report says prepared it: the person who asked for this copy.
 *
 * A report is handed over by a person, and the customer reading it needs the
 * name of whoever they can reply to. So the signed-in user signs it.
 *
 * The configured defaults still stand for the person they describe — matched
 * on email, so their role and direct number survive — and for a copy produced
 * with no user behind it (a scheduled or internal render). For anybody else
 * only their OWN name and address are printed: their colleague's job title and
 * mobile number are not theirs to carry, and this service will not invent a
 * role it was never told.
 */
export function preparedBySignatory(
  requestedBy?: { name?: string | null; email?: string | null } | null,
): ReportSignatory {
  const configured: ReportSignatory = {
    name: env.REPORT_PREPARED_BY_NAME,
    role: env.REPORT_PREPARED_BY_ROLE,
    company: env.REPORT_PREPARED_BY_COMPANY,
    phone: env.REPORT_PREPARED_BY_PHONE || null,
    email: env.REPORT_PREPARED_BY_EMAIL || null,
    web: env.REPORT_PREPARED_BY_WEB || null,
  }

  const email = requestedBy?.email?.trim() ?? ''
  const name = requestedBy?.name?.trim() ?? ''
  if (!email && !name) return configured
  if (email && configured.email && email.toLowerCase() === configured.email.toLowerCase()) return configured

  return {
    // A display name when the account has one; otherwise the address's own
    // local part read as a name ("jey.kumar@..." -> "Jey Kumar"), which is the
    // most the identity actually tells us.
    name: name || nameFromEmail(email) || configured.name,
    role: '',
    company: configured.company,
    phone: null,
    email: email || null,
    web: configured.web,
  }
}

/** "manikandan.s@altiusnxt.com" -> "Manikandan S". Never invents a surname. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  const words = local
    .split(/[._\-+]+/)
    .map((w) => w.replace(/\d+/g, '').trim())
    .filter(Boolean)
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export async function generateCustomerReport(input: CustomerReportInput): Promise<CustomerReportResult> {
  const report = await prisma.auditReport.findFirst({
    where: { tenantId: input.tenantId, auditRunId: input.auditRunId },
  })
  if (!report) {
    throw new NotFoundError('No audit report exists for that run, so there is nothing to send.')
  }

  // ── GATE 1: approval decides the AUDIENCE, not whether it exists ───────
  //
  // This used to refuse outright unless the report was approved, which put the
  // review the wrong way round: the reviewer was asked to approve a document
  // nobody could open. Approval is a PUBLICATION gate — it governs whether a
  // document may be put in front of a customer, not whether the reviewer may
  // read the thing they are being asked to sign off.
  //
  // So an unapproved report still produces the same six pages, built from the
  // same observations, watermarked on every page as an internal review copy
  // and carrying no QR. What approval changes is the audience, and the caller
  // is told which one it got so it can never present a review copy as sent.
  const audience: CustomerReportAudience = audienceFor(report.status)
  if (audience === 'internal_review') {
    log.info(
      { status: report.status, auditRunId: input.auditRunId },
      'customer report rendered as an INTERNAL REVIEW copy — watermarked, no share link',
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

  // ── THE END PDP AUDIT: the PDP Enrichment Report ─────────────────────
  //
  // A run that audited the End PDP link produces the PDP Enrichment Report
  // (see enrichmentReport.ts) instead of the whole-site discoverability audit.
  // The approval gate, the disclaimer rule, the watermark and the QR rule
  // above and below are unchanged — only the document is different.
  const pdpRun = await prisma.websiteAuditRun.findUniqueOrThrow({
    where: { id: input.auditRunId },
    select: {
      pdpAssessment: true,
      pdpEnrichment: true,
      pdpBeforeCapture: true,
      pdpAfterCapture: true,
      companyName: true,
      startUrl: true,
      crmCompanyId: true,
      completedAt: true,
      createdAt: true,
    },
  })
  if (pdpRun.pdpAssessment) {
    const assessment = pdpRun.pdpAssessment as unknown as PdpAssessment
    if (assessment.case !== 'valid_product') {
      throw new ConflictError(
        `No PDP Enrichment Report can be produced: ${assessment.headline}. ${assessment.explanation}`,
        { hint: assessment.recommendations.join(' ') },
      )
    }
    const enrichment = pdpRun.pdpEnrichment as unknown as PdpEnrichment | null
    if (!enrichment || enrichment.status !== 'ready' || !enrichment.enriched) {
      throw new ConflictError(
        enrichment?.reason ?? 'The enriched product record has not been generated for this run yet.',
        { hint: 'Run the Website Audit again to rebuild the enriched record.' },
      )
    }

    const revision = await prisma.auditReportRevision.findFirst({
      where: { auditReportId: report.id, revisionNumber: report.currentRevision },
    })
    const content = (revision?.content ?? report.collateral) as unknown as SalesCollateral
    // A reviewer's rewrite of the summary is what they approved. Revision 1 is
    // the generated text, which the enrichment's own summary supersedes.
    const reviewed =
      report.currentRevision > 1 && content?.summary
        ? { ...enrichment, enriched: { ...enrichment.enriched, executiveSummary: content.summary } }
        : enrichment

    const crmCompany = await getCrm()
      .getCompany(pdpRun.crmCompanyId)
      .catch(() => null)
    const companyName = pdpRun.companyName ?? crmCompany?.name ?? 'the customer'
    const contact = (crmCompany?.contactPersons ?? [])
      .map((c) => c.split(/\s+[-–—]\s+/)[0]!.replace(/\+?\d[\d\s().-]{5,}\d/g, '').trim())
      .find((n) => n.length >= 2)

    // THE REPORT SHOWS THE SAME "AFTER" PAGE AS THE WORKBENCH.
    //
    // A run audited before the After page wore the customer's branding still
    // holds the older photograph. Rather than leave the two surfaces showing
    // different pages, the picture is retaken once, from the same HTML the
    // Workbench renders, and kept.
    let afterCapture = pdpRun.pdpAfterCapture ? Buffer.from(pdpRun.pdpAfterCapture) : null
    // Stale in two ways: taken before the After page wore the customer's
    // branding, or taken while their pictures could not be read — some hosts
    // refuse us for a while, and the photograph then holds empty frames. Both
    // are retaken, and the second fixes itself as soon as the site answers.
    const marks = enrichment as {
      afterCaptureBranded?: boolean
      afterCaptureRecipe?: number
      inlineImages?: { map: Record<string, string> }
    }
    const picturesResolved = Object.keys(marks.inlineImages?.map ?? {}).length > 0
    // Or taken under an older drawing of the page — the masthead logo, say.
    const oldRecipe = (marks.afterCaptureRecipe ?? 1) < AFTER_PAGE_RECIPE
    if ((!marks.afterCaptureBranded || !picturesResolved || oldRecipe) && captureAvailable().ok) {
      try {
        const html = await brandedEnrichedPdpHtml(input.auditRunId, { forCapture: true })
        const shot = html ? await captureHtml(html, { baseUrl: enrichment.source.url }) : null
        if (shot?.image) {
          afterCapture = Buffer.from(shot.image)
          // Rendering the page may have found the logo or read the pictures and
          // kept them, so the row is read again rather than written back over.
          const fresh = await prisma.websiteAuditRun.findUnique({
            where: { id: input.auditRunId },
            select: { pdpEnrichment: true },
          })
          await prisma.websiteAuditRun.update({
            where: { id: input.auditRunId },
            data: {
              pdpAfterCapture: shot.image,
              pdpEnrichment: {
                ...((fresh?.pdpEnrichment as object) ?? enrichment),
                afterCaptureBranded: true,
                afterCaptureRecipe: AFTER_PAGE_RECIPE,
              } as never,
            },
          })
        }
      } catch (err) {
        // Presentation only: the stored picture still stands.
        log.info({ auditRunId: input.auditRunId, err: (err as Error).message }, 'branded After capture not refreshed')
      }
    }

    const pdf = await renderEnrichmentReport({
      companyName,
      preparedFor: contact ? `${contact}, ${companyName}` : companyName,
      preparedBy: preparedBySignatory(input.requestedBy),
      auditDate: pdpRun.completedAt ?? pdpRun.createdAt,
      sourceUrl: enrichment.source.url,
      enrichment: reviewed,
      beforeCapture: pdpRun.pdpBeforeCapture ? Buffer.from(pdpRun.pdpBeforeCapture) : null,
      afterCapture,
      captureNote: captureAvailable().reason,
      logoPath: env.REPORT_BRAND_LOGO_PATH,
      shareUrl: audience === 'customer' ? (input.workbenchUrl ?? null) : null,
      watermark:
        audience === 'internal_review'
          ? `INTERNAL REVIEW — report is "${report.status.replace(/_/g, ' ')}" — not for customer distribution`
          : null,
    })

    return {
      collateral: content,
      pdf,
      revisionNumber: report.currentRevision,
      approvalState: report.status,
      audience,
      exampleNote: null,
    }
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

  // ── THE CUSTOMER VIEW IS THE ONE REPRESENTATION ───────────────────────
  //
  // This used to re-derive the demonstration for itself: the same
  // selectCaseStudyPages, the same buildEnrichedRecord, the same
  // analyseSectors, the same loadSchemaEvidence, the same
  // buildRecommendedSchema — the customer view's derivation copied line for
  // line into a second call site.
  //
  // The two agreed, because the code happened to match. That is not a
  // guarantee, it is a coincidence maintained by hand, and the failure it
  // invites is the worst one this platform has: a customer reading the PDF
  // and the Workbench and being shown two different accounts of the same
  // product.
  //
  // So the report now CONSUMES the customer view. One selection, one enriched
  // record, one schema, one proposal, one captured website context — derived
  // once and rendered twice. The screen and the document cannot disagree
  // because there is no longer a second thing to disagree with.
  const view = await buildCustomerView(input.tenantId, input.auditRunId)
  const caseStudies = view.caseStudies
  const images = await fetchProductImages(caseStudies.map((c) => c.imageUrl))

  // ── The AI Discoverability Audit ──────────────────────────────────────
  //
  // The scorecard is computed from THIS run's observations of THIS company's
  // page. Every check names what it read, and the two checks that need
  // capabilities this platform does not have are reported as not assessed and
  // excluded from the denominator rather than scored as zero.
  const subject = caseStudies[0] ?? null
  const scorecardInput = subject ? await loadScorecardInput(run.id, subject, run.productPages) : null
  // A run with no auditable product page has no scorecard, and the document
  // says so on page four rather than scoring an absence.
  const scorecard = scorecardInput ? buildScorecard(scorecardInput) : NO_SUBJECT_SCORECARD
  const remediation = scorecardInput ? buildRemediation(scorecard) : []

  const crmCompany = await getCrm()
    .getCompany(run.crmCompanyId)
    .catch(() => null)

  const pdf = await renderPdpReport({
    companyName: collateral.companyName,
    website: collateral.website,
    preparedFor: collateral.companyName,
    auditDate: collateral.auditDate,
    sector: crmCompany?.industry ?? view.recommendedSchema.categoryLabel ?? null,
    location: crmCompany?.country ?? null,
    pagesInspected: collateral.pagesInspected,
    productPagesInspected: collateral.productPagesInspected,
    scorecard,
    remediation,
    subject,
    // Read only when there is no subject, but always supplied: the document
    // and the Workbench screen then describe the same run in the same words,
    // rather than each composing its own account of an absence.
    productEvidence: subject ? null : await loadProductEvidence(run.id),
    categoryLabel: view.recommendedSchema.determined ? view.recommendedSchema.categoryLabel : null,
    recommendedAttributes: (view.recommendedSchema.attributes ?? []).map((a) => ({
      label: a.label,
      state: a.state,
      value: a.value,
      why: a.why,
    })),
    scopeNote: collateral.scopeNote,
    nextStep: collateral.nextStep,
    ctaLabel: collateral.cta.label,
    // Who actually produced and approved this copy, from the report record.
    // The sample report carries two named signatories; inventing them here
    // would be putting a person's name against work they never saw.
    preparedBy: {
      name: 'AltiusNxt Marketing AI',
      role: 'Automated catalogue audit',
      email: null,
    },
    approvedBy:
      report.status === 'approved' && report.reviewerEmail
        ? { name: report.reviewerEmail, role: 'Approving reviewer' }
        : null,
    // A review copy carries no QR even when the caller offered one. The code
    // is a customer-facing credential, and an unapproved document must not be
    // able to hand one out just because it was rendered.
    workbenchUrl: audience === 'customer' ? (input.workbenchUrl ?? null) : null,
    legalDisclaimer: disclaimer,
    reviewWatermark:
      audience === 'internal_review'
        ? `INTERNAL REVIEW — report is "${report.status.replace(/_/g, ' ')}" — not for customer distribution`
        : null,
    logoPath: env.REPORT_BRAND_LOGO_PATH,
    images,
    // THE SAME TWO BLOCKS THE WORKBENCH RENDERS, from the same view.
    //
    // Not re-sampled and not recomposed here: a second capture is a second
    // chance to differ, and the whole point of the report consuming the
    // customer view is that there is only one of each. Both are nullable and
    // the renderer omits what it is not given — a run that captured no website
    // context, or published too little to compose a proposal from, draws
    // neither rather than a substitute.
    websiteShell: view.websiteShell,
    proposedContent: view.proposedContent,
    // The same illustrative examples the Workbench's AFTER view shows.
    illustrativeExamples: view.illustrativeExamples,
  })

  return {
    collateral,
    pdf,
    revisionNumber: report.currentRevision,
    approvalState: report.status,
    audience,
    exampleNote: examples.reason,
  }
}
