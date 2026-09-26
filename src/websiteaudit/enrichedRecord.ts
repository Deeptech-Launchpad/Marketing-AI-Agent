import { prisma } from '../platform/db.js'

// THE ENRICHED PRODUCT RECORD — one real product, before and after.
//
// This is the thing the customer report is actually about: take a product page
// the crawler really fetched, show what that page publishes today, and show the
// same facts arranged as a structured record.
//
// THE ONE RULE
//
// The AFTER side adds STRUCTURE, never CONTENT. If the page did not publish a
// brand, the enriched record says the brand is not published — it does not
// find one, infer one from the domain, or borrow one from a similar product.
// A report that invents a value is worse than no report: the customer will
// check, and everything else in the document loses its credibility with it.
//
// So every row here is one of:
//
//   observed     the page published it; the value is carried through verbatim
//   restructured the page published it inside prose or a blob; same value,
//                given a field of its own
//   absent       the page did not publish it; stated plainly, never filled in
//
// `restructured` is where the value of the exercise actually lives, and it is
// still only ever a rearrangement of the customer's own words.
//
// WHAT EACH ROW ALSO CARRIES
//
// A `restructured` row used to prove its point by putting the same paragraph on
// both sides, which reads as though nothing happened at all. So a present row
// now also carries the attributes read out of its own text by rule
// (`derivedAttributes`) — the pack size the sentence states, the application it
// names — each with the stretch of the customer's text it came from. And an
// absent row carries a `recommendation`: what to publish, never a guess at what
// the value would be. `after` stays null there, because advice is not evidence.

/** The fields a structured product record carries, in the order a buyer reads them. */
export const RECORD_FIELDS = [
  { field: 'product.name', label: 'Product name', group: 'identity' },
  { field: 'product.brand', label: 'Brand', group: 'identity' },
  { field: 'product.sku', label: 'Product code / SKU', group: 'identity' },
  { field: 'product.mpn', label: 'Manufacturer part number', group: 'identity' },
  { field: 'product.gtin', label: 'GTIN / barcode', group: 'identity' },
  { field: 'product.category', label: 'Category', group: 'identity' },
  { field: 'product.description', label: 'Description', group: 'commercial' },
  { field: 'product.price', label: 'Price', group: 'commercial' },
  { field: 'product.availability', label: 'Availability', group: 'commercial' },
  { field: 'product.specifications', label: 'Technical specifications', group: 'technical' },
  { field: 'product.attributes', label: 'Attributes', group: 'technical' },
  { field: 'product.dimensions', label: 'Dimensions', group: 'technical' },
  { field: 'product.weight', label: 'Weight', group: 'technical' },
  { field: 'product.units', label: 'Units of measure', group: 'technical' },
  { field: 'product.documents', label: 'Supporting documents', group: 'support' },
  { field: 'product.image', label: 'Product image', group: 'support' },
] as const

export type RecordFieldState = 'observed' | 'restructured' | 'absent'

/**
 * What every surface writes where a field has no value.
 *
 * Exported so the screens and the PDF say it in the same words: a customer who
 * reads "Not published on current website" in one place and a bare dash in
 * another assumes the two mean different things, and starts asking which fields
 * were actually checked.
 */
export const ABSENT_VALUE_LABEL = 'Not published on current website'

/** One attribute read out of the customer's own prose, with the words it came from. */
export interface DerivedAttribute {
  /** The name it takes in a structured record, e.g. "Pack / Capacity". */
  label: string
  /** The value, in the page's own characters — never reformatted into something it did not say. */
  value: string
  /** The stretch of the source text the value was read out of, verbatim. */
  sourceText: string
}

export interface RecordField {
  field: string
  label: string
  group: string
  /** What the page publishes today, verbatim. Null when it publishes nothing. */
  before: string | null
  /**
   * The same fact in a structured record. Null when the source published
   * nothing — the enriched record does not fill a gap it cannot evidence.
   */
  after: string | null
  state: RecordFieldState
  /**
   * Named attributes lifted out of `before` by rule. Empty is a correct and
   * common result: it means this text states nothing that can be proved.
   */
  derivedAttributes: DerivedAttribute[]
  /**
   * For an absent field, what the customer should publish — advice about the
   * field, never a value for it. Null wherever a value exists.
   */
  recommendation: string | null
  /** How the value was observed, and where on the page. */
  method: string | null
  sourcePath: string | null
  /** The page this value came from. Always the audited company's own site. */
  sourceUrl: string
}

/**
 * The page's own furniture, for showing a product the way its site shows it.
 *
 * Every field here is an OBSERVED value, because the demonstration it feeds is
 * meant to make a customer say "that is my page". Nothing is reconstructed:
 * the crawler records no logo, no navigation bar and no footer — image
 * extraction actively discards logos — so those are simply absent rather than
 * drawn from imagination. What is here is what the page really published.
 */
export interface PageContext {
  /** The <title>, verbatim. */
  pageTitle: string | null
  /**
   * The site's own name, taken from the title's trailing segment.
   *
   * Pages title themselves "<product> — <site>", so the last segment after a
   * dash or pipe is the site naming itself. Null when the title carries no
   * such suffix; a host is never dressed up as a brand name.
   */
  siteName: string | null
  /** The trail the page published, e.g. "Collections > Plumbing > …". */
  breadcrumbs: string | null
  /** The host, from the page's own URL. */
  host: string | null
}

export interface EnrichedRecord {
  crmCompanyId: string
  auditRunId: string
  pageId: string
  sourceUrl: string
  /** How this page presents itself, for rendering it as a page. */
  pageContext: PageContext
  /** The product's own name where published, else a plain description of the page. */
  title: string
  /** A real image from the company's own site, or null. Never substituted. */
  imageUrl: string | null
  fields: RecordField[]
  observedCount: number
  restructuredCount: number
  absentCount: number
  /** How many attributes the rules read out of prose, across every field. */
  derivedAttributeCount: number
  /** Prose for the report, built only from the counts above. */
  beforeSummary: string
  afterSummary: string
  keyTransformation: string
}

/** Values that are really "the page said nothing here". */
function isEmpty(value: string | null | undefined): boolean {
  if (!value) return true
  const v = value.trim().toLowerCase()
  return v === '' || v === 'n/a' || v === '-' || v === 'not specified'
}

/**
 * A value the page published, but not as its own field.
 *
 * Specifications buried in a paragraph, dimensions inside a sentence,
 * attributes glued into one string — present, but not usable by a filter or a
 * comparison. Structuring these is the whole exercise, and doing it invents
 * nothing.
 */
function isNarrative(field: string, value: string, method: string | null): boolean {
  if (method === 'json_ld' || method === 'microdata') return false
  const narrativeProne = ['product.specifications', 'product.attributes', 'product.dimensions', 'product.weight', 'product.units']
  if (!narrativeProne.includes(field)) return false
  // A long free-text value with no key:value shape is prose.
  return value.length > 40 && !/^[^:]{1,40}:/.test(value)
}

// ── Reading attributes out of the customer's own prose ──────────────────────
//
// A page that says "Suitable for industrial cleaning applications, available in
// 15L drums" HAS published an application and a pack size. It has published
// them as a sentence, where no filter, feed or marketplace can reach them.
// Lifting them into named attributes is what makes the AFTER side worth
// looking at, and it is still only the customer's own characters, moved.
//
// Rules, not a model, and that is not a performance decision. A model asked for
// "the capacity" answers even where the text states none, and a plausible
// invented 15L is precisely the value that gets the whole report disbelieved. A
// regex that finds nothing returns nothing, which is the right answer far more
// often than it looks like it should be.

const COLOURS =
  'anthracite|charcoal|black|white|grey|gray|silver|chrome|gold|bronze|copper|red|blue|green|yellow|orange|purple|pink|brown|beige|cream|ivory|navy|clear|transparent|stainless'

// Longest first, so "stainless steel" is not read as "steel" and "stoneware"
// is not read as "stone".
const MATERIALS =
  'stainless steel|mild steel|carbon steel|galvanised steel|galvanized steel|steel|cast iron|wrought iron|iron|' +
  'aluminium|aluminum|brass|copper|zinc|titanium|polypropylene|polyethylene|polycarbonate|polyester|nylon|acrylic|' +
  'upvc|pvc|hdpe|ldpe|ptfe|epdm|abs|silicone|rubber|toughened glass|glass|ceramic|porcelain|stoneware|plywood|' +
  'hardwood|softwood|bamboo|oak|pine|beech|birch|mdf|chipboard|leather|cotton|canvas|wool|concrete|granite|marble|slate|stone'

const APPLICATION_CUES =
  'suitable for|suited to|ideal for|designed for|recommended for|intended for|perfect for|for use in|for use on|for use with|used for|used in|suits'

interface AttributeRule {
  label: string
  /** Global. The value is capture group 1 where there is one, else the whole match. */
  pattern: RegExp
  /** Rejects a match whose shape is right but whose content is not a value. */
  accept?: (value: string) => boolean
  /** Drops wording that belongs to the sentence rather than to the value. */
  clean?: (value: string) => string
}

// Ordered the way a buyer reads a spec block, because the cap below means the
// order decides what survives on a page that says a great deal.
const ATTRIBUTE_RULES: AttributeRule[] = [
  {
    label: 'Application',
    // Tempered: the phrase runs to a clause boundary and stops before a
    // conjunction. Running greedily to the next full stop swallowed "and
    // available in 15L drums" into the application, which read as a sentence
    // nobody wrote.
    pattern: new RegExp(
      `\\b(?:${APPLICATION_CUES})\\s+((?:(?!\\s+(?:and|or|but|with|which|that|as)\\b)[^.,;:|\\n]){3,60})`,
      'gi',
    ),
    // Trimming only ever shortens: what is left is still a run of characters
    // the page printed.
    clean: (v) =>
      v
        .replace(/\s+(?:applications?|uses?|purposes?|environments?|settings?)$/i, '')
        .replace(/\s+(?:and|or|in|on|for|with|to|the|a|an)$/i, '')
        .trim(),
    accept: (v) => /[a-z]{3}/i.test(v),
  },
  {
    label: 'Pack / Capacity',
    // Longest unit first, so "500ml" is not read as "500m" with a stray l.
    // Anchored at a word boundary for the same reason as Weight below: a
    // quantity read out of the middle of a part number is not a capacity.
    pattern: /\b\d+(?:\.\d+)?\s*(?:millilitres|millilitre|milliliters|milliliter|litres|litre|liters|liter|ltr|ml|cl|l)\b/gi,
  },
  {
    label: 'Pack / Capacity',
    pattern: /\b(?:pack of \d+|box of \d+|case of \d+|carton of \d+|pallet of \d+|\d+\s*-?\s*pack)\b/gi,
  },
  {
    label: 'Dimensions',
    pattern: /\b\d+(?:\.\d+)?\s*(?:(?:mm|cm|m|in)\b)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:(?:mm|cm|m|in)\b)?(?:\s*[x×]\s*\d+(?:\.\d+)?\s*(?:(?:mm|cm|m|in)\b)?)?/gi,
    // "2 x 5" is a pack count or a bare ratio. With no unit anywhere in the
    // match there is no measurement here worth claiming there is.
    accept: (v) => /\d\s*(?:mm|cm|m|in)\b/i.test(v),
  },
  {
    label: 'Weight',
    // The leading \b is the whole guard. Without it this matched "61G" inside
    // the standards code "AB1953/NSF61G" and reported a 61-gram weight for a
    // brass adapter — a number the page never stated about the product, read
    // out of the middle of a word.
    pattern: /\b\d+(?:\.\d+)?\s*(?:kilograms|kilogram|kilos|kilo|kgs|kg|grams|gram|tonnes|tonne|pounds|pound|lbs|lb|oz|g)\b/gi,
  },
  {
    label: 'Material',
    pattern: new RegExp(`\\b(?:${MATERIALS})\\b`, 'gi'),
  },
  {
    // Only ever from an explicit cue. A colour word inside a product name —
    // "Blue Diamond Pump" — is a name, and reading a finish out of it is the
    // same inference as reading a brand out of a domain.
    label: 'Colour',
    pattern: new RegExp(`\\b(?:colour|color|finish)\\s*[:\\-]?\\s*(${COLOURS})\\b`, 'gi'),
  },
  {
    label: 'Colour',
    pattern: new RegExp(`\\b(?:available|finished|supplied|coated|powder[- ]coated)\\s+in\\s+(${COLOURS})\\b`, 'gi'),
  },
  {
    label: 'Colour',
    pattern: new RegExp(`\\b(${COLOURS})\\s+(?:finish|finished|coating)\\b`, 'gi'),
  },
]

/** Page text arrives carrying the newlines and runs of spaces the markup had. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * The words a value was read out of.
 *
 * A window rather than a truncation: an ellipsis would make `sourceText`
 * something the page never wrote, and provenance is only worth having verbatim.
 * Sentences split on ". " rather than "." so a "15.5L" keeps its own sentence.
 */
function sourceWindow(text: string, index: number, length: number): string {
  const sentenceStart = Math.max(text.lastIndexOf('. ', index) + 1, text.lastIndexOf('\n', index) + 1, 0)
  const stop = text.indexOf('. ', index + length)
  const sentenceEnd = stop === -1 ? text.length : stop + 1
  return collapse(text.slice(Math.max(sentenceStart, index - 120), Math.min(sentenceEnd, index + length + 120)))
}

// A record is a summary, not a dump: the same unit repeated a dozen times down
// a long description tells a buyer nothing the first three did not.
const MAX_PER_LABEL = 3
const MAX_ATTRIBUTES = 8

/**
 * Reads named attributes out of one observed value.
 *
 * Every value returned appears literally in `text` — the rules only match, trim
 * and re-label, and none of them composes a value. An empty array is a correct
 * result, and means exactly what it says: this text states nothing provable.
 */
/**
 * The text with every markup tag blanked out, character for character.
 *
 * A published description is frequently raw HTML, and the attributes a tag
 * carries are not things the page says about the product. One real product
 * page describes a chrome-plated adapter inside
 * `<p style="color: blue; display: inline">SPECIFICATIONS</p>`, and the colour
 * rule read `color: blue` out of the STYLESHEET and reported the finish as
 * blue — while the same text states "Finish: Chrome-Plated" two lines down.
 * That is a fabricated attribute dressed as an observation, which is the one
 * thing this file exists to prevent.
 *
 * Tags are replaced by spaces rather than removed so the string keeps its
 * length. Every match index therefore still points at the same character of
 * the ORIGINAL text, which is what lets the value and its source window remain
 * literal substrings of what the page published.
 */
function maskMarkup(text: string): string {
  return text.replace(/<[^>]*>/g, (tag) => ' '.repeat(tag.length))
}

export function deriveAttributes(text: string): DerivedAttribute[] {
  const found: DerivedAttribute[] = []
  const seen = new Set<string>()
  const perLabel = new Map<string, number>()
  // Matched against the masked copy; sliced out of the original. Same length,
  // so the indices mean the same thing in both.
  const searchable = maskMarkup(text)

  for (const rule of ATTRIBUTE_RULES) {
    // matchAll rather than an exec loop: it iterates over a clone, so these
    // module-level /g patterns never carry a lastIndex into the next record.
    for (const m of searchable.matchAll(rule.pattern)) {
      // noUncheckedIndexedAccess makes even m[0] optional, and the whole match
      // is needed twice: as the fallback value, and to size the source window.
      const whole = m[0]
      if (whole === undefined) continue
      const raw = m[1] ?? whole
      const value = collapse(rule.clean ? rule.clean(raw) : raw)
      if (!value) continue
      if (rule.accept && !rule.accept(value)) continue

      const key = `${rule.label}\u0000${value.toLowerCase()}`
      if (seen.has(key)) continue
      const used = perLabel.get(rule.label) ?? 0
      if (used >= MAX_PER_LABEL) continue

      seen.add(key)
      perLabel.set(rule.label, used + 1)
      found.push({ label: rule.label, value, sourceText: sourceWindow(text, m.index ?? 0, whole.length) })
      if (found.length >= MAX_ATTRIBUTES) return found
    }
  }

  return found
}

/**
 * The fields whose value is prose a person reads rather than a value a system
 * uses, and so the ones worth mining for attributes.
 *
 * product.name and product.sku are deliberately absent. A "15L" inside a
 * product name is a naming convention, and reading a published capacity out of
 * one is the same move as reading a brand out of a domain.
 */
const ATTRIBUTE_SOURCE_FIELDS: string[] = [
  'product.description',
  'product.specifications',
  'product.attributes',
  'product.dimensions',
  'product.weight',
  'product.units',
]

// Why the field is worth publishing, in the customer's terms rather than ours.
// Advice about a field is safe to generate; a value for it never is.
const RECOMMENDATION_PURPOSE: Record<string, string> = {
  'product.name': 'so every listing, feed and search result names the product the same way',
  'product.brand': 'so buyers and marketplaces can filter on it',
  'product.sku': 'so an enquiry or an order can quote a code that matches your own system',
  'product.mpn': 'so distributors can match the part against a manufacturer catalogue',
  'product.gtin': 'so the product can be matched to a barcode in retail and marketplace feeds',
  'product.category': 'so the product can be browsed and compared alongside its peers',
  'product.description': 'so the page explains the product to a buyer who has not seen it before',
  'product.price': 'so buyers and comparison sites can see what it costs without an enquiry',
  'product.availability': 'so a buyer knows whether it can be ordered today',
  'product.specifications': 'so a buyer can check the product against a requirement without calling',
  'product.attributes': 'so the product can be filtered on the properties buyers actually search by',
  'product.dimensions': 'so a buyer can confirm it fits before ordering',
  'product.weight': 'so delivery and handling can be quoted without an enquiry',
  'product.units': 'so a quantity on the page means the same thing as a quantity on an order',
  'product.documents': 'so a specifier can download the datasheet instead of requesting it',
  'product.image': 'so the product is recognisable in search results and marketplace listings',
}

/**
 * What to publish where a field is absent.
 *
 * Built from the field's own label, so a gap is never left as a bare dash the
 * customer has to interpret. It states an action, never a value: "publish the
 * brand" is advice, "the brand is ACME" would be a fabrication.
 */
export function recommendationFor(field: string, label: string): string {
  const purpose = RECOMMENDATION_PURPOSE[field] ?? 'so buyers and downstream systems can read it without interpreting prose'
  return `Publish the ${label.toLowerCase()} in a dedicated structured field ${purpose}.`
}

/**
 * Builds the record for ONE audited product page.
 *
 * Everything comes from observations already stored against that page, so the
 * record cannot describe a page the crawler did not fetch, and cannot carry a
 * value the extractor did not see.
 */
/**
 * The site's own name, read out of the page title's trailing segment.
 *
 * Pages title themselves "<product> — <site>", so the last segment is the site
 * naming itself: real published text, not a guess. A segment is only accepted
 * when there is something before it (a title that is ONLY a site name tells us
 * nothing about the product page), when it is short enough to be a name rather
 * than a sentence, and when it is not simply the host repeated back.
 */
export function siteNameFromTitle(title: string | null, host: string | null): string | null {
  if (!title) return null
  const parts = title
    .split(/\s+[—–|]\s+|\s+-\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 2) return null

  const last = parts[parts.length - 1]!
  if (last.length < 2 || last.length > 60) return null
  // "example.com" as a title suffix is the address, which the page already
  // shows; presenting it as the business's name would be dressing it up.
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(last)) return null
  if (host && last.toLowerCase().replace(/\s+/g, '') === host.toLowerCase().replace(/^www\./, '').split('.')[0]) {
    return last
  }
  return last
}

/** The page's own furniture, read from what it published. Never invented. */
function readPageContext(
  byField: Map<string, { status: string; value: string | null }>,
  sourceUrl: string,
): PageContext {
  const observed = (field: string): string | null => {
    const o = byField.get(field)
    return o && o.status === 'observed' && !isEmpty(o.value) ? o.value! : null
  }

  let host: string | null = null
  try {
    host = new URL(sourceUrl).hostname.replace(/^www\./, '')
  } catch {
    /* a stored URL that will not parse is not worth failing the record over */
  }

  const pageTitle = observed('page.title')
  return {
    pageTitle,
    siteName: siteNameFromTitle(pageTitle, host),
    breadcrumbs: observed('page.breadcrumbs'),
    host,
  }
}

export async function buildEnrichedRecord(pageId: string): Promise<EnrichedRecord | null> {
  const page = await prisma.auditedPage.findUnique({ where: { id: pageId } })
  if (!page) return null

  const observations = await prisma.pageObservation.findMany({ where: { pageId } })
  return recordFromObservations({
    crmCompanyId: page.crmCompanyId,
    auditRunId: page.auditRunId,
    pageId: page.id,
    sourceUrl: page.finalUrl ?? page.requestedUrl,
    observations,
  })
}

/** The observation fields the record reads — satisfied by a stored row and by a fresh extraction alike. */
export interface RecordObservation {
  field: string
  status: string
  value: string | null
  method: string | null
  sourcePath: string | null
}

/**
 * The record for one product page, from its observations alone.
 *
 * Pure. `buildEnrichedRecord` hands it the rows an audit stored; Prospect
 * Discovery hands it an extraction of a page it has just fetched and never
 * stored. Same rules either way, so a prospect's product page is read exactly
 * the way an audited one is.
 */
export function recordFromObservations(input: {
  crmCompanyId: string
  auditRunId: string
  pageId: string
  sourceUrl: string
  observations: RecordObservation[]
}): EnrichedRecord {
  const byField = new Map(input.observations.map((o) => [o.field, o]))
  const sourceUrl = input.sourceUrl

  const fields: RecordField[] = RECORD_FIELDS.map(({ field, label, group }) => {
    const o = byField.get(field)
    const value = o && o.status === 'observed' && !isEmpty(o.value) ? o.value! : null

    if (value === null) {
      return {
        field,
        label,
        group,
        before: null,
        after: null,
        state: 'absent' as const,
        derivedAttributes: [],
        // The only thing an empty row may carry, and it sits beside a null
        // `after`, not in place of one.
        recommendation: recommendationFor(field, label),
        method: o?.method ?? null,
        sourcePath: o?.sourcePath ?? null,
        sourceUrl,
      }
    }

    const restructured = isNarrative(field, value, o?.method ?? null)
    // Read from this field's own text only, and drop an attribute that merely
    // repeats the whole field: "Dimensions: 600 x 400 x 250mm" under the
    // dimensions field is an echo, not structure.
    const derivedAttributes = ATTRIBUTE_SOURCE_FIELDS.includes(field)
      ? deriveAttributes(value).filter((a) => a.value.toLowerCase() !== collapse(value).toLowerCase())
      : []

    return {
      field,
      label,
      group,
      before: value,
      // Same value. A field of its own is the only thing that changes; whatever
      // was read out of it travels beside it, in derivedAttributes.
      after: value,
      state: restructured ? ('restructured' as const) : ('observed' as const),
      derivedAttributes,
      recommendation: null,
      method: o?.method ?? null,
      sourcePath: o?.sourcePath ?? null,
      sourceUrl,
    }
  })

  const observedCount = fields.filter((f) => f.state === 'observed').length
  const restructuredCount = fields.filter((f) => f.state === 'restructured').length
  const absentCount = fields.filter((f) => f.state === 'absent').length

  const derived = fields.flatMap((f) => f.derivedAttributes)
  const derivedAttributeCount = derived.length
  const derivedLabels = [...new Set(derived.map((d) => d.label.toLowerCase()))]

  const nameField = fields.find((f) => f.field === 'product.name')
  // AuditedPage carries no title column, so the product's own published name
  // is the title; failing that, the path, which is at least the customer's.
  const title = nameField?.before ?? sourceUrl.replace(/^https?:\/\/[^/]+/, '') ?? 'Product page'
  const imageUrl = fields.find((f) => f.field === 'product.image')?.before ?? null

  const present = fields.filter((f) => f.state !== 'absent').map((f) => f.label.toLowerCase())
  const missing = fields.filter((f) => f.state === 'absent').map((f) => f.label.toLowerCase())

  const beforeSummary =
    present.length === 0
      ? 'The inspected page publishes none of the fields a structured product record needs.'
      : `The page publishes ${present.slice(0, 6).join(', ')}${present.length > 6 ? ` and ${present.length - 6} more` : ''}.` +
        (missing.length ? ` It does not publish ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` or ${missing.length - 6} others` : ''}.` : '') +
        (derivedAttributeCount
          ? ` ${derivedAttributeCount} attribute(s) a buyer would filter on — ${derivedLabels.join(', ')} — are stated inside that text, where a filter or a feed cannot reach them.`
          : '')

  const afterSummary =
    `The enriched record carries the same ${observedCount + restructuredCount} published value(s) as named fields` +
    (restructuredCount ? `, ${restructuredCount} of them lifted out of narrative text` : '') +
    (derivedAttributeCount
      ? `, reads ${derivedAttributeCount} attribute(s) (${derivedLabels.join(', ')}) out of that text into fields of their own`
      : '') +
    (absentCount
      ? `, and marks ${absentCount} field(s) as not published on the current page — each with what to publish instead — rather than filling them in.`
      : '.')

  const keyTransformation =
    derivedAttributeCount > 0
      ? `${derivedAttributeCount} value(s) this page states only in prose — ${derivedLabels.join(', ')} — become named attributes a buyer can filter and compare on, in the page's own words` +
        (absentCount ? `, and the ${absentCount} field(s) it does not publish are named as gaps, each with a recommendation.` : '.')
      : restructuredCount > 0
        ? `The same information this page already publishes becomes a structured, filterable record: ${restructuredCount} value(s) currently held in prose are given fields of their own, so a buyer can compare and filter on them.`
        : absentCount > 0
          ? `The page's published values become a structured record, and the ${absentCount} field(s) it does not publish are named as gaps — so it is clear what a buyer cannot currently filter or compare on.`
          : 'The page already publishes a complete set of fields; the enriched record standardises their names and formats for downstream systems.'

  return {
    crmCompanyId: input.crmCompanyId,
    auditRunId: input.auditRunId,
    pageId: input.pageId,
    sourceUrl,
    pageContext: readPageContext(byField, sourceUrl),
    title,
    imageUrl,
    fields,
    observedCount,
    restructuredCount,
    absentCount,
    derivedAttributeCount,
    beforeSummary,
    afterSummary,
    keyTransformation,
  }
}

/**
 * Chooses the product pages worth showing a customer, best first.
 *
 * Preference is for pages that PROVE the point: ones with an image and several
 * published values, because a case study built on an empty page demonstrates
 * nothing. Pages are only ever drawn from the run being reported on, so a case
 * study cannot show another company's product.
 */
export async function selectCaseStudyPages(auditRunId: string, limit = 2): Promise<string[]> {
  const pages = await prisma.auditedPage.findMany({
    where: { auditRunId, pageType: 'product', outcome: 'fetched' },
    select: { id: true },
  })
  if (pages.length === 0) return []

  const scored: Array<{ id: string; score: number }> = []
  for (const p of pages) {
    const observations = await prisma.pageObservation.findMany({
      where: { pageId: p.id, status: 'observed' },
      select: { field: true, value: true },
    })
    const useful = observations.filter((o) => !isEmpty(o.value))
    const hasImage = useful.some((o) => o.field === 'product.image')
    const hasName = useful.some((o) => o.field === 'product.name')
    // An image and a name are what make a case study recognisable to its owner.
    scored.push({ id: p.id, score: useful.length + (hasImage ? 6 : 0) + (hasName ? 4 : 0) })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((s) => s.score > 0)
    .map((s) => s.id)
}
