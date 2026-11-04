import { describe, expect, it } from 'vitest'
import { describeFetchFailure } from '../../src/research/pageFetch.js'
import { interpretWebsiteFailure, looksLikeBlockPage, looksLikePlaceholderSite, researchUnreadable } from '../../src/warmleads/websiteAccess.js'

// A website that cannot be read says nothing about the company (the first test
// run reported eight companies "unreachable" that a network filter was blocking).

describe('interpreting a failed website read', () => {
  it('every network, firewall and access failure is retryable; only the site saying "no such page" is not', () => {
    const cases: Array<[string, string, boolean]> = [
      ['The site reset the connection.', 'connection_reset', true],
      ['The site took too long to respond.', 'timeout', true],
      ['The connection to that site timed out.', 'timeout', true],
      ['That domain could not be resolved.', 'dns', true],
      ['DNS lookup for that domain failed temporarily.', 'dns', true],
      ['The site refused the connection.', 'refused', true],
      ["The site's TLS certificate has expired.", 'tls', true],
      ['HTTP 403.', 'access_denied', true],
      ['HTTP 401.', 'access_denied', true],
      ['HTTP 429.', 'rate_limited', true],
      ['The site returned HTTP 503.', 'server_error', true],
      ['Could not reach that site (EPROTO).', 'other', true],
      ['', 'other', true],
      ['HTTP 404.', 'not_found', false],
      ['The site returned HTTP 410.', 'not_found', false],
    ]
    for (const [reason, kind, retryable] of cases) {
      const r = interpretWebsiteFailure(reason)
      expect({ reason, kind: r.kind, retryable: r.retryable }).toEqual({ reason, kind, retryable })
    }
  })

  it('understands every sentence the fetcher can produce for a thrown error', () => {
    const codes = ['UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE']
    for (const code of codes) {
      const r = interpretWebsiteFailure(describeFetchFailure({ cause: { code } }))
      expect(r.retryable, code).toBe(true)
      expect(r.kind, code).not.toBe('not_found')
    }
    expect(interpretWebsiteFailure(describeFetchFailure({ name: 'TimeoutError' })).kind).toBe('timeout')
  })

  it('the message says it is about the network and tells what to do, without blaming the company', () => {
    const r = interpretWebsiteFailure('The site reset the connection.')
    expect(r.message).toMatch(/could not be read: the connection was reset/)
    expect(r.message).toMatch(/says nothing about the company/)
    expect(r.message).toMatch(/retry/i)
    expect(interpretWebsiteFailure('HTTP 404.').message).toMatch(/does not exist/)
  })
})

describe('firewall and bot-wall pages', () => {
  it('recognises the block, challenge and error pages seen in practice', () => {
    for (const t of [
      'Web Site Blocked',
      'Website Blocked',
      'Access Denied',
      '403 Forbidden',
      'Forbidden',
      'Attention Required! | Cloudflare',
      'Just a moment...',
      'Checking your browser before accessing',
      'Network Security Appliance',
      'Request blocked',
      'Are you a robot?',
      'Error 1020',
    ]) {
      expect(looksLikeBlockPage(t), t).toBe(true)
    }
    // the description can carry it when the title does not
    expect(looksLikeBlockPage('Welcome', 'This site has been blocked by your network administrator')).toBe(true)
  })

  it('never mistakes a real company page for one', () => {
    for (const t of [
      'Acme Pumps | Industrial pumps and valves',
      'Firewall systems for data centres - Acme Networks', // a company that SELLS firewalls
      'Access control and door hardware',
      'Forbidden City Tours',
      'Just a Moment Bakery',
      '',
    ]) {
      expect(looksLikeBlockPage(t), t).toBe(false)
    }
    expect(looksLikeBlockPage(null, undefined)).toBe(false)
    expect(looksLikeBlockPage('x'.repeat(400) + ' Web Site Blocked')).toBe(false) // a long page text is not a title
  })
})

describe('hosting placeholder pages', () => {
  it('a suspended, parked, expired or empty site is the site saying there is nothing there', () => {
    for (const t of ['Account Suspended', 'Account has been suspended', 'This domain is parked', 'Domain for sale', 'Parked Domain', 'Default Web Site Page', 'Coming Soon', 'Under Construction', 'Website expired', '404 Not Found', 'Page not found', 'Site not found - Acme Hosting']) {
      expect(looksLikePlaceholderSite(t), t).toBe(true)
    }
  })
  it('a real company page is never one', () => {
    for (const t of ['Suspended Ceilings Ltd | Ceiling systems', 'Parker Hannifin - Motion and Control', 'Coming Soon Bakery & Cafe', 'Parking Solutions Ltd', 'Not Found Tools', 'Account Management Software | Acme', '']) {
      expect(looksLikePlaceholderSite(t), t).toBe(false)
    }
    expect(looksLikePlaceholderSite(null, undefined)).toBe(false)
  })
})

describe('web research that read nothing', () => {
  const page = (ok: boolean, reason?: string) => ({ ok, url: 'https://x.example', events: 0, ...(reason ? { reason } : {}) })

  it('found pages but read none of them = unreadable (the search-result links could not even be opened)', () => {
    const r = researchUnreadable([
      { provider: 'crm', metadata: { errors: [] } },
      { provider: 'social_profiles', metadata: { pagesRead: ['https://x.example/', 'https://x.example/about'] } }, // strings: the company's own site, not counted
      { provider: 'public_research', metadata: { pagesRead: [page(false, 'That domain could not be resolved.'), page(false, 'That domain could not be resolved.')] } },
      { provider: 'external_sources', metadata: { pagesRead: [page(false, 'The site reset the connection.')] } },
    ])
    expect(r).toMatch(/found 3 page\(s\) but could read none of them/)
    expect(r).toMatch(/could not be resolved/)
  })

  it('reading even one page is enough; and no pages found at all is a real "nothing found"', () => {
    expect(researchUnreadable([{ metadata: { pagesRead: [page(false, 'x'), page(true)] } }])).toBeNull()
    expect(researchUnreadable([{ metadata: { pagesRead: [] } }, { provider: 'technology', metadata: {} }])).toBeNull()
    expect(researchUnreadable(null)).toBeNull()
    expect(researchUnreadable('nope')).toBeNull()
  })
})
