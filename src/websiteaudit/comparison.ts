import { assertSupported } from './claimGuard.js'
import type { CatalogFinding, FindingEvidence } from './findings.js'

// PHASE 6 — peer comparison.
//
// BUSINESS SOURCE: brief Section 10 and Section 38 of the Team Answer
// implementation prompt. The team wants a report that can say "here is where
// you are, here is what comparable companies do". The same section says:
//
//   "Do NOT create unsupported rankings, fake competitor scores, invented
//    competitor revenue... Every comparative observation must have a source.
//    If no reliable comparison source exists: show 'Comparable evidence not
//    available for this audit.' Do NOT fabricate it."
//
// So this module is built around a refusal. It compares only attributes that
// were OBSERVED on both sides, by the same audit method, and it produces
// nothing at all when the other side was never audited. There is no code path
// here that reads a competitor's website, guesses at a peer, or scores anyone.
//
// The peer's data arrives the same way the prospect's did: from a completed
// audit run of that peer, stored by this platform. That is a deliberate
// constraint. It means a comparison can only exist where somebody chose to
// audit the peer, which is the only way "comparable" is defensible — the two
// sides were measured the same way, on the same fields, at a stated time.

/** One comparable attribute, observed on both sides by the same method. */
export interface ComparisonRow {
  /** The audited field, in customer-facing language. */
  attribute: string
  field: string
  /** What the prospect's inspected pages showed. */
  prospect: string
  /** What the peer's inspected pages showed. */
  peer: string
  /** Which side carried the field more consistently, or neither. */
  advantage: 'prospect' | 'peer' | 'comparable'
  /** The evidence behind each side. Never empty. */
  prospectEvidence: { sourceUrl: string; observationId: string }[]
  peerEvidence: { sourceUrl: string; observationId: string }[]
}

export interface PeerComparison {
  available: true
  peerLabel: string
  peerAuditDate: string
  /** Stated so a reader knows both sides were measured the same way. */
  methodNote: string
  rows: ComparisonRow[]
  summary: string
}

export interface NoPeerComparison {
  available: false
  /** Shown verbatim in the report. */
  message: string
  reason: string
}

export type ComparisonResult = PeerComparison | NoPeerComparison

/** A completed audit of a peer, as this module needs it. */
export interface PeerAudit {
  /** How the peer is named in the report. Never an internal identifier. */
  label: string
  auditDate: Date
  productPagesInspected: number
  findings: CatalogFinding[]
}

export interface ComparisonInput {
  prospectLabel: string
  prospectProductPages: number
  prospectFindings: CatalogFinding[]
  peer: PeerAudit | null
  /** How many rows the report may carry. */
  maxRows: number
}

const FIELD_LABELS: Record<string, string> = {
  'product.specifications': 'Technical specifications',
  'product.dimensions': 'Dimensions',
  'product.weight': 'Weight',
  'product.sku': 'Product identifier',
  'product.brand': 'Brand',
  'product.description': 'Product description',
  'product.category': 'Category',
  'product.imageCount': 'Product imagery',
  'product.availability': 'Availability',
  'product.units': 'Units of measure',
  'product.documents': 'Supporting documents',
  'page.structuredData': 'Structured product data',
  'page.metaDescription': 'Page metadata',
}

function labelFor(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/^product\./, '').replace(/([A-Z])/g, ' $1').toLowerCase()
}

/**
 * Reduces one side's findings to "how consistently did this field appear".
 *
 * Uses the finding's own observed/sample counts, so both sides are described
 * with the numbers their own audit defended.
 */
function fieldPresence(findings: CatalogFinding[]): Map<string, { observed: number; sample: number; evidence: FindingEvidence[] }> {
  const map = new Map<string, { observed: number; sample: number; evidence: FindingEvidence[] }>()
  for (const f of findings) {
    for (const e of f.evidence) {
      const cur = map.get(e.field) ?? { observed: 0, sample: 0, evidence: [] }
      cur.evidence.push(e)
      map.set(e.field, cur)
    }
    // The finding's counts describe the field it is about; take them from the
    // first piece of evidence, which names the field.
    const field = f.evidence[0]?.field
    if (!field) continue
    const cur = map.get(field)!
    cur.observed = f.observedCount
    cur.sample = f.sampleSize
  }
  return map
}

/**
 * Builds the comparison, or explains why there is none.
 *
 * Returns the "not available" shape far more often than the comparison, and
 * that is the intended behaviour rather than a gap: a comparison requires
 * somebody to have audited a peer with this same engine.
 */
export function buildComparison(input: ComparisonInput): ComparisonResult {
  if (!input.peer) {
    return {
      available: false,
      message: 'Comparable evidence not available for this audit.',
      reason:
        'No comparable company has been audited by this platform, so there is nothing to compare against that was ' +
        'measured the same way. A comparison is only shown where a peer has been inspected using the same method.',
    }
  }

  if (input.peer.productPagesInspected === 0 || input.prospectProductPages === 0) {
    return {
      available: false,
      message: 'Comparable evidence not available for this audit.',
      reason:
        `A peer audit exists (${input.peer.label}) but one of the two sides had no product page identified, so there ` +
        'is no like-for-like basis. Comparing a site with product pages against one without would not be a comparison.',
    }
  }

  const mine = fieldPresence(input.prospectFindings)
  const theirs = fieldPresence(input.peer.findings)

  const rows: ComparisonRow[] = []
  for (const [field, a] of mine) {
    const b = theirs.get(field)
    // Both sides must have been measured on this field. A field only one side
    // was assessed on is not a difference between them — it is a difference
    // between the two audits, and reporting it as the former would be wrong.
    if (!b || a.sample === 0 || b.sample === 0) continue

    const mineRate = a.observed / a.sample
    const theirsRate = b.observed / b.sample
    // A margin, so a one-page difference in a small sample is not dressed up
    // as an advantage.
    const margin = 0.2
    const advantage: ComparisonRow['advantage'] =
      mineRate - theirsRate > margin ? 'prospect' : theirsRate - mineRate > margin ? 'peer' : 'comparable'

    rows.push({
      attribute: labelFor(field),
      field,
      prospect: `present on ${a.observed} of ${a.sample} inspected product pages`,
      peer: `present on ${b.observed} of ${b.sample} inspected product pages`,
      advantage,
      prospectEvidence: a.evidence.slice(0, 3).map((e) => ({ sourceUrl: e.sourceUrl, observationId: e.observationId })),
      peerEvidence: b.evidence.slice(0, 3).map((e) => ({ sourceUrl: e.sourceUrl, observationId: e.observationId })),
    })
  }

  if (!rows.length) {
    return {
      available: false,
      message: 'Comparable evidence not available for this audit.',
      reason:
        `A peer audit exists (${input.peer.label}) but no field was assessed on both sides, so there is no ` +
        'like-for-like row to show.',
    }
  }

  // Lead with where the peer is ahead: that is the part of a comparison a
  // prospect has a reason to act on.
  const order = { peer: 0, comparable: 1, prospect: 2 } as const
  rows.sort((x, y) => order[x.advantage] - order[y.advantage])
  const shown = rows.slice(0, input.maxRows)

  const behind = shown.filter((r) => r.advantage === 'peer')
  const summary = behind.length
    ? `On ${behind.length} of the ${shown.length} attributes compared, ${input.peer.label} carried the field more consistently across its inspected product pages than ${input.prospectLabel} did: ${behind
        .map((r) => r.attribute.toLowerCase())
        .join(', ')}. Both sides were inspected with the same method on a bounded sample.`
    : `Across the ${shown.length} attributes compared, ${input.prospectLabel} and ${input.peer.label} carried the fields at a similar rate on their inspected product pages.`

  return {
    available: true,
    peerLabel: input.peer.label,
    peerAuditDate: input.peer.auditDate.toISOString().slice(0, 10),
    methodNote:
      'Both sites were inspected by the same automated product-data review, on a bounded sample of pages. Figures ' +
      'describe the inspected pages only and are not a ranking.',
    rows: shown,
    summary: assertSupported('comparison.summary', summary),
  }
}
