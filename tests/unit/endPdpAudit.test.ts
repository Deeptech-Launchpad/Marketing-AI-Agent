import { describe, expect, it } from 'vitest'
import { assessPdpPage, productLinksOn, readEndPdpValue } from '../../src/websiteaudit/pdpTarget.js'
import {
  mentionsProduct,
  readSourcePage,
  valueAppearsIn,
  verifyEnrichment,
  withoutClaimSentences,
  type EnrichmentModelOutput,
} from '../../src/websiteaudit/pdpEnrichment.js'
import { formatPrice, renderEnrichedPdpHtml } from '../../src/workbench/enrichedPdpPage.js'
import { pdfText, renderEnrichmentReport } from '../../src/websiteaudit/enrichmentReport.js'
import type { RawPageResult } from '../../src/research/pageFetch.js'

// THE END PDP AUDIT.
//
// What must hold for EVERY company, whatever its industry or website:
//
//   · the End PDP link is sorted into one of three cases from what the page
//     served — valid product page, link problem, or no link — with a next step
//     for every case that is not a product page;
//   · a suggested replacement is only ever a link the page itself published;
//   · an enriched attribute keeps a "page" or "manufacturer" label only when
//     its value is found in that text, price and stock never come from the
//     model, and no URL is ever invented;
//   · the enriched page and the report escape everything and mark AI-enriched
//     values.
//
// Every fixture runs for two companies that share nothing, so a rule that only
// works for one of them fails here.

const COMPANIES = [
  { name: 'Northwind Fasteners', host: 'northwind-fasteners.test', product: 'Stainless Hex Bolt M8 x 40', sku: 'NW-HB-0840' },
  { name: 'Lumière Sanitaire', host: 'lumiere-sanitaire.test', product: 'Robinet Mitigeur Lavabo Chrome', sku: 'LS-RML-220' },
] as const

const FILLER =
  '<p>Trusted by trade customers for over thirty years. Next-day delivery on all stocked lines, with expert advice from our counter team.</p>'

const fetched = (url: string, html: string, over: Partial<RawPageResult> = {}): RawPageResult => ({
  ok: true,
  requestedUrl: url,
  finalUrl: url,
  status: 200,
  contentType: 'text/html',
  html,
  truncated: false,
  bytes: html.length,
  redirectChain: [],
  reason: null,
  durationMs: 10,
  ...over,
})

const productPage = (c: (typeof COMPANIES)[number]) => `<html><head><title>${c.product} | ${c.name}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${c.product}","sku":"${c.sku}",
"image":"https://${c.host}/img/main.jpg","offers":{"@type":"Offer","price":"12.50","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script>
</head><body><h1>${c.product}</h1><p>SKU: ${c.sku}</p><table><tr><td>Material</td><td>Stainless Steel</td></tr>
<tr><td>Length</td><td>40 mm</td></tr><tr><td>Thread</td><td>M8</td></tr></table><button>Add to cart</button>${FILLER}</body></html>`

const assess = (value: string, page: RawPageResult | null) => {
  const read = readEndPdpValue(value, 'https://example.test')
  if ('assessment' in read) return read.assessment
  return assessPdpPage({ endPdpValue: value, companyWebsite: 'https://example.test', fetched: page, fetchUrl: read.fetchUrl })
}

describe('which case the End PDP link is in', () => {
  it('has no link when the field is empty', () => {
    const a = assess('', null)
    expect(a.case).toBe('no_link')
    expect(a.recommendations.length).toBeGreaterThan(0)
  })

  it('has no link when the field holds a word, not an address', () => {
    const a = assess('PDP', null)
    expect(a.case).toBe('no_link')
    expect(a.issue).toBe('not_a_url')
  })

  it('names a social page as a link problem without fetching it', () => {
    const read = readEndPdpValue('https://www.facebook.com/somehardwarestore/', null)
    expect('assessment' in read && read.assessment.issue).toBe('social_profile')
  })

  it('names a search-engine results link as a link problem without fetching it', () => {
    const read = readEndPdpValue('https://www.google.com/search?q=hardware+supplies', null)
    expect('assessment' in read && read.assessment.issue).toBe('search_results_link')
  })

  for (const c of COMPANIES) {
    const url = `https://${c.host}/product/item-1`

    it(`accepts a product page and names the product — ${c.name}`, () => {
      const a = assess(url, fetched(url, productPage(c)))
      expect(a.case).toBe('valid_product')
      expect(a.productName).toBe(c.product)
      expect(a.recommendations).toEqual([])
    })

    it(`reports a removed product (HTTP 404) with a next step — ${c.name}`, () => {
      const a = assess(url, fetched(url, '', { ok: false, status: 404, reason: 'The site returned HTTP 404.' }))
      expect(a.case).toBe('link_problem')
      expect(a.issue).toBe('http_error')
      expect(a.recommendations.join(' ')).toMatch(/End PDP/)
    })

    it(`reports an unreachable site — ${c.name}`, () => {
      const a = assess(url, fetched(url, '', { ok: false, status: null, finalUrl: null, reason: 'getaddrinfo ENOTFOUND' }))
      expect(a.issue).toBe('unreachable')
    })

    it(`reports a product link that now redirects to the homepage — ${c.name}`, () => {
      const a = assess(url, fetched(url, `<html><title>${c.name}</title><body>${FILLER}</body></html>`, { finalUrl: `https://${c.host}/` }))
      expect(a.issue).toBe('redirected_away')
    })

    it(`reports a page that says the product is gone — ${c.name}`, () => {
      const a = assess(url, fetched(url, `<html><title>Page not found | ${c.name}</title><body><h1>Page not found</h1>${FILLER}</body></html>`))
      expect(a.issue).toBe('product_missing')
    })

    it(`reports a homepage, however many products it features — ${c.name}`, () => {
      const home = `https://${c.host}/`
      const a = assess(home, fetched(home, productPage(c)))
      expect(a.issue).toBe('homepage')
    })

    it(`reports a category grid and offers only product links that page published — ${c.name}`, () => {
      const catUrl = `https://${c.host}/category/bolts/`
      const tiles = Array.from(
        { length: 10 },
        (_, i) => `<div class="product-item"><a href="/category/bolts/bolt-${i}">Bolt ${i}</a><span>€${i + 1}.00</span><button>Add to cart</button></div>`,
      ).join('')
      const a = assess(catUrl, fetched(catUrl, `<html><title>Bolts | ${c.name}</title><body><h1>Bolts</h1>${tiles}${FILLER}</body></html>`))
      expect(a.case).toBe('link_problem')
      expect(a.issue).toBe('category_page')
      expect(a.suggestedProductUrls.length).toBeGreaterThan(0)
      for (const s of a.suggestedProductUrls) expect(s.startsWith(`https://${c.host}/category/bolts/bolt-`)).toBe(true)
    })

    it(`accepts a thin product page whose URL slug names the titled item — ${c.name}`, () => {
      const slug = c.product.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const thinUrl = `https://${c.host}/shop/191/${slug}.htm`
      const html = `<html><title>${c.product} | ${c.name}</title><body><h2>${c.product}</h2><button>Add to cart</button>${FILLER}</body></html>`
      const a = assess(thinUrl, fetched(thinUrl, html))
      expect(a.case).toBe('valid_product')
    })
  }

  it('never offers a sibling or parent category as a replacement product', () => {
    const page = 'https://shop.test/products/room/water-heaters/'
    const html = '<a href="/products/room/indoor-tiles/">Tiles</a><a href="/products/room/">Rooms</a><a href="/products/room/water-heaters/boiler-80l">Boiler</a>'
    expect(productLinksOn(html, page)).toEqual(['https://shop.test/products/room/water-heaters/boiler-80l'])
  })
})

// ── Enrichment checks ─────────────────────────────────────────────────────

const model = (over: Partial<EnrichmentModelOutput> = {}): EnrichmentModelOutput => ({
  enrichedTitle: 'Brand Series Product, Variant',
  brand: null,
  series: null,
  manufacturerPartNumber: null,
  productType: 'Product',
  categoryPath: ['Industrial', 'Fixings'],
  industryLabel: 'Industrial Supplies',
  unspsc: '31161500',
  description: { intro: 'A dependable product for professional use [Page data] .', bullets: ['One [AI inference]', 'Two', 'Three'] },
  attributes: [],
  recommendedDocuments: ['Technical Data Sheet'],
  attributeHighlights: [{ heading: 'Physical', detail: 'Material and length stated separately.' }],
  beforeNarrative: ['The page publishes the name and SKU only.'],
  afterNarrative: ['The record surfaces structured attributes.'],
  keyTransformation: 'From a basic listing to a structured, filterable record.',
  introParagraph: 'This report presents a before and after audit of one product page and what the enriched record becomes.',
  executiveSummary: 'Buyers need structured specifications before purchase. This will increase revenue by 30%. Structured data answers them.',
  normalizationNotes: [{ heading: 'Units', detail: 'Lengths are stated in millimetres.' }],
  auditSummary: 'This single-page comparison shows how a sparse listing becomes a structured record.',
  keyImprovements: [{ heading: 'Structure', detail: 'Attributes exposed in a matrix.' }],
  nextSteps: [{ heading: 'Pilot', detail: 'Enrich a pilot batch.' }],
  ...over,
})

describe('the enriched record is checked after the model answers', () => {
  for (const c of COMPANIES) {
    const url = `https://${c.host}/product/item-1`
    const page = readSourcePage(productPage(c), url, c.product)
    const manufacturer = [
      { ref: 'S1', url: 'https://maker.test/p/1', text: `${c.product} Thread pitch 1.25 mm. Tensile grade A2-70.`, documents: [{ title: 'Data sheet', url: 'https://maker.test/ds.pdf' }] },
    ]

    it(`keeps a "page" label only for a value the page publishes — ${c.name}`, () => {
      const { enriched, checks } = verifyEnrichment(
        model({
          attributes: [
            { name: 'Material', value: 'Stainless Steel', source: 'page', sourceRef: 'P' },
            { name: 'Head Type', value: 'Hexagon', source: 'page', sourceRef: 'P' },
          ],
        }),
        page,
        manufacturer,
      )
      expect(enriched.attributes.find((a) => a.name === 'Material')).toMatchObject({ source: 'page', sourceUrl: page.url })
      expect(enriched.attributes.find((a) => a.name === 'Head Type')).toMatchObject({ source: 'enriched', sourceUrl: null })
      expect(checks.relabelledToEnriched).toBe(1)
    })

    it(`keeps a "manufacturer" label only when the cited page states it — ${c.name}`, () => {
      const { enriched } = verifyEnrichment(
        model({
          attributes: [
            { name: 'Thread Pitch', value: '1.25 mm', source: 'manufacturer', sourceRef: 'S1' },
            { name: 'Grade', value: 'A4-80', source: 'manufacturer', sourceRef: 'S1' },
          ],
        }),
        page,
        manufacturer,
      )
      expect(enriched.attributes[0]).toMatchObject({ source: 'manufacturer', sourceUrl: 'https://maker.test/p/1' })
      expect(enriched.attributes[1]).toMatchObject({ source: 'enriched', sourceUrl: null })
    })

    it(`takes price and stock only from the page, never from the model — ${c.name}`, () => {
      const { enriched, checks } = verifyEnrichment(
        model({ attributes: [{ name: 'Price', value: '999.00', source: 'enriched', sourceRef: null }, { name: 'Stock Status', value: 'In Stock', source: 'enriched', sourceRef: null }] }),
        page,
        manufacturer,
      )
      expect(enriched.attributes).toEqual([])
      expect(checks.droppedCommercial).toBe(2)
      expect(enriched.price).toBe('12.50')
    })

    it(`links only documents a fetched page published; the rest have no URL — ${c.name}`, () => {
      const { enriched } = verifyEnrichment(model({ recommendedDocuments: ['Declaration of Conformity'] }), page, manufacturer)
      expect(enriched.documents.find((d) => d.source === 'manufacturer')?.url).toBe('https://maker.test/ds.pdf')
      expect(enriched.documents.find((d) => d.source === 'recommended')).toMatchObject({ title: 'Declaration of Conformity', url: null })
    })
  }

  it('strips basis tags and drops sentences making financial claims', () => {
    const page = readSourcePage(productPage(COMPANIES[0]), 'https://a.test/product/1', COMPANIES[0].product)
    const { enriched, checks } = verifyEnrichment(model(), page, [])
    expect(enriched.description.intro).toBe('A dependable product for professional use.')
    expect(enriched.description.bullets[0]).toBe('One')
    expect(enriched.executiveSummary).not.toMatch(/revenue|30%/)
    expect(checks.droppedClaimSentences).toBeGreaterThan(0)
  })

  it('accepts only an 8-digit UNSPSC code', () => {
    const page = readSourcePage(productPage(COMPANIES[0]), 'https://a.test/product/1', COMPANIES[0].product)
    expect(verifyEnrichment(model({ unspsc: '31161500' }), page, []).enriched.unspsc).toBe('31161500')
    expect(verifyEnrichment(model({ unspsc: '3116-15' }), page, []).enriched.unspsc).toBeNull()
  })

  it('treats a zero price as price on request', () => {
    const html = productPage(COMPANIES[0]).replace('"price":"12.50"', '"price":"0"')
    expect(readSourcePage(html, 'https://a.test/product/1', 'x').price).toBeNull()
    expect(formatPrice('0', 'EUR')).toBeNull()
    expect(formatPrice('35', 'EUR')).toBe('€35.00')
  })

  it('matches values loosely on case, units spacing and list parts, but not on different values', () => {
    expect(valueAppearsIn('Stainless Steel', 'Material: stainless  steel')).toBe(true)
    expect(valueAppearsIn('Cold; Wet; Oil', 'Suitable for cold, wet and oil conditions')).toBe(true)
    expect(valueAppearsIn('45 mm', 'Length 40 mm')).toBe(false)
  })

  it('reads a research page as about the product only when it names it', () => {
    const facts = { productName: 'Robinet Mitigeur Lavabo Chrome', mpn: null, sku: 'LS-RML-220', brand: null }
    expect(mentionsProduct('Datasheet for LS-RML-220 mixer', facts)).toBe(true)
    expect(mentionsProduct('Local news: the harbour reopens this week', facts)).toBe(false)
  })

  it('removes only claim sentences, keeping technical percentages', () => {
    expect(withoutClaimSentences('Elongation is 600% at break. Fixing this will increase revenue by 20%.').text).toBe('Elongation is 600% at break.')
  })
})

// ── The enriched page and the report ──────────────────────────────────────

const enrichmentFor = (c: (typeof COMPANIES)[number]) => {
  const url = `https://${c.host}/product/item-1`
  const page = readSourcePage(productPage(c), url, c.product)
  const { text: _t, ...source } = page
  const { enriched, checks } = verifyEnrichment(
    model({
      enrichedTitle: `${c.product} <script>alert(1)</script>`,
      attributes: [
        { name: 'Material', value: 'Stainless Steel', source: 'page', sourceRef: 'P' },
        { name: 'Finish', value: 'Brushed <b>', source: 'enriched', sourceRef: null },
      ],
    }),
    page,
    [],
  )
  return {
    status: 'ready' as const,
    reason: null,
    generatedAt: new Date(0).toISOString(),
    model: 'test',
    costUsd: 0,
    source,
    research: { attempted: false, note: null, sources: [] },
    enriched,
    checks,
  }
}

describe('the enriched product page', () => {
  for (const c of COMPANIES) {
    it(`has the approved structure, escapes everything, and marks enriched values — ${c.name}`, () => {
      const html = renderEnrichedPdpHtml(enrichmentFor(c))
      for (const section of ['Product Description', 'Technical Specifications', 'Attachments', 'Installation Videos', 'Reviews and Ratings']) {
        expect(html).toContain(section)
      }
      expect(html).toContain('2 ATTRIBUTES')
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
      expect(html).toContain('AI-enriched value (1 of 2)')
      expect(html).toContain('€12.50')
    })
  }
})

describe('the PDP Enrichment Report', () => {
  it('maps characters the standard PDF fonts cannot draw', () => {
    expect(pdfText('≥600% · 20″ ‘quoted’ ≤ 5 → x')).toBe(">=600% · 20\" 'quoted' <= 5  x")
  })

  for (const c of COMPANIES) {
    it(`renders the six template sections for any company — ${c.name}`, async () => {
      const result = await renderEnrichmentReport({
        companyName: c.name,
        preparedFor: c.name,
        preparedBy: { name: 'Team', role: 'Lead', company: 'AltiusNxt Technologies Pvt Ltd', phone: null, email: null, web: null },
        auditDate: new Date('2026-09-15T00:00:00Z'),
        sourceUrl: `https://${c.host}/product/item-1`,
        enrichment: enrichmentFor(c),
        beforeCapture: null,
        afterCapture: null,
        captureNote: 'Capture disabled in tests.',
        logoPath: null,
        shareUrl: null,
        watermark: null,
      })
      expect(result.pageCount).toBe(6)
      expect(result.bytes.subarray(0, 5).toString()).toBe('%PDF-')
    })
  }
})
