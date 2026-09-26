import { describe, expect, it } from 'vitest'
import { imageUrlsIn } from '../../src/research/pageCapture.js'
import { brandKit, renderEnrichedPdpHtml } from '../../src/workbench/enrichedPdpPage.js'
import { deflateSync } from 'node:zlib'
import { findLogoOnPage, productPicturesOnly } from '../../src/workbench/enrichedPdpBrand.js'
import { logoToneOf } from '../../src/workbench/logoTone.js'
import type { PdpEnrichment } from '../../src/websiteaudit/pdpEnrichment.js'
import type { ThemeProfile } from '../../src/workbench/types.js'
import type { WebsiteShell } from '../../src/workbench/websiteShell.js'

// PICTURES THAT ONLY THEIR OWN SITE WILL SERVE.
//
// Some image hosts refuse a request that does not come from the shop itself,
// and some themes embed their pictures rather than publishing a fetchable URL.
// Either way the enriched page pointed at links that resolved to nothing, and
// the report was photographed with broken image boxes.
//
// So pictures are read once and carried as bytes. What must hold:
//
//   · a picture we hold is drawn from those bytes, on screen and in the report;
//   · a picture we do not hold keeps its link ON SCREEN, where the browser can
//     still fetch it a moment later;
//   · but a CAPTURE draws the honest placeholder instead, because a broken box
//     photographed is broken forever;
//   · the same rule covers the customer's logo.

const PAGE = 'https://shop.test/products/thing'
const LOGO = 'https://cdn.shop.test/logo.png'
const IMG = 'https://cdn.shop.test/product-1.jpg'
const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

const shell = (): WebsiteShell => ({
  captured: true,
  reason: null,
  sourceUrl: PAGE,
  siteName: 'Shop Test',
  host: 'shop.test',
  logoUrl: LOGO,
  logoAlt: 'Shop Test',
  nav: [{ label: 'Home', href: null }],
  hasSearch: true,
  utility: [],
  footerLinks: [],
  footerText: null,
  social: [],
  notCaptured: [],
})

const theme = (): ThemeProfile => ({
  source: 'live_sample',
  reason: null,
  primary: '#0b6e4f',
  accent: '#333333',
  ink: '#111827',
  surface: '#ffffff',
  muted: '#6b7280',
  fontFamily: 'Arial',
  headingFamily: 'Arial',
  logoUrl: null,
  radius: '4px',
  layoutFamily: 'generic',
})

const enrichment = (): PdpEnrichment =>
  ({
    status: 'ready',
    reason: null,
    generatedAt: new Date(0).toISOString(),
    model: 'm',
    costUsd: 0,
    source: { url: PAGE, host: 'shop.test', productName: 'Thing', sku: null, mpn: null, price: null, currency: null, availability: null, images: [IMG], specifications: [], documents: [], observedFields: [], missingFields: [], description: null, brand: null, gtin: null, pageTitle: null, breadcrumbs: [] },
    research: { attempted: false, note: null, sources: [] },
    enriched: {
      enrichedTitle: 'Thing, Enriched',
      brand: null, series: null, manufacturerPartNumber: null, productType: 'Thing',
      categoryPath: ['A', 'B'], industryLabel: 'X', unspsc: null,
      description: { intro: 'An intro sentence for the thing.', bullets: ['One', 'Two', 'Three'] },
      attributes: [{ name: 'Material', value: 'Steel', source: 'enriched', sourceUrl: null }],
      documents: [], attributeHighlights: [], beforeNarrative: [], afterNarrative: [],
      keyTransformation: 'k', introParagraph: 'i', executiveSummary: 'e', normalizationNotes: [],
      auditSummary: 'a', keyImprovements: [], nextSteps: [],
      price: null, currency: null, availability: null, images: [IMG],
    },
    checks: { relabelledToEnriched: 0, droppedCommercial: 0, droppedClaimSentences: 0 },
  }) as unknown as PdpEnrichment

describe('pictures on the enriched page', () => {
  it('draws the bytes we hold instead of the link', () => {
    const html = renderEnrichedPdpHtml(enrichment(), {
      brand: { shell: shell(), theme: theme() },
      inlineImages: { [IMG]: DATA, [LOGO]: DATA },
    })
    expect(html).toContain(`src="${DATA}"`)
    expect(html).not.toContain(IMG)
    expect(html).not.toContain(LOGO)
  })

  it('keeps the link on screen when we hold no bytes', () => {
    const html = renderEnrichedPdpHtml(enrichment(), { brand: { shell: shell(), theme: theme() }, inlineImages: {} })
    expect(html).toContain(IMG)
    expect(html).toContain(LOGO)
  })

  it('draws the placeholder rather than a broken box in a capture', () => {
    const html = renderEnrichedPdpHtml(enrichment(), {
      brand: { shell: shell(), theme: theme() },
      inlineImages: {},
      onlyResolvedImages: true,
    })
    expect(html).not.toContain(IMG)
    expect(html).toContain('Product image')
  })

  it('falls back to the company name when its logo cannot be drawn in a capture', () => {
    const forScreen = brandKit(shell(), theme(), 'shop.test', {}, false)
    expect(forScreen.header).toContain(LOGO)
    const forCapture = brandKit(shell(), theme(), 'shop.test', {}, true)
    expect(forCapture.header).not.toContain(LOGO)
    expect(forCapture.header).toContain('<span>Shop Test</span>')
  })

  it('lists the pictures a document points at, once each', () => {
    const html = `<img src="${IMG}"><img src="${IMG}"><img src="${LOGO}"><img src="${DATA}">`
    expect(imageUrlsIn(html)).toEqual([IMG, LOGO])
  })
})

describe('the masthead logo', () => {
  // A product page's social-share image is the PRODUCT. Standing it in the
  // masthead reads as a broken page, so the name is set in type instead.
  const themed = (logoUrl: string | null): ThemeProfile => ({ ...theme(), logoUrl })
  const noShellLogo = (): WebsiteShell => ({ ...shell(), logoUrl: null })

  it('never uses one of the product own pictures', () => {
    const kit = brandKit(noShellLogo(), themed(IMG), 'shop.test', {}, false, [IMG])
    expect(kit.header).not.toContain(IMG)
    expect(kit.header).toContain('<span>Shop Test</span>')
  })

  it('refuses a theme picture that is not plainly a logo', () => {
    const photo = 'https://cdn.shop.test/edge-led-drop-light40-reel-4case_600.png'
    const kit = brandKit(noShellLogo(), themed(photo), 'shop.test', {}, false, [])
    expect(kit.header).not.toContain(photo)
    expect(kit.header).toContain('<span>Shop Test</span>')
  })

  it('accepts a theme picture that is the site mark', () => {
    const mark = 'https://cdn.shop.test/content/images/logo2.png'
    expect(brandKit(noShellLogo(), themed(mark), 'shop.test', {}, false, []).header).toContain(mark)
  })

  it('always prefers the logo the page own header named', () => {
    expect(brandKit(shell(), themed('https://cdn.shop.test/other-logo.png'), 'shop.test', {}, false, []).header).toContain(LOGO)
  })
})

// FINDING THE LOGO ON A PAGE THAT NEVER LABELS IT.
//
// 1st Ayd's masthead is `0019099.png` inside a plain <div class="header">.
// Nothing in the file name says logo, so the header capture named none — and
// the page reader had listed the same file among the product photos, which is
// how the customer ended up looking at their own name set in type.
describe('finding the logo on the page', () => {
  const page = (body: string) => `<html><body>${body}</body></html>`
  const HOME_LINK =
    '<div class="header"><a href="/" class="logo"><img alt="1st Ayd Corporation" src="https://shop.test/images/thumbs/0019099.png" /></a></div>'

  it('takes the picture inside the link home', () => {
    expect(findLogoOnPage(page(HOME_LINK), PAGE, '1st Ayd', [])).toBe('https://shop.test/images/thumbs/0019099.png')
  })

  it('still takes it when the page reader filed it as a product photo', () => {
    const asProduct = ['https://shop.test/images/thumbs/0019099.png']
    expect(findLogoOnPage(page(HOME_LINK), PAGE, '1st Ayd', asProduct)).toBe(asProduct[0])
  })

  it('takes a picture whose alt text is the company name', () => {
    const body = '<img alt="Acme Tools Limited" src="https://shop.test/i/44.png" />'
    expect(findLogoOnPage(page(body), PAGE, 'Acme Tools Ltd', [])).toBe('https://shop.test/i/44.png')
  })

  it('leaves a product photo alone when nothing marks it as the masthead', () => {
    const body = '<img alt="The Edge drop light" src="https://shop.test/i/light_600.png" />'
    expect(findLogoOnPage(page(body), PAGE, '1st Ayd', ['https://shop.test/i/light_600.png'])).toBeNull()
  })

  it('never takes site furniture', () => {
    const body = '<a href="/"><img alt="1st Ayd" src="https://shop.test/i/spacer.gif" /></a>'
    expect(findLogoOnPage(page(body), PAGE, '1st Ayd', [])).toBeNull()
  })

  it('says so plainly when the page carries no logo', () => {
    expect(findLogoOnPage(page('<p>no pictures here</p>'), PAGE, '1st Ayd', [])).toBeNull()
  })
})

// A PICTURE THE HEADER CANNOT SHOW.
//
// B&M publish their mark in white, because their own masthead is a dark blue
// bar. Drawn on our white header it was simply not there, and the customer saw
// a page with no logo at all.
describe('reading the logo tone', () => {
  // A minimal 8-bit RGBA PNG, built pixel by pixel so the reader is tested
  // against a real file rather than a stub.
  const png = (pixels: Array<[number, number, number, number]>, width: number): string => {
    const height = pixels.length / width
    const raw = Buffer.alloc((width * 4 + 1) * height)
    pixels.forEach(([r, g, b, a], i) => {
      const y = Math.floor(i / width)
      const at = y * (width * 4 + 1) + 1 + (i % width) * 4
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
      raw[at + 3] = a
    })
    const chunk = (type: string, body: Buffer) => {
      const out = Buffer.alloc(body.length + 12)
      out.writeUInt32BE(body.length, 0)
      out.write(type, 4, 'ascii')
      body.copy(out, 8)
      out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)) >>> 0, 8 + body.length)
      return out
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    const file = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
    return `data:image/png;base64,${file.toString('base64')}`
  }

  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buf) {
      c ^= byte
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    }
    return c ^ 0xffffffff
  }

  const fill = (count: number, px: [number, number, number, number]) => Array.from({ length: count }, () => px)
  const WHITE: [number, number, number, number] = [255, 255, 255, 255]
  const CLEAR: [number, number, number, number] = [0, 0, 0, 0]
  const NAVY: [number, number, number, number] = [30, 58, 95, 255]

  it('calls a white mark cut out of transparency light', () => {
    expect(logoToneOf(png([...fill(24, WHITE), ...fill(40, CLEAR)], 8))).toBe('light')
  })

  it('calls a dark mark on transparency dark', () => {
    expect(logoToneOf(png([...fill(24, NAVY), ...fill(40, CLEAR)], 8))).toBe('dark')
  })

  it('leaves a logo that carries its own white plate alone', () => {
    // Dark type on an opaque white background shows perfectly well as it is.
    expect(logoToneOf(png([...fill(16, NAVY), ...fill(48, WHITE)], 8))).toBe('dark')
  })

  it('says nothing about a picture it cannot read', () => {
    expect(logoToneOf('data:image/jpeg;base64,/9j/4AAQ')).toBeNull()
    expect(logoToneOf(null)).toBeNull()
  })

  it('puts a light logo on the site own colour, and an ordinary one on nothing', () => {
    const light = brandKit(shell(), theme(), 'shop.test', { [LOGO]: 'data:image/png;base64,x' }, false, [], 'light')
    expect(light.css).toMatch(/\.logo img\{background:#/)
    expect(brandKit(shell(), theme(), 'shop.test', null, false, [], 'dark').css).not.toMatch(/\.logo img\{background:/)
  })
})

// WHAT THE PAGE READER SWEPT UP WITH THE PRODUCT PHOTOGRAPHS.
//
// B&M's markup carries the search, sign-in and basket icons in the same place
// as the product, so the gallery opened on a 32-pixel magnifying glass.
describe('keeping only the product pictures', () => {
  const PRODUCT = 'https://shop.test/Content/products/images/136.jpg'
  const FURNITURE = [
    'https://shop.test/content/images/search.png',
    'https://shop.test/content/images/signin.png',
    'https://shop.test/content/images/cart.png',
    'https://shop.test/content/images/document.png',
  ]

  it('drops the interface icons and keeps the product', () => {
    expect(productPicturesOnly([...FURNITURE, PRODUCT])).toEqual([PRODUCT])
  })

  it('keeps a product whose name merely reads like furniture', () => {
    const screw = 'https://shop.test/img/button-head-screw.jpg'
    expect(productPicturesOnly([screw])).toEqual([screw])
  })

  it('drops a picture the site serves as a few hundred bytes', () => {
    const icon = 'https://shop.test/img/thing-32.png'
    const held = { [icon]: `data:image/png;base64,${'a'.repeat(600)}`, [PRODUCT]: `data:image/jpeg;base64,${'a'.repeat(40000)}` }
    expect(productPicturesOnly([icon, PRODUCT], held)).toEqual([PRODUCT])
  })

  it('never empties the gallery', () => {
    // Every picture reads as furniture — better the wrong picture than none.
    expect(productPicturesOnly(FURNITURE)).toEqual(FURNITURE)
    const tiny = { [FURNITURE[0]!]: 'data:image/png;base64,aaaa' }
    expect(productPicturesOnly([FURNITURE[0]!], tiny)).toEqual([FURNITURE[0]])
  })
})
