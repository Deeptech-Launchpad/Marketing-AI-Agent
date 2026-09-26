import type { EnrichedRecord } from '../websiteaudit/enrichedRecord.js'

// ALTIUSNXT PROPOSED CONTENT — the fourth state.
//
// The Workbench already distinguishes three things a field can be:
//
//   OBSERVED     the customer's website published it
//   DERIVED      their own page text states it, in prose a filter cannot read
//   RECOMMENDED  their category needs it and their page does not have it
//
// This adds a fourth, and it is the only one that is OURS rather than theirs:
//
//   PROPOSED     wording we suggest for the page
//
// That distinction is the entire safety model. A customer must be able to look
// at any line in the demonstration and know instantly whether it is a fact
// about their catalogue or a suggestion about their copy, because a suggestion
// mistaken for a fact is how a supplier ends up publishing a specification
// nobody verified.
//
// SO PROPOSED CONTENT IS COMPOSED, NEVER INVENTED. Every sentence is a
// template filled with values this page already published. There is no rule
// here that can emit a certification, a measurement, a tolerance, a material
// grade, a compatibility claim, a part number or a brand that the source did
// not state — and `assertOnlySourcedFacts` below fails the build of any
// proposal that manages it anyway.

export type ProposedTone = 'listing' | 'category'

export interface ProposedContent {
  /** The suggested overview paragraph. Presentation only. */
  overview: string
  /** Suggested short bullets, each one echoing a value the page published. */
  bullets: string[]
  /** Questions the copy should answer, from fields the page does not publish. */
  openQuestions: string[]
  /**
   * The exact source values every sentence was built from.
   *
   * Rendered beside the proposal so a reviewer can check it in one pass
   * rather than having to trust it.
   */
  supportedBy: Array<{ label: string; value: string; from: 'observed' | 'derived' }>
  /** Why this block is labelled the way it is. Shown to the customer. */
  note: string
}

const NOTE =
  'Suggested wording from AltiusNxt, built only from values this page already publishes. ' +
  'It is a proposal for how the page could read — not a statement of fact about the product, ' +
  'and not something to publish before someone who knows the product has approved it.'

/** Values that are identifiers rather than described properties. */
const IDENTITY_FIELDS = new Set(['product.name', 'product.sku', 'product.mpn', 'product.gtin', 'product.image'])

/**
 * Availability arrives as a schema.org URL more often than as a word.
 *
 * Reading "https://schema.org/InStock" back as "In Stock" is normalisation of
 * the customer's own value, not a change to it — and the same rule the
 * Workbench's product mock already applies, so the two cannot disagree.
 */
const readable = (label: string, value: string): string => {
  if (!/availability/i.test(label)) return value
  const m = value.match(/schema\.org\/(\w+)/i)
  return m ? m[1]!.replace(/([a-z])([A-Z])/g, '$1 $2') : value
}

const plain = (raw: string): string =>
  raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/**
 * Builds a proposal for one product page.
 *
 * Returns null when the page published too little to compose from. That is a
 * real outcome and a common one: a page with a name and nothing else gives us
 * nothing to propose, and writing something anyway is precisely the failure
 * this whole module exists to make impossible.
 */
export function buildProposedContent(input: {
  record: EnrichedRecord
  /** The category the run's own pages named, when it named one. */
  categoryLabel: string | null
}): ProposedContent | null {
  const { record } = input

  const observed = record.fields
    .filter((f) => f.state !== 'absent' && f.before !== null && !IDENTITY_FIELDS.has(f.field))
    .map((f) => ({ label: f.label, value: readable(f.label, plain(f.before!)), from: 'observed' as const }))
    .filter((f) => f.value.length > 0)

  const derived = record.fields
    .flatMap((f) => f.derivedAttributes ?? [])
    .map((d) => ({ label: d.label, value: plain(d.value), from: 'derived' as const }))
    .filter((d) => d.value.length > 0)

  const supportedBy = [...derived, ...observed]
  // Two facts is the floor. Below that a proposal is padding around a name.
  if (supportedBy.length < 2) return null

  const brand = record.fields.find((f) => f.field === 'product.brand')?.before
  const crumbs = record.pageContext?.breadcrumbs ? plain(record.pageContext.breadcrumbs) : null

  // ── Overview ────────────────────────────────────────────────────────────
  //
  // Deliberately dull. Every clause is either the product's own name, a value
  // it published, or a statement about where it sits in the customer's own
  // navigation. Nothing here characterises the product's suitability, because
  // suitability is exactly the kind of claim we have no standing to make.
  const parts: string[] = []
  parts.push(
    brand
      ? `${clip(record.title, 90)} is listed by ${plain(brand)} on this catalogue.`
      : `${clip(record.title, 90)} is listed on this catalogue.`,
  )
  if (crumbs) {
    parts.push(`It sits under ${clip(crumbs, 90)} in the site's own navigation.`)
  } else if (input.categoryLabel) {
    parts.push(`Its category was read from the site as ${input.categoryLabel.toLowerCase()}.`)
  }
  const named = derived.slice(0, 3)
  if (named.length > 0) {
    parts.push(
      `The page already states ${named.map((d) => `${d.label.toLowerCase()} ${d.value}`).join(', ')} — inside its description, where a filter cannot reach it.`,
    )
  }

  const bullets = supportedBy.slice(0, 5).map((s) => `${s.label}: ${clip(s.value, 80)}`)

  // ── Open questions ──────────────────────────────────────────────────────
  //
  // The absent fields, phrased as questions for the customer to answer rather
  // than as gaps we could fill. This is the line the module will not cross:
  // "Connection type is not stated" is ours to say; "Connection type is 15mm
  // compression" is not, at any confidence.
  // Phrased so it reads correctly for every field label. "What is the
  // technical specifications for this product?" is what a template gets when
  // it assumes every label is a singular noun, and half of them are not.
  const openQuestions = record.fields
    .filter((f) => f.state === 'absent')
    .slice(0, 6)
    .map((f) => `${f.label} — what should this page state?`)

  const content: ProposedContent = {
    overview: parts.join(' '),
    bullets,
    openQuestions,
    supportedBy,
    note: NOTE,
  }

  assertOnlySourcedFacts(content, record)
  return content
}

/**
 * Refuses a proposal that states anything the source did not.
 *
 * The templates above are safe by construction, and this exists because
 * "safe by construction" is a claim about code that someone will edit. A
 * measurement, a standard or a percentage that is not in the source values is
 * a fabrication regardless of which template produced it, so the check is on
 * the OUTPUT rather than on the rules that made it.
 *
 * Throws rather than filtering: silently dropping a bad sentence would leave a
 * proposal that reads fine and quietly lost the thing that made it wrong.
 */
export function assertOnlySourcedFacts(content: ProposedContent, record: EnrichedRecord): void {
  const haystack = [
    record.title,
    record.pageContext?.breadcrumbs ?? '',
    ...record.fields.map((f) => f.before ?? ''),
    ...record.fields.flatMap((f) => (f.derivedAttributes ?? []).map((d) => `${d.value} ${d.sourceText}`)),
  ]
    .join(' ')
    .toLowerCase()

  const prose = [content.overview, ...content.bullets].join(' ')

  // Three shapes, matched separately because each needs a different rule.
  //
  //   · a measurement — "15mm", "20L", "30%", "5.5V"
  //   · a bare number — "4.20", "71803"
  //   · a standard reference — "ASTM A574", "ISO 9001", "EN 1090"
  //
  // A MEASUREMENT'S UNIT MUST BE ATTACHED TO ITS NUMBER, and that is the whole
  // correction here. The unit list necessarily contains `in`, `a`, `m`, `g`,
  // `l`, `v` and `w` — several of the commonest words in English — and the old
  // pattern allowed whitespace between the number and the unit. So a product
  // whose title ends in a numeric SKU, followed by ordinary prose, produced a
  // measurement that nobody had written:
  //
  //   "…SANITISER 20L 71803 in the Cleaning & hygiene category"
  //                  └────── read as "71803 inches"
  //
  // That phantom was then, correctly, not found in the source — and the guard
  // threw, taking the whole customer view and the Audit Report down with it,
  // on the richest and healthiest audit in the estate. Attachment is what
  // separates a unit from a preposition: nobody writes "71803 in" meaning
  // inches, and everybody writes "15mm".
  //
  // Verification is NOT relaxed by this. The bare number is still extracted
  // and still checked on its own, so "71803" must appear in the source; and
  // the full measurement token is checked as well as its number, so removing
  // the unit cannot launder an invented figure — "71803kg" fails even though
  // "71803" passes.
  //
  // The standards pattern must stay case-SENSITIVE. Folding case would let any
  // ordinary word followed by digits count as a standard, and the check would
  // then be firing on prose rather than on claims.
  const measurements =
    prose.match(/\b\d+(?:[.,]\d+)?(?:%|mm|cm|km|ml|kg|lb|nm|bar|psi|in|ft|m|g|l|v|w|a)\b/gi) ?? []
  const numbers = prose.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []
  const standards = prose.match(/\b[A-Z]{2,}[\s-]?[A-Z]?\d{2,}[A-Z]?\b/g) ?? []
  const claims = [...measurements, ...numbers, ...standards]

  for (const claim of claims) {
    const needle = claim.toLowerCase().trim()
    if (!haystack.includes(needle)) {
      throw new Error(
        `Proposed content stated "${claim}", which does not appear in anything this page published. ` +
          'Proposed content may re-present the source; it may not add to it.',
      )
    }
  }
}
