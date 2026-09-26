import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverSitemapUrls } from '../../src/websiteaudit/sitemap.js'
import { crawlSite, type CrawlLimits } from '../../src/websiteaudit/crawler.js'
import * as pageFetch from '../../src/research/pageFetch.js'
import type { RawPageResult } from '../../src/research/pageFetch.js'

// THE SITE'S OWN INDEX OF ITSELF.
//
// A link-following crawl reaches only what the homepage links to. On a
// catalogue the products are three clicks down behind a grid, and a bounded
// crawl spends its whole page budget on the first level — which is how a
// company with a full catalogue was audited as having no products.
//
// A sitemap is the company TELLING us where its pages are. It is read as
// evidence like everything else: URLs are queued, never trusted, and each one
// is still fetched and classified on its own content.
//
// The transport is stubbed, so these run offline. What is NOT stubbed is which
// transport is used: the same fetchPageRaw as everything else, which is what
// keeps the SSRF guard, the redirect cap, the timeout and the byte cap shared.

function reply(over: Partial<RawPageResult> = {}): RawPageResult {
  const html = over.html ?? ''
  return {
    ok: true,
    requestedUrl: 'https://acme.test/',
    finalUrl: 'https://acme.test/',
    status: 200,
    contentType: 'application/xml',
    html,
    truncated: false,
    bytes: html.length,
    redirectChain: [],
    reason: null,
    durationMs: 3,
    ...over,
  }
}

const MISSING = reply({ ok: false, status: 404, html: '', reason: 'The site returned HTTP 404.' })

function stub(responder: (url: string) => RawPageResult) {
  return vi.spyOn(pageFetch, 'fetchPageRaw').mockImplementation(async (url: string) => {
    const r = responder(url)
    return { ...r, requestedUrl: url, finalUrl: r.finalUrl ?? url }
  })
}

const urlset = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`

afterEach(() => vi.restoreAllMocks())

// ── 1. Reading it ─────────────────────────────────────────────────────────

describe('reading a sitemap', () => {
  it('reads /sitemap.xml and returns its URLs in file order', async () => {
    stub((url) =>
      url.endsWith('/sitemap.xml')
        ? reply({ html: urlset('https://acme.test/p/m8', 'https://acme.test/p/m10') })
        : MISSING,
    )
    const r = await discoverSitemapUrls('https://acme.test')
    expect(r.urls).toEqual(['https://acme.test/p/m8', 'https://acme.test/p/m10'])
    expect(r.sourcesRead).toEqual(['https://acme.test/sitemap.xml'])
  })

  it('follows a Sitemap: directive in robots.txt', async () => {
    stub((url) => {
      if (url.endsWith('/robots.txt')) {
        return reply({ contentType: 'text/plain', html: 'User-agent: *\nSitemap: https://acme.test/sm/products.xml\n' })
      }
      if (url.endsWith('/sm/products.xml')) return reply({ html: urlset('https://acme.test/p/bolt') })
      return MISSING
    })
    const r = await discoverSitemapUrls('https://acme.test')
    expect(r.sourcesRead).toContain('https://acme.test/sm/products.xml')
    expect(r.urls).toEqual(['https://acme.test/p/bolt'])
  })

  it('follows one level of sitemap index', async () => {
    stub((url) => {
      if (url.endsWith('/sitemap.xml')) {
        return reply({
          html:
            '<sitemapindex><sitemap><loc>https://acme.test/sm/a.xml</loc></sitemap>' +
            '<sitemap><loc>https://acme.test/sm/b.xml</loc></sitemap></sitemapindex>',
        })
      }
      if (url.endsWith('/sm/a.xml')) return reply({ html: urlset('https://acme.test/p/1') })
      if (url.endsWith('/sm/b.xml')) return reply({ html: urlset('https://acme.test/p/2') })
      return MISSING
    })
    const r = await discoverSitemapUrls('https://acme.test')
    expect(r.urls).toEqual(['https://acme.test/p/1', 'https://acme.test/p/2'])
  })

  it('unescapes and de-duplicates', async () => {
    stub((url) =>
      url.endsWith('/sitemap.xml')
        ? reply({
            html: urlset('https://acme.test/s?a=1&amp;b=2', 'https://acme.test/p/1', 'https://acme.test/p/1'),
          })
        : MISSING,
    )
    const r = await discoverSitemapUrls('https://acme.test')
    expect(r.urls).toEqual(['https://acme.test/s?a=1&b=2', 'https://acme.test/p/1'])
  })
})

// ── 2. Refusing to be led astray ──────────────────────────────────────────

describe('what a sitemap may not do', () => {
  it('drops URLs on another host', async () => {
    stub((url) =>
      url.endsWith('/sitemap.xml')
        ? reply({ html: urlset('https://acme.test/p/1', 'https://somewhere-else.test/p/2') })
        : MISSING,
    )
    const r = await discoverSitemapUrls('https://acme.test')
    expect(r.urls).toEqual(['https://acme.test/p/1'])
  })

  it('rejects a 404 page served at /sitemap.xml', async () => {
    stub((url) =>
      url.endsWith('/sitemap.xml')
        ? reply({ contentType: 'text/html', html: '<html><body>Page not found</body></html>' })
        : MISSING,
    )
    const r = await discoverSitemapUrls('https://acme.test')
    expect(r.urls).toEqual([])
    expect(r.note).toMatch(/not a sitemap/i)
  })

  it('reports the absence of a sitemap as a finding, not as silence', async () => {
    stub(() => MISSING)
    const r = await discoverSitemapUrls('https://acme.test')
    expect(r.sourcesRead).toEqual([])
    expect(r.note).toMatch(/publishes no readable sitemap/i)
    expect(r.note).toMatch(/its absence is itself a finding/i)
  })

  it('is bounded, so a huge index cannot become an unbounded crawl', async () => {
    const spy = stub((url) => {
      if (url.endsWith('/sitemap.xml')) {
        return reply({
          html:
            '<sitemapindex>' +
            Array.from({ length: 50 }, (_, i) => `<sitemap><loc>https://acme.test/sm/${i}.xml</loc></sitemap>`).join('') +
            '</sitemapindex>',
        })
      }
      return reply({ html: urlset('https://acme.test/p/x') })
    })
    await discoverSitemapUrls('https://acme.test')
    // robots.txt + sitemap.xml + at most three children.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6)
  })
})

// ── 3. What the crawler does with it ──────────────────────────────────────

const LIMITS: CrawlLimits = {
  maxPages: 6,
  maxProductPages: 20,
  maxCategoryPages: 5,
  maxBytes: 15 * 1024 * 1024,
  maxDepth: 3,
}

describe('the crawler uses the sitemap to reach pages nothing links to', () => {
  it('fetches a product page the homepage never links to', async () => {
    stub((url) => {
      if (url.includes('probe-404')) return MISSING
      if (url.endsWith('/sitemap.xml')) return reply({ html: urlset('https://acme.test/p/hidden-bolt') })
      if (url.endsWith('/robots.txt')) return MISSING
      if (url === 'https://acme.test/') {
        return reply({ contentType: 'text/html', html: '<html><body><a href="/about">About</a></body></html>' })
      }
      return reply({ contentType: 'text/html', html: `<html><body><h1>${url}</h1></body></html>` })
    })

    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.pages.map((p) => p.requestedUrl)).toContain('https://acme.test/p/hidden-bolt')
    expect(r.sitemap.urls).toEqual(['https://acme.test/p/hidden-bolt'])
  })

  it('carries the note back even when the site publishes none', async () => {
    stub((url) =>
      url.includes('probe-404') || url.endsWith('.xml') || url.endsWith('robots.txt')
        ? MISSING
        : reply({ contentType: 'text/html', html: '<html><body>hi</body></html>' }),
    )
    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.sitemap.note).toMatch(/publishes no readable sitemap/i)
  })
})
