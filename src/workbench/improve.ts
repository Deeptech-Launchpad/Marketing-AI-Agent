import { assertSupported } from '../websiteaudit/claimGuard.js'
import {
  DISPLAY_FIELDS,
  EMPTY_STATE,
  type ComparedField,
  type FieldProvenance,
  type ValuePoint,
} from './types.js'

// TASK #981 — building the AFTER from the BEFORE.
//
// This is the file the whole task's credibility rests on. Everything it emits
// must be defensible to the prospect whose page it describes, because they can
// open that page and check.
//
// So there are exactly three ways to produce an AFTER value:
//
//   RESTRUCTURE  the fact is already there, expressed badly.
//                "1028" sits in microdata; publish it as JSON-LD too.
//
//   DERIVE       another observed field logically contains it.
//                The breadcrumb says "RAGS, WIPERS & PAPER > Paper Towels",
//                so the category is "Paper Towels". That is reading their
//                page, not guessing about their product.
//
//   REWORD       existing text, rewritten. Facts unchanged. (Gemini, optional.)
//
// There is no fourth way. A field with no observed source stays empty and says
// so. On the real 1st Ayd page that is nine of seventeen fields, and showing
// nine honest gaps is the argument — filling them with plausible-sounding
// invented specifications would destroy the only thing being sold here, which
// is that AltiusNXT gets product data right.

export interface ObservationInput {
  id: string
  field: string
  status: string
  value: string | null
  sourcePath: string | null
  fragment: string | null
}

export interface ImproveInput {
  pageUrl: string
  observations: ObservationInput[]
}

function gap(field: string, source: ObservationInput | undefined, pageUrl: string): FieldProvenance {
  return {
    kind: 'not_present',
    sourceObservationId: source?.id ?? null,
    sourceField: field,
    sourceUrl: pageUrl,
    sourcePath: null,
    sourceFragment: null,
    rule: 'No value for this field was observed on the audited page, so it is shown empty.',
  }
}

function carried(o: ObservationInput, pageUrl: string, rule: string): FieldProvenance {
  return {
    kind: 'unchanged',
    sourceObservationId: o.id,
    sourceField: o.field,
    sourceUrl: pageUrl,
    sourcePath: o.sourcePath,
    sourceFragment: o.fragment,
    rule,
  }
}

// ── DERIVE: category from the breadcrumb trail ─────────────────────────────

/**
 * The last meaningful crumb is the category the product sits in.
 *
 * "Home > RAGS, WIPERS & PAPER > Paper Towels" gives "Paper Towels". The
 * product's own name is dropped when it appears as the final crumb, because a
 * product is not its own category.
 */
export function categoryFromBreadcrumbs(trail: string, productName: string | null): string | null {
  const crumbs = trail
    .split('>')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !/^home$/i.test(c))

  if (!crumbs.length) return null

  const last = crumbs[crumbs.length - 1]!
  const normalisedName = (productName ?? '').toLowerCase().trim()
  const candidate = normalisedName && last.toLowerCase() === normalisedName ? crumbs[crumbs.length - 2] : last

  if (!candidate) return null
  // Title-case a SHOUTED crumb; leave anything else exactly as published.
  return candidate === candidate.toUpperCase() && /[A-Z]{3,}/.test(candidate) ? titleCase(candidate) : candidate
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    // Keep short conjunctions lowercase, except at the start.
    .replace(/\B\b(And|Or|Of|The|For|With)\b/g, (m) => m.toLowerCase())
}

// ── RESTRUCTURE: a schema.org Product block from observed fields only ──────

/**
 * Builds the JSON-LD the page could publish.
 *
 * Every key comes from an observed value. A field that was not observed is
 * simply not in the object — the block is a faithful restructuring of what the
 * page already says, not a template with blanks filled in.
 */
export function buildStructuredData(
  fields: Map<string, ObservationInput>,
  derivedCategory: string | null,
): { json: Record<string, unknown>; usedFields: string[] } | null {
  const json: Record<string, unknown> = { '@context': 'https://schema.org', '@type': 'Product' }
  const used: string[] = []

  const put = (key: string, field: string) => {
    const o = fields.get(field)
    if (o?.value) {
      json[key] = o.value
      used.push(field)
    }
  }

  put('name', 'product.name')
  put('sku', 'product.sku')
  put('mpn', 'product.mpn')
  put('gtin', 'product.gtin')
  put('description', 'product.description')
  put('weight', 'product.weight')

  const brand = fields.get('product.brand')
  if (brand?.value) {
    json.brand = { '@type': 'Brand', name: brand.value }
    used.push('product.brand')
  }

  if (derivedCategory) {
    json.category = derivedCategory
    used.push('product.category(derived)')
  }

  const price = fields.get('product.price')
  const availability = fields.get('product.availability')
  // A price the page shows as "TBD" is not a price. It is recorded as observed
  // by the audit — correctly, it IS what the page says — but publishing it as
  // schema.org `price` would emit a machine-readable falsehood.
  const numericPrice = price?.value && /^[\d.,]+$/.test(price.value.trim()) ? price.value.trim() : null
  if (numericPrice || availability?.value) {
    const offer: Record<string, unknown> = { '@type': 'Offer' }
    if (numericPrice) {
      offer.price = numericPrice
      used.push('product.price')
    }
    if (availability?.value) {
      offer.availability = availability.value
      used.push('product.availability')
    }
    json.offers = offer
  }

  // `name` alone is not worth showing as an improvement.
  return used.length >= 2 ? { json, usedFields: used } : null
}

// ── The comparison ─────────────────────────────────────────────────────────

export interface ImproveResult {
  fields: ComparedField[]
  structuredData: { json: Record<string, unknown>; usedFields: string[] } | null
  valuePoints: ValuePoint[]
  /** Counts for the honest headline. Never expressed as a percentage. */
  observedCount: number
  totalCount: number
  improvedCount: number
}

export function buildComparison(input: ImproveInput): ImproveResult {
  const byField = new Map<string, ObservationInput>()
  input.observations.forEach((o) => {
    if (!byField.has(o.field)) byField.set(o.field, o)
  })

  const observedValue = (field: string): ObservationInput | undefined => {
    const o = byField.get(field)
    return o && o.status === 'observed' && o.value ? o : undefined
  }

  const name = observedValue('product.name')?.value ?? null
  const breadcrumbs = observedValue('page.breadcrumbs')
  const derivedCategory =
    !observedValue('product.category') && breadcrumbs?.value
      ? categoryFromBreadcrumbs(breadcrumbs.value, name)
      : null

  const fields: ComparedField[] = DISPLAY_FIELDS.map(({ field, label, headline }) => {
    const o = observedValue(field)

    // DERIVE — the only field the deterministic MVP can add.
    if (!o && field === 'product.category' && derivedCategory && breadcrumbs) {
      return {
        field,
        label,
        before: null,
        after: derivedCategory,
        delta: 'added' as const,
        headline,
        provenance: {
          kind: 'derived' as const,
          sourceObservationId: breadcrumbs.id,
          sourceField: 'page.breadcrumbs',
          sourceUrl: input.pageUrl,
          sourcePath: breadcrumbs.sourcePath,
          sourceFragment: breadcrumbs.fragment,
          rule: `Derived from the breadcrumb trail published on this page ("${breadcrumbs.value}") — the category the product is filed under, read from your own navigation.`,
        },
      }
    }

    if (!o) {
      return {
        field,
        label,
        before: null,
        after: null,
        delta: 'still_absent' as const,
        headline,
        provenance: gap(field, byField.get(field), input.pageUrl),
      }
    }

    return {
      field,
      label,
      before: o.value,
      after: o.value,
      delta: 'unchanged' as const,
      headline,
      provenance: carried(o, input.pageUrl, 'Present on the audited page and carried across unchanged.'),
    }
  })

  const structuredData = buildStructuredData(
    new Map([...byField].filter(([, o]) => o.status === 'observed' && o.value)),
    derivedCategory,
  )

  // Restructuring is a real change to how the page presents its data, so the
  // fields that feed the JSON-LD are marked as restructured rather than
  // unchanged — otherwise the strongest improvement would be invisible.
  if (structuredData) {
    for (const f of fields) {
      if (f.delta === 'unchanged' && structuredData.usedFields.includes(f.field)) {
        f.delta = 'restructured'
        f.provenance = {
          ...f.provenance,
          kind: 'restructured',
          rule: `${f.provenance.rule} Published as machine-readable schema.org Product data so search engines and marketplaces can read it.`,
        }
      }
    }
  }

  const observedCount = fields.filter((f) => f.before !== null).length
  const improvedCount = fields.filter((f) => f.delta === 'added' || f.delta === 'restructured' || f.delta === 'reworded').length

  return {
    fields,
    structuredData,
    valuePoints: buildValuePoints(fields, structuredData),
    observedCount,
    totalCount: fields.length,
    improvedCount,
  }
}

/** "a", "a and b", "a, b and c" — customer copy, not a debug join. */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Verb agreement for a list that may hold exactly one item. */
function isAre(items: readonly unknown[]): string {
  return items.length === 1 ? 'is' : 'are'
}

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Turns the changes into two to four things a buyer would care about.
 *
 * Every sentence goes through the existing claim guard, so nothing here can
 * promise revenue, quote a percentage, or generalise to the whole catalogue.
 */
function buildValuePoints(
  fields: ComparedField[],
  structuredData: ImproveResult['structuredData'],
): ValuePoint[] {
  const points: ValuePoint[] = []
  const absent = fields.filter((f) => f.delta === 'still_absent')
  const added = fields.filter((f) => f.delta === 'added')

  if (structuredData) {
    points.push({
      title: 'Machine-readable product data',
      why: 'Search engines, marketplaces and data partners read structured product data to understand a page. Publishing it means the details already on this page can be understood without guessing at the layout.',
      fields: structuredData.usedFields,
    })
  }

  if (added.length) {
    points.push({
      title: sentenceCase(`${list(added.map((f) => f.label.toLowerCase()))} made explicit`),
      why: 'Information that today only appears in the page navigation becomes a field in its own right, so products can be grouped, filtered and compared rather than only browsed.',
      fields: added.map((f) => f.field),
    })
  }

  const specGaps = absent.filter((f) =>
    ['product.specifications', 'product.dimensions', 'product.weight', 'product.attributes'].includes(f.field),
  )
  if (specGaps.length) {
    points.push({
      title: 'Comparable specifications',
      why: `A buyer choosing between similar items has less to compare on this page: ${list(
        specGaps.map((f) => f.label.toLowerCase()),
      )} ${isAre(specGaps)} not shown. Consistent named attributes let people filter to the item that fits.`,
      fields: specGaps.map((f) => f.field),
    })
  }

  const identityGaps = absent.filter((f) => ['product.brand', 'product.mpn', 'product.gtin'].includes(f.field))
  if (identityGaps.length) {
    points.push({
      title: 'Findable by what buyers search for',
      why: `Buyers often search by manufacturer or part number. On this page ${list(
        identityGaps.map((f) => f.label.toLowerCase()),
      )} ${isAre(identityGaps)} not published, so those searches cannot match.`,
      fields: identityGaps.map((f) => f.field),
    })
  }

  return points.slice(0, 4).map((p, i) => ({
    ...p,
    title: assertSupported(`workbench.valuePoint[${i}].title`, p.title),
    why: assertSupported(`workbench.valuePoint[${i}].why`, p.why),
  }))
}

export { EMPTY_STATE }
