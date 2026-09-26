import { describe, expect, it } from 'vitest'
import { deriveAttributes } from '../../src/websiteaudit/enrichedRecord.js'

// ATTRIBUTES ARE READ OUT OF WHAT THE PAGE SAYS — NOT OUT OF ITS MARKUP.
//
// The rule that makes the AFTER column worth anything is that every named
// attribute is words the customer already published. Markup breaks that in a
// way prose never does: a tag carries text that is not about the product at
// all, and it sits in the same string.
//
// This file exists because of one real product page. 1source Supply describes
// a chrome-plated aerator adapter inside
//   <p style="color: blue; display: inline; font-size: 20px;">SPECIFICATIONS</p>
// and the colour rule matched `color: blue` in the STYLESHEET, reporting the
// finish as blue — while the same description states "Finish: Chrome-Plated"
// a few lines further down. It rendered as an OBSERVED attribute in front of a
// customer, which is a fabricated value wearing an observation's badge.

const REAL_PAGE =
  '"A" Male Aerator Adapter (Lead-Free)<br><p style="color: blue; display: inline; font-size: 20px;">' +
  'SPECIFICATIONS</p><br>• 27 Threads Per Inch<br>• Hose Connection: 12T<br>' +
  '• Threads: 15/16" Male X 55/64" Male<br>• Material: Lead-Free Brass<br>' +
  '• Finish: Chrome-Plated<br>• Meets: AB1953/NSF61G Standard<br>'

describe('markup is never mistaken for what the page says', () => {
  it('does not read a CSS colour declaration as the product finish', () => {
    const colours = deriveAttributes(REAL_PAGE).filter((a) => a.label === 'Colour')
    expect(
      colours.map((c) => c.value.toLowerCase()),
      'blue is a style declaration, not this product’s finish',
    ).not.toContain('blue')
  })

  it('still reads the material the page actually states', () => {
    const material = deriveAttributes(REAL_PAGE).find((a) => a.label === 'Material')
    expect(material, 'the page states a material in its own words').toBeTruthy()
    expect(material!.value.toLowerCase()).toContain('brass')
  })

  it('reads nothing at all out of a tag attribute', () => {
    // Every value here lives only inside markup. A page that publishes no
    // visible attribute must yield none.
    const derived = deriveAttributes(
      '<div data-material="steel" title="Colour: red" style="color: green">Product</div>',
    )
    expect(derived, 'nothing visible was published, so nothing may be derived').toEqual([])
  })

  it('keeps every value and source window a literal part of the published text', () => {
    // The masking replaces tags with spaces rather than deleting them, so the
    // indices still address the original string. If that ever regresses, the
    // source window quoted as evidence would no longer be the page's own text.
    for (const attr of deriveAttributes(REAL_PAGE)) {
      expect(REAL_PAGE, `${attr.label} value`).toContain(attr.value)
      expect(REAL_PAGE, `${attr.label} sourceText`).toContain(attr.sourceText)
      expect(attr.sourceText, `${attr.label} window contains its value`).toContain(attr.value)
    }
  })

  it('does not read a quantity out of the middle of a part or standards code', () => {
    // "AB1953/NSF61G" ends in something a weight rule will happily read as
    // "61 g" unless it is anchored at a word boundary. The page states no
    // weight for this product at all.
    const weights = deriveAttributes(REAL_PAGE).filter((a) => a.label === 'Weight')
    expect(
      weights.map((w) => w.value),
      'a standards code is not a weight',
    ).toEqual([])
  })

  it('is unchanged on text that carries no markup', () => {
    const plain = 'Supplied in a 15L drum. Material: stainless steel. Finish: black powder-coated.'
    const derived = deriveAttributes(plain)
    expect(derived.length, 'plain prose still yields its attributes').toBeGreaterThan(0)
    for (const a of derived) expect(plain).toContain(a.value)
  })
})
