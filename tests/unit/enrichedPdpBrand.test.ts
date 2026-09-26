import { describe, expect, it } from 'vitest'
import { brandKit, luminance, renderEnrichedPdpHtml } from '../../src/workbench/enrichedPdpPage.js'
import { brandColourFrom } from '../../src/workbench/enrichedPdpBrand.js'
import type { PdpEnrichment } from '../../src/websiteaudit/pdpEnrichment.js'
import type { ThemeProfile } from '../../src/workbench/types.js'
import type { WebsiteShell } from '../../src/workbench/websiteShell.js'

// THE WORKBENCH "AFTER" PAGE WEARS THE CUSTOMER'S OWN BRANDING.
//
//   Before: the customer's website as it is.
//   After:  the same company's logo, navigation, colours, fonts and footer
//           around our enriched product-page structure — never AltiusNxt's.
//
// Brand values come from someone else's website, so every one must be
// sanitised before it reaches CSS or markup. Without a brand the page is
// unchanged, which is what keeps the report's capture unchanged.

const COMPANIES = [
  { name: 'Northwind Fasteners', host: 'northwind.test', primary: '#0b6e4f', nav: ['Home', 'Fixings', 'Tools', 'Contact'] },
  { name: 'Lumière Sanitaire', host: 'lumiere.test', primary: '#c2410c', nav: ['Accueil', 'Robinetterie', 'Salles de bain'] },
] as const

const shell = (c: (typeof COMPANIES)[number], over: Partial<WebsiteShell> = {}): WebsiteShell => ({
  captured: true,
  reason: null,
  sourceUrl: `https://${c.host}/p/1`,
  siteName: c.name,
  host: c.host,
  logoUrl: `https://${c.host}/logo.png`,
  logoAlt: c.name,
  nav: c.nav.map((label) => ({ label, href: null })),
  hasSearch: true,
  utility: [{ label: 'My account', href: null }],
  footerLinks: [{ label: 'Delivery', href: null }, { label: 'Returns', href: null }],
  footerText: `© 2026 ${c.name}`,
  social: [{ platform: 'facebook', href: 'https://facebook.com/x' }],
  notCaptured: [],
  ...over,
})

const theme = (primary: string, over: Partial<ThemeProfile> = {}): ThemeProfile => ({
  source: 'live_sample',
  reason: null,
  primary,
  accent: '#333333',
  ink: '#111827',
  surface: '#ffffff',
  muted: '#6b7280',
  fontFamily: 'Manrope, sans-serif',
  headingFamily: 'Manrope, sans-serif',
  logoUrl: null,
  radius: '8px',
  layoutFamily: 'generic',
  ...over,
})

const enrichment = (host: string): PdpEnrichment =>
  ({
    status: 'ready',
    reason: null,
    generatedAt: new Date(0).toISOString(),
    model: 'm',
    costUsd: 0,
    source: { url: `https://${host}/p/1`, host, productName: 'Item', brand: null, sku: null, mpn: null, gtin: null, price: '10', currency: 'EUR', availability: 'In Stock', description: null, images: [], specifications: [], documents: [], observedFields: [], missingFields: [], pageTitle: null, breadcrumbs: [] },
    research: { attempted: false, note: null, sources: [] },
    enriched: {
      enrichedTitle: 'Enriched Item',
      brand: null,
      series: null,
      manufacturerPartNumber: null,
      productType: 'Item',
      categoryPath: ['A', 'B'],
      industryLabel: 'X',
      unspsc: null,
      description: { intro: 'Intro text for the item.', bullets: ['One', 'Two', 'Three'] },
      attributes: [{ name: 'Material', value: 'Steel', source: 'enriched', sourceUrl: null }],
      documents: [],
      attributeHighlights: [],
      beforeNarrative: [],
      afterNarrative: [],
      keyTransformation: 'k',
      introParagraph: 'i',
      executiveSummary: 'e',
      normalizationNotes: [],
      auditSummary: 'a',
      keyImprovements: [],
      nextSteps: [],
      price: '10',
      currency: 'EUR',
      availability: 'In Stock',
      images: [],
    },
    checks: { relabelledToEnriched: 0, droppedCommercial: 0, droppedClaimSentences: 0 },
  }) as unknown as PdpEnrichment

describe('the branded After page', () => {
  for (const c of COMPANIES) {
    it(`wears the company's logo, name, navigation, colour and footer — not AltiusNxt's — ${c.name}`, () => {
      const html = renderEnrichedPdpHtml(enrichment(c.host), { brand: { shell: shell(c), theme: theme(c.primary) } })
      expect(html).toContain(`https://${c.host}/logo.png`)
      for (const label of c.nav) expect(html).toContain(`<span>${label.replace(/&/g, '&amp;')}</span>`)
      expect(html).toContain(`.nav{background:${c.primary}}`)
      expect(html).toContain('Manrope')
      expect(html).toContain('Returns')
      expect(html).toContain(`© 2026 ${c.name}`)
      expect(html).not.toContain('ALL CATEGORIES</div><span>HOME</span>')
      expect(html).not.toMatch(/Altius<b>Nxt<\/b>/)
      // Our enriched structure is still the page.
      for (const section of ['Product Description', 'Technical Specifications', 'Attachments', 'Reviews and Ratings']) {
        expect(html).toContain(section)
      }
    })
  }

  it('renders exactly as before when no brand is given (the report capture)', () => {
    const html = renderEnrichedPdpHtml(enrichment('a.test'))
    expect(html).toContain('ALL CATEGORIES</div><span>HOME</span>')
    expect(html).not.toContain('<footer class="foot">')
  })

  it('never uses AltiusNxt branding when the site gave nothing usable', () => {
    const html = renderEnrichedPdpHtml(enrichment('bare.test'), { brand: { shell: null, theme: null } })
    expect(html).toContain('bare.test')
    expect(html).not.toMatch(/Altius<b>Nxt<\/b>/)
  })

  it('uses the site name as the wordmark when there is no logo', () => {
    const c = COMPANIES[0]
    const kit = brandKit(shell(c, { logoUrl: null }), theme(c.primary), c.host)
    expect(kit.header).toContain(`<span>${c.name}</span>`)
  })

  it('refuses CSS and markup injection from captured brand values', () => {
    const c = COMPANIES[0]
    const kit = brandKit(
      shell(c, { siteName: '<script>alert(1)</script>', nav: [{ label: '"><img src=x onerror=alert(1)>', href: null }], logoUrl: 'javascript:alert(1)' }),
      theme('red;}body{display:none', { fontFamily: 'x;}</style><script>', radius: '999px;}' }),
      c.host,
    )
    expect(kit.header).not.toContain('<script>')
    expect(kit.header).not.toContain('<img src=x')
    expect(kit.header).not.toContain('javascript:')
    expect(kit.css).not.toContain('display:none')
    expect(kit.css).not.toContain('</style>')
    expect(kit.css).toContain('border-radius:4px')
  })

  it('keeps text readable: a pale brand colour hands buttons to the site ink', () => {
    const c = COMPANIES[0]
    const kit = brandKit(shell(c), theme('#f5f5dc'), c.host)
    expect(kit.css).toContain('.cart{background:#111827;color:#ffffff')
    expect(luminance('#ffffff')).toBeGreaterThan(0.9)
    expect(luminance('#000000')).toBe(0)
  })
})

describe('reading the brand colour from a stylesheet', () => {
  it('prefers colours used on buttons, the header and links over repeated error styles', () => {
    const css = `
      .form-error, .alert-danger { color: #cc3b3b } .form-error { border-color: #cc3b3b } .invalid { color: #cc3b3b }
      .site-header { background: #f0523d } .btn-primary { background: #f0523d } a:hover { color: #f0523d }
      body { color: #333333; background: #ffffff }`
    expect(brandColourFrom(css)).toBe('#f0523d')
  })

  it('ignores greys, near-white and near-black', () => {
    expect(brandColourFrom('.btn{color:#777777} .nav{background:#fafafa} .header{color:#0a0a0a}')).toBeNull()
  })

  it('reads brand custom properties and rgb() values', () => {
    expect(brandColourFrom(':root{--brand-primary: #2563eb}')).toBe('#2563eb')
    expect(brandColourFrom('.button{background: rgb(22, 163, 74)}')).toBe('#16a34a')
  })
})
