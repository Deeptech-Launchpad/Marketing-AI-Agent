import { describe, expect, it } from 'vitest'
import { listingLocation, locationsOnPage, placeCompany, shortLocation, stateInObjective } from '../../src/prospects/companyLocation.js'
import { analyseCompanyWebsite } from '../../src/prospects/productPageAnalysis.js'

// WHERE A COMPANY IS — only from what a page states, and a company outside
// the state a search names is set aside, as a map search would.

const URL_ = 'https://www.apex-electric.test/'

describe('reading a company’s address from its own website', () => {
  it('reads a structured-data address', () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Apex Electric Supply",
      "address":{"@type":"PostalAddress","streetAddress":"1000 E Market St","addressLocality":"Akron","addressRegion":"OH","postalCode":"44305","addressCountry":"US"}}</script>`
    expect(locationsOnPage(html, URL_)).toEqual([
      { text: '1000 E Market St, Akron, OH 44305', city: 'Akron', region: 'OH', postalCode: '44305', country: 'US', source: 'company website (structured data)', sourceUrl: URL_ },
    ])
  })

  it('reads an address written in the footer, with the state spelt out or abbreviated', () => {
    const a = locationsOnPage('<footer>Apex Electric Supply · 1000 E Market St, Akron, OH 44305 · (330) 555-0100</footer>', URL_)
    expect(a[0]).toMatchObject({ city: 'Akron', region: 'OH', postalCode: '44305', source: 'company website (address on page)' })
    const b = locationsOnPage('<p>Visit us: Columbus, Ohio 43215</p>', URL_)
    expect(b[0]).toMatchObject({ city: 'Columbus', region: 'OH', postalCode: '43215' })
    const c = locationsOnPage('<p>Corporate Headquarters Akron, OH 44305</p>', URL_)
    expect(c[0]).toMatchObject({ city: 'Akron' })
    // Seen on real sites: the street's last word on the line above, or before the city.
    expect(locationsOnPage('<p>5801 Executive Blvd.<br>Huber Heights, OH 45424</p>', URL_)[0]).toMatchObject({ city: 'Huber Heights', region: 'OH' })
    expect(locationsOnPage('<p>1000 Exchange St. Akron, OH 44306</p>', URL_)[0]).toMatchObject({ city: 'Akron' })
    expect(locationsOnPage('<p>8150 Byrne Rd Toledo, OH 43615</p>', URL_)[0]).toMatchObject({ city: 'Toledo' })
  })

  it('reports no location when the page states none — never from a phone number or domain', () => {
    expect(locationsOnPage('<p>Call 330-555-0100. Apex Electric, your Ohio supplier.</p>', URL_)).toEqual([])
  })
})

describe('the area a search names', () => {
  it('reads a US state by its full name only', () => {
    expect(stateInObjective('electrical products distributors in ohio usa')).toEqual({ code: 'OH', name: 'Ohio' })
    expect(stateInObjective('suppliers in the usa')).toBeNull()
    expect(stateInObjective('distributors in West Virginia')).toEqual({ code: 'WV', name: 'West Virginia' })
  })

  it('keeps a company with an address in the state, and sets aside one whose every address is elsewhere', () => {
    const ohio = { code: 'OH', name: 'Ohio' }
    const akron = locationsOnPage('<p>1000 E Market St, Akron, OH 44305</p>', URL_)
    const dallas = locationsOnPage('<p>200 Main St, Dallas, TX 75201</p>', URL_)
    expect(placeCompany(akron, ohio, '')).toMatchObject({ outsideArea: false })
    expect(placeCompany(dallas, ohio, 'Serving Texas since 1970')).toMatchObject({ outsideArea: true })
    // A branch in the state wins over a head office elsewhere.
    const both = [...dallas, ...akron]
    expect(placeCompany(both, ohio, '')).toMatchObject({ outsideArea: false, location: { city: 'Akron' } })
    // Saying it serves the state is enough to keep it.
    expect(placeCompany(dallas, ohio, 'Branches across Texas and Ohio')).toMatchObject({ outsideArea: false })
    // No address stated is unknown, not outside.
    expect(placeCompany([], ohio, '')).toEqual({ location: null, outsideArea: false })
  })
})

describe('a location printed on a listing page', () => {
  it('is kept only when written on that page', () => {
    const page = 'Apex Electric Supply — Akron, OH — Electrical supply store — 4.9 stars'
    expect(listingLocation('Akron, OH', page, 'https://listing.test/')).toMatchObject({ city: 'Akron', region: 'OH', source: 'listing page' })
    expect(listingLocation('Cleveland, OH', page, 'https://listing.test/')).toBeNull()
    expect(listingLocation('Rausch Dr. Plain City, OH', 'Mahoney — Rausch Dr. Plain City, OH', 'https://listing.test/')).toMatchObject({ city: 'Plain City' })
    expect(shortLocation(listingLocation('Akron, OH', page, 'https://listing.test/')!)).toBe('Akron, OH')
  })
})

describe('the website check, end to end', () => {
  const site = (pages: Record<string, string>) => async (url: string) => {
    const html = pages[url]
    return html
      ? { ok: true, status: 200, finalUrl: url, html, contentType: 'text/html', reason: null, durationMs: 1, bytes: html.length }
      : { ok: false, status: 404, finalUrl: url, html: '', contentType: null, reason: 'not found', durationMs: 1, bytes: 0 }
  }

  it('sets aside a company whose own website places it outside the searched state, and says where it is', async () => {
    const r = await analyseCompanyWebsite({
      websiteUrl: 'https://www.texas-electric.test/',
      objective: 'electrical distributors in Ohio',
      read: null,
      fetch: site({ 'https://www.texas-electric.test/': '<html><body><h1>Texas Electric</h1><p>200 Main St, Dallas, TX 75201</p></body></html>' }) as never,
    })
    expect(r.status).toBe('not_relevant')
    expect(r.statusReason).toMatch(/places it in Dallas, TX — outside Ohio/)
    expect(r.companyLocation).toMatchObject({ city: 'Dallas', region: 'TX' })
  })

  it('reads the address from the contact page when the homepage states none', async () => {
    const r = await analyseCompanyWebsite({
      websiteUrl: 'https://www.apex-electric.test/',
      objective: 'electrical distributors in Ohio',
      read: null,
      fetch: site({
        'https://www.apex-electric.test/': '<html><body><h1>Apex Electric</h1><a href="/contact-us">Contact us</a></body></html>',
        'https://www.apex-electric.test/contact-us': '<html><body><p>1000 E Market St, Akron, OH 44305</p></body></html>',
      }) as never,
    })
    expect(r.status).not.toBe('not_relevant')
    expect(r.companyLocation).toMatchObject({ city: 'Akron', region: 'OH', source: 'company website (address on page)' })
  })
})

describe('filtering out what is not a company, and listing each company once', async () => {
  const { looksLikeCompanySite } = await import('../../src/prospects/companyIdentification.js')
  const { companyKey } = await import('../../src/prospects/companyWebDiscovery.js')

  it('never takes a job board, map app, data vendor or public institution for a company', () => {
    for (const host of ['www.monster.com', 'www.ziprecruiter.com', 'www.waze.com', 'craft.co', 'safer.fmcsa.dot.gov', 'procurement.umich.edu', 'pitchbook.com']) {
      expect(looksLikeCompanySite(host), host).toBe(false)
    }
    expect(looksLikeCompanySite('www.ohioelectricsupply.com')).toBe(true)
  })

  it('matches one company across its naming variants, and keeps different companies apart', () => {
    expect(companyKey('The F.D. Lawrence Electric Company')).toBe(companyKey('F.D. Lawrence Electric Co.'))
    expect(companyKey('Buckeye Power Sales Co.')).toBe(companyKey('Buckeye Power Sales'))
    expect(companyKey('Cooper Electric')).not.toBe(companyKey('Cooper Electrical Sales'))
  })
})
