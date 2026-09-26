import { afterEach, describe, expect, it, vi } from 'vitest'
import { crawlSite, type CrawlLimits } from '../../src/websiteaudit/crawler.js'
import * as pageFetch from '../../src/research/pageFetch.js'
import type { RawPageResult } from '../../src/research/pageFetch.js'
import { isDescendantPath, samePath } from '../../src/websiteaudit/urls.js'

// A CANONICAL THAT CONTRADICTS THE OBSERVED CONTENT.
//
// Canonical exists to collapse ?utm=, trailing slashes, www. and http/https
// into one address — variants of the SAME page, which share a path.
//
// A canonical naming a DIFFERENT path is a cross-page claim, and a common CMS
// template mistake: on one real site every category page emitted
// <link rel="canonical" href="/products">. Honouring it discarded thirteen
// distinct category pages, burnt the page budget on them, and produced an
// audit reporting zero products for a company with a full catalogue.
//
// By the time the canonical is read, the crawler's content-hash check has
// already passed — which is proof the pages differ. A declaration that
// contradicts an observation loses to the observation, and the contradiction
// is recorded as a finding about the site rather than silently dropped.

describe('a canonical is honoured only for variants of the same page', () => {
  it('accepts a canonical that differs only in query, host, case or trailing slash', () => {
    expect(samePath('https://acme.test/products/bathroom', 'https://acme.test/products/bathroom?utm=x')).toBe(true)
    expect(samePath('https://acme.test/products/bathroom/', 'https://acme.test/products/bathroom')).toBe(true)
    expect(samePath('https://www.acme.test/p/1', 'https://acme.test/p/1')).toBe(true)
    expect(samePath('https://acme.test/Products/Bathroom', 'https://acme.test/products/bathroom')).toBe(true)
  })

  it('rejects a canonical pointing at a different page', () => {
    // The exact shape that caused the bug.
    expect(samePath('https://acme.test/products', 'https://acme.test/products/mobility')).toBe(false)
    expect(samePath('https://acme.test/products', 'https://acme.test/products/bathroom')).toBe(false)
    expect(samePath('https://acme.test/', 'https://acme.test/products/first-aid')).toBe(false)
  })

  it('treats the site root canonical as a variant only of the root', () => {
    expect(samePath('https://acme.test/', 'https://acme.test')).toBe(true)
    expect(samePath('https://acme.test/', 'https://acme.test/shop')).toBe(false)
  })

  it('treats an unreadable canonical as no canonical', () => {
    expect(samePath(null, 'https://acme.test/p/1')).toBe(false)
    expect(samePath('not a url', 'https://acme.test/p/1')).toBe(false)
    expect(samePath('https://acme.test/p/1', 'not a url')).toBe(false)
  })
})

// ── DESCENDING BEATS SPREADING SIDEWAYS ──────────────────────────────────
//
// On a catalogue every category page links to every other category page. A
// crawl that treats those links as equal spends its whole page budget on one
// level and never reaches the detail pages beneath — which is exactly how
// fifteen fetched pages produced zero products for a company with a full
// catalogue. A link that goes DEEPER INTO THE PAGE WE ARE ALREADY ON is the
// only move that can reach a product, so it is ordered first.
//
// Ordering only. Nothing is ever excluded on the strength of this.

describe('a link deeper into the current page outranks a sibling', () => {
  it('recognises a strictly deeper path', () => {
    expect(isDescendantPath('https://u.test/products/bathroom', 'https://u.test/products/bathroom/grab-rails')).toBe(true)
    expect(isDescendantPath('https://u.test/products', 'https://u.test/products/bathroom/grab-rails')).toBe(true)
    expect(isDescendantPath('https://u.test/', 'https://u.test/products')).toBe(true)
  })

  it('does not treat a sibling as a descendant', () => {
    expect(isDescendantPath('https://u.test/products/bathroom', 'https://u.test/products/mobility')).toBe(false)
    expect(isDescendantPath('https://u.test/products/bathroom', 'https://u.test/products')).toBe(false)
    expect(isDescendantPath('https://u.test/products/bathroom', 'https://u.test/products/bathroom')).toBe(false)
  })

  it('does not cross hosts, but ignores a www prefix', () => {
    expect(isDescendantPath('https://u.test/products', 'https://other.test/products/x')).toBe(false)
    expect(isDescendantPath('https://www.u.test/products', 'https://u.test/products/x')).toBe(true)
  })

  it('treats an unreadable URL as no relationship', () => {
    expect(isDescendantPath('not a url', 'https://u.test/x')).toBe(false)
    expect(isDescendantPath('https://u.test/x', 'not a url')).toBe(false)
  })
})

// ── CATALOGUE EVIDENCE IS COLLECTED ON EVERY FETCHED PAGE ────────────────
//
// Deliberately not gated on page type. Gating on "is this a product page" is
// the exact mistake that reported zero products for a full catalogue: the
// category pages classified correctly, and the products were named only in
// the image alt text on them.

function reply(over: Partial<RawPageResult> = {}): RawPageResult {
  const html = over.html ?? '<html><body><h1>Page</h1></body></html>'
  return {
    ok: true,
    requestedUrl: 'https://u.test/',
    finalUrl: 'https://u.test/',
    status: 200,
    contentType: 'text/html',
    html,
    truncated: false,
    bytes: html.length,
    redirectChain: [],
    reason: null,
    durationMs: 4,
    ...over,
  }
}

const GONE = reply({ ok: false, status: 404, html: '', bytes: 0, reason: 'The site returned HTTP 404.' })

const LIMITS: CrawlLimits = {
  maxPages: 6,
  maxProductPages: 20,
  maxCategoryPages: 5,
  maxBytes: 15 * 1024 * 1024,
  maxDepth: 3,
}

afterEach(() => vi.restoreAllMocks())

describe('a category page whose products exist only in alt text', () => {
  // The real Unicare shape, reduced: a category page that classifies as a
  // category, publishes no product link, and names four products in alt text.
  const CATEGORY =
    '<html><head><title>Bathroom | Unicare Malta</title></head><body>' +
    '<img src="/i/logo.png" alt="Unicare Malta">' +
    '<img src="/m/RS972XX.jpg" alt="GRAB RAIL">' +
    '<img src="/m/H3301.jpg" alt="GRAB RAIL LOOPED">' +
    '<p>No results found</p></body></html>'

  it('records the products it names, though no product page exists', async () => {
    vi.spyOn(pageFetch, 'fetchPageRaw').mockImplementation(async (url: string) => {
      if (url.includes('probe-404') || url.endsWith('.xml') || url.endsWith('robots.txt')) {
        return { ...GONE, requestedUrl: url, finalUrl: url }
      }
      const r = reply({ html: CATEGORY })
      return { ...r, requestedUrl: url, finalUrl: url }
    })

    const r = await crawlSite('https://u.test/products/bathroom', LIMITS)
    const page = r.pages.find((p) => p.outcome === 'fetched')!
    const names = page.observations.filter((o) => /^catalog\.entry\.\d+\.name$/.test(o.field)).map((o) => o.value)

    expect(r.stats.productPages).toBe(0)
    expect(names).toEqual(['GRAB RAIL', 'GRAB RAIL LOOPED'])
    expect(r.stats.catalogEntries).toBeGreaterThanOrEqual(2)
  })

  it('keeps the file name labelled as a file name, never as a product code', async () => {
    vi.spyOn(pageFetch, 'fetchPageRaw').mockImplementation(async (url: string) => {
      if (url.includes('probe-404') || url.endsWith('.xml') || url.endsWith('robots.txt')) {
        return { ...GONE, requestedUrl: url, finalUrl: url }
      }
      const r = reply({ html: CATEGORY })
      return { ...r, requestedUrl: url, finalUrl: url }
    })

    const r = await crawlSite('https://u.test/products/bathroom', LIMITS)
    const all = r.pages.flatMap((p) => p.observations)
    expect(all.some((o) => o.field === 'catalog.entry.0.imageFileName' && o.value === 'RS972XX.jpg')).toBe(true)
    // The line that must never be crossed.
    expect(all.some((o) => o.field === 'product.sku' && o.status === 'observed')).toBe(false)
  })
})
