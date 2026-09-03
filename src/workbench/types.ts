// TASK #981 — AI WORKBENCH vocabulary.
//
// The Workbench is a customer-facing demonstration, not another audit report.
// It shows a prospect their own product page as it is today, beside a version
// improved from their own evidence, and asks for fifteen minutes.
//
// Two rules shape every type here.
//
// 1. An AFTER value exists only because a BEFORE value or another observed
//    field justified it. `TransformKind` has three producing values, and every
//    one of them names a source. There is no kind meaning "invented", because
//    a field with nowhere to record a source cannot be filled in.
//
// 2. An absent fact stays absent. `not_present` is a first-class outcome that
//    renders as a labelled empty slot carrying the observation proving we
//    looked. On the real 1st Ayd page that is nine fields of seventeen, and
//    those nine ARE the sales argument.

export const TRANSFORM_KINDS = [
  /** An observed fact re-expressed in a better structure. */
  'restructured',
  /** A field logically implied by a different observed field. */
  'derived',
  /** Existing text rewritten; the facts are unchanged. */
  'reworded',
  /** Present and already good; carried across untouched. */
  'unchanged',
  /** Not on the audited page. Rendered empty, never filled. */
  'not_present',
] as const
export type TransformKind = (typeof TRANSFORM_KINDS)[number]

/** What a customer sees marked against a field in the comparison. */
export const FIELD_DELTAS = ['added', 'restructured', 'reworded', 'unchanged', 'still_absent'] as const
export type FieldDelta = (typeof FIELD_DELTAS)[number]

export const DEMO_STATUSES = ['ready', 'no_product_page', 'failed'] as const
export type DemoStatus = (typeof DEMO_STATUSES)[number]

/**
 * Why a field looks the way it does, kept for every factual field.
 *
 * The customer-facing page does not show this by default — it is behind a
 * "View source evidence" disclosure — but it is stored for all of them, so any
 * claim on the page can be traced to the row and the page fragment behind it.
 */
export interface FieldProvenance {
  kind: TransformKind
  /** The PageObservation this came from. Null only for `not_present` gaps. */
  sourceObservationId: string | null
  sourceField: string | null
  sourceUrl: string | null
  sourcePath: string | null
  sourceFragment: string | null
  /** Plain-language statement of the rule that produced the AFTER value. */
  rule: string
}

/** One row of the BEFORE/AFTER comparison. */
export interface ComparedField {
  field: string
  /** Customer-facing label. "product.sku" is not a thing to show a buyer. */
  label: string
  before: string | null
  after: string | null
  delta: FieldDelta
  /** Whether this field is strong enough to lead with. */
  headline: boolean
  provenance: FieldProvenance
}

/**
 * The strongest few improvements, in business language.
 *
 * Deliberately not financial. "Buyers can filter by category" is defensible
 * from the evidence; "this earns you 12% more" is not, and the existing claim
 * guard refuses it.
 */
export interface ValuePoint {
  title: string
  why: string
  /** Fields this point is derived from, for traceability. */
  fields: string[]
}

/** Colours, fonts and layout sampled from the prospect's live site. */
export interface ThemeProfile {
  /** Where the sample came from, or why there is none. */
  source: 'live_sample' | 'neutral_default'
  reason: string | null
  primary: string
  accent: string
  ink: string
  surface: string
  muted: string
  fontFamily: string
  headingFamily: string
  logoUrl: string | null
  radius: string
  layoutFamily: string
}

export const NEUTRAL_THEME: ThemeProfile = {
  source: 'neutral_default',
  reason: null,
  primary: '#1d4ed8',
  accent: '#0f766e',
  ink: '#111827',
  surface: '#ffffff',
  muted: '#6b7280',
  fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  headingFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  logoUrl: null,
  radius: '10px',
  layoutFamily: 'generic',
}

/**
 * Product fields the Workbench shows, in the order a buyer cares about.
 *
 * Not the same order as the audit's PRODUCT_FIELDS: an audit lists fields for
 * completeness, a product page leads with what someone is trying to find out.
 */
export const DISPLAY_FIELDS: Array<{ field: string; label: string; headline: boolean }> = [
  { field: 'product.name', label: 'Product name', headline: true },
  { field: 'product.sku', label: 'Product code', headline: true },
  { field: 'product.brand', label: 'Brand', headline: true },
  { field: 'product.category', label: 'Category', headline: true },
  { field: 'product.description', label: 'Description', headline: true },
  { field: 'product.specifications', label: 'Specifications', headline: true },
  { field: 'product.dimensions', label: 'Dimensions', headline: true },
  { field: 'product.weight', label: 'Weight', headline: true },
  { field: 'product.attributes', label: 'Attributes', headline: false },
  { field: 'product.units', label: 'Units of measure', headline: false },
  { field: 'product.price', label: 'Price', headline: false },
  { field: 'product.availability', label: 'Availability', headline: false },
  { field: 'product.mpn', label: 'Manufacturer part number', headline: false },
  { field: 'product.gtin', label: 'GTIN / barcode', headline: false },
  { field: 'product.documents', label: 'Datasheets', headline: false },
  { field: 'product.imageCount', label: 'Images', headline: false },
]

/** Shown in place of a value that was not on the page. Never a guess. */
export const EMPTY_STATE = 'Not observed in audited page'
