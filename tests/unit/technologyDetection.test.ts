import { describe, expect, it } from 'vitest'
import { detectSignals, PLATFORM_SIGNATURES } from '../../src/research/htmlToText.js'
import { chooseWebsite } from '../../src/enrichment/companyEnrichment.js'
import type { CrmCompany } from '../../src/crm/types.js'

// Stage 2 detection. The contract is: a technology is only reported when the
// page contains markup that proves it, and the proof is stored alongside.

const page = (body: string) => `<!doctype html><html><head><title>Acme Ltd</title>
<meta name="description" content="Industrial supplies"></head><body>${body}</body></html>`

function company(over: Partial<CrmCompany> = {}): CrmCompany {
  return {
    id: 'c1',
    name: 'Acme',
    email: null,
    emails: [],
    phone: null,
    domain: null,
    industry: null,
    country: null,
    cms: null,
    leadStatus: null,
    status: null,
    remarks: null,
    notes: null,
    endPdpUrl: null,
    contactPersons: [],
    linkedProfiles: [],
    ownerId: null,
    ownerName: null,
    dealCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...over,
  }
}

describe('known CMS / platform detection', () => {
  it('detects Shopify from its CDN host and keeps the proof', () => {
    const s = detectSignals(page('<img src="https://cdn.shopify.com/s/files/1/0001/x.png">'))
    expect(s.platforms).toContain('Shopify')
    const tech = s.technologies.find((t) => t.name === 'Shopify')!
    expect(tech.category).toBe('ecommerce')
    expect(tech.evidence).toContain('cdn.shopify.com')
  })

  it('detects Magento without the historical image/ false positive', () => {
    expect(detectSignals(page('<script src="/static/version1234/frontend/x.js">')).platforms).toContain('Magento')
    // The bug this guards: /mage\// also matches "i-mage/", so every
    // "image/jpeg" tag used to tag plain WordPress sites as Magento.
    const wp = detectSignals(page('<img src="/uploads/image/logo.png"><link href="/wp-content/x.css">'))
    expect(wp.platforms).toContain('WordPress')
    expect(wp.platforms).not.toContain('Magento')
  })

  it('detects a PIM and an ERP with the right category', () => {
    // Fixture updated: a bare "hybris" in body copy used to count as proof of
    // SAP Commerce. The storefront's /_ui/ asset path is the real trace.
    const s = detectSignals(page('<script src="https://cdn.salsify.com/p.js"></script><link href="/_ui/responsive/common/css/style.css">'))
    expect(s.technologies.find((t) => t.name === 'Salsify (PIM)')?.category).toBe('pim')
    expect(s.technologies.find((t) => t.name === 'SAP Commerce (Hybris)')?.category).toBe('erp')
  })
})

describe('multiple and duplicate signals', () => {
  it('reports several distinct technologies from one page', () => {
    const s = detectSignals(
      // Fixture updated: bare "epicor" prose is no longer evidence; an Epicor
      // SaaS host is.
      page('<link href="/wp-content/a.css"><script src="https://cdn.salsify.com/p.js"></script><script src="https://shop1.epicorsaas.com/x.js"></script>'),
    )
    const names = s.technologies.map((t) => t.name)
    expect(names).toContain('WordPress')
    expect(names).toContain('Salsify (PIM)')
    expect(names).toContain('Epicor')
    expect(s.technologies.every((t) => t.evidence.length > 0)).toBe(true)
  })

  it('reports Shopify ONCE even though two signatures match it', () => {
    // Shopify has two entries in the table; a site hitting both is one
    // detection, not two.
    const s = detectSignals(page('<img src="https://cdn.shopify.com/a.png"><script src="https://cdn.shopifycloud.com/b.js">'))
    expect(s.technologies.filter((t) => t.name === 'Shopify')).toHaveLength(1)
    expect(s.platforms.filter((p) => p === 'Shopify')).toHaveLength(1)
  })

  it('reports the same technology once when its pattern matches repeatedly', () => {
    const s = detectSignals(page('<a href="/wp-content/1">a</a><a href="/wp-content/2">b</a><a href="/wp-includes/3">c</a>'))
    expect(s.technologies.filter((t) => t.name === 'WordPress')).toHaveLength(1)
  })
})

describe('unknown / absent technology', () => {
  it('returns an empty list rather than guessing', () => {
    const s = detectSignals(page('<div class="content">Plain hand-written HTML.</div>'))
    expect(s.technologies).toEqual([])
    expect(s.platforms).toEqual([])
  })

  it('does not fabricate a detection from ordinary prose', () => {
    // "information" contains "infor"; "salesforce" as a word in body copy is a
    // known weakness and is asserted explicitly below, not glossed over.
    const s = detectSignals(page('<p>For more information about our products, contact us.</p>'))
    expect(s.technologies.map((t) => t.name)).not.toContain('Epicor')
    expect(s.technologies).toEqual([])
  })
})

describe('evidence preservation', () => {
  it('captures surrounding context so a false positive is visible on sight', () => {
    const s = detectSignals(page('<script src="https://cdn.salsify.com/accounts/12345/bundle.js"></script>'))
    const ev = s.technologies[0]!.evidence
    expect(ev).toContain('salsify.com')
    // Wider than the bare token, so the match can be judged without re-fetching.
    expect(ev.length).toBeGreaterThan('cdn.salsify.com'.length)
    expect(ev.length).toBeLessThanOrEqual(160)
  })

  it('every signature carries a name and a category', () => {
    PLATFORM_SIGNATURES.forEach((sig) => {
      expect(sig.name.length).toBeGreaterThan(0)
      expect(['ecommerce', 'cms', 'pim', 'erp', 'framework']).toContain(sig.category)
    })
  })
})

describe('website selection', () => {
  it('prefers Company.domain and reports which field it used', () => {
    const w = chooseWebsite(company({ domain: 'acme.example', endPdpUrl: 'https://acme.example/p/1' }))
    expect(w?.source).toBe('Company.domain')
    expect(w?.url).toBe('https://acme.example/')
  })

  it('falls back to the product URL when no domain is stored', () => {
    const w = chooseWebsite(company({ endPdpUrl: 'https://acme.example/product/1' }))
    expect(w?.source).toBe('Company.endPdpUrl')
  })

  it('returns null when the CRM holds no usable website', () => {
    expect(chooseWebsite(company())).toBeNull()
    expect(chooseWebsite(company({ domain: '   ' }))).toBeNull()
  })

  it('refuses a non-http scheme rather than repairing it into a real host', () => {
    // normalizeUrl must not turn file:///etc/passwd into https://file/etc/passwd.
    expect(chooseWebsite(company({ domain: 'file:///etc/passwd' }))).toBeNull()
    expect(chooseWebsite(company({ domain: 'javascript:alert(1)' }))).toBeNull()
  })
})

describe('self-declared platform (meta generator)', () => {
  it('reports a generator the fingerprint table does not know about', () => {
    // Found on real prospect sites: nopCommerce and "The IPG Member Platform".
    // No asset-path heuristic would ever have matched the second one.
    const s = detectSignals(
      '<html><head><meta name="generator" content="The IPG Member Platform"></head><body>x</body></html>',
    )
    const tech = s.technologies.find((t) => t.name === 'The IPG Member Platform')
    expect(tech).toBeDefined()
    expect(tech!.category).toBe('declared')
    expect(tech!.evidence).toContain('generator')
  })

  it('does not double-report a platform already matched by a fingerprint', () => {
    const s = detectSignals(
      '<html><head><meta name="generator" content="nopCommerce"></head><body>nopcommerce</body></html>',
    )
    expect(s.technologies.filter((t) => /nopcommerce/i.test(t.name))).toHaveLength(1)
  })

  it('reports nothing when the page declares no generator', () => {
    expect(detectSignals('<html><head></head><body>plain</body></html>').technologies).toEqual([])
  })

  it('folds a site-builder generator into the matching fingerprint', () => {
    const s = detectSignals(
      '<html><head><meta name="generator" content="Wix.com Website Builder"><script src="https://static.parastorage.com/x.js"></script></head><body><img src="https://static.wixstatic.com/media/a.jpg"></body></html>',
    )
    expect(s.technologies.map((t) => t.name)).toEqual(['Wix'])
  })

  it('strips the version and does not list WordPress twice', () => {
    const s = detectSignals(
      '<html><head><meta name="generator" content="WordPress 7.0.4"><link href="/wp-content/themes/t/style.css"></head><body></body></html>',
    )
    expect(s.technologies.map((t) => t.name)).toEqual(['WordPress'])
    expect(s.generator).toBe('WordPress 7.0.4')
  })

  it('does not count plugin generators as technologies', () => {
    const s = detectSignals(
      '<html><head><meta name="generator" content="Site Kit by Google 1.187.0">' +
        '<meta name="generator" content="Powered by WPBakery Page Builder - drag and drop page builder for WordPress.">' +
        '<meta name="generator" content="WordPress 6.5"><link href="/wp-content/a.css"></head><body></body></html>',
    )
    expect(s.technologies.map((t) => t.name)).toEqual(['WordPress'])
    expect(s.generators).toHaveLength(3)
  })

  it('reads generator tags in either attribute order', () => {
    const s = detectSignals('<html><head><meta content="Acme Commerce Suite 4.2" name="generator"></head><body></body></html>')
    expect(s.technologies).toEqual([expect.objectContaining({ name: 'Acme Commerce Suite', category: 'declared' })])
  })

  it('a declared platform generator is recorded under its canonical name', () => {
    const s = detectSignals('<html><head><meta name="generator" content="Drupal 10 (https://www.drupal.org)"></head><body></body></html>')
    expect(s.technologies).toEqual([expect.objectContaining({ name: 'Drupal', category: 'cms' })])
  })
})

describe('WordPress vs WooCommerce', () => {
  it('labels a plain wp-content site WordPress, not WooCommerce', () => {
    const names = detectSignals(page('<link href="/wp-content/themes/x/style.css">')).technologies.map((t) => t.name)
    expect(names).toEqual(['WordPress'])
  })

  it('reports WooCommerce only with WooCommerce evidence', () => {
    const names = detectSignals(
      page('<link href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css"><body class="home woocommerce-page">'),
    ).technologies.map((t) => t.name)
    expect(names).toContain('WordPress')
    expect(names).toContain('WooCommerce')
  })

  it('does not treat the word WooCommerce in prose as a shop', () => {
    const names = detectSignals(page('<p>We build WooCommerce and Shopify stores for clients.</p>')).technologies.map((t) => t.name)
    expect(names).toEqual([])
  })
})

describe('vendor words in ordinary prose are not detections', () => {
  const prose = [
    'We integrate with Salesforce and Epicor ERP.',
    'Migrated from Hybris to a new platform.',
    'Our PIM partner is Pimcore; we also evaluated PrestaShop, Shopware, OpenCart and nopCommerce.',
    '<a href="https://www.squarespace.com">Squarespace</a> was our old host.',
  ]
  it.each(prose)('%s', (text) => {
    expect(detectSignals(page(`<p>${text}</p>`)).technologies).toEqual([])
  })

  it('still detects the anchored true positives', () => {
    const cases: Array<[string, string]> = [
      ['<img src="https://static1.squarespace.com/static/a.png">', 'Squarespace'],
      ['<script src="/on/demandware.static/Sites-x/js/main.js"></script>', 'Salesforce Commerce Cloud'],
      ['<script>var prestashop = {"cart":{}}</script>', 'PrestaShop'],
      ['<link href="/bundles/storefront/assets/css/app.css">', 'Shopware'],
      ['<link href="/catalog/view/theme/default/stylesheet.css">', 'OpenCart'],
      ['<script src="/js/public.common.js"></script>', 'nopCommerce'],
      ['<script src="/bundles/pimcoreadmin/js/x.js"></script>', 'Pimcore (PIM)'],
      ['<img src="/medias/abc.jpg?context=bWFzdGVy">', 'SAP Commerce (Hybris)'],
      ['<script src="https://acme.epicorsaas.com/app.js"></script>', 'Epicor'],
    ]
    for (const [markup, name] of cases) {
      expect(detectSignals(page(markup)).technologies.map((t) => t.name)).toContain(name)
    }
  })
})
