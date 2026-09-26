import { describe, expect, it } from 'vitest'
import {
  catalogObservations,
  extractCatalogEntries,
  imageFileNameOf,
  looksLikeProductCode,
} from '../../src/websiteaudit/catalogEvidence.js'

// THE COMPANY THAT WAS TOLD IT HAD NO PRODUCTS.
//
// unicaremalta.com sells grab rails, shower seats and mobility aids. The audit
// read fifteen of its pages, every one a real category page, and reported ZERO
// PRODUCTS.
//
// The first diagnosis was that the grid is rendered by JavaScript, because the
// visible text of those pages reads "No results found". That was wrong, and
// section 6 below is where the real cause is pinned: the cards are
// server-rendered, and Squarespace writes their links WITHOUT QUOTES, which is
// legal HTML5 and which the link reader could not read. The crawler never saw
// a product link on that site.
//
// Both halves of the answer are tested here. Sections 1-5 collect what a page
// names however it names it — including the weakest case, where the only
// machine-readable trace of a product is its image alt text. Section 6 pins
// the markup that was actually there.
//
// And throughout, what must NOT happen: nothing is invented, promoted or
// dressed up. A file name is a file name. It is never a SKU.

const PAGE = (body: string, title = 'Unicare Malta') =>
  `<html><head><title>${title}</title></head><body>${body}</body></html>`

// ── 1. The case that forced this: names in alt text ───────────────────────

describe('a JavaScript-rendered grid that leaves its evidence in alt text', () => {
  // The real markup shape, reduced: a company logo, then alternating product
  // name and product-code image, and a visible "No results found".
  const unicare = PAGE(
    `<img src="/img/logo.png" alt="Unicare Malta">
     <div class="grid">
       <img src="/media/RS972XX.jpg" alt="GRAB RAIL">
       <img src="/media/code.png" alt="RS972XX.jpg">
       <img src="/media/H3301.jpg" alt="GRAB RAIL LOOPED">
       <img src="/media/code.png" alt="H3301.jpg">
       <img src="/media/GRS.jpeg" alt="GRAB RAIL SCREWS STAINLESS STEEL">
       <img src="/media/170XX.jpeg" alt="GRAB RAIL STAINLESS STEEL">
     </div>
     <p>No results found</p>`,
  )

  const entries = extractCatalogEntries(unicare, 'https://www.unicaremalta.com/products/bathroom')

  it('finds the products the page names', () => {
    expect(entries.map((e) => e.name)).toEqual([
      'GRAB RAIL',
      'GRAB RAIL LOOPED',
      'GRAB RAIL SCREWS STAINLESS STEEL',
      'GRAB RAIL STAINLESS STEEL',
    ])
  })

  it('records how weak the evidence is, rather than hiding it', () => {
    expect(entries.every((e) => e.strength === 'image_alt')).toBe(true)
  })

  it('keeps the image, absolute, on the company own host', () => {
    expect(entries[0]!.imageUrl).toBe('https://www.unicaremalta.com/media/RS972XX.jpg')
  })

  it('carries the image file name where one reads like a code', () => {
    expect(entries[0]!.imageFileName).toBe('RS972XX.jpg')
    expect(entries[1]!.imageFileName).toBe('H3301.jpg')
    expect(entries[2]!.imageFileName).toBe('GRS.jpeg')
  })

  it('never turns a file name into a product code', () => {
    // The whole risk of reading file names. Nothing here may claim the company
    // published a SKU, an MPN or a GTIN, because it did not.
    const rows = catalogObservations(entries)
    expect(rows.some((r) => /product\.(sku|mpn|gtin)/.test(r.field))).toBe(false)
    const codeRow = rows.find((r) => r.field === 'catalog.entry.0.imageFileName')!
    expect(codeRow.value).toBe('RS972XX.jpg')
    expect(codeRow.fragment).toMatch(/not a published product code/i)
  })

  it('does not collect the company own name as merchandise', () => {
    expect(entries.map((e) => e.name)).not.toContain('Unicare Malta')
  })

  it('does not collect a file name used as alt text as a product', () => {
    expect(entries.map((e) => e.name)).not.toContain('RS972XX.jpg')
  })
})

// ── 2. The stronger shapes, which must still win ──────────────────────────

describe('a site that declares its own list', () => {
  it('reads a JSON-LD ItemList', () => {
    const html = PAGE(
      `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: [
          { '@type': 'ListItem', item: { name: 'M8 Hex Bolt', url: '/p/m8-hex', image: '/i/m8.jpg' } },
          { '@type': 'ListItem', item: { name: 'M10 Hex Bolt', url: '/p/m10-hex' } },
        ],
      })}</script>`,
      'Acme Fasteners',
    )
    const entries = extractCatalogEntries(html, 'https://acme.test/c/bolts')
    expect(entries.map((e) => e.name)).toEqual(['M8 Hex Bolt', 'M10 Hex Bolt'])
    expect(entries[0]!.strength).toBe('linked')
    expect(entries[0]!.detailUrl).toBe('https://acme.test/p/m8-hex')
    expect(entries[0]!.method).toBe('json_ld')
  })

  it('reads an OpenGraph product page', () => {
    const html =
      '<html><head><title>M8 Hex Bolt | Acme</title>' +
      '<meta property="og:type" content="product">' +
      '<meta property="og:title" content="M8 Hex Bolt">' +
      '<meta property="og:image" content="https://acme.test/i/m8.jpg">' +
      '</head><body></body></html>'
    const entries = extractCatalogEntries(html, 'https://acme.test/p/m8')
    expect(entries[0]).toMatchObject({ name: 'M8 Hex Bolt', strength: 'linked', method: 'meta_tag' })
  })

  it('reads repeated product cards, with their links', () => {
    const card = (name: string, href: string, img: string) =>
      `<div class="product-item"><a href="${href}"><img src="${img}" alt="${name}"><h3 class="product-title">${name}</h3></a></div>`
    const html = PAGE(card('Foaming Carpet Cleaner', '/foaming-carpet-cleaner', '/i/fcc.jpg') + card('Glass Cleaner', '/glass-cleaner', '/i/gc.jpg'), 'Acme Supply')
    const entries = extractCatalogEntries(html, 'https://acme.test/c/cleaning')
    expect(entries.map((e) => e.name)).toEqual(['Foaming Carpet Cleaner', 'Glass Cleaner'])
    expect(entries.every((e) => e.strength === 'linked')).toBe(true)
    expect(entries[0]!.detailUrl).toBe('https://acme.test/foaming-carpet-cleaner')
  })

  it('puts the strongest evidence first', () => {
    const html = PAGE(
      '<div class="product-card"><a href="/p/1"><h3>Linked Product</h3></a></div>' +
        '<img src="/i/x1.jpg" alt="ALT ONLY PRODUCT">',
      'Acme Supply',
    )
    const entries = extractCatalogEntries(html, 'https://acme.test/shop')
    expect(entries[0]!.strength).toBe('linked')
    expect(entries[1]!.strength).toBe('image_alt')
  })
})

// ── 3. What it must refuse to collect ─────────────────────────────────────

describe('what is not merchandise', () => {
  it('ignores site furniture', () => {
    const html = PAGE(
      `<img src="/i/logo.svg" alt="logo">
       <img src="/i/cart.png" alt="cart">
       <img src="/i/visa.png" alt="Visa">
       <img src="/i/hero.jpg" alt="banner">
       <img src="/i/fb.svg" alt="facebook">`,
      'Acme Supply',
    )
    expect(extractCatalogEntries(html, 'https://acme.test/')).toEqual([])
  })

  it('ignores calls to action dressed as alt text', () => {
    const html = PAGE('<img src="/i/a.jpg" alt="Read more"><img src="/i/b.jpg" alt="View all">', 'Acme Supply')
    expect(extractCatalogEntries(html, 'https://acme.test/')).toEqual([])
  })

  it('ignores a bare single word', () => {
    const html = PAGE('<img src="/i/a.jpg" alt="New">', 'Acme Supply')
    expect(extractCatalogEntries(html, 'https://acme.test/')).toEqual([])
  })

  it('returns nothing at all for a page that names nothing', () => {
    // State B has to be reachable. A module that always finds something turns
    // "this site publishes no products" into a claim nobody can make.
    const html = PAGE('<h1>About us</h1><p>We have been trading since 1974.</p>', 'Acme Supply')
    expect(extractCatalogEntries(html, 'https://acme.test/about')).toEqual([])
  })
})

// ── 4. Code-shaped file names, narrowly ───────────────────────────────────

describe('does this file name read like a product code', () => {
  it('accepts short tokens carrying digits or deliberate capitals', () => {
    for (const f of ['RS972XX.jpg', 'H3301.jpg', 'GRS.jpeg', '170XX.jpeg', 'AB-12.png']) {
      expect(looksLikeProductCode(f), f).toBe(true)
    }
  })

  it('accepts the real codes seen on live catalogues', () => {
    // Every one of these is a file name on a real customer's own server.
    for (const f of ['DTSF450C001.jpg', 'MSDEA8166.jpeg', 'P302C46461HW.jpeg', 'CP88035.jpeg', '4228.jpg']) {
      expect(looksLikeProductCode(f), f).toBe(true)
    }
  })

  it('rejects slugs, furniture and prose', () => {
    for (const f of [
      'grab-rail.jpg',
      'foaming-carpet-cleaner.png',
      'logo.svg',
      'hero-banner.png',
      'placeholder.png',
      'a-very-long-descriptive-file-name-here.jpg',
      // A slug WITH digits is still a slug: a product name and an image size.
      // This one reached a customer's screen labelled as a code.
      'ark-silver3_1_9-800x600.jpg',
      'blue-chair-1024x768.png',
      // A trailing pixel dimension is a CMS-generated thumbnail. Both of these
      // reached a customer's screen labelled as a product code.
      'render1_114_2-800x600.jpg',
      'Avangard1-800x527.png',
      null,
    ]) {
      expect(looksLikeProductCode(f), String(f)).toBe(false)
    }
  })

  it('reads the file name off a URL, and only off an image URL', () => {
    expect(imageFileNameOf('https://acme.test/media/RS972XX.jpg?v=2')).toBe('RS972XX.jpg')
    expect(imageFileNameOf('https://acme.test/p/bolt')).toBeNull()
    expect(imageFileNameOf(null)).toBeNull()
  })
})

// ── 5. The rows that persist ──────────────────────────────────────────────

describe('catalogue entries as observation rows', () => {
  const entries = extractCatalogEntries(
    PAGE('<div class="product-item"><a href="/p/1"><img src="/i/AB12.jpg" alt="Stainless Grab Rail"></a></div>', 'Acme'),
    'https://acme.test/c/rails',
  )
  const rows = catalogObservations(entries)

  it('indexes each entry so it can be reassembled without a join', () => {
    expect(rows.map((r) => r.field)).toEqual([
      'catalog.entry.0.name',
      'catalog.entry.0.strength',
      'catalog.entry.0.url',
      'catalog.entry.0.image',
      'catalog.entry.0.imageFileName',
    ])
  })

  it('records every row as observed, with its own source fragment', () => {
    expect(rows.every((r) => r.status === 'observed')).toBe(true)
    expect(rows.every((r) => Boolean(r.fragment))).toBe(true)
  })
})

// ── 6. The markup that was actually there ────────────────────────────────
//
// The diagnosis at the time was "the product grid is rendered by JavaScript".
// It was not. unicaremalta.com is a Squarespace store that server-renders
// every product card — and writes the href WITHOUT QUOTES, which is legal
// HTML5 and which the link reader could not read. Fifteen category pages were
// crawled, no product link was ever seen, and a company with a 295-item
// catalogue was audited as publishing no products.
//
// This is that markup, reduced to the attributes that mattered.

describe('a Squarespace product card, verbatim in shape', () => {
  const card = `<div class="product-list-item tag-unicare tag-bath" data-product-id="68a0">
      <a class="product-list-item-link" href=/products/p/bath-board-steel aria-label="BATH BOARD STEEL">
        <div class="product-list-image-wrapper">
          <img data-src="https://cdn.test/95cc/4228.jpg" alt="BATH BOARD STEEL" class="grid-item-image">
        </div>
      </a>
    </div>`
  const entries = extractCatalogEntries(PAGE(card), 'https://www.unicaremalta.com/products/bathroom')

  it('reads the product through an unquoted href', () => {
    expect(entries).toHaveLength(1)
    expect(entries[0]!.detailUrl).toBe('https://www.unicaremalta.com/products/p/bath-board-steel')
  })

  it('is linked evidence, not the alt-text fallback', () => {
    expect(entries[0]!.strength).toBe('linked')
    expect(entries[0]!.name).toBe('BATH BOARD STEEL')
  })

  it('takes the image out of data-src when src is absent', () => {
    expect(entries[0]!.imageUrl).toBe('https://cdn.test/95cc/4228.jpg')
    expect(entries[0]!.imageFileName).toBe('4228.jpg')
  })
})

describe('a catalogue page navigation is not merchandise', () => {
  // Every one of these class names was matched by a `\bproduct\b` pattern,
  // because a hyphen is a word boundary. Six filter and navigation controls
  // were collected as this customer's products.
  const chrome = `
    <div class="product-list-nav"><a href="/products">All Products</a></div>
    <div class="product-list-category-select-container"><a href="/products/therapy-equipment">Therapy Equipment</a></div>
    <div class="product-filter-dropdown"><a href="/products/first-aid">First Aid</a></div>
    <div class="product-list-filters-container"><a href="/products/kitchen-aids">Kitchen Aids</a></div>
    <div class="product-list-result-count-container">No results found</div>`

  it('collects none of it', () => {
    expect(extractCatalogEntries(PAGE(chrome), 'https://www.unicaremalta.com/products/bathroom')).toEqual([])
  })

  it('still reads a real card standing beside the chrome', () => {
    const withCard =
      chrome +
      '<div class="product-list-item"><a href=/products/p/grab-rail aria-label="GRAB RAIL STAINLESS STEEL">' +
      '<img data-src="/m/170XX.jpeg" alt="GRAB RAIL STAINLESS STEEL"></a></div>'
    const entries = extractCatalogEntries(PAGE(withCard), 'https://www.unicaremalta.com/products/bathroom')
    expect(entries.map((e) => e.name)).toEqual(['GRAB RAIL STAINLESS STEEL'])
  })

  it('never collects an empty-state message as a product', () => {
    const empty = PAGE('<div class="product-list-item"><p>No results found</p></div><img src="/i/x.jpg" alt="No results found">')
    expect(extractCatalogEntries(empty, 'https://www.unicaremalta.com/products/bathroom')).toEqual([])
  })
})
