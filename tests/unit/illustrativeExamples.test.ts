import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EXAMPLE_NOTE,
  exampleForAttribute,
  exampleForRecordField,
} from '../../src/workbench/illustrativeExamples.js'

// AN EXAMPLE SHOWS STRUCTURE, NEVER A FACT.
//
// The AFTER view and the report's improved frame now fill fields the customer's
// page leaves empty, so the improvement is visible rather than a column of
// blanks. That is only safe under one rule, and these tests are that rule:
//
//   · measurements may carry a generic sample with a unit;
//   · identifiers and claims carry bracketed structure only — never a real
//     barcode, standard, certification, compatibility list, price or rating,
//     because those are what somebody copies onto a live page as true.

const RECORD_FIELDS = [
  'product.dimensions', 'product.weight', 'product.units', 'product.sku', 'product.mpn', 'product.gtin',
  'product.category', 'product.price', 'product.availability', 'product.specifications', 'product.attributes',
  'product.documents',
]
const ATTRIBUTES = [
  'application', 'capacity', 'certification', 'compatibility', 'concentration', 'connection', 'coverage_pack',
  'dimensions', 'documents', 'finish', 'grade_standard', 'installation_type', 'material', 'model', 'operating_range',
  'pack_capacity', 'pack_quantity', 'power', 'safety_documentation', 'size', 'standards', 'usage', 'voltage',
]

const allExamples = () => [
  ...RECORD_FIELDS.map((f) => [f, exampleForRecordField(f)] as const),
  ...ATTRIBUTES.map((a) => [`attr:${a}`, exampleForAttribute(a)] as const),
]

describe('every gap the audit can report has an example', () => {
  it('covers each record field and each recommended attribute', () => {
    for (const [key, ex] of allExamples()) {
      expect(ex, key).not.toBeNull()
      expect(ex!.value.trim().length, key).toBeGreaterThan(2)
    }
  })

  // Name, brand and description are the product's identity and copy. An
  // example of those is the one kind a reader could not tell from real.
  it('never offers an example of the product’s identity or copy', () => {
    for (const f of ['product.name', 'product.brand', 'product.description', 'product.image']) {
      expect(exampleForRecordField(f), f).toBeNull()
    }
  })
})

describe('identifiers and claims are structure only', () => {
  const STRUCTURE_ONLY = [
    ['product.sku', exampleForRecordField('product.sku')],
    ['product.mpn', exampleForRecordField('product.mpn')],
    ['product.gtin', exampleForRecordField('product.gtin')],
    ['product.price', exampleForRecordField('product.price')],
    ['product.documents', exampleForRecordField('product.documents')],
    ['certification', exampleForAttribute('certification')],
    ['standards', exampleForAttribute('standards')],
    ['grade_standard', exampleForAttribute('grade_standard')],
    ['compatibility', exampleForAttribute('compatibility')],
    ['safety_documentation', exampleForAttribute('safety_documentation')],
    ['voltage', exampleForAttribute('voltage')],
    ['power', exampleForAttribute('power')],
    ['operating_range', exampleForAttribute('operating_range')],
    ['material', exampleForAttribute('material')],
    ['concentration', exampleForAttribute('concentration')],
    ['model', exampleForAttribute('model')],
  ] as const

  for (const [key, ex] of STRUCTURE_ONLY) {
    it(`${key} is a bracketed format, not a value`, () => {
      expect(ex!.kind).toBe('format')
      expect(ex!.value).toMatch(/\[[^\]]+\]/)
    })
  }
})

describe('no example can be mistaken for a real claim', () => {
  it('never states money, a percentage, or a long digit run a barcode could be', () => {
    for (const [key, ex] of allExamples()) {
      expect(ex!.value, key).not.toMatch(/[£$€]\s?\d/)
      expect(ex!.value, key).not.toMatch(/\d\s?%/)
      expect(ex!.value, key).not.toMatch(/\d{6,}/)
    }
  })

  it('never names a real standard, certification mark or approval body', () => {
    for (const [key, ex] of allExamples()) {
      expect(ex!.value, key).not.toMatch(/\b(ISO|EN|ASTM|DIN|BS|UL|CE|WRAS|NSF|IEC|ANSI|REACH|RoHS)\b\s?\d*/)
    }
  })

  it('carries one shared note that says what an example is', () => {
    expect(EXAMPLE_NOTE).toMatch(/illustrative example/i)
    expect(EXAMPLE_NOTE).toMatch(/not your product data/i)
  })
})

describe('examples are the same for every company', () => {
  it('reads no company, product or category', () => {
    const src = readFileSync('src/workbench/illustrativeExamples.ts', 'utf8')
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    // A lookup by field id — nothing about who the customer is.
    expect(code).not.toMatch(/companyName|crmCompanyId|domain|host|categoryLabel|record\./i)
    for (const name of ['Ac Cleaning', 'accleaning', 'Unicare', '1source', 'Jamesco', '247lighting']) {
      expect(code, name).not.toContain(name)
    }
  })

  it('returns an identical example on every call', () => {
    expect(exampleForRecordField('product.gtin')).toEqual(exampleForRecordField('product.gtin'))
    expect(exampleForAttribute('dimensions')).toEqual(exampleForAttribute('dimensions'))
  })
})
