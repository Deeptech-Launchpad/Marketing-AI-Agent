import { describe, expect, it } from 'vitest'
import { assertOnlySourcedFacts, buildProposedContent } from '../../src/workbench/proposedContent.js'
import type { EnrichedRecord, RecordField } from '../../src/websiteaudit/enrichedRecord.js'

// THE ONE STATE THAT IS OURS.
//
// OBSERVED, DERIVED and RECOMMENDED are all statements about the customer's
// catalogue. PROPOSED is a suggestion about their copy, which makes it the
// only place in the product where we write a sentence a customer might publish
// as their own specification.
//
// So the tests that matter are not about what it says. They are about what it
// is structurally unable to say.

const f = (over: Partial<RecordField> & { field: string; label: string }): RecordField => ({
  group: 'identity',
  before: null,
  after: null,
  state: 'absent',
  method: null,
  sourcePath: null,
  sourceUrl: 'https://acme.test/p/1',
  derivedAttributes: [],
  recommendation: null,
  ...over,
})

const observed = (field: string, label: string, value: string): RecordField =>
  f({ field, label, before: value, after: value, state: 'observed' })

const record = (over: Partial<EnrichedRecord> = {}): EnrichedRecord => ({
  crmCompanyId: 'c1',
  auditRunId: 'r1',
  pageId: 'p1',
  sourceUrl: 'https://acme.test/p/1',
  pageContext: {
    pageTitle: 'Brass Aerator Adapter — Acme',
    siteName: 'Acme',
    breadcrumbs: 'Home > Plumbing > Aerators',
    host: 'acme.test',
  },
  title: 'Brass Aerator Adapter',
  imageUrl: null,
  fields: [
    observed('product.name', 'Product name', 'Brass Aerator Adapter'),
    observed('product.brand', 'Brand', 'WAL-RICH'),
    observed('product.price', 'Price', '4.20'),
    f({
      field: 'product.description',
      label: 'Description',
      before: 'Brass aerator adapter. Chrome finish.',
      after: null,
      state: 'observed',
      derivedAttributes: [
        { label: 'Material', value: 'Brass', sourceText: 'Brass aerator adapter.' },
        { label: 'Finish', value: 'Chrome', sourceText: 'Chrome finish.' },
      ],
    }),
    f({ field: 'product.gtin', label: 'GTIN / barcode' }),
    f({ field: 'product.dimensions', label: 'Dimensions' }),
  ],
  observedCount: 4,
  restructuredCount: 0,
  absentCount: 2,
  derivedAttributeCount: 2,
  beforeSummary: 'b',
  afterSummary: 'a',
  keyTransformation: 'k',
  ...over,
})

describe('proposed content is composed from the page, never added to it', () => {
  it('builds an overview out of the page’s own values', () => {
    const c = buildProposedContent({ record: record(), categoryLabel: 'Plumbing & pipework' })!
    expect(c.overview).toContain('Brass Aerator Adapter')
    expect(c.overview).toContain('WAL-RICH')
    expect(c.overview).toContain('Home > Plumbing > Aerators')
  })

  it('lists what it was built from, so a reviewer can check it in one pass', () => {
    const c = buildProposedContent({ record: record(), categoryLabel: null })!
    const labels = c.supportedBy.map((s) => s.label)
    expect(labels).toContain('Material')
    expect(labels).toContain('Brand')
    expect(c.supportedBy.find((s) => s.label === 'Material')?.from).toBe('derived')
  })

  // The line the module will not cross. A missing field becomes a question for
  // the customer, never a value we supply at any confidence.
  // "What is the technical specifications for this product?" is what a
  // template produces when it assumes every label is a singular noun.
  it('phrases the prompt so it reads correctly for every field label', () => {
    const rec = record({
      fields: [
        observed('product.brand', 'Brand', 'WAL-RICH'),
        observed('product.price', 'Price', '4.20'),
        f({ field: 'product.specifications', label: 'Technical specifications' }),
        f({ field: 'product.attributes', label: 'Attributes' }),
      ],
      absentCount: 2,
    })
    const c = buildProposedContent({ record: rec, categoryLabel: null })!
    for (const q of c.openQuestions) expect(q).not.toMatch(/What is the .*specifications/i)
    expect(c.openQuestions).toContain('Technical specifications — what should this page state?')
  })

  it('normalises a schema.org availability URL the way the page mock does', () => {
    const rec = record({
      fields: [
        observed('product.brand', 'Brand', 'WAL-RICH'),
        observed('product.availability', 'Availability', 'https://schema.org/InStock'),
      ],
    })
    const c = buildProposedContent({ record: rec, categoryLabel: null })!
    const avail = c.supportedBy.find((v) => v.label === 'Availability')
    expect(avail?.value).toBe('In Stock')
  })

  it('turns an absent field into a value-free prompt, not into a value', () => {
    const c = buildProposedContent({ record: record(), categoryLabel: null })!
    expect(c.openQuestions.some((q) => /^Dimensions — what should this page state\?$/.test(q))).toBe(true)
    expect(c.overview).not.toMatch(/dimensions/i)
    expect(c.bullets.join(' ')).not.toMatch(/dimensions/i)
  })

  it('says nothing at all when the page published almost nothing', () => {
    const bare = record({
      fields: [observed('product.name', 'Product name', 'Widget')],
      observedCount: 1,
      derivedAttributeCount: 0,
    })
    expect(buildProposedContent({ record: bare, categoryLabel: null })).toBeNull()
  })

  it('carries a note saying plainly that it is a proposal', () => {
    const c = buildProposedContent({ record: record(), categoryLabel: null })!
    expect(c.note).toContain('not a statement of fact')
    expect(c.note).toContain('AltiusNxt')
  })

  it('never invents a certification, a standard or a measurement', () => {
    const c = buildProposedContent({ record: record(), categoryLabel: null })!
    const prose = [c.overview, ...c.bullets].join(' ')
    for (const invented of ['ASTM', 'ISO ', 'CE marked', 'certified', 'compatible with', 'suitable for']) {
      expect(prose, invented).not.toContain(invented)
    }
  })
})

// The guard exists because "safe by construction" is a claim about code that
// someone will edit later. It checks the OUTPUT, so a future template that
// starts adding facts fails loudly rather than shipping.
describe('the guard refuses a proposal that states what the source did not', () => {
  const base = record()

  const proposal = (overview: string) => ({
    overview,
    bullets: [],
    openQuestions: [],
    supportedBy: [],
    note: 'n',
  })

  it('accepts a figure the page actually published', () => {
    expect(() => assertOnlySourcedFacts(proposal('Priced at 4.20 on this catalogue.'), base)).not.toThrow()
  })

  it('rejects a measurement the page never stated', () => {
    expect(() => assertOnlySourcedFacts(proposal('Fits a 15mm compression joint.'), base)).toThrow(
      /does not appear in anything this page published/,
    )
  })

  it('rejects a standard reference the page never stated', () => {
    expect(() => assertOnlySourcedFacts(proposal('Manufactured to ASTM A574.'), base)).toThrow()
  })

  it('rejects an invented percentage', () => {
    expect(() => assertOnlySourcedFacts(proposal('Reduces flow by 30%.'), base)).toThrow()
  })

  // It throws rather than filtering: a silently dropped sentence leaves a
  // proposal that reads fine and has quietly lost the thing that was wrong.
  it('throws rather than quietly removing the bad sentence', () => {
    let threw = false
    try {
      assertOnlySourcedFacts(proposal('Chrome finish. Rated to 16 bar.'), base)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('passes text carrying no specification-shaped claim at all', () => {
    expect(() =>
      assertOnlySourcedFacts(proposal('Listed under Plumbing in the site navigation.'), base),
    ).not.toThrow()
  })
})

// ── A UNIT IS ATTACHED TO ITS NUMBER; A PREPOSITION IS NOT ───────────────
//
// The unit list necessarily contains `in`, `a`, `m`, `g`, `l`, `v` and `w` —
// several of the commonest words in English — and the guard used to allow
// whitespace between a number and its unit. So a product whose title ends in a
// numeric SKU, followed by ordinary prose, produced a measurement nobody wrote:
//
//   "…SANITISER 20L 71803 in the Cleaning & hygiene category"
//                  └────── read as "71803 inches"
//
// Not found in the source, because nobody had written it — so the guard threw,
// and took the whole customer view and the Audit Report down with it, on a real
// company whose audit was perfectly good (14 product pages, every field
// populated). A false positive on a fail-closed guard is an outage.
//
// What must NOT change: verification. The bare number is still checked on its
// own, and the whole measurement token is checked as well as its number, so
// dropping a unit cannot launder an invented figure.

describe('a number followed by an ordinary English word is not a measurement', () => {
  // The real title and the real sentence shape that caused the outage.
  const skuRecord = record({
    title: 'CLEAN PLUS ALL PURPOSE SANITISER 20L 71803',
    fields: [
      observed('product.name', 'Product name', 'CLEAN PLUS ALL PURPOSE SANITISER 20L 71803'),
      observed('product.sku', 'Product code / SKU', '71803'),
    ],
  })

  it('accepts a title ending in a numeric SKU followed by prose', () => {
    const content = {
      overview: 'CLEAN PLUS ALL PURPOSE SANITISER 20L 71803 in the Cleaning & hygiene products category.',
      bullets: [],
      openQuestions: [],
      supportedBy: [],
      note: '',
    }
    expect(() => assertOnlySourcedFacts(content, skuRecord)).not.toThrow()
  })

  it('accepts every single-letter unit word used as ordinary prose', () => {
    // in, a, m, g, l, v, w are all real units AND real words.
    for (const word of ['in', 'a', 'm', 'g', 'l', 'v', 'w']) {
      const content = {
        overview: `CLEAN PLUS ALL PURPOSE SANITISER 20L 71803 ${word} something.`,
        bullets: [],
        openQuestions: [],
        supportedBy: [],
        note: '',
      }
      expect(() => assertOnlySourcedFacts(content, skuRecord), word).not.toThrow()
    }
  })

  it('still requires the bare number itself to be in the source', () => {
    const content = {
      overview: 'CLEAN PLUS ALL PURPOSE SANITISER 99999 in the category.',
      bullets: [],
      openQuestions: [],
      supportedBy: [],
      note: '',
    }
    expect(() => assertOnlySourcedFacts(content, skuRecord)).toThrow(/99999/)
  })

  it('accepts an attached unit the source really published', () => {
    const content = {
      overview: 'CLEAN PLUS ALL PURPOSE SANITISER 20L is listed on this catalogue.',
      bullets: [],
      openQuestions: [],
      supportedBy: [],
      note: '',
    }
    expect(() => assertOnlySourcedFacts(content, skuRecord)).not.toThrow()
  })
})

describe('an invented figure is still refused', () => {
  const skuRecord = record({
    title: 'CLEAN PLUS ALL PURPOSE SANITISER 20L 71803',
    fields: [
      observed('product.name', 'Product name', 'CLEAN PLUS ALL PURPOSE SANITISER 20L 71803'),
      observed('product.sku', 'Product code / SKU', '71803'),
    ],
  })
  const say = (overview: string) => ({ overview, bullets: [], openQuestions: [], supportedBy: [], note: '' })

  it('refuses an invented measurement', () => {
    expect(() => assertOnlySourcedFacts(say('Measures 123mm across.'), skuRecord)).toThrow(/123mm|123/)
  })

  // The laundering case: the NUMBER is real, the measurement is not.
  it('refuses a real number wearing a unit the source never gave it', () => {
    expect(() => assertOnlySourcedFacts(say('Weighs 71803kg.'), skuRecord)).toThrow(/71803kg/)
  })

  it('refuses an invented percentage', () => {
    expect(() => assertOnlySourcedFacts(say('Removes 99% of bacteria.'), skuRecord)).toThrow()
  })

  it('refuses an invented standard', () => {
    expect(() => assertOnlySourcedFacts(say('Certified to ISO 9001.'), skuRecord)).toThrow()
  })

  it('refuses an invented bare figure in a bullet, not only in the overview', () => {
    const content = say('CLEAN PLUS ALL PURPOSE SANITISER 20L 71803.')
    content.bullets = ['Pack of 48']
    expect(() => assertOnlySourcedFacts(content, skuRecord)).toThrow(/48/)
  })
})
