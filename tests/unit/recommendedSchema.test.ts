import { describe, expect, it } from 'vitest'
import {
  buildRecommendedSchema,
  classifyCategory,
  type SchemaCategory,
  type SchemaEvidence,
} from '../../src/websiteaudit/recommendedSchema.js'
import type { DerivedAttribute, EnrichedRecord, RecordField } from '../../src/websiteaudit/enrichedRecord.js'

// THE RECOMMENDED SCHEMA NAMES FIELDS, NEVER VALUES.
//
// Two things have to hold, and they are tested in that order of importance:
//
//   · no attribute ever carries a value the customer's own page did not
//     publish — a `recommended` attribute has no value at all
//   · the category is read from the run's own evidence, and where that
//     evidence is missing, weak or split the answer is `general` and says so
//
// The module is pure, so the records below are built by hand rather than
// through prisma; what a page publishes is the only input that matters.

const FIELDS = [
  ['product.name', 'Product name', 'identity'],
  ['product.brand', 'Brand', 'identity'],
  ['product.sku', 'Product code / SKU', 'identity'],
  ['product.mpn', 'Manufacturer part number', 'identity'],
  ['product.gtin', 'GTIN / barcode', 'identity'],
  ['product.category', 'Category', 'identity'],
  ['product.description', 'Description', 'commercial'],
  ['product.price', 'Price', 'commercial'],
  ['product.availability', 'Availability', 'commercial'],
  ['product.specifications', 'Technical specifications', 'technical'],
  ['product.attributes', 'Attributes', 'technical'],
  ['product.dimensions', 'Dimensions', 'technical'],
  ['product.weight', 'Weight', 'technical'],
  ['product.units', 'Units of measure', 'technical'],
  ['product.documents', 'Supporting documents', 'support'],
  ['product.image', 'Product image', 'support'],
] as const

interface Present {
  before: string
  restructured?: boolean
  derived?: DerivedAttribute[]
}

/** A record where every field is absent except the ones named. Same invariants as buildEnrichedRecord. */
function record(present: Partial<Record<(typeof FIELDS)[number][0], Present>> = {}): EnrichedRecord {
  const sourceUrl = 'https://customer.test/product/one/'
  const fields: RecordField[] = FIELDS.map(([field, label, group]) => {
    const p = present[field]
    if (!p) {
      return {
        field, label, group,
        before: null, after: null, state: 'absent',
        derivedAttributes: [],
        recommendation: `Publish the ${label.toLowerCase()}.`,
        method: null, sourcePath: null, sourceUrl,
      }
    }
    return {
      field, label, group,
      before: p.before, after: p.before, state: p.restructured ? 'restructured' : 'observed',
      derivedAttributes: p.derived ?? [],
      recommendation: null,
      method: 'dom_heuristic', sourcePath: 'test', sourceUrl,
    }
  })
  return {
    crmCompanyId: 'co-1', auditRunId: 'run-1', pageId: 'page-1', sourceUrl,
    title: present['product.name']?.before ?? '/product/one/',
    imageUrl: null,
    fields,
    observedCount: fields.filter((f) => f.state === 'observed').length,
    restructuredCount: fields.filter((f) => f.state === 'restructured').length,
    absentCount: fields.filter((f) => f.state === 'absent').length,
    derivedAttributeCount: fields.reduce((n, f) => n + f.derivedAttributes.length, 0),
    beforeSummary: '', afterSummary: '', keyTransformation: '',
  }
}

const evidence = (over: Partial<SchemaEvidence> = {}): SchemaEvidence => ({
  sectorNames: [],
  categoryTexts: [],
  productNames: [],
  productDescriptions: [],
  ...over,
})

const CLEANING_SITE = evidence({
  sectorNames: ['Floor Cleaners', 'Washroom & Hygiene'],
  categoryTexts: ['Home > Cleaning Chemicals > Floor Cleaners > Citrus Degreaser 5L'],
  productNames: ['Citrus Degreaser 5L', 'Bactericidal Hand Soap 500ml'],
  productDescriptions: ['A concentrated degreaser suitable for commercial kitchen floors, available in 5L containers.'],
})

const PLUMBING_SITE = evidence({
  sectorNames: ['Brassware', 'Bathroom Taps'],
  categoryTexts: ['Home > Plumbing > Compression Fittings > 15mm Compression Elbow'],
  productNames: ['15mm Compression Elbow', 'Chrome Basin Mixer Tap'],
})

describe('the category is read from the site’s own words', () => {
  it('reads a cleaning supplier as cleaning, and says which words it read', () => {
    const d = classifyCategory(CLEANING_SITE)
    expect(d.category).toBe('cleaning')
    expect(d.determined).toBe(true)
    expect(d.matchedEvidence.length).toBeGreaterThan(0)
    expect(d.matchedEvidence.join('\n')).toContain('Floor Cleaners')
    expect(d.matchedEvidence.join('\n')).toMatch(/matched "(?:cleaner|cleaning|degreaser)"/)
    expect(d.note).toMatch(/read as cleaning/i)
  })

  it('reads a plumbers’ merchant as plumbing', () => {
    const d = classifyCategory(PLUMBING_SITE)
    expect(d.category).toBe('plumbing')
    expect(d.determined).toBe(true)
    expect(d.matchedEvidence.join('\n')).toContain('Brassware')
  })

  it('reads an electrical wholesaler and an engineering supplier apart', () => {
    expect(
      classifyCategory(evidence({ sectorNames: ['Cable & Wiring', 'Consumer Units'], productNames: ['6242Y Twin & Earth Cable 2.5mm'] })).category,
    ).toBe('electrical')
    expect(
      classifyCategory(evidence({ sectorNames: ['Bearings', 'Hydraulic Pumps'], productNames: ['Deep Groove Ball Bearing 6205'] })).category,
    ).toBe('industrial')
    expect(
      classifyCategory(evidence({ sectorNames: ['Timber & Sheet Materials', 'Plasterboard'], productNames: ['C24 Treated Timber 47 x 100mm'] })).category,
    ).toBe('building')
  })

  it('is deterministic: the same evidence always yields the same decision', () => {
    expect(classifyCategory(CLEANING_SITE)).toEqual(classifyCategory(CLEANING_SITE))
    expect(buildRecommendedSchema(PLUMBING_SITE, record())).toEqual(buildRecommendedSchema(PLUMBING_SITE, record()))
  })

  it('quotes only the site’s own text as evidence', () => {
    const d = classifyCategory(CLEANING_SITE)
    const own = [
      ...CLEANING_SITE.sectorNames,
      ...CLEANING_SITE.categoryTexts,
      ...CLEANING_SITE.productNames,
      ...CLEANING_SITE.productDescriptions,
    ].join('\n')
    for (const e of d.matchedEvidence) {
      const quoted = /"([^"]+)" matched/.exec(e)![1]!
      expect(own, `evidence must be a verbatim excerpt: ${e}`).toContain(quoted)
    }
  })
})

describe('where the evidence does not support a category, none is assumed', () => {
  it('gives an unclassifiable site the general profile and says the category could not be determined', () => {
    const s = buildRecommendedSchema(evidence({ productNames: ['Widget A'], productDescriptions: ['A great product.'] }), null)
    expect(s.category).toBe('general')
    expect(s.determined).toBe(false)
    expect(s.note).toMatch(/could not be determined/i)
    expect(s.note).toMatch(/no sector has been assumed/i)
    expect(s.matchedEvidence).toEqual([])
    expect(s.attributes.length).toBeGreaterThan(0)
  })

  it('treats a passing mention as a mention, not a reading', () => {
    // One word in one description is weight 1; it takes three distinct sector words to carry a reading.
    const d = classifyCategory(evidence({ productDescriptions: ['Easy to keep clean with a mop.'] }))
    expect(d.category).toBe('general')
    expect(d.determined).toBe(false)
    expect(d.note).toMatch(/only in passing/i)
    expect(d.matchedEvidence.length, 'the near-miss is still shown, so "not determined" is not mistaken for "nothing found"').toBe(1)
  })

  it('reports evidence split evenly between two categories as split, rather than picking one', () => {
    const d = classifyCategory(evidence({ sectorNames: ['Plumbing', 'Electrical'] }))
    expect(d.category).toBe('general')
    expect(d.determined).toBe(false)
    expect(d.note).toMatch(/equal weight/i)
    expect(d.note).toMatch(/plumbing/i)
    expect(d.note).toMatch(/electrical/i)
  })

  it('does not read a category out of a one-page site with no product page', () => {
    // The 4boxes shape: one page fetched, nothing categorised, no product observed.
    const s = buildRecommendedSchema(evidence(), null)
    expect(s.category).toBe('general')
    expect(s.assessedAgainst).toBeNull()
    expect(s.attributes.every((a) => a.state === 'recommended' && a.value === null)).toBe(true)
    expect(s.recommendedCount).toBe(s.attributes.length)
  })
})

describe('an attribute’s state is read from the customer’s own record', () => {
  it('marks a cleaning attribute derived where prose already supplied it, and observed where a field does', () => {
    const rec = record({
      'product.name': { before: 'Citrus Degreaser 5L' },
      'product.description': {
        before: 'A concentrated degreaser suitable for commercial kitchen floors, available in 5L containers.',
        derived: [
          { label: 'Application', value: 'commercial kitchen floors', sourceText: 'suitable for commercial kitchen floors, available in 5L containers.' },
          { label: 'Pack / Capacity', value: '5L', sourceText: 'suitable for commercial kitchen floors, available in 5L containers.' },
        ],
      },
      'product.documents': { before: 'https://customer.test/docs/citrus-sds.pdf' },
    })
    const s = buildRecommendedSchema(CLEANING_SITE, rec)
    expect(s.category).toBe('cleaning')
    expect(s.assessedAgainst).toEqual({ pageId: 'page-1', title: 'Citrus Degreaser 5L', sourceUrl: 'https://customer.test/product/one/' })

    const by = (field: string) => s.attributes.find((a) => a.field === field)!
    expect(by('pack_capacity').state).toBe('derived')
    expect(by('pack_capacity').value).toBe('5L')
    expect(by('application').state).toBe('derived')
    expect(by('application').value).toBe('commercial kitchen floors')
    expect(by('safety_documentation').state).toBe('observed')
    expect(by('safety_documentation').value).toBe('https://customer.test/docs/citrus-sds.pdf')

    // Nothing on the page states a concentration, so none is stated here.
    expect(by('concentration').state).toBe('recommended')
    expect(by('concentration').value).toBeNull()
    expect(by('concentration').source).toBeNull()

    expect(s.derivedCount).toBe(2)
    expect(s.observedCount).toBe(1)
    expect(s.recommendedCount).toBe(s.attributes.length - 3)
  })

  it('reads a published "Key: value" specification pair as observed, verbatim', () => {
    const rec = record({
      'product.name': { before: '15mm Compression Elbow' },
      'product.specifications': { before: 'Material: Brass | Size: 15mm | Connection Type: Compression' },
    })
    const s = buildRecommendedSchema(PLUMBING_SITE, rec)
    const by = (field: string) => s.attributes.find((a) => a.field === field)!

    expect(by('material').state).toBe('observed')
    expect(by('material').value).toBe('Brass')
    expect(by('size').value).toBe('15mm')
    expect(by('connection').value).toBe('Compression')
    expect(by('connection').source).toMatch(/Connection Type/)

    expect(by('finish').state).toBe('recommended')
    expect(by('finish').value).toBeNull()
  })

  it('does not read a field out of prose that merely mentions the word', () => {
    // No "Voltage:" pair was published; a sentence containing the word is not a field.
    const rec = record({
      'product.specifications': {
        before: 'This unit accepts a wide range of voltage inputs and is popular in workshops across the country.',
        restructured: true,
      },
    })
    const s = buildRecommendedSchema(evidence({ sectorNames: ['Electrical'] }), rec)
    const voltage = s.attributes.find((a) => a.field === 'voltage')!
    expect(voltage.state).toBe('recommended')
    expect(voltage.value).toBeNull()
  })
})

describe('no attribute ever carries a value the page did not publish', () => {
  const FORCE: Record<Exclude<SchemaCategory, 'general'>, string> = {
    cleaning: 'Cleaning Chemicals',
    plumbing: 'Plumbing',
    electrical: 'Electrical',
    industrial: 'Industrial Tools',
    building: 'Building Supplies',
  }

  it('leaves every attribute of every profile without a value when there is no record to read', () => {
    for (const [category, sector] of Object.entries(FORCE) as Array<[SchemaCategory, string]>) {
      const s = buildRecommendedSchema(evidence({ sectorNames: [sector] }), null)
      expect(s.category, `"${sector}" should classify as ${category}`).toBe(category)
      for (const a of s.attributes) {
        expect(a.state, `${category}/${a.field}`).toBe('recommended')
        expect(a.value, `${category}/${a.field} carried a value with nothing to read it from`).toBeNull()
        expect(a.source).toBeNull()
      }
    }
  })

  it('leaves every attribute without a value when the record publishes nothing', () => {
    for (const sector of Object.values(FORCE)) {
      const s = buildRecommendedSchema(evidence({ sectorNames: [sector] }), record())
      expect(s.assessedAgainst).not.toBeNull()
      expect(s.attributes.every((a) => a.state === 'recommended' && a.value === null && a.source === null)).toBe(true)
    }
  })

  it('carries a value only as observed or derived, and only in the page’s own characters', () => {
    const rec = record({
      'product.name': { before: 'ACME Circulation Pump 42' },
      'product.mpn': { before: 'ACM-42-MPN' },
      'product.dimensions': { before: '600 x 400 x 250mm' },
      'product.specifications': { before: 'Rated Voltage (V): 230 | Power: 1500W | Operating Temperature: -10 to 40°C' },
      'product.description': {
        before: 'A stainless steel pump designed for heating circuits, supplied in a pack of 2.',
        derived: [
          { label: 'Material', value: 'stainless steel', sourceText: 'A stainless steel pump designed for heating circuits' },
          { label: 'Application', value: 'heating circuits', sourceText: 'A stainless steel pump designed for heating circuits' },
          { label: 'Pack / Capacity', value: 'pack of 2', sourceText: 'supplied in a pack of 2.' },
        ],
      },
    })
    const published = rec.fields.flatMap((f) => [f.before ?? '', ...f.derivedAttributes.map((d) => d.value)]).join('\n')

    for (const sector of Object.values(FORCE)) {
      const s = buildRecommendedSchema(evidence({ sectorNames: [sector] }), rec)
      for (const a of s.attributes) {
        if (a.state === 'recommended') {
          expect(a.value, `${s.category}/${a.field}`).toBeNull()
          expect(a.source).toBeNull()
          continue
        }
        expect(a.value, `${s.category}/${a.field} has a state but no value`).not.toBeNull()
        expect(a.source).not.toBeNull()
        expect(published, `${s.category}/${a.field} = "${a.value}" was never published`).toContain(a.value!)
      }
    }

    // And the spec pairs were read as the page printed them.
    const electrical = buildRecommendedSchema(evidence({ sectorNames: ['Electrical'] }), rec)
    const by = (field: string) => electrical.attributes.find((a) => a.field === field)!
    expect(by('voltage').value).toBe('230')
    expect(by('power').value).toBe('1500W')
    expect(by('model').value).toBe('ACM-42-MPN')
    expect(by('dimensions').value).toBe('600 x 400 x 250mm')
  })

  it('never proposes a value in the advice text either', () => {
    for (const site of [CLEANING_SITE, PLUMBING_SITE, evidence()]) {
      for (const a of buildRecommendedSchema(site, null).attributes) {
        expect(a.why, `${a.field}: advice must name the field, not a value`).not.toMatch(/\b\d+\s*(?:ml|l|mm|kg|v|w)\b/i)
      }
    }
  })
})
