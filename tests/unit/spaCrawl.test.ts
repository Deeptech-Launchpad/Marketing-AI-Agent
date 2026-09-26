import { afterEach, describe, expect, it, vi } from 'vitest'
import { crawlSite, type CrawlLimits } from '../../src/websiteaudit/crawler.js'
import { extractRouteUrls, firstPartyAssetUrls, looksLikeAppShell } from '../../src/research/appShell.js'
import * as pageFetch from '../../src/research/pageFetch.js'
import type { RawPageResult } from '../../src/research/pageFetch.js'

// A CATALOGUE THE CRAWLER COULD NOT SEE.
//
// Some real company sites render themselves in the browser. The server sends
// one empty <div id="root"> and a script — 640 bytes — so the crawler found no
// links, fetched one page, and the audit concluded "1 page fetched, 0 product
// pages" about a company with hundreds of real products.
//
// That conclusion was about our reading, not about their catalogue. The routes
// exist; they are declared as string literals inside the bundle the shell
// loads, and that bundle is served by the company's own host.
//
// So a page that turns out to be a shell now has its OWN same-origin assets
// read as text, and the paths they declare are queued as CANDIDATES. The word
// candidate is the whole design: each one is still fetched and classified on
// its own content, exactly like a URL found in an anchor. Nothing here decides
// that a path is a product, and nothing is executed.
//
// WHAT IS BOUNDED, and why each bound is there:
//   · same-origin only — a CDN or analytics bundle is not the company speaking
//   · at most three assets PER RUN — a site of shells must not become a crawl
//     of its own bundles
//   · the same guarded transport — SSRF revalidation, redirect cap, timeout
//     and byte ceiling all still apply, because there is no second HTTP client

const LIMITS: CrawlLimits = {
  maxPages: 12,
  maxProductPages: 20,
  maxCategoryPages: 5,
  maxBytes: 15 * 1024 * 1024,
  maxDepth: 3,
}

function reply(over: Partial<RawPageResult> = {}): RawPageResult {
  const html = over.html ?? '<html><body><h1>Page</h1></body></html>'
  return {
    ok: true,
    requestedUrl: 'https://acme.test/',
    finalUrl: 'https://acme.test/',
    status: 200,
    contentType: 'text/html',
    html,
    truncated: false,
    bytes: html.length,
    redirectChain: [],
    reason: null,
    durationMs: 3,
    ...over,
  }
}

const GONE = reply({ ok: false, status: 404, html: '', bytes: 0, reason: 'The site returned HTTP 404.' })

/** Records every URL asked for, so bounds and safety can be asserted. */
let asked: string[] = []

function stub(responder: (url: string) => RawPageResult) {
  asked = []
  return vi.spyOn(pageFetch, 'fetchPageRaw').mockImplementation(async (url: string) => {
    asked.push(url)
    const r = responder(url)
    return { ...r, requestedUrl: url, finalUrl: r.finalUrl ?? url }
  })
}

/** The real shape: one mount point and one module script, nothing else. */
const SHELL =
  '<!doctype html><html lang="en"><head><meta name="description" content="Premium taps." />' +
  '<title>Acme</title><script type="module" crossorigin src="/assets/index-9v7InpYE.js"></script>' +
  '<link rel="stylesheet" href="/assets/index.css"></head><body><div id="root"></div></body></html>'

/** A bundle declaring routes the way a router actually does. */
const BUNDLE =
  'const R=[{path:"/products"},{path:"/products/p/bath-board-steel"},' +
  '{path:"/products/p/grab-rail-steel"},{path:"/contact"},{path:"/about"}];' +
  'const A="/assets/logo.png",B="/api/cart",C="/products/:slug";'

const PDP = (name: string) =>
  `<html><head><title>${name}</title>` +
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    sku: 'SKU-1',
    offers: { '@type': 'Offer', price: '49.00', priceCurrency: 'EUR', availability: 'InStock' },
  })}</script></head>` +
  `<body><h1>${name}</h1><p>A stainless steel fitting for bathrooms.</p>` +
  `<img src="/i/${name.replace(/\s+/g, '-')}.jpg" alt="${name}"><button>Add to cart</button></body></html>`

afterEach(() => vi.restoreAllMocks())

// ── The shell itself ──────────────────────────────────────────────────────

describe('recognising a client-rendered shell', () => {
  it('recognises one', () => {
    expect(looksLikeAppShell(SHELL)).toBe(true)
  })

  it('does not mistake a small real page for one', () => {
    const small =
      '<html><body><h1>Acme Supplies</h1><p>Fasteners since 1974 across the south west of England.</p>' +
      '<a href="/products">Products</a><a href="/about">About</a><script src="/a.js"></script></body></html>'
    expect(looksLikeAppShell(small)).toBe(false)
  })

  it('takes only the company own same-origin assets', () => {
    expect(firstPartyAssetUrls(SHELL, 'https://acme.test/')).toEqual([
      'https://acme.test/assets/index-9v7InpYE.js',
    ])
  })

  it('ignores a third-party bundle entirely', () => {
    const mixed =
      '<script src="https://cdn.other.test/x.js"></script>' +
      '<script src="https://www.googletagmanager.com/gtag/js"></script>'
    expect(firstPartyAssetUrls(mixed, 'https://acme.test/')).toEqual([])
  })
})

// ── Routes out of the bundle ──────────────────────────────────────────────

describe('reading the routes an application declares', () => {
  const routes = extractRouteUrls(BUNDLE, 'https://acme.test/')

  it('finds the product and category paths', () => {
    expect(routes).toContain('https://acme.test/products')
    expect(routes).toContain('https://acme.test/products/p/bath-board-steel')
    expect(routes).toContain('https://acme.test/products/p/grab-rail-steel')
  })

  it('skips assets, API plumbing and route templates', () => {
    expect(routes).not.toContain('https://acme.test/assets/logo.png')
    expect(routes).not.toContain('https://acme.test/api/cart')
    // "/products/:slug" is an instruction for building a URL, not a page.
    // Checked on the PATH: every URL contains a colon in "https:".
    const paths = routes.map((r) => new URL(r).pathname)
    expect(paths.some((p) => p.includes(':'))).toBe(false)
    expect(paths).not.toContain('/products/:slug')
  })

  it('stays on the company own origin', () => {
    const cross = 'a("https://evil.test/products/p/x");b("https://acme.test/products/p/y")'
    expect(extractRouteUrls(cross, 'https://acme.test/')).toEqual(['https://acme.test/products/p/y'])
  })

  it('is bounded', () => {
    const many = Array.from({ length: 500 }, (_, i) => `"/p${i}"`).join(',')
    expect(extractRouteUrls(many, 'https://acme.test/', 20)).toHaveLength(20)
  })

  it('finds nothing in a bundle that declares nothing', () => {
    expect(extractRouteUrls('const x=1;let y=x+2;', 'https://acme.test/')).toEqual([])
  })
})

// ── The crawl, end to end ─────────────────────────────────────────────────

describe('a site whose products exist only in its own JavaScript', () => {
  const serve = () =>
    stub((url) => {
      if (url.includes('probe-404') || url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      if (url.endsWith('/assets/index-9v7InpYE.js')) {
        return reply({ contentType: 'application/javascript', html: BUNDLE })
      }
      if (url.includes('/products/p/')) {
        return reply({ html: PDP(url.split('/').pop()!.replace(/-/g, ' ')) })
      }
      if (url.endsWith('/products')) {
        return reply({ html: '<html><body><h1>All products</h1></body></html>' })
      }
      // Every HTML page on this site is the same shell.
      return reply({ html: SHELL })
    })

  it('finds the product pages the markup never mentions', async () => {
    serve()
    const r = await crawlSite('https://acme.test/', LIMITS)

    expect(r.stats.productPages).toBeGreaterThan(0)
    expect(r.pages.map((p) => p.requestedUrl)).toContain('https://acme.test/products/p/bath-board-steel')
  })

  it('was one page and no products before the bundle was read', async () => {
    // The same site with the bundle unreadable: the honest previous outcome.
    stub((url) => {
      if (url.includes('probe-404') || url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      if (url.endsWith('.js')) return GONE
      return reply({ html: SHELL })
    })
    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.stats.productPages).toBe(0)
    expect(r.stats.pagesFetched).toBe(1)
  })

  it('records where each product page was discovered', async () => {
    serve()
    const r = await crawlSite('https://acme.test/', LIMITS)
    const pdp = r.pages.find((p) => p.requestedUrl.includes('/products/p/bath-board-steel'))!
    expect(pdp.typeSignals[0]).toMatch(/Discovered via the site's own JavaScript/)
    expect(pdp.typeSignals[0]).toContain('/assets/index-9v7InpYE.js')
  })

  it('reports the assets it had to read', async () => {
    serve()
    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.stats.assetsRead).toEqual(['https://acme.test/assets/index-9v7InpYE.js'])
  })

  it('reads at most three assets however many shells it meets', async () => {
    stub((url) => {
      if (url.includes('probe-404') || url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      if (url.endsWith('.js')) return reply({ contentType: 'application/javascript', html: '"/a","/b","/c"' })
      // Every page is a shell referencing a DIFFERENT bundle.
      return reply({
        html: SHELL.replace('index-9v7InpYE.js', `b${Math.random().toString(36).slice(2, 6)}.js`),
      })
    })
    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.stats.assetsRead.length).toBeLessThanOrEqual(3)
    expect(asked.filter((u) => u.endsWith('.js')).length).toBeLessThanOrEqual(3)
  })

  it('ranks a product detail path above the category and the contact page', async () => {
    serve()
    const r = await crawlSite('https://acme.test/', LIMITS)
    const order = r.pages.map((p) => p.requestedUrl)
    const pdp = order.findIndex((u) => u.includes('/products/p/'))
    const contact = order.findIndex((u) => u.endsWith('/contact'))
    expect(pdp).toBeGreaterThan(-1)
    if (contact > -1) expect(pdp).toBeLessThan(contact)
  })

  it('verifies the product on the page rather than trusting the URL', async () => {
    serve()
    const r = await crawlSite('https://acme.test/', LIMITS)
    const pdp = r.pages.find((p) => p.pageType === 'product')!
    const names = pdp.observations.filter((o) => o.field === 'product.name' && o.status === 'observed')
    expect(names.length).toBeGreaterThan(0)
    expect(pdp.typeSignals.some((s) => /declares @type Product/i.test(s))).toBe(true)
  })

  it('never fetches an asset off the company own origin', async () => {
    stub((url) => {
      if (url.includes('probe-404') || url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      if (url.endsWith('.js')) return reply({ contentType: 'application/javascript', html: BUNDLE })
      return reply({
        html: SHELL.replace(
          'src="/assets/index-9v7InpYE.js"',
          'src="https://cdn.evil.test/pwn.js"',
        ),
      })
    })
    await crawlSite('https://acme.test/', LIMITS)
    expect(asked.some((u) => u.includes('evil.test'))).toBe(false)
  })

  it('goes through the shared guarded transport, so SSRF protection still applies', async () => {
    // Not re-testing the guard — asserting that the crawler owns no second
    // HTTP client, by having the shared one refuse and the crawl carry it.
    stub((url) => {
      if (url.includes('probe-404') || url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      if (url.endsWith('.js')) {
        return reply({ ok: false, status: null, html: '', bytes: 0, reason: 'That address is not permitted.' })
      }
      return reply({ html: SHELL })
    })
    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.stats.assetsRead).toEqual([])
    expect(r.stats.productPages).toBe(0)
  })
})

// ── The server-rendered path is untouched ─────────────────────────────────

describe('a site that renders on the server is unaffected', () => {
  it('reads no assets at all', async () => {
    stub((url) => {
      if (url.includes('probe-404') || url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      if (url.includes('/products/p/')) return reply({ html: PDP('Bath Board Steel') })
      return reply({
        html: '<html><body><h1>Acme Supplies</h1><p>Fasteners since 1974, supplied across the region.</p>' +
          '<a href=/products/p/bath-board-steel>Bath Board Steel</a></body></html>',
      })
    })
    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.stats.assetsRead).toEqual([])
    expect(asked.some((u) => u.endsWith('.js'))).toBe(false)
    // …and the unquoted href is still followed.
    expect(r.stats.productPages).toBe(1)
  })

  it('says so honestly when a readable site genuinely publishes no product', async () => {
    stub((url) => {
      if (url.includes('probe-404') || url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      return reply({
        html: '<html><body><h1>Acme Consulting</h1><p>We advise on procurement strategy for industrial buyers.</p>' +
          '<a href="/about">About</a></body></html>',
      })
    })
    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.stats.productPages).toBe(0)
    expect(r.stats.assetsRead).toEqual([])
    expect(r.homepageReachable).toBe(true)
  })
})

// ── A SITE THAT SERVES ONE RESPONSE FOR EVERY URL ────────────────────────
//
// The soft-404 probe learns what a site does with an unknown path so copies of
// that body can be discarded. On a site that answers EVERY path with the same
// response, the probe's fingerprint equals the HOMEPAGE's fingerprint — and
// the homepage was discarded along with everything else.
//
// The cost was not a missing page, it was a false statement. Nothing was
// examined, no observation was recorded, and the run then reported "1 page was
// read and none names a product" about a catalogue it had never looked at. One
// real company's site — a single-response catch-all serving 16,545 bytes of
// real content — produced exactly that.
//
// Whatever else is true, the body a company serves at its own root is the page
// it published there. It is read. That the site also serves it for unknown
// paths is kept as a finding about the site.

describe('the start URL is never discarded as a soft 404', () => {
  const SAME_EVERYWHERE =
    '<html><head><title>Acme Packaging</title></head><body><h1>Acme Packaging</h1>' +
    '<p>Packaging, paper and facility solutions for industrial buyers.</p>' +
    '<a href="/products/p/carton-sealer">Carton Sealer</a></body></html>'

  it('reads the homepage of a site that answers every path identically', async () => {
    stub((url) => {
      if (url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      // Probe, homepage, everything: one identical response.
      return reply({ html: SAME_EVERYWHERE })
    })

    const r = await crawlSite('https://acme.test/', LIMITS)
    const home = r.pages.find((p) => p.requestedUrl === 'https://acme.test/')!
    expect(home.outcome).toBe('fetched')
    expect(home.observations.length).toBeGreaterThan(0)
    expect(home.observations.some((o) => o.field === 'page.title' && o.value === 'Acme Packaging')).toBe(true)
  })

  it('still records that the site serves that body for unknown paths', async () => {
    stub((url) => {
      if (url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      return reply({ html: SAME_EVERYWHERE })
    })

    const r = await crawlSite('https://acme.test/', LIMITS)
    const home = r.pages.find((p) => p.requestedUrl === 'https://acme.test/')!
    expect(home.typeSignals.some((s) => /soft-404s/i.test(s))).toBe(true)
  })

  it('still discards a DEEPER page that matches the not-found body', async () => {
    // The exemption is the start URL only. Everything below it is still
    // checked, which is the whole point of the probe.
    stub((url) => {
      if (url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      if (url === 'https://acme.test/') {
        return reply({
          html: '<html><head><title>Acme</title></head><body><h1>Acme</h1>' +
            '<p>We supply packaging to industrial buyers across the region.</p>' +
            '<a href="/nowhere">Nowhere</a></body></html>',
        })
      }
      // The probe and every other path share one body.
      return reply({ html: '<html><body><h1>Page not found</h1></body></html>' })
    })

    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.pages.find((p) => p.requestedUrl === 'https://acme.test/')!.outcome).toBe('fetched')
    const deeper = r.pages.find((p) => p.requestedUrl.endsWith('/nowhere'))
    expect(deeper?.outcome).toBe('soft_404')
    expect(r.stats.soft404s).toBe(1)
  })

  it('is unaffected on a site with normal 404 behaviour', async () => {
    stub((url) => {
      if (url.includes('probe-404') || url.endsWith('robots.txt') || url.endsWith('.xml')) return GONE
      return reply({ html: SAME_EVERYWHERE })
    })

    const r = await crawlSite('https://acme.test/', LIMITS)
    expect(r.stats.soft404s).toBe(0)
    expect(r.pages.find((p) => p.requestedUrl === 'https://acme.test/')!.outcome).toBe('fetched')
  })
})
