import { describe, expect, it, vi } from 'vitest'

// THE COUNTRY, ONLY WHERE A SOURCE STATES IT (2026-10-07).
//
// From an address the company's own website states (structured data, or a
// written address on the homepage or its contact page). Never from a domain
// ending, a phone prefix or a name, and never picked from several countries.

vi.mock('../../src/research/pageFetch.js', () => ({ fetchPageRaw: vi.fn() }))

const { countryName, countryOfLocation, countryOfLocations, countryFromWebsite, writtenAddressCountries } = await import('../../src/enrichment/companyCountry.js')

const loc = (over: Record<string, unknown> = {}) => ({
  text: 'x', city: null, region: null, postalCode: null, country: null,
  source: 'company website (address on page)' as const, sourceUrl: 'https://a.test/', ...over,
})

const ok = (url: string, html: string) => ({
  ok: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', html,
  truncated: false, bytes: html.length, redirectChain: [], reason: null, durationMs: 1,
})

describe('country names', () => {
  it('reads the ways a country is written', () => {
    expect(countryName('US')).toBe('United States')
    expect(countryName('USA')).toBe('United States')
    expect(countryName('United States of America')).toBe('United States')
    expect(countryName('DE')).toBe('Germany')
    expect(countryName('mt')).toBe('Malta')
    // An unknown spelling is kept as written, never replaced by a guess.
    expect(countryName('Deutschland')).toBe('Deutschland')
    expect(countryName('XX')).toBeNull()
    expect(countryName('')).toBeNull()
  })

  it('takes a US state with a five-digit ZIP as a US address, and nothing less', () => {
    expect(countryOfLocation(loc({ region: 'IN', postalCode: '46278' }))).toBe('United States')
    // Western Australia is also "WA"; its postcodes have four digits.
    expect(countryOfLocation(loc({ region: 'WA', postalCode: '6000' }))).toBeNull()
    expect(countryOfLocation(loc({ region: 'OH' }))).toBeNull()
  })

  it('chooses no country when the addresses name several', () => {
    const r = countryOfLocations([loc({ country: 'US' }), loc({ country: 'CA' })])
    expect(r && 'several' in r ? r.several : null).toEqual(['United States', 'Canada'])
  })
})

describe('reading the country off the company website', () => {
  it('uses the address in its structured data', async () => {
    const html =
      '<html><head><script type="application/ld+json">{"@type":"Organization","address":{"@type":"PostalAddress",' +
      '"streetAddress":"12 Merchants Street","addressLocality":"Valletta","addressCountry":"MT"}}</script></head><body>Hi</body></html>'
    const r = await countryFromWebsite('https://bonnici.test/', async (u) => ok(u, html))
    expect(r.finding).toMatchObject({ country: 'Malta', source: 'company website (structured data)', sourceUrl: 'https://bonnici.test/' })
  })

  it('opens the contact page when the homepage states no address', async () => {
    const pages: Record<string, string> = {
      'https://harbor.test/': '<html><body><a href="/contact-us">Contact us</a> Valves and fittings.</body></html>',
      'https://harbor.test/contact-us': '<html><body><p>Visit us: 1234 Main St, Akron, OH 44301</p></body></html>',
    }
    const fetcher = vi.fn(async (u: string) => ok(u, pages[u] ?? ''))
    const r = await countryFromWebsite('https://harbor.test/', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(r.finding).toMatchObject({ country: 'United States', source: 'company website (address on page)', sourceUrl: 'https://harbor.test/contact-us' })
  })

  it('says so, and guesses nothing, when no address is stated', async () => {
    const r = await countryFromWebsite('https://plain.test/', async (u) => ok(u, '<html><body>We sell tools. Call us.</body></html>'))
    expect(r.finding).toBeNull()
    expect(r.note).toMatch(/No address was stated/)
  })

  it('attributes nothing read on another site after a redirect', async () => {
    const r = await countryFromWebsite('https://old.test/', async () =>
      ok('https://parent-group.test/', '<html><body>1 Main St, Akron, OH 44301</body></html>'),
    )
    expect(r.finding).toBeNull()
    expect(r.note).toMatch(/redirected/)
  })

  it('reports an unreadable homepage as a note, not a country', async () => {
    const r = await countryFromWebsite('https://down.test/', async (u) => ({ ...ok(u, ''), ok: false, reason: 'The site returned HTTP 503.' }))
    expect(r.finding).toBeNull()
    expect(r.note).toMatch(/could not be read/)
  })
})

describe('addresses written on a page, as real company pages write them', () => {
  const read = (text: string) => writtenAddressCountries(text, 'https://x.test/contact').map((f) => f.country)

  it('reads an address that ends in its country, and a US address without the comma', () => {
    expect(read(['Contacts', 'CHINESPORT S.p.a.', 'Via Croazia, 2 - Z.A.U. 33100 UDINE - ITALY'].join('\n'))).toEqual(['Italy'])
    expect(read(['Fax 901-266-2558', '5305 Distriplex Farms Drive', 'Memphis TN 38141'].join('\n'))).toEqual(['United States'])
    expect(read(['Mdina Road', 'Qormi QRM 9010', 'Malta'].join('\n'))).toEqual(['Malta'])
    expect(read('12 High Street, London SW1A 1AA, UK')).toEqual(['United Kingdom'])
  })

  it('reads nothing from text that only mentions a country', () => {
    for (const text of [
      ['Isle of Man', 'Israel', 'Italy'].join('\n'), // a country drop-down
      ['Who do you want to get in touch with?', 'Italy'].join('\n'),
      '© 2024 TrioMed Ltd, Malta',
      'We ship to 40 countries, including Italy',
      '123 Peachtree St, Atlanta, Georgia', // a US state, not the country
      'Head office: 55 Main Rd, Newark, New Jersey',
      'AEDs Malta',
      ['+39', 'Italy'].join('\n'),
    ]) {
      expect(read(text)).toEqual([])
    }
  })
})
