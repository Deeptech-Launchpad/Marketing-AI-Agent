import { describe, expect, it, vi } from 'vitest'

// PROSPECT DISCOVERY — ONE COMPANY, ONE GENUINE PRODUCT, ONE ANSWER.
//
// Not a website audit. For each company: open its own website, find ONE
// genuine individual product page (never a family, category, solution,
// article, FAQ or general page), analyse that product's information, and say
// whether our service is genuinely needed — and why.

vi.mock('../../src/platform/db.js', () => ({ prisma: {} }))
// The sitemap step reads robots.txt and sitemap.xml through the shared
// transport; none of these test sites publish one.
const sitemapFetches: string[] = []
vi.mock('../../src/research/pageFetch.js', () => ({
  fetchPageRaw: vi.fn(async (url: string) => {
    sitemapFetches.push(url)
    return { ok: false, requestedUrl: url, finalUrl: url, status: 404, html: '', reason: 'HTTP 404' }
  }),
}))

const { analyseCompanyWebsite, analyseProductPage, decideServiceNeed, genuineProduct, sitemapCandidates } = await import(
  '../../src/prospects/productPageAnalysis.js'
)

const SITE = 'https://acmesafety.test/'
const PRODUCT = 'https://acmesafety.test/products/titan-hard-hat-x200'

const page = (url: string, html: string, status = 200) => ({
  ok: status < 400,
  requestedUrl: url,
  finalUrl: url,
  status,
  contentType: 'text/html',
  html,
  truncated: false,
  bytes: html.length,
  redirectChain: [],
  reason: status < 400 ? null : `HTTP ${status}`,
  durationMs: 1,
})

/** A genuine product whose information is thin: one-line description, two attributes. */
const THIN_PRODUCT_HTML = `<html><head><title>Titan Hard Hat X200 | Acme Safety Co</title></head><body>
<nav><a href="/">Home</a></nav>
<h1>Titan Hard Hat X200</h1>
<p>SKU: X200-WHT</p>
<table><tr><th>Colour</th><td>White</td></tr><tr><th>Shell material</th><td>HDPE</td></tr></table>
<button>Add to cart</button><span>$24.99</span>
</body></html>`

/** The same product, presented completely in the company's own style — no schema, no price. */
const COMPLETE_PRODUCT_HTML = `<html><head><title>Titan Hard Hat X200 | Acme Safety Co</title></head><body>
<h1>Titan Hard Hat X200</h1>
<p>The Titan X200 is a vented Type I hard hat built for construction and utility crews. Its HDPE shell and six-point ratchet suspension spread impact across the head. It accepts earmuffs and face shields through universal accessory slots. It is certified to ANSI Z89.1 Type I Class C.</p>
<table>
<tr><th>Model</th><td>X200</td></tr><tr><th>Brand</th><td>Titan</td></tr><tr><th>Colour</th><td>White</td></tr>
<tr><th>Shell material</th><td>HDPE</td></tr><tr><th>Suspension</th><td>6-point ratchet</td></tr>
<tr><th>Standard</th><td>ANSI Z89.1 Type I Class C</td></tr><tr><th>Weight</th><td>350 g</td></tr><tr><th>Category</th><td>Head protection</td></tr>
</table>
</body></html>`

const HOME_HTML = `<html><head><title>Acme Safety Co</title></head><body>
<a href="/about">About us</a>
<a href="/products/titan-hard-hat-x200">Titan Hard Hat X200</a>
<a href="/contact">Contact</a></body></html>`

function router(pages: Record<string, ReturnType<typeof page>>) {
  const calls: string[] = []
  const fetch = vi.fn(async (url: string, _opts?: { as?: string }) => {
    calls.push(url)
    return pages[url] ?? page(url, '', 404)
  })
  return { fetch, calls }
}

describe('finding one genuine product on the company’s own website', () => {
  it('opens the homepage and follows the product link the site itself publishes', async () => {
    const { fetch, calls } = router({ [SITE]: page(SITE, HOME_HTML), [PRODUCT]: page(PRODUCT, THIN_PRODUCT_HTML) })

    const r = await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'Safety companies', fetch })

    expect(r.status).toBe('analysed')
    expect(r.product?.url).toBe(PRODUCT)
    expect(r.product?.name).toBe('Titan Hard Hat X200')
    expect(calls[0]).toBe(SITE)
  })

  it('analyses one product only, and opens nothing after it', async () => {
    const OTHER = 'https://acmesafety.test/products/titan-hard-hat-x300'
    const home = HOME_HTML.replace('</body>', '<a href="/products/titan-hard-hat-x300">X300</a></body>')
    const { fetch, calls } = router({
      [SITE]: page(SITE, home),
      [PRODUCT]: page(PRODUCT, THIN_PRODUCT_HTML),
      [OTHER]: page(OTHER, THIN_PRODUCT_HTML.replace(/X200/g, 'X300')),
    })

    await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch })

    expect(calls.filter((u) => u.includes('/products/'))).toHaveLength(1)
  })

  it('goes down from a family page to one of the products it lists', async () => {
    const FAMILY = 'https://acmesafety.test/products/hard-hats'
    const family = `<html><head><title>Hard Hats | Acme</title></head><body><h1>Hard Hats</h1>
      <p>Our range of hard hats protects crews on every site.</p>
      <a class="product-card" href="/products/titan-hard-hat-x200">Titan X200</a></body></html>`
    const home = `<html><body><a href="/products/hard-hats">Hard hats</a></body></html>`
    const { fetch } = router({ [SITE]: page(SITE, home), [FAMILY]: page(FAMILY, family), [PRODUCT]: page(PRODUCT, THIN_PRODUCT_HTML) })

    const r = await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch })

    expect(r.status).toBe('analysed')
    expect(r.product?.url).toBe(PRODUCT)
  })

  it('never takes a solution, article or FAQ page for the product', async () => {
    const SOLUTION = 'https://acmesafety.test/solutions/connected-safety'
    const home = `<html><body><a href="/solutions/connected-safety">Connected Safety</a></body></html>`
    const { fetch, calls } = router({ [SITE]: page(SITE, home), [SOLUTION]: page(SOLUTION, THIN_PRODUCT_HTML) })

    const r = await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch })

    expect(calls).not.toContain(SOLUTION)
    expect(r.status).toBe('no_product_page')
  })

  it('marks a website with no genuine individual product page accordingly', async () => {
    const LIST = 'https://acmesafety.test/products/all'
    const listing = `<html><head><title>All products</title></head><body><h1>All products</h1>
      ${Array.from({ length: 8 }, (_, i) => `<div class="product-card"><a href="/item-${i}">Item ${i}</a><span>$${i + 10}.00</span><button>Add to cart</button></div>`).join('')}
      </body></html>`
    const home = `<html><body><a href="/products/all">Products</a></body></html>`
    const { fetch } = router({ [SITE]: page(SITE, home), [LIST]: page(LIST, listing) })

    const r = await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch })

    expect(r.status).toBe('no_product_page')
    expect(r.statusReason).toMatch(/No genuine individual product page/)
    expect(r.product).toBeNull()
    expect(r.serviceNeed).toBe('not_assessed')
  })

  it('reports an unreachable website as such', async () => {
    const { fetch } = router({ [SITE]: page(SITE, '', 503) })

    const r = await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch })

    expect(r.status).toBe('website_unreachable')
    expect(r.statusReason).toMatch(/HTTP 503/)
    expect(r.whyNeeded).toBeNull()
  })

  it('stays inside its page budget and never leaves the company’s site', async () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/products/thing-${i}">Thing ${i}</a>`).join('')
    const offsite = '<a href="https://marketplace.test/products/titan-x200">Marketplace</a>'
    const { fetch, calls } = router({ [SITE]: page(SITE, `<html><body>${links}${offsite}</body></html>`) })
    sitemapFetches.length = 0

    await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch })

    // Pages opened; sitemap files have their own small budget.
    expect(fetch.mock.calls.filter((c) => !(c as unknown[])[1]).length).toBeLessThanOrEqual(10)
    expect(fetch.mock.calls.filter((c) => (c as unknown[])[1]).length).toBeLessThanOrEqual(5)
    expect([...calls, ...sitemapFetches].every((u) => u.startsWith('https://acmesafety.test/'))).toBe(true)
  })
})

describe('what counts as ONE genuine individual product', () => {
  it('accepts a page with a product code', () => {
    expect(genuineProduct(THIN_PRODUCT_HTML, PRODUCT).ok).toBe(true)
  })

  it('rejects a product-family page that names a line but no specific item', () => {
    const family = `<html><head><title>Heat Protective Clothing</title></head><body><h1>Heat Protective Clothing</h1>
      <p>Garments that protect against radiant heat and flame in foundries and furnace work.</p></body></html>`
    const r = genuineProduct(family, 'https://acmesafety.test/products/heat-protective-clothing/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/product-family page/)
  })

  it('rejects pages in solution, article, FAQ and other non-product sections', () => {
    for (const path of ['solutions/connected-safety', 'blog/choosing-a-hard-hat-x200', 'faq/hard-hats', 'resources/x200-guide']) {
      expect(genuineProduct(THIN_PRODUCT_HTML, `https://acmesafety.test/${path}`).ok).toBe(false)
    }
  })

  it('rejects a page that declares itself an article or FAQ', () => {
    const faq = `<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script>`
    expect(genuineProduct(faq + THIN_PRODUCT_HTML, PRODUCT).ok).toBe(false)
  })
})

describe('analysing that one product’s information', () => {
  const thin = analyseProductPage({ html: THIN_PRODUCT_HTML, url: PRODUCT, httpStatus: 200, websiteUrl: SITE })

  it('reads the attributes and their values off the page, with where each came from', () => {
    const names = thin.product!.attributes.map((a) => `${a.name}=${a.value}`)
    expect(names).toContain('Colour=White')
    expect(names).toContain('Shell material=HDPE')
    expect(thin.product!.attributes.find((a) => a.name === 'Colour')?.source).toBe('specification table')
  })

  it('names the gaps in the product’s information, most serious first', () => {
    expect(thin.gaps[0]!.severity).toBe('major')
    expect(thin.gaps.map((g) => g.title)).toContain('No product description')
    expect(thin.gaps.map((g) => g.title)).toContain('Attributes and values missing')
  })

  it('says our service is needed, why, and what the Marketing Agent should do next', () => {
    expect(thin.serviceNeed).toBe('needed')
    expect(thin.whyNeeded).toContain('Titan Hard Hat X200')
    expect(thin.recommendedActions.map((a) => a.title)).toContain('Write a complete product description')
    expect(thin.nextStep).toMatch(/^Contact this company/)
  })

  it('is not a website audit: no score, no SEO, no pricing check', () => {
    expect(JSON.stringify(thin)).not.toMatch(/\/100|canonical|Buying-Decision|discoverability/i)
    expect(thin.missingInformation.map((m) => m.label)).not.toContain('Price')
  })

  it('never invents a value the page did not publish', () => {
    expect(thin.product!.brand).toBeNull()
  })
})

describe('a product presented completely, in the company’s own style', () => {
  it('is not called a company in need — missing schema, price or barcode are not reasons on their own', () => {
    const r = analyseProductPage({ html: COMPLETE_PRODUCT_HTML, url: PRODUCT, httpStatus: 200, websiteUrl: SITE })
    expect(r.serviceNeed).toBe('not_needed')
    expect(r.gaps.every((g) => g.severity === 'minor')).toBe(true)
    expect(r.nextStep).toMatch(/^No action/)
  })

  it('finds a description kept in the site’s own layout rather than a declared field', () => {
    const html = COMPLETE_PRODUCT_HTML.replace('<p>', '<div class="pdp-copy">').replace('</p>', '</div>')
    const r = analyseProductPage({ html, url: PRODUCT, httpStatus: 200, websiteUrl: SITE })
    expect(r.gaps.map((g) => g.key)).not.toContain('description')
  })
})

describe('the service-need rule', () => {
  const g = (severity: 'major' | 'gap' | 'minor') => ({ key: 'k', severity, title: 't', detail: 'd' })

  it('is needed for a missing core, or two clear shortfalls', () => {
    expect(decideServiceNeed([g('major')])).toBe('needed')
    expect(decideServiceNeed([g('gap'), g('gap')])).toBe('needed')
  })

  it('is possible for one clear shortfall', () => {
    expect(decideServiceNeed([g('gap'), g('minor')])).toBe('possible')
  })

  it('is not needed when only minor points remain', () => {
    expect(decideServiceNeed([g('minor'), g('minor'), g('minor'), g('minor')])).toBe('not_needed')
  })
})

describe('the sitemap fallback', () => {
  it('considers products served from a bare slug, model-numbered ones first, and skips non-product pages', () => {
    const out = sitemapCandidates(
      [
        'https://acme.test/',
        'https://acme.test/about',
        'https://acme.test/contact',
        'https://acme.test/solutions/connected',
        'https://acme.test/gloves',
        'https://acme.test/skullerz-3215-breakaway-safety-strap',
        'https://acme.test/products/titan-hard-hat',
      ],
      'https://acme.test/',
    )
    expect(out[0]).toBe('https://acme.test/products/titan-hard-hat')
    expect(out[1]).toBe('https://acme.test/skullerz-3215-breakaway-safety-strap')
    expect(out).not.toContain('https://acme.test/')
    expect(out).not.toContain('https://acme.test/about')
    expect(out).not.toContain('https://acme.test/solutions/connected')
  })
})

describe('the product name', () => {
  it('uses the name the PDP check read when the page carries no name field, never the URL path', () => {
    const html = '<html><body><p>Just a spec sheet</p><table><tr><th>Colour</th><td>Red</td></tr></table></body></html>'
    const r = analyseProductPage({ html, url: PRODUCT, httpStatus: 200, websiteUrl: SITE, productName: 'Titan Hard Hat X200' })
    expect(r.product!.name).toBe('Titan Hard Hat X200')
  })

  it('drops the label punctuation a spec row carries', () => {
    const html = THIN_PRODUCT_HTML.replace('<th>Colour</th>', '<th>Colour:</th>')
    const r = analyseProductPage({ html, url: PRODUCT, httpStatus: 200, websiteUrl: SITE })
    expect(r.product!.attributes.map((a) => a.name)).toContain('Colour')
  })
})

describe('pages that feature products without being one', () => {
  it('rejects a promotion page', () => {
    const promo = THIN_PRODUCT_HTML.replace('<h1>Titan Hard Hat X200</h1>', '<h1>Titan Hard Hat X200</h1><h3>Get 5 free hard hats with purchase of a bundle</h3>')
    const r = genuineProduct(promo, PRODUCT, 'Titan Hard Hat X200')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/promotion/)
  })

  it('rejects a page comparing two models', () => {
    const r = genuineProduct(THIN_PRODUCT_HTML, 'https://acmesafety.test/products/x200-or-x300', 'Titan')
    expect(r.ok).toBe(false)
  })

  it('does not accept a model code in the address that the product’s own name does not carry', () => {
    const html = '<html><head><title>Blast with the Best | Acme</title></head><body><h1>Blast with the Best</h1><p>Great value.</p></body></html>'
    expect(genuineProduct(html, 'https://acmesafety.test/products/blast-88vx', 'Blast with the Best').ok).toBe(false)
  })
})

describe('the company’s own site', () => {
  it('steps from a country-chooser homepage to the company’s regional site', async () => {
    const GLOBAL = 'https://www.acme.test/global'
    const US = 'https://us.acme.test/'
    const US_PRODUCT = 'https://us.acme.test/products/titan-hard-hat-x200'
    const chooser = `<html><body><h1>Choose your country</h1><a href="https://us.acme.test/">United States</a><a href="https://uk.acme.test/">United Kingdom</a></body></html>`
    const usHome = `<html><body><a href="/products/titan-hard-hat-x200">Titan X200</a></body></html>`
    const { fetch } = router({ [GLOBAL]: page(GLOBAL, chooser), [US]: page(US, usHome), [US_PRODUCT]: page(US_PRODUCT, THIN_PRODUCT_HTML) })

    const r = await analyseCompanyWebsite({ websiteUrl: GLOBAL, objective: 'x', fetch })

    expect(r.status).toBe('analysed')
    expect(r.product?.url).toBe(US_PRODUCT)
    expect(r.pagesChecked.some((p) => /regional website opened/.test(p.outcome))).toBe(true)
  })

  it('never opens a PDF or an uploaded file as the product', async () => {
    const home = `<html><body><a href="/products/datasheet-x200.pdf">X200 datasheet</a><a href="/wp-content/uploads/x200.jpg">Photo</a></body></html>`
    const { fetch, calls } = router({ [SITE]: page(SITE, home) })

    await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch })

    expect(calls.some((u) => /\.pdf$|\.jpg$/.test(u))).toBe(false)
  })
})

describe('store record numbers and duplicate addresses', () => {
  it('accepts a store’s own product record number as one item', () => {
    const html = '<html><head><title>V-Gard C1 Hard Hat | Acme</title></head><body><h1>V-Gard C1 Hard Hat</h1><p>A hard hat.</p></body></html>'
    expect(genuineProduct(html, 'https://acme.test/Head/Hard-Hats/V-Gard-C1/p/000060003900001001', 'V-Gard C1 Hard Hat').ok).toBe(true)
  })

  it('does not open the same page twice because of a language parameter', async () => {
    const home = `<html><body><a href="/products/titan-hard-hat-x200">A</a><a href="/products/titan-hard-hat-x200?locale=en&default=1">B</a></body></html>`
    const { fetch, calls } = router({ [SITE]: page(SITE, home), [PRODUCT]: page(PRODUCT, THIN_PRODUCT_HTML) })

    await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch })

    expect(calls.filter((u) => u.includes('titan-hard-hat-x200'))).toHaveLength(1)
  })
})

describe('a website that blocks automated reading', () => {
  const INCAPSULA =
    '<html><head><script src="/_Incapsula_Resource?SWJIYLWA=1"></script></head><body><iframe>Request unsuccessful. Incapsula incident ID: 1</iframe></body></html>'

  it('is reported as blocked — never as having no product page — with the product link for Sales, and not retried', async () => {
    const MSC = 'https://msc.test/'
    const MSC_PRODUCT = 'https://msc.test/product/details/00222844'
    const home = `<html><body><a href="/product/details/00222844">Roloc disc</a><a href="/product/details/00222845">Other</a></body></html>`
    const { fetch, calls } = router({ [MSC]: page(MSC, home), [MSC_PRODUCT]: page(MSC_PRODUCT, INCAPSULA) })

    const r = await analyseCompanyWebsite({ websiteUrl: MSC, objective: 'x', fetch, read: null })

    expect(r.status).toBe('blocked')
    expect(r.statusReason).toMatch(/Incapsula bot protection/)
    expect(r.reviewUrl).toBe(MSC_PRODUCT)
    expect(r.serviceNeed).toBe('not_assessed')
    // It stopped at the wall rather than trying the next product.
    expect(calls.filter((u) => u.includes('/product/details/'))).toHaveLength(1)
  })

  it('recognises a blocked homepage', async () => {
    const { fetch } = router({ [SITE]: page(SITE, INCAPSULA) })
    const r = await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch, read: null })
    expect(r.status).toBe('blocked')
    expect(r.reviewUrl).toBeNull()
  })
})

describe('the product sitemap', () => {
  it('reads the product sitemap of a sitemap index first, and finds product pages listed after marketing pages', async () => {
    const { productSitemapUrls } = await import('../../src/prospects/productPageAnalysis.js')
    const xml: Record<string, string> = {
      'https://msc.test/robots.txt': 'User-agent: *\nSitemap: https://msc.test/sitemap_index.xml',
      'https://msc.test/sitemap_index.xml':
        '<sitemapindex><sitemap><loc>https://msc.test/sitemap-content.xml</loc></sitemap><sitemap><loc>https://msc.test/sitemap-products-1.xml</loc></sitemap></sitemapindex>',
      'https://msc.test/sitemap-products-1.xml':
        '<urlset><url><loc>https://msc.test/product/details/00222844</loc></url><url><loc>https://msc.test/product/details/00222845</loc></url></urlset>',
      'https://msc.test/sitemap-content.xml': '<urlset><url><loc>https://msc.test/products/innovation/floor-tape</loc></url></urlset>',
    }
    const fetch = vi.fn(async (url: string) => page(url, xml[url] ?? '', xml[url] ? 200 : 404))

    const r = await productSitemapUrls('https://msc.test', fetch)

    expect(r.products[0]).toBe('https://msc.test/product/details/00222844')
    expect(fetch.mock.calls.map((c) => c[0])).toContain('https://msc.test/sitemap-products-1.xml')
  })
})

describe('the verified text read', () => {
  it('keeps what the page states and drops what it does not', async () => {
    const { verifyRead } = await import('../../src/prospects/productReader.js')
    const pageText =
      'Titan Hard Hat X200. The Titan X200 is a vented hard hat built for construction crews working at height. Shell material: HDPE. Weight: 350 g.'
    const r = verifyRead(
      {
        description: 'The Titan X200 is a vented hard hat built for construction crews working at height.',
        attributes: [
          { name: 'Shell material', value: 'HDPE' },
          { name: 'Weight', value: '350 g' },
          { name: 'Colour', value: 'Blue' }, // not on the page
        ],
        featureBullets: ['Made on the moon'], // not on the page
      },
      pageText,
    )
    expect(r.description).toMatch(/^The Titan X200/)
    expect(r.attributes.map((a) => a.name)).toEqual(['Shell material', 'Weight'])
    expect(r.featureBullets).toEqual([])
    expect(r.dropped).toBe(2)
  })

  it('lets a description kept in a custom layout count, so no false "no description" is reported', () => {
    const html = THIN_PRODUCT_HTML
    const withoutRead = analyseProductPage({ html, url: PRODUCT, httpStatus: 200, websiteUrl: SITE })
    const withRead = analyseProductPage({
      html,
      url: PRODUCT,
      httpStatus: 200,
      websiteUrl: SITE,
      modelRead: {
        description: 'The Titan X200 is a vented hard hat for construction. It carries a six-point suspension. It is certified to ANSI Z89.1.',
        attributes: [
          { name: 'Suspension', value: '6-point' },
          { name: 'Standard', value: 'ANSI Z89.1' },
        ],
        featureBullets: [],
        dropped: 0,
      },
    })
    expect(withoutRead.gaps.map((g) => g.key)).toContain('description')
    expect(withRead.gaps.map((g) => g.key)).not.toContain('description')
    expect(withRead.product!.attributes.find((a) => a.name === 'Standard')?.source).toBe('product page text')
  })
})

describe('pages the live searches wrongly accepted (2026-09-25)', () => {
  it('skips contest, recall, newsroom and press-release pages', () => {
    for (const path of [
      'a2z_crescent-contest_landing-page/',
      'recall/ncvt1-sp',
      'about-parker/newsroom/news-release-details/new-motor-v16.html',
      'press-releases/x200-launch',
    ]) {
      expect(genuineProduct(THIN_PRODUCT_HTML, `https://acmesafety.test/${path}`, 'Titan Hard Hat X200').ok).toBe(false)
    }
  })

  it('does not take a category with a filter table for one product', () => {
    const cat = `<html><head><title>Combination Tools | Acme</title></head><body><h1>Combination Tools</h1>
      <table><tr><th>Diameter</th><td>3–32 mm</td></tr><tr><th>Material</th><td>Carbide</td></tr><tr><th>Coolant</th><td>Through</td></tr></table></body></html>`
    expect(genuineProduct(cat, 'https://acmesafety.test/products/holemaking/combination-tools.html', 'Combination Tools').ok).toBe(false)
  })

  it('accepts a model code given as its own segment right after /product/', () => {
    const html = '<html><head><title>1/4" 120° Mini Die Grinder | Proto</title></head><body><h1>1/4" 120° Mini Die Grinder</h1><p>A die grinder.</p></body></html>'
    expect(genuineProduct(html, 'https://proto.test/product/j325agah120/14-120deg-mini-die-grinder', '1/4" 120° Mini Die Grinder').ok).toBe(true)
  })

  it('opens a product once however its address is tagged, and a foreign-language copy last', async () => {
    const KO = 'https://acmesafety.test/products/%ED%95%B8%EB%93%9C-%ED%8E%8C%ED%94%84'
    const home = `<html><body><a href="${KO}">KO</a><a href="/products/titan-hard-hat-x200?tid=1">A</a><a href="/products/titan-hard-hat-x200?tid=2">B</a></body></html>`
    const { fetch, calls } = router({ [SITE]: page(SITE, home), [`${PRODUCT}?tid=1`]: page(`${PRODUCT}?tid=1`, THIN_PRODUCT_HTML) })

    const r = await analyseCompanyWebsite({ websiteUrl: SITE, objective: 'x', fetch, read: null })

    expect(r.status).toBe('analysed')
    expect(calls.filter((u) => u.includes('titan-hard-hat-x200'))).toHaveLength(1)
    expect(calls).not.toContain(KO)
  })

  it('steps only to a country site, never to an investor-relations subdomain', async () => {
    const GLOBAL = 'https://www.acme.test/'
    const chooser = `<html><body><h1>Welcome</h1><a href="https://ir.acme.test/press-releases">Investors</a></body></html>`
    const { fetch, calls } = router({ [GLOBAL]: page(GLOBAL, chooser) })

    await analyseCompanyWebsite({ websiteUrl: GLOBAL, objective: 'x', fetch, read: null })

    expect(calls.some((u) => u.includes('ir.acme.test'))).toBe(false)
  })
})

describe('the last live search (2026-09-25)', () => {
  it('never takes a page on a newsroom or investor subdomain for a product', () => {
    expect(genuineProduct(THIN_PRODUCT_HTML, 'https://newsroom.acmesafety.test/2026-09-08-acme-x200-launch', 'Titan Hard Hat X200').ok).toBe(false)
  })

  it('treats a page labelling several product codes as a listing', () => {
    const listing = `<html><head><title>Adhesives &amp; Chemicals</title></head><body><h1>Adhesives &amp; Chemicals</h1>
      ${['A1', 'B2', 'C3', 'D4'].map((c) => `<div><h3>Glue ${c}</h3><p>Item #: ${c}-100</p></div>`).join('')}</body></html>`
    const r = genuineProduct(listing, 'https://acmesafety.test/industrial-adhesives-and-chemicals.html', 'Adhesives & Chemicals')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/listing/)
  })
})

describe('a service page with a few spec-like rows', () => {
  it('is not taken for one product', () => {
    const html = `<html><head><title>Reliable Industrial Adhesives &amp; Chemicals in Scranton, PA</title></head><body>
      <h1>Reliable Industrial Adhesives &amp; Chemicals in Scranton, PA</h1>
      <table><tr><th>Brands</th><td>3M, Loctite</td></tr><tr><th>Service</th><td>Same day</td></tr><tr><th>Area</th><td>Scranton</td></tr></table></body></html>`
    expect(genuineProduct(html, 'https://acme.test/industrial-adhesives-and-chemicals.html', 'Reliable Industrial Adhesives & Chemicals in Scranton, PA').ok).toBe(false)
  })
})
