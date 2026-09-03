import { describe, expect, it } from 'vitest'
import {
  extractCategoryObservations,
  extractPageObservations,
  extractProductObservations,
} from '../../src/websiteaudit/extraction.js'
import {
  countProductTiles,
  extractJsonLd,
  extractProductTileLinks,
  extractSpecPairs,
  hasType,
  jsonLdNodes,
  ldValue,
  structuredDataTypes,
} from '../../src/websiteaudit/htmlStructure.js'
import { classifyPage, linkPriority } from '../../src/websiteaudit/pageClassifier.js'
import { normalizeUrlForDedup, resolveLink, sameSite } from '../../src/websiteaudit/urls.js'
import { CATEGORY_FIELDS, PRODUCT_FIELDS } from '../../src/websiteaudit/types.js'

// Stage 5 — JSON-LD EXTRACTION, PRODUCT ATTRIBUTES, PAGE/CATEGORY DETECTION,
// PAGINATION, DUPLICATE URLS, EVIDENCE PRESERVATION.
//
// The rule under test everywhere below: Stage 5 records WHAT WAS OBSERVED. The
// most important assertions are the ones checking that an ABSENT field still
// produces a row, and that no output anywhere says a field is "missing" — that
// word belongs to Stage 6.

const find = (obs: ReturnType<typeof extractProductObservations>, field: string) =>
  obs.find((o) => o.field === field)!

const PRODUCT_HTML = `<!doctype html><html><head>
<title>M12 Hex Bolt A2 Stainless | Acme Industrial</title>
<meta name="description" content="M12 x 60mm hex bolt in A2 stainless steel.">
<link rel="canonical" href="https://acme.example/products/m12-hex-bolt">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product",
 "name":"M12 Hex Bolt A2 Stainless","sku":"BOLT-M12-60-A2","mpn":"HX1260A2",
 "brand":{"@type":"Brand","name":"FastenPro"},
 "category":"Fasteners > Bolts > Hex Bolts",
 "description":"Hex head bolt, M12 thread, 60mm length, A2 stainless.",
 "width":"12 mm","length":"60 mm","weight":"48 g",
 "additionalProperty":[{"@type":"PropertyValue","name":"Thread","value":"M12 x 1.75"},
                       {"@type":"PropertyValue","name":"Material","value":"A2 Stainless"}],
 "offers":{"@type":"Offer","price":"1.45","priceCurrency":"GBP","availability":"https://schema.org/InStock"}}
</script></head><body>
<nav class="breadcrumb"><a>Home</a><a>Fasteners</a><a>Hex Bolts</a></nav>
<h1>M12 Hex Bolt A2 Stainless</h1>
<img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg">
<table><tr><th>Thread</th><td>M12 x 1.75</td></tr>
<tr><th>Length</th><td>60 mm</td></tr>
<tr><th>Weight</th><td>48 g</td></tr></table>
<a href="/docs/bolt-m12.pdf">Datasheet</a>
<button class="add-to-cart">Add to basket</button>
</body></html>`

// A page with an <h1> and a spec table but no declarations at all.
const BARE_PRODUCT_HTML = `<!doctype html><html><head><title>Widget 500</title></head><body>
<h1>Widget 500</h1><p>Part Number: WID-500-X</p>
<img src="/w.jpg">
<dl><dt>Material</dt><dd>Mild steel</dd></dl>
</body></html>`

const CATEGORY_HTML = `<!doctype html><html><head><title>Hex Bolts</title>
<link rel="next" href="https://acme.example/c/hex-bolts?page=2"></head><body>
<nav class="breadcrumbs"><a>Home</a><a>Fasteners</a></nav>
<h1>Hex Bolts</h1>
<p>Showing 1-24 of 512 products</p>
<div class="filters"><div class="facet-material">Material</div></div>
<select name="sort"><option>Price low to high</option><option>Newest</option></select>
<ul class="pagination"><li>1</li><li>2</li><li>3</li></ul>
${Array.from({ length: 10 }, (_, i) => `<a href="/products/bolt-${i}">Bolt ${i}</a>`).join('')}
</body></html>`

// ── 11. JSON-LD EXTRACTION ─────────────────────────────────────────────────

describe('JSON-LD extraction', () => {
  it('parses a Product block and reaches nested nodes', () => {
    const nodes = jsonLdNodes(extractJsonLd(PRODUCT_HTML))
    expect(nodes.some(({ node }) => hasType(node, 'Product'))).toBe(true)
    expect(nodes.some(({ path }) => path.includes('.offers'))).toBe(true)
  })

  it('unwraps @graph containers', () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme"},{"@type":"Product","name":"Bolt"}]}
    </script>`
    const types = jsonLdNodes(extractJsonLd(html)).map(({ node }) => node['@type'])
    expect(types).toContain('Organization')
    expect(types).toContain('Product')
  })

  it('handles an array at the top level', () => {
    const html = `<script type="application/ld+json">[{"@type":"Product","name":"A"},{"@type":"Product","name":"B"}]</script>`
    expect(jsonLdNodes(extractJsonLd(html)).length).toBe(2)
  })

  it('DROPS an unparseable block rather than repairing it', () => {
    // Half-parsed markup invents structure the page never declared.
    const html = `<script type="application/ld+json">{"@type":"Product", "name": }</script>`
    expect(extractJsonLd(html)).toEqual([])
  })

  it('tolerates CDATA and HTML-comment wrappers', () => {
    const html = `<script type="application/ld+json"><!--{"@type":"Product","name":"Bolt"}--></script>`
    expect(jsonLdNodes(extractJsonLd(html)).length).toBe(1)
  })

  it('reads a nested value without inventing one', () => {
    expect(ldValue({ '@type': 'Brand', name: 'FastenPro' })).toBe('FastenPro')
    expect(ldValue(null)).toBeNull()
    expect(ldValue({})).toBeNull()
  })

  it('lists every declared structured-data type, including microdata', () => {
    const html = `${PRODUCT_HTML}<div itemtype="https://schema.org/Offer"></div>`
    const types = structuredDataTypes(html)
    expect(types).toContain('Product')
    expect(types).toContain('Offer')
  })

  it('ignores an enormous JSON-LD island rather than parsing it', () => {
    const huge = `<script type="application/ld+json">{"@type":"Product","d":"${'x'.repeat(250_000)}"}</script>`
    expect(extractJsonLd(huge)).toEqual([])
  })
})

// ── 12. PRODUCT ATTRIBUTE EXTRACTION ───────────────────────────────────────

describe('product attribute extraction', () => {
  const obs = extractProductObservations(PRODUCT_HTML, 'https://acme.example/products/m12-hex-bolt')

  it('reads declared fields with a citable JSON-LD path', () => {
    const sku = find(obs, 'product.sku')
    expect(sku.status).toBe('observed')
    expect(sku.value).toBe('BOLT-M12-60-A2')
    expect(sku.method).toBe('json_ld')
    expect(sku.sourcePath).toMatch(/JSON-LD\[1\].*\.sku/)
  })

  it('resolves a nested brand node to its name', () => {
    expect(find(obs, 'product.brand').value).toBe('FastenPro')
  })

  it('reads price, currency and availability from the Offer', () => {
    expect(find(obs, 'product.price').value).toBe('1.45')
    expect(find(obs, 'product.currency').value).toBe('GBP')
    expect(find(obs, 'product.availability').value).toMatch(/InStock/)
  })

  it('collects dimensions from the declared measurement properties', () => {
    const d = find(obs, 'product.dimensions')
    expect(d.status).toBe('observed')
    expect(d.value).toMatch(/width=12 mm/)
    expect(d.value).toMatch(/length=60 mm/)
  })

  it('collects additionalProperty as attributes', () => {
    expect(find(obs, 'product.attributes').value).toMatch(/Thread: M12 x 1.75/)
  })

  it('records the units the page used, without converting them', () => {
    // "60 mm" stays "60 mm". Normalising here would discard what the page said.
    const u = find(obs, 'product.units')
    expect(u.status).toBe('observed')
    expect(u.value).toMatch(/mm/)
  })

  it('counts images and document links', () => {
    expect(find(obs, 'product.imageCount').value).toBe('3')
    expect(find(obs, 'product.documents').value).toMatch(/bolt-m12\.pdf/)
  })

  it('produces a row for EVERY expected field, present or not', () => {
    // The absences are the point: Stage 6 reads them.
    expect(obs.map((o) => o.field).sort()).toEqual([...PRODUCT_FIELDS].sort())
  })

  it('records an absent field as not_observed rather than omitting it', () => {
    const gtin = find(obs, 'product.gtin')
    expect(gtin.status).toBe('not_observed')
    expect(gtin.value).toBeNull()
  })

  it('NEVER describes a field as missing, wrong or poor', () => {
    // Stage 5 says "not observed". "Missing" is a Stage 6 word.
    const text = JSON.stringify(obs).toLowerCase()
    expect(text).not.toMatch(/\bmissing\b|\bincomplete\b|\bpoor\b|\bproblem\b|\bshould have\b/)
  })

  it('falls back to the h1 and a part-number label when nothing is declared', () => {
    const bare = extractProductObservations(BARE_PRODUCT_HTML, 'https://acme.example/p/widget-500')
    expect(find(bare, 'product.name')).toMatchObject({ value: 'Widget 500', method: 'dom_heuristic' })
    expect(find(bare, 'product.sku').value).toBe('WID-500-X')
    expect(find(bare, 'product.brand').status).toBe('not_observed')
  })

  it('reports an unattributable price as could_not_determine, not as a price', () => {
    // A currency-shaped string could be a delivery charge. The third status
    // exists so that ambiguity is recorded rather than resolved by guessing.
    const html = `<html><body><h1>Widget</h1><p>Delivery from £4.99</p></body></html>`
    const r = extractProductObservations(html, 'https://acme.example/p/w')
    const price = r.find((o) => o.field === 'product.price')!
    expect(price.status).toBe('could_not_determine')
    expect(price.fragment).toMatch(/£4\.99/)
    expect(price.value).toBeNull()
  })
})

// ── 17. EVIDENCE PRESERVATION ──────────────────────────────────────────────

describe('evidence preservation', () => {
  it('every observed field carries a method, a source path and a fragment', () => {
    const obs = extractProductObservations(PRODUCT_HTML, 'https://acme.example/products/m12-hex-bolt')
    obs
      .filter((o) => o.status === 'observed')
      .forEach((o) => {
        expect(o.method, o.field).toBeTruthy()
        expect(o.sourcePath, o.field).toBeTruthy()
        expect(o.fragment, o.field).toBeTruthy()
      })
  })

  it('a not_observed row carries no invented evidence', () => {
    const gtin = find(extractProductObservations(PRODUCT_HTML, 'u'), 'product.gtin')
    expect(gtin.method).toBeNull()
    expect(gtin.sourcePath).toBeNull()
    expect(gtin.fragment).toBeNull()
  })

  it('bounds stored values so one runaway page cannot dominate storage', () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"${'A'.repeat(9000)}"}</script>`
    const name = find(extractProductObservations(html, 'u'), 'product.name')
    expect(name.value!.length).toBeLessThanOrEqual(2000)
  })

  it('prefers the declaration when both JSON-LD and a spec table state a field', () => {
    const w = find(extractProductObservations(PRODUCT_HTML, 'u'), 'product.weight')
    expect(w.method).toBe('json_ld')
  })
})

// ── Page-level observations ────────────────────────────────────────────────

describe('page-level observations', () => {
  const obs = extractPageObservations(PRODUCT_HTML, 'https://acme.example/products/m12-hex-bolt')
  const get = (f: string) => obs.find((o) => o.field === f)!

  it('reads title, meta description and canonical', () => {
    expect(get('page.title').value).toMatch(/M12 Hex Bolt/)
    expect(get('page.metaDescription').value).toMatch(/A2 stainless steel/)
    expect(get('page.canonical').value).toBe('https://acme.example/products/m12-hex-bolt')
  })

  it('reads breadcrumbs from markup when JSON-LD does not declare them', () => {
    expect(get('page.breadcrumbs').value).toMatch(/Home > Fasteners > Hex Bolts/)
  })

  it('prefers a JSON-LD BreadcrumbList when the page declares one', () => {
    const html = `<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[
      {"@type":"ListItem","name":"Home"},{"@type":"ListItem","name":"Valves"}]}</script>`
    const b = extractPageObservations(html, 'u').find((o) => o.field === 'page.breadcrumbs')!
    expect(b.method).toBe('json_ld')
    expect(b.value).toBe('Home > Valves')
  })

  it('counts words of visible text', () => {
    expect(Number(get('page.wordCount').value)).toBeGreaterThan(5)
  })
})

// ── 9 & 10. PRODUCT AND CATEGORY PAGE DETECTION ────────────────────────────

describe('page classification', () => {
  it('detects a product page from its Product declaration', () => {
    const c = classifyPage(PRODUCT_HTML, 'https://acme.example/products/m12-hex-bolt')
    expect(c.pageType).toBe('product')
    expect(c.signals.join(' ')).toMatch(/declares @type Product/)
  })

  it('detects a product page from microdata when there is no JSON-LD', () => {
    const html = `<div itemtype="https://schema.org/Product"><h1>Bolt</h1></div>`
    expect(classifyPage(html, 'https://acme.example/x').pageType).toBe('product')
  })

  it('detects a category page from listing shape, not from the URL', () => {
    const c = classifyPage(CATEGORY_HTML, 'https://acme.example/c/hex-bolts')
    expect(c.pageType).toBe('category')
    expect(c.signals.join(' ')).toMatch(/product-shaped URLs/)
  })

  it('does NOT classify from a URL pattern alone', () => {
    // /products/about-us is a company page. A URL hint is not a classification.
    const c = classifyPage('<html><body><p>About our company</p></body></html>', 'https://acme.example/products/about-us')
    expect(c.pageType).toBe('unknown')
    expect(c.signals.join(' ')).toMatch(/not enough to classify/)
  })

  it('reports unknown when no signal fires at all', () => {
    expect(classifyPage('<html><body>hello</body></html>', 'https://acme.example/x').pageType).toBe('unknown')
  })

  it('records the signals that lost, so the call can be checked', () => {
    const c = classifyPage(PRODUCT_HTML, 'https://acme.example/products/m12-hex-bolt')
    expect(c.signals.length).toBeGreaterThan(1)
  })

  it('prioritises catalogue links over boilerplate ones', () => {
    expect(linkPriority('/products/bolt-12', 'Bolt')).toBeGreaterThan(linkPriority('/about-us', 'About'))
    expect(linkPriority('/privacy', 'Privacy')).toBeLessThan(0)
  })

  // These cover the case that URL patterns and JSON-LD both miss, which is the
  // common one on real distributor sites. Markup shapes are taken verbatim from
  // 1stayd.com, a nopCommerce storefront with bare-slug URLs and no JSON-LD.
  it('detects a listing from repeated product tiles when there is no JSON-LD and no URL hint', () => {
    const tiles = Array.from(
      { length: 12 },
      (_, i) => `<div class="item-box"><div class="product-item"><h2 class="product-title"><a href="/widget-${i}-4x1-galcs">W${i}</a></h2></div></div>`,
    ).join('')
    const html = `<html><body><div class="product-grid">${tiles}</div>
      <div class="product-sorting"></div><div class="product-page-size"></div></body></html>`

    const c = classifyPage(html, 'https://1stayd.example/carpet-cleaners')
    expect(c.pageType).toBe('category')
    expect(c.signals.join(' ')).toMatch(/repeats \d+ product-tile containers/)
    expect(c.signals.join(' ')).toMatch(/listing controls/)
  })

  it('detects a single product page from its detail containers', () => {
    const html = `<html><body><div class="page product-details-page">
      <div class="product-essential"><div class="product-name"><h1>Foaming Carpet Cleaner</h1></div></div>
      <div class="product-specs-box"><table><tr><th>Size</th><td>18 oz</td></tr></table></div>
      </div></body></html>`
    const c = classifyPage(html, 'https://1stayd.example/foaming-carpet-cleaner-24x18-ozcs')
    expect(c.pageType).toBe('product')
    expect(c.signals.join(' ')).toMatch(/single-product containers/)
  })

  it('extracts product links from tile structure rather than from URL shape', () => {
    const tiles = Array.from(
      { length: 3 },
      (_, i) => `<div class="item-box"><h2 class="product-title"><a href="/bare-slug-${i}">P${i}</a></h2></div>`,
    ).join('')
    const links = extractProductTileLinks(`<div class="product-grid">${tiles}</div>`)
    // Not one of these URLs contains /product/ — only the tile markup says so.
    expect(links).toEqual(expect.arrayContaining(['/bare-slug-0', '/bare-slug-1', '/bare-slug-2']))
  })

  it('does not mistake a nav menu for a product grid', () => {
    const html = '<html><body><ul class="mobile-menu-items"><li><a href="/a">A</a></li></ul></body></html>'
    expect(countProductTiles(html)).toBe(0)
    expect(classifyPage(html, 'https://acme.example/x').pageType).toBe('unknown')
  })
})

// ── 13. PAGINATION + category fields ───────────────────────────────────────

describe('category and listing extraction', () => {
  const obs = extractCategoryObservations(CATEGORY_HTML, 'https://acme.example/c/hex-bolts')
  const get = (f: string) => obs.find((o) => o.field === f)!

  it('reads the publicly stated product count without recomputing it', () => {
    expect(get('category.productCount').value).toBe('512')
    expect(get('category.productCount').fragment).toMatch(/Showing 1-24 of 512 products/)
  })

  it('detects pagination from rel=next', () => {
    const p = get('category.pagination')
    expect(p.status).toBe('observed')
    expect(p.value).toMatch(/page=2/)
  })

  it('detects pagination from a pagination container when rel=next is absent', () => {
    const html = CATEGORY_HTML.replace(/<link rel="next"[^>]*>/, '')
    const p = extractCategoryObservations(html, 'u').find((o) => o.field === 'category.pagination')!
    expect(p.status).toBe('observed')
    expect(p.value).toMatch(/page links/)
  })

  it('records filters, facets and sort options that are present', () => {
    expect(get('category.filters').status).toBe('observed')
    expect(get('category.facets').status).toBe('observed')
    expect(get('category.sortOptions').value).toMatch(/Price low to high/)
  })

  it('produces a row for every expected category field', () => {
    expect(obs.map((o) => o.field).sort()).toEqual([...CATEGORY_FIELDS].sort())
  })

  it('records absent facets as not_observed rather than as zero', () => {
    const plain = extractCategoryObservations('<html><body><h1>Bolts</h1></body></html>', 'u')
    expect(plain.find((o) => o.field === 'category.facets')!.status).toBe('not_observed')
    expect(plain.find((o) => o.field === 'category.productCount')!.status).toBe('not_observed')
  })
})

describe('specification block parsing', () => {
  it('reads two-column table rows', () => {
    const pairs = extractSpecPairs('<table><tr><th>Material</th><td>A2 Stainless</td></tr></table>')
    expect(pairs[0]).toMatchObject({ key: 'Material', value: 'A2 Stainless' })
  })

  it('reads definition lists', () => {
    const pairs = extractSpecPairs('<dl><dt>Thread</dt><dd>M12</dd></dl>')
    expect(pairs[0]).toMatchObject({ key: 'Thread', value: 'M12' })
  })

  it('reads "Label: value" list items', () => {
    const pairs = extractSpecPairs('<ul><li>Finish: Zinc plated</li></ul>')
    expect(pairs[0]).toMatchObject({ key: 'Finish', value: 'Zinc plated' })
  })

  it('ignores a three-column row, which is a data table rather than a spec pair', () => {
    expect(extractSpecPairs('<table><tr><td>A</td><td>B</td><td>C</td></tr></table>')).toEqual([])
  })

  it('keeps the source fragment for every pair', () => {
    const pairs = extractSpecPairs('<table><tr><th>Weight</th><td>48 g</td></tr></table>')
    expect(pairs[0]!.fragment).toMatch(/<th>Weight<\/th>/)
  })
})

// ── 7. DUPLICATE URLS ──────────────────────────────────────────────────────

describe('URL identity', () => {
  it('collapses tracking parameters, casing and trailing slashes', () => {
    const a = normalizeUrlForDedup('https://WWW.Acme.example/products/bolt/?utm_source=google&gclid=xyz')
    const b = normalizeUrlForDedup('http://acme.example/products/bolt')
    expect(a).toBe(b)
  })

  it('collapses reordered query parameters', () => {
    expect(normalizeUrlForDedup('https://a.example/x?b=2&a=1')).toBe(normalizeUrlForDedup('https://a.example/x?a=1&b=2'))
  })

  it('keeps meaningful parameters distinct', () => {
    // ?page=2 is a different page. Collapsing it would lose real evidence.
    expect(normalizeUrlForDedup('https://a.example/c?page=1')).not.toBe(normalizeUrlForDedup('https://a.example/c?page=2'))
  })

  it('drops the fragment, which never changes the response', () => {
    expect(normalizeUrlForDedup('https://a.example/x#specs')).toBe(normalizeUrlForDedup('https://a.example/x'))
  })

  it('rejects non-http schemes', () => {
    expect(normalizeUrlForDedup('file:///etc/passwd')).toBeNull()
    expect(normalizeUrlForDedup('javascript:alert(1)')).toBeNull()
  })

  it('resolves relative links against the page they were found on', () => {
    expect(resolveLink('../bolt', 'https://a.example/c/fasteners/')).toBe('https://a.example/c/bolt')
    expect(resolveLink('mailto:x@y.z', 'https://a.example/')).toBeNull()
  })

  it('treats a subdomain as the same site', () => {
    expect(sameSite('shop.acme.example', 'acme.example')).toBe(true)
    expect(sameSite('acme.example', 'notacme.example')).toBe(false)
  })
})

describe('breadcrumb decoding (Task #981 compatibility fix)', () => {
  it('decodes HTML entities in breadcrumb crumbs', () => {
    // Verbatim from the stored 1st Ayd audit, which recorded
    // "RAGS, WIPERS &amp; PAPER" because this path stripped tags with a raw
    // regex instead of decoding. Breadcrumbs are the only source of product
    // category, so the corruption propagated into anything derived from it.
    const html = `<div class="breadcrumb"><a>Home</a><span>/</span>
      <a>RAGS, WIPERS &amp; PAPER</a><span>/</span><a>Paper Towels</a></div>`
    const b = extractPageObservations(html, 'https://1stayd.example/p/x').find((o) => o.field === 'page.breadcrumbs')!
    expect(b.value).toBe('Home > RAGS, WIPERS & PAPER > Paper Towels')
    expect(b.value).not.toMatch(/&amp;/)
  })

  it('drops separator elements rather than treating them as crumbs', () => {
    const html = '<nav class="breadcrumbs"><a>Home</a><span>›</span><a>Valves</a></nav>'
    const b = extractPageObservations(html, 'u').find((o) => o.field === 'page.breadcrumbs')!
    expect(b.value).toBe('Home > Valves')
  })

  it('decodes numeric entities too', () => {
    const html = '<div class="breadcrumb"><a>Caf&#233; Supplies</a><a>Cups</a></div>'
    const b = extractPageObservations(html, 'u').find((o) => o.field === 'page.breadcrumbs')!
    expect(b.value).toBe('Café Supplies > Cups')
  })
})
