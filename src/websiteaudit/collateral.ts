import { env } from '../config/env.js'
import type { ComparedField } from '../workbench/types.js'
import {
  buildBusinessPain,
  buildBusinessValue,
  buildDiscoverabilityNotes,
  type BusinessPain,
  type BusinessValue,
  type DiscoverabilityNote,
} from './businessCase.js'
import { assertSupported } from './claimGuard.js'
import type { ComparisonResult } from './comparison.js'
import type { CatalogFinding } from './findings.js'

// TASK #979 — account-specific sales collateral.
//
// Assembled entirely from findings that already carry evidence. Nothing here
// introduces a new claim: the key findings ARE the findings, the metrics ARE
// their sample-scoped metrics, and the impact statements are the ones the
// analyser already had to defend.
//
// Every generated sentence passes the claim guard before it is returned, so
// this file cannot produce "worth £40k a year" or "87% of your catalogue" even
// by accident. What it produces instead is dull and defensible, which is the
// correct trade for something a salesperson will put in front of a prospect.

export interface CollateralMetric {
  label: string
  value: string
  /** Where the number came from, so a reader can check it. */
  basis: string
}

export interface CollateralFinding {
  priority: string
  title: string
  metric: string
  impact: string
  recommendation: string
  /** Source URLs behind this finding, for traceability. */
  sourceUrls: string[]
  evidenceCount: number
}

/**
 * Who a rendering is for.
 *
 * `internal` is the full audit: every finding, every piece of evidence, the
 * method, the complete recommendation set.
 *
 * `customer` is the courier teaser. It is limited ON PURPOSE — Team Answer
 * F.4/F.5 asks for enough real evidence to establish credibility as a
 * product-data specialist, and for the remediation methodology to be held back
 * for the sales conversation. So the customer variant is not a smaller render
 * of the same object; it is a different object with fields deliberately
 * missing, which is why the withholding is enforced here rather than left to
 * whatever renders it.
 */
export type ReportAudience = 'internal' | 'customer'

/** One before/after pair shown to a customer, with its provenance intact. */
export interface CollateralExample {
  productUrl: string
  productName: string | null
  fields: ComparedField[]
}

export interface SalesCollateral {
  audience: ReportAudience
  companyName: string
  website: string
  auditDate: string
  pagesInspected: number
  productPagesInspected: number
  categoryPagesInspected: number
  headline: string
  summary: string
  keyFindings: CollateralFinding[]
  metrics: CollateralMetric[]
  businessImpact: string[]
  recommendedImprovementAreas: string[]
  nextStep: string
  /** Stated on the artifact itself, not only in our own documentation. */
  scopeNote: string

  // ── Phase 6 additions ────────────────────────────────────────────────
  /** OBSERVATION -> PAIN -> WHY -> OPPORTUNITY -> DIRECTION, per finding. */
  businessPain: BusinessPain[]
  /** The six-section case-study reading of the whole audit. */
  businessValue: BusinessValue
  /** Evidence-anchored discoverability notes. Empty when none apply. */
  discoverability: DiscoverabilityNote[]
  /** Real before/after pairs from audited product pages. */
  examples: CollateralExample[]
  /** Peer comparison, or an explicit statement that there is none. */
  comparison: ComparisonResult
  cta: { label: string; url: string | null }
  /**
   * The legal wording confirmed by legal/compliance. Null on an internal
   * rendering, and never null on a customer one — generateCustomerReport
   * refuses to produce a customer report without it.
   */
  legalDisclaimer: string | null
  /**
   * Set on a customer rendering when findings exist beyond those shown, so
   * the teaser can say so without itemising them.
   */
  withheldNote: string | null

  /** Task #979 ends here. Task #980 owns what happens next. */
  status: 'ready_for_approval'
}

export interface CollateralInput {
  audience?: ReportAudience
  companyName: string
  website: string | null
  auditDate: Date
  pagesInspected: number
  productPagesInspected: number
  categoryPagesInspected: number
  findings: CatalogFinding[]
  /** Which crawl limits bound, so the sample can be read honestly. */
  limitsHit: string[]
  /** Before/after pairs already built from audited pages by the Workbench. */
  examples?: CollateralExample[]
  comparison?: ComparisonResult
  /** Overrides the configured sample count, for a per-run choice. */
  sampleCount?: number
  ctaUrl?: string | null
  hasWorkbenchDemo?: boolean
  legalDisclaimer?: string | null
}

/** How many findings a one-page summary can carry without becoming a list. */
const MAX_KEY_FINDINGS = 5

export function buildCollateral(input: CollateralInput): SalesCollateral {
  const {
    companyName,
    website,
    auditDate,
    pagesInspected,
    productPagesInspected,
    categoryPagesInspected,
    findings,
  } = input

  const audience: ReportAudience = input.audience ?? 'internal'
  const isCustomer = audience === 'customer'

  const date = auditDate.toISOString().slice(0, 10)
  const high = findings.filter((f) => f.priority === 'high')

  // Highlight order is configuration, not a constant: Section 19 asks for
  // "which finding categories are highlighted" to be settable.
  const highlightOrder = env.REPORT_HIGHLIGHT_CATEGORIES.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const ranked = [...findings].sort((a, b) => {
    const ai = highlightOrder.indexOf(a.category)
    const bi = highlightOrder.indexOf(b.category)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  // The customer report carries 2–4 key findings; the internal one carries up
  // to five. This is the first of the two places the teaser narrows.
  const keyCount = isCustomer ? env.REPORT_CUSTOMER_KEY_FINDINGS : MAX_KEY_FINDINGS
  const key = ranked.slice(0, keyCount)

  // The sample sentence is repeated in the collateral, in the PDF, and in the
  // API response on purpose. Every place a number appears, its denominator
  // appears with it.
  const sampleSentence =
    productPagesInspected > 0
      ? `This review covers ${pagesInspected} page(s) inspected on ${website ?? 'the site'}, of which ${productPagesInspected} were product pages and ${categoryPagesInspected} were category pages.`
      : `This review covers ${pagesInspected} page(s) inspected on ${website ?? 'the site'}. No product page could be identified among them.`

  const summary = findings.length
    ? `${sampleSentence} ${findings.length} product-data finding(s) were recorded, each traceable to a specific page and source fragment.`
    : `${sampleSentence} No product-data finding was recorded against the inspected pages.`

  const headline = `Product Data Health Check — ${companyName}`

  const metrics: CollateralMetric[] = [
    {
      label: 'Pages inspected',
      value: String(pagesInspected),
      basis: 'Pages fetched successfully during this audit run.',
    },
    {
      label: 'Product pages inspected',
      value: String(productPagesInspected),
      basis: 'Pages classified as product pages from their own markup, not from their URL.',
    },
    {
      label: 'Category pages inspected',
      value: String(categoryPagesInspected),
      basis: 'Pages classified as category or listing pages from their own markup.',
    },
    {
      label: 'Findings recorded',
      value: String(findings.length),
      basis: 'Findings derived from stored observations; each one cites the pages behind it.',
    },
    {
      label: 'Higher-priority findings',
      value: String(high.length),
      basis: 'Findings affecting fields needed to find and filter a product across at least half the inspected sample.',
    },
  ]

  // Findings already carry defensible metrics. Adding a field-level metric per
  // key finding keeps the numbers next to what they describe.
  key.forEach((f) => {
    metrics.push({
      label: f.title,
      value: `${f.observedCount} of ${f.sampleSize} inspected ${f.sampleUnit}`,
      basis: f.metric,
    })
  })

  const keyFindings: CollateralFinding[] = key.map((f) => ({
    priority: f.priority,
    title: f.title,
    metric: f.metric,
    impact: f.impact,
    // The remediation methodology is what the sales conversation is for
    // (Team Answer F.4). A customer rendering states the direction; it does
    // not hand over the approach.
    recommendation: isCustomer ? '' : f.recommendation,
    // Source URLs are credibility on a customer report, so a couple are shown.
    // The full evidence chain is not.
    sourceUrls: [...new Set(f.evidence.map((e) => e.sourceUrl))].slice(0, isCustomer ? 2 : 5),
    evidenceCount: f.evidence.length,
  }))

  // Impact is the findings' own impact statements, deduplicated. It is not a
  // separate act of writing, so there is nowhere for a new claim to enter.
  const businessImpact = [...new Set(key.map((f) => f.impact))]

  const recommendedImprovementAreas = [...new Set(key.map((f) => f.recommendation))]

  const nextStep = findings.length
    ? `Review these findings against the pages cited, and confirm whether the same gaps hold across the wider catalogue. AltiusNXT can then scope what it would take to close them.`
    : `No product-data gap was recorded on the inspected pages. A wider review would be needed before drawing any conclusion about the rest of the catalogue.`

  const scopeNote =
    input.limitsHit.length > 0
      ? `Scope: this audit inspected a bounded sample and stopped at ${input.limitsHit.join(', ')}. Every figure describes the inspected pages only and should not be read as a measure of the whole catalogue.`
      : `Scope: every figure describes the inspected pages only and should not be read as a measure of the whole catalogue.`

  // ── Phase 6: the business reading ──────────────────────────────────────
  const pains = ranked.map(buildBusinessPain)
  const businessValue = buildBusinessValue({
    companyName,
    findings: ranked,
    pains,
    pagesInspected,
    productPagesInspected,
    hasWorkbenchDemo: input.hasWorkbenchDemo ?? false,
  })
  const discoverability = buildDiscoverabilityNotes(ranked)

  // The defect-sample policy (Team Answer F.5). A customer sees 2–5 worked
  // examples and a COUNT of what else was found; never the list. The count is
  // safe to state because it is sample-scoped and carries its denominator.
  const sampleCount = Math.max(1, Math.min(5, input.sampleCount ?? env.REPORT_CUSTOMER_SAMPLE_COUNT))
  const allExamples = input.examples ?? []
  const examples = isCustomer ? allExamples.slice(0, sampleCount) : allExamples

  const withheldFindings = ranked.length - key.length
  const withheldExamples = allExamples.length - examples.length
  // Written in the two shapes it actually occurs in. Saying "shows 0 worked
  // example(s)" when there are none reads as a fault in the report rather
  // than as a deliberate summary, so that sentence is not built at all.
  const shownParts = [
    examples.length === 1
      ? 'one worked example'
      : examples.length > 1
        ? `${examples.length} worked examples`
        : null,
    withheldFindings > 0
      ? `the ${key.length} strongest of ${ranked.length} findings`
      : null,
  ].filter(Boolean)
  const withheldNote =
    isCustomer && (withheldFindings > 0 || withheldExamples > 0)
      ? `Additional affected pages were observed in the inspected sample. This summary shows ${shownParts.join(
          ' and ',
        )}; the rest are covered in the walkthrough.`
      : null

  // An explicit null means "this run has no booking link" and is honoured.
  // Omitting the field means "use whatever is configured". Collapsing the two
  // would make it impossible to render a report without a CTA, and a report
  // that invents a link because none was supplied is worse than one that
  // states there is none.
  const ctaUrl =
    input.ctaUrl !== undefined ? input.ctaUrl : env.REPORT_CTA_URL || env.WORKBENCH_CTA_URL || null

  return {
    audience,
    companyName,
    website: website ?? 'not recorded',
    auditDate: date,
    pagesInspected,
    productPagesInspected,
    categoryPagesInspected,
    headline: assertSupported('collateral.headline', headline),
    summary: assertSupported('collateral.summary', summary),
    keyFindings,
    // Metrics on a customer report stay at the scope level. The per-finding
    // breakdown is the audit, and the audit is not what is being couriered.
    metrics: isCustomer ? metrics.slice(0, 5) : metrics,
    businessImpact: businessImpact.map((t, i) => assertSupported(`collateral.businessImpact[${i}]`, t)),
    // Improvement AREAS are directional and safe to show; the recommendation
    // text per finding is withheld above.
    recommendedImprovementAreas: isCustomer
      ? []
      : recommendedImprovementAreas.map((t, i) => assertSupported(`collateral.recommendation[${i}]`, t)),
    nextStep: assertSupported('collateral.nextStep', nextStep),
    scopeNote: assertSupported('collateral.scopeNote', scopeNote),
    businessPain: isCustomer ? pains.slice(0, keyCount) : pains,
    businessValue,
    discoverability,
    examples,
    comparison:
      input.comparison ?? {
        available: false,
        message: 'Comparable evidence not available for this audit.',
        reason: 'No peer comparison was requested or supplied for this run.',
      },
    cta: { label: env.REPORT_CTA_LABEL, url: ctaUrl },
    legalDisclaimer: input.legalDisclaimer ?? null,
    withheldNote: withheldNote ? assertSupported('collateral.withheldNote', withheldNote) : null,
    status: 'ready_for_approval',
  }
}
