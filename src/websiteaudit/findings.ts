import { assertSupported, sampleMetric } from './claimGuard.js'

// TASK #979 — catalog / product-data analysis.
//
// This is the ONE place in the website-audit module allowed to say something is
// wrong. Everything upstream records what was observed; this file reads those
// records and names the gaps.
//
// Three rules bind every finding here:
//
// 1. It must come from stored observations. A rule that cannot point at
//    observation rows produces nothing. There is no path by which a finding is
//    written without evidence attached, because the evidence is a required
//    argument, not an optional decoration.
//
// 2. It must state its denominator. Every metric goes through sampleMetric(),
//    so "3 of 12 inspected product pages" is expressible and "87% of the
//    catalogue" is not.
//
// 3. It must survive the claim guard. Impact and recommendation text is checked
//    before it is returned, and a generator that writes an indefensible
//    sentence throws instead of shipping it.

export interface FindingEvidence {
  observationId: string
  pageId: string
  sourceUrl: string
  field: string
  status: string
  value: string | null
  sourcePath: string | null
  fragment: string | null
  observedAt: Date
}

export type FindingPriority = 'high' | 'medium' | 'low'

export interface CatalogFinding {
  code: string
  title: string
  category: string
  priority: FindingPriority
  priorityReasons: string[]
  /** How many of the sample the finding applies to. */
  affectedCount: number
  /** How many of the sample had the thing present. */
  observedCount: number
  sampleSize: number
  sampleUnit: string
  metric: string
  finding: string
  impact: string
  recommendation: string
  evidence: FindingEvidence[]
}

/** One observation row as the analyser needs it. */
export interface ObservationRow {
  id: string
  pageId: string
  field: string
  status: string
  value: string | null
  sourcePath: string | null
  fragment: string | null
  observedAt: Date
  pageUrl: string
  pageType: string
}

export interface AuditContext {
  pagesFetched: number
  productPages: number
  categoryPages: number
  duplicatePages: number
  canonicalDuplicates: number
  soft404Pages: number
  httpErrors: number
  /** URLs that returned an HTTP error, for evidence. */
  httpErrorPages: Array<{ pageId: string; url: string; status: number | null; reason: string | null }>
}

/**
 * Field criticality.
 *
 * Tier 1 fields are what a buyer searches and filters on; without them a
 * product is effectively unfindable. Tier 2 fields affect how a found product
 * presents. Tier 3 is page housekeeping. The tiers drive priority, and they are
 * a stated editorial judgement rather than a computed one — which is why they
 * are written down here instead of buried in a score.
 */
const TIER: Record<string, 1 | 2 | 3> = {
  'product.specifications': 1,
  'product.attributes': 1,
  'product.dimensions': 1,
  'product.weight': 1,
  'product.sku': 1,
  'product.units': 1,
  'product.brand': 2,
  'product.description': 2,
  'product.category': 2,
  'product.imageCount': 2,
  'product.availability': 2,
  'product.documents': 3,
  'page.metaDescription': 3,
  'page.canonical': 3,
}

/** Deterministic and explained. There is no hidden score. */
function priorityFor(field: string, affected: number, sample: number): { priority: FindingPriority; reasons: string[] } {
  const tier = TIER[field] ?? 3
  const proportion = sample > 0 ? affected / sample : 0
  const reasons = [
    `"${field}" is a tier ${tier} field (${tier === 1 ? 'needed to find and filter a product' : tier === 2 ? 'affects how a found product presents' : 'page housekeeping'}).`,
    `It applies to ${affected} of the ${sample} inspected pages in this sample.`,
  ]

  let priority: FindingPriority
  if (tier === 1) priority = proportion >= 0.5 ? 'high' : 'medium'
  else if (tier === 2) priority = proportion >= 0.8 ? 'high' : proportion >= 0.5 ? 'medium' : 'low'
  else priority = proportion >= 1 ? 'medium' : 'low'

  reasons.push(`Tier ${tier} at this share of the sample gives priority "${priority}".`)
  return { priority, reasons }
}

/**
 * The one ordering for findings, shared by the analyser, the PDF and the API.
 *
 * It exists as a function because `priority` is a string column, so a SQL
 * `ORDER BY priority ASC` sorts high, low, medium and puts the least important
 * findings above the middling ones. The PDF prints only the first four, so a
 * revision rendered from a SQL-ordered list showed a DIFFERENT set of findings
 * than the original document — caught when a revision's PDF came out a page
 * shorter than the revision it was edited from.
 */
export const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

export function sortFindingsByPriority<T extends { priority: string; affectedCount: number; sampleSize: number }>(
  rows: T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      b.affectedCount / Math.max(1, b.sampleSize) - a.affectedCount / Math.max(1, a.sampleSize),
  )
}

function evidenceFrom(rows: ObservationRow[], limit = 5): FindingEvidence[] {
  return rows.slice(0, limit).map((o) => ({
    observationId: o.id,
    pageId: o.pageId,
    sourceUrl: o.pageUrl,
    field: o.field,
    status: o.status,
    value: o.value,
    sourcePath: o.sourcePath,
    fragment: o.fragment,
    observedAt: o.observedAt,
  }))
}

/** Every finding is built here, so every finding is guarded and evidenced. */
function makeFinding(input: Omit<CatalogFinding, 'metric' | 'priority' | 'priorityReasons'> & {
  field: string
  metric: string
}): CatalogFinding {
  const { priority, reasons } = priorityFor(input.field, input.affectedCount, input.sampleSize)
  return {
    code: input.code,
    title: input.title,
    category: input.category,
    priority,
    priorityReasons: reasons,
    affectedCount: input.affectedCount,
    observedCount: input.observedCount,
    sampleSize: input.sampleSize,
    sampleUnit: input.sampleUnit,
    metric: assertSupported(`${input.code}.metric`, input.metric),
    finding: assertSupported(`${input.code}.finding`, input.finding),
    impact: assertSupported(`${input.code}.impact`, input.impact),
    recommendation: assertSupported(`${input.code}.recommendation`, input.recommendation),
    evidence: input.evidence,
  }
}

/** A field-absence rule: "this field was not on N of the M pages we looked at". */
interface AbsenceRule {
  field: string
  code: string
  title: string
  category: string
  what: string
  impact: string
  recommendation: string
  /**
   * How the metric names this field, and the verb that agrees with it.
   *
   * Written out per rule rather than derived from the field name. Deriving it
   * produced "Weight were observed on 0 of 12 inspected product pages" and
   * "Sku were observed on ...", which is exactly the kind of thing a prospect
   * notices in the first line of a document asking them to trust its numbers.
   */
  metricSubject: string
  metricVerb: string
}

const ABSENCE_RULES: AbsenceRule[] = [
  {
    field: 'product.specifications',
    metricSubject: "A specification block",
    metricVerb: "was observed on",
    code: 'incomplete_specifications',
    title: 'Specifications not present on inspected product pages',
    category: 'specifications',
    what: 'A specification block (a table, definition list, or labelled key/value list) could not be found',
    impact:
      'A buyer comparing options on those pages has nothing structured to compare, and the pages carry no attribute data for a search or filter to index.',
    recommendation:
      'Publish a consistent specification block on each product page, using the same attribute names across the range so the values can be compared and filtered.',
  },
  {
    field: 'product.dimensions',
    metricSubject: "Dimensional data",
    metricVerb: "was observed on",
    code: 'missing_dimensions',
    title: 'Dimensional data not present on inspected product pages',
    category: 'attributes',
    what: 'No dimensional attribute (width, height, length, depth, diameter or an explicit size) was found',
    impact:
      'Buyers who need to confirm fit cannot do so on the page, and dimensional filters cannot be offered for those products.',
    recommendation:
      'Record dimensions as separate named attributes with their units, rather than only inside prose or an image.',
  },
  {
    field: 'product.weight',
    metricSubject: "A weight attribute",
    metricVerb: "was observed on",
    code: 'missing_weight',
    title: 'Weight not present on inspected product pages',
    category: 'attributes',
    what: 'No weight or mass attribute was found',
    impact:
      'Shipping and handling questions cannot be answered from the page, and weight-based delivery rules have nothing to read.',
    recommendation: 'Publish weight as a named attribute with its unit on each product page.',
  },
  {
    field: 'product.brand',
    metricSubject: "A brand",
    metricVerb: "was stated on",
    code: 'missing_brand',
    title: 'Brand not stated on inspected product pages',
    category: 'attributes',
    what: 'No brand or manufacturer was stated in structured data or in a labelled field',
    impact:
      'Buyers searching for a specific manufacturer cannot narrow to it, and brand facets cannot be built from those pages.',
    recommendation: 'State the brand in a structured field on each product page, not only in the product title.',
  },
  {
    field: 'product.sku',
    metricSubject: "A product identifier (SKU, part number, MPN or GTIN)",
    metricVerb: "was stated on",
    code: 'missing_product_identifier',
    title: 'Product identifier not stated on inspected product pages',
    category: 'identifiers',
    what: 'No SKU, part number, MPN or GTIN was stated',
    impact:
      'A buyer who knows the part number cannot match it to the page, and the products cannot be reconciled against a distributor or manufacturer feed.',
    recommendation:
      'Publish the manufacturer part number and your own SKU as distinct labelled fields on each product page.',
  },
  {
    field: 'product.description',
    metricSubject: "A product description",
    metricVerb: "was observed on",
    code: 'weak_product_description',
    title: 'Product description not present on inspected product pages',
    category: 'descriptions',
    what: 'No product description was found in structured data or a description field',
    impact:
      'The page gives a buyer little to read beyond the title, and there is little text for a search engine to index against the product.',
    recommendation:
      'Add a short factual description to each product page covering what the item is, what it is used for, and what distinguishes it from adjacent items in the range.',
  },
  {
    field: 'product.availability',
    metricSubject: "An availability status",
    metricVerb: "was stated on",
    code: 'missing_availability',
    title: 'Availability not stated on inspected product pages',
    category: 'availability',
    what: 'No stock or availability status was stated',
    impact: 'Buyers cannot tell from the page whether an item can be supplied, which moves the question to a phone call.',
    recommendation: 'Publish an availability status on each product page, even where the value is "made to order" or "on request".',
  },
]

/**
 * Builds findings from stored observations.
 *
 * Returns an empty list when there is nothing to say. That is a real outcome:
 * a site with no product pages inspected produces one honest finding about the
 * crawl, not seventeen invented ones about a catalogue nobody saw.
 */
export function analyseObservations(observations: ObservationRow[], ctx: AuditContext): CatalogFinding[] {
  const findings: CatalogFinding[] = []
  const productObs = observations.filter((o) => o.field.startsWith('product.'))
  const productPageIds = new Set(productObs.map((o) => o.pageId))
  const sample = productPageIds.size

  // ── No product pages: say so, and stop. ─────────────────────────────────
  if (sample === 0) {
    if (ctx.pagesFetched > 0) {
      findings.push(
        makeFinding({
          field: 'page.canonical',
          code: 'no_product_pages_identified',
          title: 'No product page could be identified among the inspected pages',
          category: 'structure',
          affectedCount: ctx.pagesFetched,
          observedCount: 0,
          sampleSize: ctx.pagesFetched,
          sampleUnit: 'pages',
          metric: sampleMetric('Product pages', 0, ctx.pagesFetched, 'pages', 'were identified among'),
          finding:
            'None of the inspected pages carried product structured data, single-product markup, or a repeated product-tile grid. This may mean the site has no online catalogue, that the catalogue sits behind a login or a script-rendered interface, or that the crawl did not reach it within its page budget.',
          impact:
            'Product data on this site could not be assessed. Anything a buyer or a search engine would read about individual products was not reachable from the inspected pages.',
          recommendation:
            'Confirm whether an online catalogue exists and is publicly reachable. If it is rendered by script or sits behind a login, note that the pages cannot be read by search engines or by data partners either.',
          evidence: evidenceFrom(observations.filter((o) => o.field === 'page.title')),
        }),
      )
    }
    findings.push(...siteLevelFindings(observations, ctx))
    return findings
  }

  // ── Field absence across the product sample. ────────────────────────────
  for (const rule of ABSENCE_RULES) {
    const rows = productObs.filter((o) => o.field === rule.field)
    if (!rows.length) continue

    const absent = rows.filter((o) => o.status === 'not_observed')
    const present = rows.filter((o) => o.status === 'observed')
    if (!absent.length) continue

    findings.push(
      makeFinding({
        field: rule.field,
        code: rule.code,
        title: rule.title,
        category: rule.category,
        affectedCount: absent.length,
        observedCount: present.length,
        sampleSize: rows.length,
        sampleUnit: 'product pages',
        metric: sampleMetric(rule.metricSubject, present.length, rows.length, 'product pages', rule.metricVerb),
        finding: `${rule.what} on ${absent.length} of the ${rows.length} inspected product pages.`,
        impact: rule.impact,
        recommendation: rule.recommendation,
        // Evidence for an ABSENCE is the not_observed rows themselves: they
        // record that the field was looked for on a named URL and was not there.
        evidence: evidenceFrom(absent),
      }),
    )
  }

  findings.push(...unitConsistency(productObs))
  findings.push(...thinProductPages(productObs))
  findings.push(...structuredDataFindings(observations, productPageIds))
  findings.push(...siteLevelFindings(observations, ctx))
  findings.push(...duplicateCategoryFindings(observations))

  // Highest priority first, then the largest share of the sample. Shared with
  // the PDF and the API so all three agree on which findings lead.
  return sortFindingsByPriority(findings)
}

/** Different pages stating measurements in different units. */
function unitConsistency(productObs: ObservationRow[]): CatalogFinding[] {
  const rows = productObs.filter((o) => o.field === 'product.units' && o.status === 'observed')
  if (rows.length < 2) return []

  const unitsPerPage = rows.map((o) => ({ row: o, units: (o.value ?? '').split(',').map((u) => u.trim()).filter(Boolean) }))
  const metric = new Set<string>()
  const imperial = new Set<string>()
  const METRIC = /^(mm|cm|m|km|kg|g|ml|l|litres?|liters?|tonnes?)$/
  const IMPERIAL = /^(in|inch|inches|ft|yd|lb|lbs|oz)$/

  unitsPerPage.forEach(({ units }) =>
    units.forEach((u) => {
      if (METRIC.test(u)) metric.add(u)
      if (IMPERIAL.test(u)) imperial.add(u)
    }),
  )

  if (!metric.size || !imperial.size) return []

  const mixed = unitsPerPage.filter(({ units }) => units.some((u) => METRIC.test(u)) && units.some((u) => IMPERIAL.test(u)))
  const affected = mixed.length || unitsPerPage.length

  return [
    makeFinding({
      field: 'product.units',
      code: 'inconsistent_units',
      title: 'Both metric and imperial units appear across inspected product pages',
      category: 'consistency',
      affectedCount: affected,
      observedCount: rows.length,
      sampleSize: rows.length,
      sampleUnit: 'product pages',
      metric: sampleMetric('Measurement units', rows.length, rows.length, 'product pages'),
      finding: `Metric units (${[...metric].sort().join(', ')}) and imperial units (${[...imperial].sort().join(', ')}) both appear across the inspected product pages.`,
      impact:
        'Values stated in different unit systems cannot be sorted or filtered together, and a buyer comparing two items has to convert between them by hand.',
      recommendation:
        'Choose one primary unit system for stored attribute values and derive the other for display, so that a single comparable value exists behind each measurement.',
      evidence: evidenceFrom(rows),
    }),
  ]
}

/** Product pages carrying almost no attribute data of any kind. */
function thinProductPages(productObs: ObservationRow[]): CatalogFinding[] {
  const byPage = new Map<string, ObservationRow[]>()
  productObs.forEach((o) => {
    const list = byPage.get(o.pageId)
    if (list) list.push(o)
    else byPage.set(o.pageId, [o])
  })

  const DATA_FIELDS = [
    'product.specifications',
    'product.attributes',
    'product.dimensions',
    'product.weight',
    'product.brand',
    'product.description',
  ]

  const thin: ObservationRow[] = []
  let thinPages = 0
  for (const [, rows] of byPage) {
    const present = rows.filter((o) => DATA_FIELDS.includes(o.field) && o.status === 'observed').length
    if (present === 0) {
      thinPages++
      const marker = rows.find((o) => o.field === 'product.name') ?? rows[0]
      if (marker) thin.push(marker)
    }
  }
  if (!thinPages) return []

  return [
    makeFinding({
      field: 'product.attributes',
      code: 'incomplete_product_metadata',
      title: 'Inspected product pages carrying no descriptive or attribute data',
      category: 'attributes',
      affectedCount: thinPages,
      observedCount: byPage.size - thinPages,
      sampleSize: byPage.size,
      sampleUnit: 'product pages',
      metric: sampleMetric('Descriptive or attribute data', byPage.size - thinPages, byPage.size, 'product pages', 'was observed on'),
      finding: `${thinPages} of the ${byPage.size} inspected product pages carried none of: specifications, attributes, dimensions, weight, brand, or a description.`,
      impact:
        'Those pages identify a product by name and little else, so a buyer cannot evaluate the item and a search engine has nothing specific to index against it.',
      recommendation:
        'Establish a minimum data set that a product page must carry before it is published, and backfill the pages that fall short of it.',
      evidence: evidenceFrom(thin),
    }),
  ]
}

/** Product pages with no machine-readable product markup. */
function structuredDataFindings(observations: ObservationRow[], productPageIds: Set<string>): CatalogFinding[] {
  const rows = observations.filter((o) => o.field === 'page.structuredDataTypes' && productPageIds.has(o.pageId))
  if (!rows.length) return []

  const withProductMarkup = rows.filter((o) => o.status === 'observed' && /product/i.test(o.value ?? ''))
  const without = rows.filter((o) => !(o.status === 'observed' && /product/i.test(o.value ?? '')))
  if (!without.length) return []

  return [
    makeFinding({
      field: 'product.category',
      code: 'no_product_structured_data',
      title: 'Product structured data not declared on inspected product pages',
      category: 'structure',
      affectedCount: without.length,
      observedCount: withProductMarkup.length,
      sampleSize: rows.length,
      sampleUnit: 'product pages',
      metric: sampleMetric('Product structured data', withProductMarkup.length, rows.length, 'product pages', 'was declared on'),
      finding: `No Product schema (JSON-LD or microdata) was declared on ${without.length} of the ${rows.length} inspected product pages.`,
      impact:
        'Search engines, marketplaces and data partners read that markup to understand a page. Without it they have to infer the product from layout, and often decline to show enhanced results for the page.',
      recommendation:
        'Emit Product structured data on each product page, populated from the same source as the visible attributes so the two cannot drift apart.',
      evidence: evidenceFrom(without),
    }),
  ]
}

/** Findings about the site as a whole rather than about product fields. */
function siteLevelFindings(observations: ObservationRow[], ctx: AuditContext): CatalogFinding[] {
  const out: CatalogFinding[] = []

  if (ctx.httpErrors > 0 && ctx.httpErrorPages.length) {
    out.push(
      makeFinding({
        field: 'page.canonical',
        code: 'broken_internal_links',
        title: 'Internal links returning an HTTP error',
        category: 'structure',
        affectedCount: ctx.httpErrors,
        observedCount: ctx.pagesFetched,
        sampleSize: ctx.pagesFetched + ctx.httpErrors,
        sampleUnit: 'pages',
        metric: sampleMetric('HTTP errors', ctx.httpErrors, ctx.pagesFetched + ctx.httpErrors, 'pages', 'were returned by'),
        finding: `${ctx.httpErrors} internal link(s) followed from the inspected pages returned an HTTP error.`,
        impact:
          'A buyer following those links reaches an error page, and a crawler following them spends its budget on pages that do not exist.',
        recommendation: 'Correct or remove the links that lead to those URLs.',
        evidence: ctx.httpErrorPages.slice(0, 5).map((p) => ({
          observationId: `page:${p.pageId}`,
          pageId: p.pageId,
          sourceUrl: p.url,
          field: 'page.httpStatus',
          status: 'observed',
          value: p.status !== null ? String(p.status) : null,
          sourcePath: 'HTTP response status',
          fragment: p.reason,
          observedAt: new Date(),
        })),
      }),
    )
  }

  if (ctx.soft404Pages > 0) {
    const total = ctx.pagesFetched + ctx.soft404Pages
    out.push(
      makeFinding({
        field: 'page.canonical',
        code: 'soft_404_pages',
        title: 'Unknown URLs answered with a page instead of a 404',
        category: 'structure',
        affectedCount: ctx.soft404Pages,
        observedCount: 0,
        sampleSize: total,
        sampleUnit: 'pages',
        metric: sampleMetric('Soft-404 responses', ctx.soft404Pages, total, 'pages', 'were returned by'),
        finding: `${ctx.soft404Pages} inspected URL(s) returned HTTP 200 with content identical to the site's not-found page.`,
        impact:
          'Search engines cannot tell a real page from a missing one on this site, so removed products can stay indexed and dilute the pages that do exist.',
        recommendation: 'Return a genuine 404 status for URLs that do not exist, rather than a 200 with a not-found template.',
        evidence: evidenceFrom(observations.filter((o) => o.field === 'page.title'), 3),
      }),
    )
  }

  const duplicates = ctx.duplicatePages + ctx.canonicalDuplicates
  if (duplicates > 0) {
    const total = ctx.pagesFetched + duplicates
    out.push(
      makeFinding({
        field: 'page.canonical',
        code: 'duplicate_pages',
        title: 'Duplicate pages served at more than one URL',
        category: 'structure',
        affectedCount: duplicates,
        observedCount: ctx.pagesFetched,
        sampleSize: total,
        sampleUnit: 'pages',
        metric: sampleMetric('Duplicate pages', duplicates, total, 'pages', 'were found among'),
        finding: `${ctx.duplicatePages} inspected URL(s) returned content identical to another URL, and ${ctx.canonicalDuplicates} declared the same canonical URL as another inspected page.`,
        impact:
          'The same content reachable at several addresses splits how it is indexed and makes reporting on a page ambiguous.',
        recommendation:
          'Serve one canonical URL per page and redirect or canonicalise the alternatives to it.',
        evidence: evidenceFrom(observations.filter((o) => o.field === 'page.canonical' && o.status === 'observed'), 5),
      }),
    )
  }

  return out
}

/** The same category name published at more than one URL. */
function duplicateCategoryFindings(observations: ObservationRow[]): CatalogFinding[] {
  const rows = observations.filter((o) => o.field === 'category.name' && o.status === 'observed' && o.value)
  if (rows.length < 2) return []

  const byName = new Map<string, ObservationRow[]>()
  rows.forEach((o) => {
    const key = (o.value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
    const list = byName.get(key)
    if (list) list.push(o)
    else byName.set(key, [o])
  })

  const duplicated = [...byName.entries()].filter(([, list]) => new Set(list.map((o) => o.pageUrl)).size > 1)
  if (!duplicated.length) return []

  const affectedRows = duplicated.flatMap(([, list]) => list)

  return [
    makeFinding({
      field: 'product.category',
      code: 'duplicate_categories',
      title: 'The same category name published at more than one URL',
      category: 'structure',
      affectedCount: duplicated.length,
      observedCount: byName.size,
      sampleSize: byName.size,
      sampleUnit: 'category pages',
      metric: sampleMetric('Distinct category names', byName.size, rows.length, 'category pages', 'were found across'),
      finding: `${duplicated.length} category name(s) appeared at more than one URL among the inspected category pages: ${duplicated
        .map(([name]) => `"${name}"`)
        .slice(0, 5)
        .join(', ')}.`,
      impact:
        'A buyer can arrive at either address for the same range, and the two compete with each other in search results.',
      recommendation:
        'Keep one URL per category and redirect the alternatives, or set a canonical URL on the duplicates.',
      evidence: evidenceFrom(affectedRows),
    }),
  ]
}
