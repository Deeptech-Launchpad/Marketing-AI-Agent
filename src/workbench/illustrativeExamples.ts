// ILLUSTRATIVE EXAMPLES — SHOWING WHAT A COMPLETE PAGE LOOKS LIKE, WITHOUT
// CLAIMING ANYTHING ABOUT THIS PRODUCT.
//
// The Workbench's AFTER view and the report's comparison frames used to show a
// missing field as "Not published on current website" and stop. That is
// honest, and it is also why the improved page looked barely different from
// the current one: a customer cannot picture a page full of empty rows.
//
// So a missing field can now carry an EXAMPLE — a value that shows what the
// finished field looks like. The rule that makes this safe is that an example
// demonstrates STRUCTURE, never a FACT about this product:
//
//   · MEASUREMENTS get a generic sample with its unit ("300 × 200 × 150 mm").
//     Nobody reads a round-number sample dimension as this product's size,
//     and it shows the format far better than a description of the format.
//
//   · IDENTIFIERS AND CLAIMS get bracketed structure only ("[13-digit GTIN]",
//     "[Standard] [Number]:[Year]"). A realistic barcode, a real standard name
//     or a plausible compatibility list is exactly what someone would copy
//     onto a live product page as though it were true. For these, anything
//     more concrete than the shape of the field is a claim.
//
// Every example is returned with `kind` so the renderers can label it, and
// both renderers — the Workbench screen and the PDF — label it EXAMPLE. That
// label is part of the contract, not decoration.
//
// WHAT THIS MODULE NEVER DOES
//   · It never reads a product, a company or a category. The same field gets
//     the same example for every company, which is what makes it an example
//     rather than a guess about somebody's catalogue.
//   · It never produces a value for a field the page DID publish. Callers only
//     ask for absent fields; a published value is shown as published.
//   · It never produces money, a percentage, a certification name, a standard
//     number or a brand.

export type ExampleKind = 'sample' | 'format'

export interface IllustrativeExample {
  /** What the finished field looks like. Never this product's data. */
  value: string
  /**
   * `sample` — a generic sample value with units (measurements only).
   * `format` — bracketed structure only (identifiers, claims, anything a
   *            reader might copy onto a live page as fact).
   */
  kind: ExampleKind
}

const sample = (value: string): IllustrativeExample => ({ value, kind: 'sample' })
const format = (value: string): IllustrativeExample => ({ value, kind: 'format' })

/**
 * The enriched record's own field ids.
 *
 * Deliberately no example for `product.name`, `product.brand` or
 * `product.description`: those are the product's identity and copy, and an
 * example of them would be the one kind a reader could not tell from real.
 * `product.image` is handled by the renderers as a labelled placement.
 */
const BY_RECORD_FIELD: Record<string, IllustrativeExample> = {
  'product.dimensions': sample('300 × 200 × 150 mm'),
  'product.weight': sample('2.4 kg'),
  'product.units': sample('Sold per each · pack of 1'),
  'product.sku': format('[Your internal item code]'),
  'product.mpn': format('[Manufacturer part number]'),
  'product.gtin': format('[13-digit GTIN / EAN barcode]'),
  'product.category': format('[Department] > [Category] > [Sub-category]'),
  'product.price': format('[Price] [Currency] · ex. / inc. tax stated'),
  'product.availability': format('[In stock / Made to order] · [lead time]'),
  'product.specifications': format('[Property]: [value] [unit] — one row per property'),
  'product.attributes': format('[Attribute]: [value] — filterable, one per row'),
  'product.documents': format('[Datasheet].pdf · [Safety data sheet].pdf'),
}

/**
 * The recommended-schema attributes, by their stable id.
 *
 * Grouped the same way as above: a measurement may carry a sample, anything
 * that asserts a standard, an approval, a compatibility, a safety fact or a
 * rating that a buyer relies on carries structure only.
 */
const BY_ATTRIBUTE: Record<string, IllustrativeExample> = {
  // Measurements — generic samples with units.
  dimensions: sample('300 × 200 × 150 mm'),
  size: sample('22 mm nominal bore'),
  capacity: sample('20 L'),
  pack_capacity: sample('5 L · pack of 4'),
  pack_quantity: sample('Box of 100'),
  coverage_pack: sample('Covers 10 m² per pack'),

  // Descriptive properties — structure only, because a sample would read as
  // a statement about what this product is made of or how it is used.
  material: format('[Material] · [grade or finish if relevant]'),
  finish: format('[Finish / colour]'),
  application: format('[Where it is used] · [what it is used for]'),
  usage: format('[Step 1] · [Step 2] · [Dilution / quantity per use]'),
  concentration: format('[Ratio, e.g. 1 : N] for [use]'),
  installation_type: format('[Surface / wall / floor / inline]'),
  connection: format('[Connection type] · [size]'),
  model: format('[Model / manufacturer part number]'),

  // Ratings and ranges — structure only: a plausible sample voltage or
  // pressure is a safety-relevant claim about a specific product.
  voltage: format('[Nominal voltage] V'),
  power: format('[Power rating] W'),
  operating_range: format('[Minimum] – [Maximum] [unit]'),

  // Claims — structure only, always. These are the fields a customer would
  // copy onto a live page, and an invented one is a false claim.
  certification: format('[Standard] [Number]:[Year] · [issuing body]'),
  grade_standard: format('[Standard] [Number] · [grade]'),
  standards: format('[Standard] [Number]:[Year]'),
  compatibility: format('Compatible with [product / system name]'),
  safety_documentation: format('Safety data sheet · [revision date] · PDF'),
  documents: format('[Datasheet].pdf · [Installation guide].pdf'),
}

/** An example for one absent enriched-record field, or null when none applies. */
export function exampleForRecordField(field: string): IllustrativeExample | null {
  return BY_RECORD_FIELD[field] ?? null
}

/** An example for one recommended-schema attribute, or null when none applies. */
export function exampleForAttribute(attributeField: string): IllustrativeExample | null {
  return BY_ATTRIBUTE[attributeField] ?? null
}

/** The sentence every renderer shows beside an example. One wording, everywhere. */
export const EXAMPLE_NOTE = 'Illustrative example — not your product data. Publish your real value here.'
