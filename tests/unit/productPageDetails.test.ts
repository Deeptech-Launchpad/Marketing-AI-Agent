import { describe, expect, it } from 'vitest'
import { readBreadcrumb, readProductPageDetails, readableHtml } from '../../src/prospects/productPageDetails.js'
import { analyseProductPage, declaredProductLinks, genuineProduct, isBoilerplateDescription } from '../../src/prospects/productPageAnalysis.js'

// THE PRODUCT PAGE AS A BUYER SEES IT — picture, price, how it is sold,
// buying options, downloads and specifications — read verbatim, and nothing
// the page does not show.

const URL_ = 'https://www.example-electrical.test/item/din-rail/ts3515sl'

// Modelled on a real industrial catalogue page: a site-wide "Send Inquiry" in
// the header, a commented-out old breadcrumb, hidden "N/A" placeholders in
// every spec value, a microdata price, a quantity box that enforces a minimum,
// downloads, and footer contact rows laid out like spec rows.
const PAGE = `<!doctype html><html><head>
<title>Item # TS3515SL | Example Electrical</title>
<meta name="description" content="Browse Item # TS3515SL in the Example Electrical catalog including Item #,Item Name,Description,Length,Type,Size,Material,Lot Size">
<meta property="og:image" content="https://www.example-electrical.test/ImgMedium/TS3515SL.PNG">
</head><body>
<header><img src="/img/site-logo.png" alt="Example Electrical"><a class="btn-rfq" href="/request">Send Inquiry</a></header>
<!-- <div id="breadcrumbs"><a href="/">Home</a> &gt; International</div> -->
<nav id="plp-bread-crumb"><a href="/c/all">All Categories</a> > <a href="/c/din">DIN Rail</a> > Item # TS3515SL<div style="display:none"><ol itemscope itemtype="http://schema.org/BreadcrumbList"><li>All</li></ol></div></nav>
<h1>Item # TS3515SL, TS Series 35 x 15 mm Steel Slotted DIN Rail</h1>
<div style="display: none"><span itemprop="sku">TS3515SL</span></div>
<img alt="TS Series 35 x 15 mm Steel Slotted DIN Rail" src="/ImgMedium/TS3515SL.PNG">
<img alt="TS Series 35 x 15 mm Steel Slotted DIN Rail" src="/ImgSmall/TS3515SL.PNG">
<section id="ecomm-price"><h3>List Price</h3>
<div itemprop="offers" itemscope itemtype="http://schema.org/Offer"><span itemprop="priceCurrency" content="USD">$</span><span itemprop="price" content="12.79">12.79</span></div>
<div>Qty. <input type="text" id="plp-cart-quantity" value="10" data-minqty="10" data-qtyincrement="10"></div>
<a class="cart" href="/addtocart">Add To Cart</a>
<a href="/addtocart">Request Quote</a>
</section>
<div id="plp-downloads"><h3>Downloads</h3>
<a class="plp-download-link" data-assettype="PDF" href="/Asset/TS3515SL_1.PDF" target="_blank">TS3515SL Data Sheet</a>
<a class="plp-download-link" data-assettype="PDF" href="/Asset/DIN Rail specs_1.pdf" target="_blank">DIN Rail specs.pdf</a>
</div>
<div itemprop="description"></div>
<table>
<tr><td>Length</td><td><span class="nodisplay">N/A</span><span>2 m</span></td></tr>
<tr><td>Type</td><td><span class="nodisplay">N/A</span><span>Slotted</span></td></tr>
<tr><td>Size</td><td><span class="nodisplay">N/A</span><span>35 x 15 mm</span></td></tr>
<tr><td>Material</td><td><span class="nodisplay">N/A</span><span>Steel</span></td></tr>
<tr><td>Lot Size</td><td><span class="nodisplay">N/A</span><span>10</span></td></tr>
<tr><td>Package Type</td><td><span class="nodisplay">N/A</span><span>Stick</span></td></tr>
</table>
<footer>
<table><tr><td>Tel</td><td>804-555-0100</td></tr><tr><td>Fax</td><td>804-555-0101</td></tr></table>
<a href="/docs/privacy-policy.pdf">Privacy policy</a><a href="/linecard.pdf">Line card</a>
</footer>
</body></html>`

describe('reading the product page a buyer sees', () => {
  const a = analyseProductPage({ html: PAGE, url: URL_, httpStatus: 200, websiteUrl: 'https://www.example-electrical.test' })
  const p = a.product!
  const page = p.page!

  it('names the product by its heading, not by a breadcrumb that reuses the "name" property', () => {
    expect(p.name).toBe('Item # TS3515SL, TS Series 35 x 15 mm Steel Slotted DIN Rail')
    expect(page.title).toBe(p.name)
  })

  it('reads specification values without hidden placeholder text, and leaves footer contact rows out', () => {
    const specs = p.attributes.filter((x) => x.source === 'specification table').map((x) => `${x.name}: ${x.value}`)
    expect(specs).toEqual(expect.arrayContaining(['Length: 2 m', 'Type: Slotted', 'Size: 35 x 15 mm', 'Material: Steel', 'Lot Size: 10', 'Package Type: Stick']))
    expect(specs.join(' ')).not.toMatch(/N\/A/)
    expect(specs.join(' ')).not.toMatch(/Tel|Fax/)
  })

  it('reads the price the page declares, with its currency and the page’s own label', () => {
    expect(page.price).toEqual({ amount: '12.79', currency: 'USD', label: 'List Price', source: 'structured data' })
  })

  it('reads how the product is ordered: the quantity box’s minimum and step, and the lot size', () => {
    expect(page.ordering).toEqual(
      expect.arrayContaining([
        { label: 'Minimum order quantity', value: '10' },
        { label: 'Order in multiples of', value: '10' },
        { label: 'Lot Size', value: '10' },
      ]),
    )
  })

  it('lists the product’s buying options, not the site header’s', () => {
    expect(page.buyingOptions).toEqual(['Add To Cart', 'Request Quote'])
  })

  it('lists the product’s downloads with their type, and leaves the footer’s policy documents out', () => {
    expect(page.downloads).toEqual([
      { label: 'TS3515SL Data Sheet', url: 'https://www.example-electrical.test/Asset/TS3515SL_1.PDF', fileType: 'PDF' },
      { label: 'DIN Rail specs.pdf', url: 'https://www.example-electrical.test/Asset/DIN%20Rail%20specs_1.pdf', fileType: 'PDF' },
    ])
  })

  it('keeps one picture per image, not one per size, and never the logo', () => {
    expect(page.images).toEqual(['https://www.example-electrical.test/ImgMedium/TS3515SL.PNG'])
  })

  it('reads the visible breadcrumb, not a commented-out one', () => {
    expect(p.category).toBe('All Categories > DIN Rail > Item # TS3515SL')
    expect(p.category).not.toMatch(/International/)
  })

  it('does not take the catalogue’s SEO line as the product’s description', () => {
    expect(p.description).toBeNull()
    expect(a.gaps[0]!.key).toBe('description')
  })
})

describe('what the page does not show stays absent', () => {
  const details = (body: string) =>
    readProductPageDetails({
      html: readableHtml(`<html><body><h1>Widget W-100 Pump</h1>${body}</body></html>`),
      url: URL_,
      declared: { imageUrl: null, price: null, currency: null, availability: null, sku: null, mpn: null, gtin: null, brand: null },
      specPairs: [],
    })

  it('records no price from an unlabelled amount (a shipping threshold is not a price)', () => {
    const d = details('<p>Free shipping on orders over $50.00</p>')
    expect(d.price).toBeNull()
  })

  it('reads a labelled price from page text, and says where it came from', () => {
    const d = details('<p>Your Price: $249.00</p>')
    expect(d.price).toEqual({ amount: '249.00', currency: '$', label: 'Your Price', source: 'page text' })
  })

  it('quotes the page when it withholds the price', () => {
    const d = details('<p>Login for pricing</p>')
    expect(d.price).toBeNull()
    expect(d.priceNote).toBe('Login For Pricing')
  })

  it('reports no buying option, download or picture the page does not have', () => {
    const d = details('<p>A pump.</p>')
    expect(d.buyingOptions).toEqual([])
    expect(d.downloads).toEqual([])
    expect(d.images).toEqual([])
    expect(d.ordering).toEqual([])
    expect(d.availability).toBeNull()
  })

  it('reads availability only when the page states it', () => {
    expect(details('<p>In Stock</p>').availability).toBe('In Stock')
    const declared = readProductPageDetails({
      html: '<h1>X</h1>',
      url: URL_,
      declared: { imageUrl: null, price: null, currency: null, availability: 'https://schema.org/InStock', sku: null, mpn: null, gtin: null, brand: null },
      specPairs: [],
    })
    expect(declared.availability).toBe('In Stock')
  })
})

describe('a listing is not a product page', () => {
  it('rejects a page that declares several products in microdata, and accepts one that declares one', () => {
    const row = (sku: string) =>
      `<div itemscope itemtype="http://schema.org/Product"><span itemprop="sku">${sku}</span><a href="/item/${sku}">${sku}</a></div>`
    const listing = `<h1>DIN Rail</h1><table><tr><td>Size</td><td>35 mm</td></tr><tr><td>Type</td><td>Rail</td></tr><tr><td>Material</td><td>Steel</td></tr></table>${['A1', 'B2', 'C3', 'D4', 'E5'].map(row).join('')}`
    const verdict = genuineProduct(listing, 'https://www.example-electrical.test/viewitems/din-rail', 'DIN Rail')
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? '' : verdict.reason).toMatch(/declares 5 products — it is a listing/)

    expect(genuineProduct(PAGE, URL_, 'Item # TS3515SL').ok).toBe(true)
  })

  it('goes from a listing to the pages of the products it declares, ahead of its email / print links', () => {
    const listing = `<a href="/email/din-rail?from=viewitems">Email</a><a href="/printitems/din-rail">Print</a>
      <div itemscope itemtype="http://schema.org/Product"><a href="/item/din-rail/ts3515sl-1">TS3515SL</a></div>
      <div itemscope itemtype="http://schema.org/Product"><a href="/item/din-rail/ts3575f6">TS3575F6</a></div>`
    expect(declaredProductLinks(listing)).toEqual(['/item/din-rail/ts3515sl-1', '/item/din-rail/ts3575f6'])
  })
})

describe('helpers', () => {
  it('recognises a catalogue SEO line, and leaves a real description alone', () => {
    expect(isBoilerplateDescription('Browse Item # X in the ACME catalog including Item #,Item Name,Description,Length,Type')).toBe(true)
    expect(isBoilerplateDescription('A slotted steel DIN rail for mounting terminal blocks and relays in control panels.')).toBe(false)
  })

  it('reads a breadcrumb only when the page marks one', () => {
    expect(readBreadcrumb('<ol class="breadcrumb"><li><a href="/">Home</a></li><li>/ Pumps</li></ol>')).toBe('Home > Pumps')
    expect(readBreadcrumb('<div class="menu"><a href="/">Home</a> > Pumps</div>')).toBeNull()
  })

  it('removes hidden placeholder text but keeps hidden microdata', () => {
    const out = readableHtml('<td><span class="nodisplay">N/A</span><span>2 m</span></td><span itemprop="sku" style="display:none">X1</span>')
    expect(out).not.toContain('N/A')
    expect(out).toContain('itemprop="sku"')
  })
})
