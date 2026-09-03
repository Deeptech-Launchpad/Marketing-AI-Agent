// STAGE 5 — WEBSITE AUDIT vocabulary.
//
// The single rule this file encodes: Stage 5 says WHAT WAS OBSERVED, never
// what is wrong. There is no field here for a verdict, a score, a severity or
// a problem, because a type that has nowhere to put a judgement cannot leak
// one into Stage 6's input.
//
// The distinction that makes that work is `status`. A field that is absent is
// recorded as `not_observed` rather than dropped — "the dimensions field was
// not on the page" is a fact Stage 6 needs, and an omitted row would be
// indistinguishable from a field nobody looked for.

export const OBSERVATION_STATUSES = ['observed', 'not_observed', 'could_not_determine'] as const
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number]

/** How a value was obtained. Ordered strongest-first for evidence weighting. */
export const EXTRACTION_METHODS = [
  'json_ld',
  'microdata',
  'meta_tag',
  'http_header',
  'dom_heuristic',
  'url_pattern',
  'link_analysis',
] as const
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number]

export const PAGE_TYPES = [
  'product',
  'category',
  'listing',
  'search',
  'specification',
  'company',
  'other',
  'unknown',
] as const
export type PageType = (typeof PAGE_TYPES)[number]

export const FETCH_OUTCOMES = [
  'fetched',
  'http_error',
  'unreachable',
  'timeout',
  'blocked',
  'non_html',
  'too_large',
  'duplicate',
  'soft_404',
] as const
export type FetchOutcome = (typeof FETCH_OUTCOMES)[number]

export const AUDIT_STATUSES = ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'] as const
export type AuditStatus = (typeof AUDIT_STATUSES)[number]

/**
 * One observation about one field on one page.
 *
 * `value` is the literal text found — never normalised into a canonical form,
 * because "12 x 8 x 4 in" and "304.8mm" are different observations and Stage 6
 * may care which one the page actually said.
 */
export interface Observation {
  field: string
  status: ObservationStatus
  /** Exactly as the page stated it. Null whenever status is not `observed`. */
  value: string | null
  method: ExtractionMethod | null
  /** Where in the document: a JSON-LD path, a selector, a URL pattern. */
  sourcePath: string | null
  /** The literal source fragment, so a wrong reading is visible without a refetch. */
  fragment: string | null
}

/**
 * Product fields an audit looks for on every product page.
 *
 * The list is fixed on purpose: each one produces a row whether or not the page
 * has it, so "not observed" is recorded as positively as "observed". Stage 6
 * reads the absences.
 */
export const PRODUCT_FIELDS = [
  'product.name',
  'product.sku',
  'product.mpn',
  'product.gtin',
  'product.brand',
  'product.category',
  'product.description',
  'product.specifications',
  'product.attributes',
  'product.dimensions',
  'product.weight',
  'product.units',
  'product.price',
  'product.currency',
  'product.availability',
  'product.imageCount',
  'product.documents',
] as const

/** Category/listing fields, looked for on every category page. */
export const CATEGORY_FIELDS = [
  'category.name',
  'category.productCount',
  'category.pagination',
  'category.filters',
  'category.facets',
  'category.sortOptions',
  'category.breadcrumbs',
] as const

/** Page-level fields recorded for every inspected page. */
export const PAGE_FIELDS = [
  'page.title',
  'page.metaDescription',
  'page.canonical',
  'page.breadcrumbs',
  'page.headings',
  'page.wordCount',
  'page.structuredDataTypes',
] as const

export interface PageRecord {
  requestedUrl: string
  finalUrl: string | null
  httpStatus: number | null
  contentType: string | null
  outcome: FetchOutcome
  pageType: PageType
  /** Which signals produced the page-type call, so it can be checked. */
  typeSignals: string[]
  depth: number
  bytes: number
  wordCount: number
  contentHash: string | null
  canonicalUrl: string | null
  /** Set when this page duplicates one already recorded. */
  duplicateOfUrl: string | null
  redirectChain: string[]
  truncated: boolean
  failureReason: string | null
  fetchedAt: Date
  durationMs: number
  observations: Observation[]
}

export interface CrawlStats {
  pagesFetched: number
  pagesSkipped: number
  productPages: number
  categoryPages: number
  otherPages: number
  duplicates: number
  canonicalDuplicates: number
  soft404s: number
  httpErrors: number
  unreachable: number
  totalBytes: number
  structuredDataPages: number
  limitsHit: string[]
}

/** Convenience for building an absence row without repeating the nulls. */
export function notObserved(field: string): Observation {
  return { field, status: 'not_observed', value: null, method: null, sourcePath: null, fragment: null }
}

export function observed(
  field: string,
  value: string,
  method: ExtractionMethod,
  sourcePath: string,
  fragment: string,
): Observation {
  return {
    field,
    status: 'observed',
    // Bounded so one runaway page cannot dominate the run's storage.
    value: value.slice(0, 2000),
    method,
    sourcePath: sourcePath.slice(0, 300),
    fragment: fragment.replace(/\s+/g, ' ').trim().slice(0, 600),
  }
}

export function couldNotDetermine(field: string, sourcePath: string, fragment: string): Observation {
  return {
    field,
    status: 'could_not_determine',
    value: null,
    method: null,
    sourcePath: sourcePath.slice(0, 300),
    fragment: fragment.replace(/\s+/g, ' ').trim().slice(0, 600),
  }
}
