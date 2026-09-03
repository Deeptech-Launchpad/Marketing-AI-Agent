import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { renderAuditPdf } from '../../src/websiteaudit/pdfReport.js'
import { buildCollateral, type CollateralExample } from '../../src/websiteaudit/collateral.js'
import type { CatalogFinding, FindingEvidence } from '../../src/websiteaudit/findings.js'

// PHASE 6 — the customer / courier PDF.
//
// The tests that matter here are the negative ones. A courier report is a
// document that leaves the building, so what it must NOT contain is a harder
// requirement than what it must.
//
// PDF text is extracted rather than parsed properly: pdfkit writes text as
// Tj/TJ operators inside an uncompressed content stream when no compression is
// requested, which is enough to assert on presence and absence. It is not a
// PDF reader and does not need to be.

/**
 * Extracts the visible text from a PDF.
 *
 * pdfkit Flate-compresses its content streams, so the streams are inflated
 * first. Decompressing in the test is the right side to solve this on: turning
 * compression off in the renderer would make every real report larger to suit
 * a test.
 */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1')
  const chunks: string[] = []

  // Each `stream ... endstream` that inflates is a content stream; the rest
  // (fonts, images) throw and are skipped.
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      chunks.push(inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1'))
    } catch {
      chunks.push(m[1]!)
    }
  }

  // pdfkit embeds a subsetted font and writes text as HEX strings inside TJ
  // arrays — <5072> <6f64756374...> rather than (Product...). Both forms are
  // handled because the standard-14 path still emits literals.
  const fromHex = (hex: string): string =>
    Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ''), 'hex').toString('latin1')

  // One entry per text-showing operator. A TJ array's parts are one run split
  // by kerning, so they concatenate; separate operators get a space between.
  const runs: string[] = []
  for (const content of chunks) {
    for (const m of content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) runs.push(m[1]!)
    for (const m of content.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)) runs.push(fromHex(m[1]!))
    for (const m of content.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
      const parts: string[] = []
      for (const s of m[1]!.matchAll(/\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]+)>/g)) {
        parts.push(s[1] !== undefined ? s[1] : fromHex(s[2]!))
      }
      runs.push(parts.join(''))
    }
  }
  return runs
    .join(' ')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

const ev = (over: Partial<FindingEvidence> = {}): FindingEvidence => ({
  observationId: 'obs_secret_1',
  pageId: 'pg_secret_1',
  sourceUrl: 'https://1stayd.com/product/degreaser-5l',
  field: 'product.specifications',
  status: 'missing',
  value: null,
  sourcePath: 'main > .spec-table',
  fragment: '<div class="spec-table" data-internal="yes"></div>',
  observedAt: new Date('2026-08-27T00:00:00Z'),
  ...over,
})

const finding = (over: Partial<CatalogFinding> = {}): CatalogFinding => ({
  code: 'incomplete_specifications',
  title: 'Specifications not present on inspected product pages',
  category: 'specifications',
  priority: 'high',
  priorityReasons: ['tier 1 field'],
  affectedCount: 9,
  observedCount: 3,
  sampleSize: 12,
  sampleUnit: 'product pages',
  metric: 'A specification block was observed on 3 of 12 inspected product pages.',
  finding: 'A specification block could not be found on 9 of the 12 inspected product pages',
  impact: 'Buyers cannot compare products on specification.',
  recommendation: 'SECRETMETHODOLOGY: run the AltiusNXT attribute-derivation pipeline in three stages.',
  evidence: [ev(), ev({ observationId: 'obs_secret_2', sourceUrl: 'https://1stayd.com/product/wipes-100' })],
  ...over,
})

const example: CollateralExample = {
  productUrl: 'https://1stayd.com/product/degreaser-5l',
  productName: 'Industrial Degreaser 5L',
  fields: [
    {
      field: 'product.category',
      label: 'Category',
      before: null,
      after: 'Cleaning Chemicals',
      delta: 'added',
      headline: true,
      provenance: {
        kind: 'derived',
        sourceObservationId: 'obs_9',
        sourceField: 'page.breadcrumbs',
        sourceUrl: 'https://1stayd.com/product/degreaser-5l',
        sourcePath: 'nav.breadcrumb',
        sourceFragment: 'Home > Cleaning Chemicals > Degreasers',
        rule: 'Taken from the breadcrumb trail already published on the page.',
      },
    },
    {
      field: 'product.description',
      label: 'Description',
      before: 'Degreaser 5L',
      after: 'Industrial degreaser, 5 litre container, for workshop floors and machinery.',
      delta: 'reworded',
      headline: true,
      provenance: {
        kind: 'reworded',
        sourceObservationId: 'obs_10',
        sourceField: 'product.description',
        sourceUrl: 'https://1stayd.com/product/degreaser-5l',
        sourcePath: 'main .desc',
        sourceFragment: 'Degreaser 5L',
        rule: 'Rewritten from the existing description and the observed attributes. No new fact was added.',
      },
    },
  ],
}

const base = {
  companyName: '1st Ayd',
  website: 'https://1stayd.com',
  auditDate: new Date('2026-08-27T00:00:00Z'),
  pagesInspected: 25,
  productPagesInspected: 12,
  categoryPagesInspected: 3,
  limitsHit: ['the 25-page cap'],
}

const manyFindings = [
  finding(),
  finding({ code: 'missing_brand', category: 'identifiers', title: 'Brand not stated', priority: 'high' }),
  finding({ code: 'missing_weight', category: 'attributes', title: 'Weight absent', priority: 'medium' }),
  finding({ code: 'no_product_structured_data', category: 'structure', title: 'No structured product data', priority: 'high' }),
  finding({ code: 'duplicate_pages', category: 'structure', title: 'Duplicate pages', priority: 'low' }),
]

async function customerPdf(over: Record<string, unknown> = {}) {
  const c = buildCollateral({
    ...base,
    audience: 'customer',
    findings: manyFindings,
    examples: [example],
    ctaUrl: 'https://calendar.app.google/altiusnxt-15min',
    ...over,
  })
  const pdf = await renderAuditPdf(c, manyFindings, { workbenchUrl: 'https://demo.altiusnxt.com/w/abc123' })
  return { c, pdf, text: pdfText(pdf.bytes) }
}

// ── 1. STRUCTURE ───────────────────────────────────────────────────────────

describe('customer PDF structure', () => {
  it('renders a real PDF', async () => {
    const { pdf } = await customerPdf()
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.bytes.length).toBeGreaterThan(3000)
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('targets the agreed 5–6 pages when the content is there', async () => {
    const { pdf } = await customerPdf()
    expect(pdf.pageCount).toBeGreaterThanOrEqual(5)
    expect(pdf.pageCount).toBeLessThanOrEqual(7)
  })

  it('carries every required section', async () => {
    const { text } = await customerPdf()
    for (const heading of [
      'Product Data Health Check',
      'What we observed',
      'Strongest observations',
      'Audit scope',
      'Where the opportunity may be',
      'The same product, better described',
      'How AltiusNXT can help',
      'Discoverability considerations',
      'Next step',
    ]) {
      expect(text, heading).toContain(heading)
    }
  })

  it('drops the pages it has no content for, honestly', async () => {
    // No examples and no discoverability findings: those pages must not appear
    // as empty sections.
    const { pdf, text } = await customerPdf({
      findings: [finding({ code: 'missing_weight', category: 'attributes' })],
      examples: [],
    })
    expect(text).not.toContain('The same product, better described')
    expect(text).not.toContain('Discoverability considerations')
    expect(pdf.pageCount).toBeLessThan(5)
    // What survives is still a complete document.
    expect(text).toContain('Product Data Health Check')
    expect(text).toContain('How AltiusNXT can help')
    expect(text).toContain('Next step')
  })

  it('is reproducible from the same stored observations', async () => {
    const a = await customerPdf()
    const b = await customerPdf()
    expect(a.pdf.sha256).toBe(b.pdf.sha256)
  })
})

// ── 2. WHAT MUST NEVER LEAVE THE BUILDING ──────────────────────────────────

describe('courier safety — what the customer PDF must not contain', () => {
  it('does not print the remediation methodology', async () => {
    const { text } = await customerPdf()
    expect(text).not.toContain('SECRETMETHODOLOGY')
    expect(text).not.toContain('attribute-derivation pipeline')
  })

  it('does not print internal identifiers', async () => {
    const { text } = await customerPdf()
    expect(text).not.toMatch(/obs_secret/)
    expect(text).not.toMatch(/pg_secret/)
  })

  it('does not print source fragments or DOM paths', async () => {
    const { text } = await customerPdf()
    expect(text).not.toContain('spec-table')
    expect(text).not.toContain('data-internal')
    expect(text).not.toContain('main > .spec-table')
  })

  it('does not print an evidence appendix', async () => {
    const { text } = await customerPdf()
    expect(text).not.toContain('Evidence appendix')
    expect(text).not.toContain('incomplete_specifications')
  })

  it('does not list every affected page', async () => {
    const { text } = await customerPdf()
    const urls = text.match(/https:\/\/1stayd\.com\/product\/[a-z0-9-]+/g) ?? []
    expect(new Set(urls).size).toBeLessThanOrEqual(2)
  })

  it('says more was found without itemising it', async () => {
    const { text } = await customerPdf()
    expect(text).toContain('Additional affected pages were observed in the inspected sample')
  })

  it('still gives the internal report everything', async () => {
    const internal = buildCollateral({ ...base, audience: 'internal', findings: manyFindings })
    const pdf = await renderAuditPdf(internal, manyFindings)
    const text = pdfText(pdf.bytes)
    expect(text).toContain('Evidence appendix')
    expect(text).toContain('SECRETMETHODOLOGY')
    expect(text).toContain('incomplete_specifications')
  })
})

// ── 3. BEFORE / AFTER ──────────────────────────────────────────────────────

describe('before/after in the PDF', () => {
  it('prints both sides and the rule that justifies the after value', async () => {
    const { text } = await customerPdf()
    expect(text).toContain('BEFORE')
    expect(text).toContain('AFTER')
    expect(text).toContain('Cleaning Chemicals')
    expect(text).toContain('Taken from the breadcrumb trail already published on the page.')
  })

  it('shows an absent BEFORE as absent rather than inventing one', async () => {
    const { text } = await customerPdf()
    expect(text).toContain('not present on the page')
  })

  it('honours the configured example count', async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...example, productUrl: `https://1stayd.com/p/${i}` }))
    const c = buildCollateral({ ...base, audience: 'customer', findings: manyFindings, examples: five, sampleCount: 2 })
    expect(c.examples).toHaveLength(2)
    const pdf = await renderAuditPdf(c, manyFindings)
    const urls = pdfText(pdf.bytes).match(/https:\/\/1stayd\.com\/p\/\d/g) ?? []
    expect(new Set(urls).size).toBe(2)
  })
})

// ── 4. THE CLOSING PAGE ────────────────────────────────────────────────────

describe('CTA and disclaimers', () => {
  it('prints the call to action and its link', async () => {
    const { text } = await customerPdf()
    expect(text.toUpperCase()).toContain('BOOK A 15-MINUTE WALKTHROUGH')
    expect(text).toContain('https://calendar.app.google/altiusnxt-15min')
  })

  it('states plainly when no booking link is configured', async () => {
    const { text } = await customerPdf({ ctaUrl: null })
    expect(text).toContain('A booking link has not been configured')
    expect(text).not.toContain('calendar.app.google')
  })

  it('prints the scope and financial disclaimers', async () => {
    const { text } = await customerPdf()
    expect(text).toContain('inspected pages only')
    expect(text).toContain('Potential opportunity')
  })

  it('prints the CONFIGURED legal disclaimer rather than a literal', async () => {
    const { text } = await customerPdf({ legalDisclaimer: 'Approved wording from legal, ref LGL-2026-11.' })
    expect(text).toContain('Approved wording from legal, ref LGL-2026-11.')
  })

  it('marks an unconfigured report as not approved for sending', async () => {
    // Reachable only through the development bypass — generateCustomerReport
    // refuses to produce one at all. It must never look like approved copy.
    const { text } = await customerPdf({ legalDisclaimer: null })
    expect(text).toContain('not approved for sending')
  })

  it('never claims a ranking', async () => {
    const { text } = await customerPdf()
    expect(text).not.toMatch(/your (?:search )?ranking will/i)
    expect(text).toContain('no ranking or visibility position was measured')
  })

  it('never states money, a percentage or an ROI', async () => {
    const { text } = await customerPdf()
    expect(text).not.toMatch(/\b\d{1,3}\s?%/)
    expect(text).not.toMatch(/[£$€]\s?\d/)
    expect(text).not.toMatch(/\bROI\b/i)
  })
})

// ── 5. HONEST DEGRADATION ──────────────────────────────────────────────────

describe('degrading honestly', () => {
  it('renders for an unreachable site with nothing observed', async () => {
    const c = buildCollateral({
      ...base,
      audience: 'customer',
      pagesInspected: 0,
      productPagesInspected: 0,
      categoryPagesInspected: 0,
      findings: [],
      examples: [],
    })
    const pdf = await renderAuditPdf(c, [])
    const text = pdfText(pdf.bytes)
    expect(pdf.pageCount).toBeGreaterThanOrEqual(2)
    expect(text).toContain('No product-data finding was recorded')
    expect(text).toContain('0 page(s) inspected')
    expect(text).not.toContain('The same product, better described')
  })

  it('renders for a site with no product page', async () => {
    const c = buildCollateral({
      ...base,
      audience: 'customer',
      productPagesInspected: 0,
      findings: [finding({ code: 'no_product_pages_identified', category: 'structure', sampleUnit: 'pages' })],
      examples: [],
    })
    const text = pdfText(await renderAuditPdf(c, []).then((p) => p.bytes))
    expect(text).toContain('No product page could be identified')
    expect(text).toContain('Next step')
  })
})
