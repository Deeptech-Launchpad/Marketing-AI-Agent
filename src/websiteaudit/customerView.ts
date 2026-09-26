import { prisma } from '../platform/db.js'
import { NotFoundError } from '../platform/errors.js'
import { buildEnrichedRecord, selectCaseStudyPages, type EnrichedRecord } from './enrichedRecord.js'
import { analyseSectors, type SectorAnalysis, type SectorGap } from './sectorAnalysis.js'
import { buildRecommendedSchema, type RecommendedSchema, type SchemaEvidence } from './recommendedSchema.js'
import { loadProductEvidence, type ProductEvidence } from './productEvidence.js'
import { buildProposedContent, type ProposedContent } from '../workbench/proposedContent.js'
import { logger } from '../platform/logger.js'
import { sampleWebsiteShell, type WebsiteShell } from '../workbench/websiteShell.js'
import { sampleTheme } from '../workbench/themeExtractor.js'
import type { ThemeProfile } from '../workbench/types.js'
import {
  exampleForAttribute,
  exampleForRecordField,
  type IllustrativeExample,
} from '../workbench/illustrativeExamples.js'
import type { SalesCollateral } from './collateral.js'

// THE CUSTOMER'S OWN STORY, ASSEMBLED ONCE.
//
// The Audit Report screen, the AI Workbench screen and the customer PDF were
// each building their own idea of what to show. That is how the three drifted
// apart — the PDF grew real products and images while the screens still
// listed findings and internal identifiers.
//
// So all three now read THIS. The shape is deliberately the customer's
// narrative and not the audit's internals:
//
//   what your website publishes today
//   what is missing from it
//   two of your own products, before and after
//   the categories your own site names
//   what that makes possible
//
// Two rules hold throughout, and both are structural rather than conventions
// somebody has to remember:
//
//   · Everything is scoped to ONE audit run, and a run belongs to exactly one
//     company. No product, image, URL or category can come from another
//     customer because none of them is ever loaded.
//
//   · The wording is READ from the stored report, not recomposed. If a
//     reviewer edited the summary and approved their wording, that is what the
//     screen shows — regenerating the prose here would quietly discard an
//     approval.

export interface CustomerViewGap extends SectorGap {
  /** Said the way a customer would say it, e.g. "Not stated on any of 12". */
  statement: string
}

export interface CustomerView {
  /** Lineage. Every consumer checks these before rendering anything. */
  crmCompanyId: string
  auditRunId: string

  companyName: string
  website: string | null
  auditDate: string

  pagesInspected: number
  productPagesInspected: number
  categoryPagesInspected: number

  /** The Task #980 gate, reported rather than enforced here. */
  reportStatus: string
  approved: boolean

  headline: string
  summary: string
  scopeNote: string
  businessValue: string[]
  nextStep: string
  ctaLabel: string

  priorities: { high: number; medium: number; low: number }

  /** Worst-covered fields across the inspected product pages, worst first. */
  gaps: CustomerViewGap[]

  /** Up to two real products from this company's own site. */
  caseStudies: EnrichedRecord[]

  /**
   * Which of the four evidence states this run is in, and what may honestly
   * be shown because of it.
   *
   * Carried alongside caseStudies rather than folded into it. An empty
   * caseStudies array used to mean four different things — the site was never
   * read, the site names nothing it sells, the site names products but
   * publishes no product page, or the run simply has not got there yet — and
   * every surface printed the same sentence for all four. This is the field
   * that tells them apart, and it carries the catalogue entries the company
   * really published so a demonstration is possible without a product page.
   */
  productEvidence: ProductEvidence

  sectors: SectorAnalysis

  /**
   * The attribute fields this customer's category calls for, and which of
   * them the first case study already publishes. Fields, never values: a
   * `recommended` attribute carries no value, and the category itself is read
   * from this run's own pages or reported as not determined.
   */
  recommendedSchema: RecommendedSchema
  /**
   * Suggested wording for the hero product, or null when the page published
   * too little to compose from.
   *
   * The fourth state, and the only one that is ours rather than the
   * customer's: OBSERVED, DERIVED and RECOMMENDED are all statements about
   * their catalogue, and this is a proposal about their copy. It is carried
   * separately from the record for exactly that reason — nothing downstream
   * can merge it into the field list by accident.
   */
  proposedContent: ProposedContent | null

  /**
   * The customer's own page furniture — logo, navigation, footer, site name.
   *
   * What makes the demonstration recognisably THEIR page rather than a card
   * with their data in it. Captured from the hero product page, cached on the
   * run, and reported as not-captured when the site could not be sampled.
   *
   * Null only when this run has no product page to sample from.
   */
  websiteShell: WebsiteShell | null
  /** Their palette and fonts, sampled from the same page. Never their markup. */
  pageTheme: ThemeProfile | null

  /**
   * ILLUSTRATIVE EXAMPLES for what the hero product's page does NOT publish.
   *
   * Keyed by the enriched-record field id (`product.gtin`) or the recommended
   * attribute id (`attr:concentration`). Present ONLY for fields the page
   * leaves empty, so an example can never sit beside, or be mistaken for, a
   * value the customer actually published.
   *
   * Carried here rather than computed separately by each screen, for the same
   * reason as the website shell: the Workbench's AFTER view and the report's
   * comparison frames must show the customer the same examples, and the only
   * way to guarantee that is for there to be one set.
   *
   * Empty when the run has no product page. There is no page to complete.
   */
  illustrativeExamples: Record<string, IllustrativeExample>
}

/**
 * Examples for every gap on the hero product page, and nothing else.
 *
 * Absent record fields first, then recommended attributes the page does not
 * publish. Anything the page DID publish — as a field, or read out of its prose
 * — gets no example, because the customer's own value is the only thing that
 * may appear there.
 */
function examplesFor(hero: EnrichedRecord | null, schema: RecommendedSchema): Record<string, IllustrativeExample> {
  const out: Record<string, IllustrativeExample> = {}
  if (!hero) return out
  for (const f of hero.fields) {
    if (f.state !== 'absent' || f.before) continue
    const ex = exampleForRecordField(f.field)
    if (ex) out[f.field] = ex
  }
  for (const a of schema.attributes) {
    if (a.state !== 'recommended' || a.value) continue
    const ex = exampleForAttribute(a.field)
    if (ex) out[`attr:${a.field}`] = ex
  }
  return out
}

/**
 * The customer's page context, captured once and remembered.
 *
 * WHY THIS IS HERE AND NOT ONLY IN THE WORKBENCH BUILDER.
 *
 * The builder captures the same two things, but only for an APPROVED report
 * and only when somebody presses Build. Everyone else — a salesperson opening
 * the Workbench on a company whose audit finished an hour ago — was shown a
 * neutral card for a website this platform had already read in full. The shell
 * describes the CUSTOMER'S SITE, not our demonstration of it, so it belongs to
 * the run that read that site and is available as soon as that run exists.
 *
 * Written once. A failed capture is stored AS a failed capture, so a site that
 * cannot be sampled is not re-fetched on every page view — and the interface
 * gets the reason rather than a silent blank.
 */
async function pageContextFor(
  run: { id: string; websiteShell: unknown; pageTheme: unknown },
  heroUrl: string | null,
): Promise<{ websiteShell: WebsiteShell | null; pageTheme: ThemeProfile | null }> {
  const cachedShell = run.websiteShell as WebsiteShell | null
  const cachedTheme = run.pageTheme as ThemeProfile | null
  if (cachedShell && cachedTheme) return { websiteShell: cachedShell, pageTheme: cachedTheme }

  // No product page means no page to sample. Nothing is invented in its place
  // and nothing is stored, so a later run that DOES find one still captures.
  if (!heroUrl) return { websiteShell: null, pageTheme: null }

  try {
    const [websiteShell, pageTheme] = await Promise.all([sampleWebsiteShell(heroUrl), sampleTheme(heroUrl)])
    await prisma.websiteAuditRun.update({
      where: { id: run.id },
      data: { websiteShell: websiteShell as never, pageTheme: pageTheme as never },
    })
    return { websiteShell, pageTheme }
  } catch (err) {
    // Presentation only. A sampling failure must never cost the customer the
    // evidence view, which is the part that actually matters.
    logger.info(
      { auditRunId: run.id, heroUrl, err: (err as Error).message },
      'page context not captured; the Workbench will show the neutral shell and say so',
    )
    return { websiteShell: null, pageTheme: null }
  }
}

/** The observation fields the category classifier is allowed to read. */
const SCHEMA_EVIDENCE_FIELDS = ['page.breadcrumbs', 'product.category', 'category.name', 'product.name', 'product.description']

/**
 * Gathers the classifier's evidence from ONE run.
 *
 * Scoped to the run like everything else here, so the category a report
 * names can only ever have been read from this company's own pages — the
 * sector names come from analyseSectors(), which is scoped the same way.
 */
export async function loadSchemaEvidence(auditRunId: string, sectors: SectorAnalysis): Promise<SchemaEvidence> {
  const observations = await prisma.pageObservation.findMany({
    where: { auditRunId, status: 'observed', field: { in: SCHEMA_EVIDENCE_FIELDS } },
    select: { field: true, value: true },
  })

  const valuesOf = (...fields: string[]) =>
    [...new Set(observations.filter((o) => fields.includes(o.field) && o.value?.trim()).map((o) => o.value!))]

  return {
    sectorNames: sectors.sectors.map((s) => s.name),
    categoryTexts: valuesOf('page.breadcrumbs', 'product.category', 'category.name'),
    productNames: valuesOf('product.name'),
    productDescriptions: valuesOf('product.description'),
  }
}

/**
 * The suggested wording, or null — never an exception.
 *
 * The proposal is ONE OPTIONAL BLOCK of the customer view. Everything else
 * here is the customer's own observed evidence: their products, their fields,
 * their gaps, their categories. Letting a failure in the suggestion box
 * destroy all of that is the wrong trade by a wide margin, and it is what
 * happened — a false positive in the proposal's own fact-guard threw, and the
 * entire view and the Audit Report with it became unavailable for a company
 * whose audit was perfectly good.
 *
 * `proposedContent: null` is already a supported, rendered state, reached
 * whenever a page publishes too little to compose from. A failure lands in
 * that same state.
 *
 * NOT a swallowed error. The reason is logged at error level with the run it
 * belongs to, because a proposal that cannot be built is a real defect worth
 * fixing — it is simply not a reason to withhold the customer's own data.
 */
function safeProposal(
  record: EnrichedRecord | null,
  categoryLabel: string | null,
  auditRunId: string,
): ProposedContent | null {
  if (!record) return null
  try {
    return buildProposedContent({ record, categoryLabel })
  } catch (err) {
    logger.error(
      { auditRunId, sourceUrl: record.sourceUrl, err: (err as Error).message },
      'proposed content could not be built; the customer view is returned without it',
    )
    return null
  }
}

/** "Not stated on any of 12 inspected product pages", and its milder forms. */
function statementFor(gap: SectorGap): string {
  if (gap.sample === 0) return 'No product page was inspected on this website.'
  if (gap.published === 0) {
    return `Not stated on any of the ${gap.sample} inspected product page(s).`
  }
  if (gap.published < gap.sample) {
    return `Stated on only ${gap.published} of ${gap.sample} inspected product page(s), so it cannot be relied on.`
  }
  return `Stated on all ${gap.sample} inspected product page(s).`
}

/**
 * Assembles the customer-facing reading of ONE audit run.
 *
 * Requires a generated report, because the wording belongs to it — but NOT an
 * approved one. An unapproved run still has a real story to show internally,
 * and refusing to build it is what left the Workbench as a bare warning box.
 * Approval governs PUBLICATION, and `approved` is reported so each caller can
 * enforce that itself.
 */
export async function buildCustomerView(tenantId: string, auditRunId: string): Promise<CustomerView> {
  const run = await prisma.websiteAuditRun.findFirst({ where: { id: auditRunId, tenantId } })
  if (!run) throw new NotFoundError('Website audit run not found.')

  const report = await prisma.auditReport.findFirst({ where: { auditRunId, tenantId } })
  if (!report) {
    throw new NotFoundError(
      'No report has been generated for that audit run yet, so there is no customer view to show.',
    )
  }

  // The approved revision's content wins over the report's own, because a
  // reviewer's edit is the thing that was approved.
  const revision = await prisma.auditReportRevision.findFirst({
    where: { auditReportId: report.id, revisionNumber: report.currentRevision },
  })
  const collateral = ((revision?.content ?? report.collateral) ?? {}) as Partial<SalesCollateral>

  const findings = await prisma.catalogFinding.findMany({
    where: { auditRunId },
    select: { priority: true },
  })

  // Scoped to this run throughout — see the note at the top of this file.
  const caseStudyPageIds = await selectCaseStudyPages(auditRunId, 2)
  const caseStudies = (
    await Promise.all(caseStudyPageIds.map((id) => buildEnrichedRecord(id)))
  ).filter((r): r is EnrichedRecord => r !== null)

  // Presentation context for the hero product's own page. Cached on the run
  // after the first view, so this costs one fetch per audit and not one per
  // page view.
  const pageContext = await pageContextFor(run, caseStudies[0]?.sourceUrl ?? null)

  const sectors = await analyseSectors(auditRunId)

  // Read from this run's own observation rows. Nothing here is recomputed
  // from the live site: what the crawl saw is what the customer is shown.
  const productEvidence = await loadProductEvidence(auditRunId)

  // Assessed against the FIRST case study — the richest page the run
  // fetched — or against nothing when the run found no product page, which
  // the schema then says rather than pretending every field is missing.
  const recommendedSchema = buildRecommendedSchema(
    await loadSchemaEvidence(auditRunId, sectors),
    caseStudies[0] ?? null,
  )

  const gaps: CustomerViewGap[] = sectors.catalogueGaps
    .filter((g) => g.published < g.sample)
    .slice(0, 6)
    .map((g) => ({ ...g, statement: statementFor(g) }))

  return {
    crmCompanyId: run.crmCompanyId,
    auditRunId: run.id,

    companyName: run.companyName ?? report.companyName ?? '(company name not recorded)',
    website: run.startUrl ?? report.websiteUrl ?? null,
    auditDate: (run.completedAt ?? run.createdAt).toISOString().slice(0, 10),

    pagesInspected: run.pagesFetched,
    productPagesInspected: run.productPages,
    categoryPagesInspected: run.categoryPages,

    reportStatus: report.status,
    approved: report.status === 'approved',

    headline: collateral.headline ?? `Product Data Health Check — ${run.companyName ?? 'this company'}`,
    summary: collateral.summary ?? '',
    scopeNote: collateral.scopeNote ?? '',
    businessValue: collateral.businessImpact ?? [],
    nextStep: collateral.nextStep ?? '',
    ctaLabel: collateral.cta?.label ?? 'Book a 15-minute walkthrough',

    priorities: {
      high: findings.filter((f) => f.priority === 'high').length,
      medium: findings.filter((f) => f.priority === 'medium').length,
      low: findings.filter((f) => f.priority === 'low').length,
    },

    gaps,
    caseStudies,
    productEvidence,
    sectors,
    recommendedSchema,
    // Composed from the hero product only, and only from what it published.
    // A page with a name and nothing else yields null rather than filler.
    proposedContent: safeProposal(
      caseStudies[0] ?? null,
      recommendedSchema.determined ? recommendedSchema.categoryLabel : null,
      auditRunId,
    ),
    // Their own furniture and palette, so the demonstration opens on a page
    // they recognise. Sampled from the hero product page — the page the
    // before-and-after is actually built from.
    ...pageContext,
    // One set of examples for both screens. Only for gaps on the hero page.
    illustrativeExamples: examplesFor(caseStudies[0] ?? null, recommendedSchema),
  }
}
