import { describe, expect, it } from 'vitest'
import { classifyCompanyUrl, resolveCompanySource } from '../../src/crm/companySource.js'
import { chooseWebsite } from '../../src/enrichment/companyEnrichment.js'
import type { CrmCompany } from '../../src/crm/types.js'

// WHAT COUNTS AS A COMPANY'S WEBSITE.
//
// The bug this file exists for: a CRM record whose website column read
// "facebook.com". Enrichment fetched the platform's front door, the fetch
// failed, and the failure was reported as THE CUSTOMER'S WEBSITE being
// unreadable — a statement about their business that was never true. Website
// Audit then had nothing to crawl, for a reason nobody could see.
//
// Three engines read one field and reached three different conclusions. The
// fix is not a better error message; it is that the question "is this a
// website" now has exactly one answer.
//
// The distinction that matters most is the one between a platform ROOT and a
// platform PROFILE. facebook.com identifies nobody. facebook.com/danucstore
// identifies this company, is genuinely useful, and belongs to Intent Signals
// — not to a crawler.

const company = (over: Partial<CrmCompany> = {}): CrmCompany =>
  ({
    id: 'cmp-1',
    name: 'Acme Supplies',
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as CrmCompany

// ── 1. A platform root is never a website ────────────────────────────────

describe('a social platform is not a company website', () => {
  it('classifies a bare platform root as a root, not a site', () => {
    for (const url of [
      'https://facebook.com/',
      'https://www.facebook.com',
      'facebook.com',
      'https://instagram.com/',
      'https://www.linkedin.com/',
      'https://x.com/',
      'https://youtube.com/',
    ]) {
      expect(classifyCompanyUrl(url).kind, url).toBe('platform_root')
    }
  })

  it('never offers a platform root to a crawler', () => {
    const c = company({ domain: 'facebook.com' })
    expect(resolveCompanySource(c).websiteUrl).toBeNull()
    expect(chooseWebsite(c)).toBeNull()
  })

  it('rejects a platform utility path as an account', () => {
    for (const url of ['https://facebook.com/login', 'https://linkedin.com/feed', 'https://instagram.com/explore']) {
      expect(classifyCompanyUrl(url).kind, url).toBe('platform_root')
    }
  })
})

// ── 2. A real domain is the primary website ──────────────────────────────

describe('a company domain is the primary website', () => {
  it('classifies a real site as the primary website', () => {
    for (const url of ['https://accleaning.com.au/', 'accleaning.com.au', 'http://danuc.com.mt/shop']) {
      expect(classifyCompanyUrl(url).kind, url).toBe('primary_website')
    }
  })

  it('resolves it, and names the field it came from', () => {
    const r = resolveCompanySource(company({ domain: 'accleaning.com.au' }))
    expect(r.kind).toBe('primary_website')
    expect(r.websiteUrl).toContain('accleaning.com.au')
    expect(r.websiteField).toBe('Company.domain')
    expect(r.reason).toBeNull()
  })

  it('hands the same site to enrichment', () => {
    expect(chooseWebsite(company({ domain: 'accleaning.com.au' }))?.url).toContain('accleaning.com.au')
  })

  it('is not confused by a domain that merely contains a platform name', () => {
    expect(classifyCompanyUrl('https://facebook-marketing-agency.com').kind).toBe('primary_website')
  })
})

// ── 3. Social-only: no website, social retained ──────────────────────────

describe('a company with only a social presence', () => {
  const danuc = company({
    name: 'DANUC Hardware Store',
    domain: 'facebook.com',
    endPdpUrl: 'https://www.facebook.com/danucstore/',
    email: 'admin@danielpetrilagroup.com',
    emails: ['admin@danielpetrilagroup.com'],
  })

  it('has no primary website', () => {
    const r = resolveCompanySource(danuc)
    expect(r.kind).toBe('social_only')
    expect(r.websiteUrl).toBeNull()
  })

  it('keeps the social profile, with the field it came from', () => {
    const r = resolveCompanySource(danuc)
    expect(r.socialSources).toHaveLength(1)
    expect(r.socialSources[0]).toMatchObject({
      platform: 'facebook',
      url: 'https://facebook.com/danucstore',
      field: 'Company.endPdpUrl',
    })
  })

  it('explains which problem this is, so an operator can act on it', () => {
    const r = resolveCompanySource(danuc)
    expect(r.reason).toContain('holds a social platform address')
    expect(r.reason).toContain('facebook profile is kept as a social source')
  })

  // Offered for a caller that can check it. Never adopted here.
  it('offers a domain implied by the corporate address, marked unverified', () => {
    const r = resolveCompanySource(danuc)
    expect(r.candidateWebsiteUrl).toBe('https://danielpetrilagroup.com')
    expect(r.candidateReason).toContain('Unverified')
    // The candidate is NOT the website, and must never be crawled as one.
    expect(r.websiteUrl).toBeNull()
    expect(chooseWebsite(danuc)).toBeNull()
  })

  it('derives no candidate from a free mailbox', () => {
    const r = resolveCompanySource(company({ domain: 'facebook.com', emails: ['danuc.store@gmail.com'] }))
    expect(r.candidateWebsiteUrl).toBeNull()
  })

  it('says so plainly when the record holds nothing at all', () => {
    const r = resolveCompanySource(company())
    expect(r.kind).toBe('none')
    expect(r.socialSources).toEqual([])
    expect(r.reason).toContain('no website and no social profile')
  })
})

// ── 4. Every engine reads the same answer ────────────────────────────────

describe('one field, one interpretation', () => {
  // The failure was three engines disagreeing about one column. These assert
  // they cannot: enrichment's picker is built on the resolver, and the audit's
  // start-URL resolver is too.
  it('enrichment and the resolver agree on a social-only record', () => {
    const c = company({ domain: 'facebook.com', endPdpUrl: 'https://facebook.com/danucstore/' })
    expect(resolveCompanySource(c).websiteUrl).toBeNull()
    expect(chooseWebsite(c)).toBeNull()
  })

  it('enrichment and the resolver agree on a real site', () => {
    const c = company({ domain: 'accleaning.com.au' })
    expect(resolveCompanySource(c).websiteUrl).toBeTruthy()
    expect(chooseWebsite(c)).not.toBeNull()
  })

  // Field precedence is unchanged by this fix — Company.domain first — and
  // that is deliberate: the bug was about WHICH VALUES are eligible, not about
  // which field wins among eligible ones.
  it('keeps Company.domain ahead of Company.endPdpUrl', () => {
    const both = company({ domain: 'acme.test', endPdpUrl: 'https://acme.test/p/1' })
    expect(chooseWebsite(both)?.source).toBe('Company.domain')
  })

  it('reaches the product URL when the domain column holds a platform', () => {
    const c = company({ domain: 'facebook.com', endPdpUrl: 'https://acme.test/p/1' })
    expect(chooseWebsite(c)?.source).toBe('Company.endPdpUrl')
    expect(chooseWebsite(c)?.url).toContain('acme.test')
  })

  it('collects social profiles from every field that can hold one', () => {
    const r = resolveCompanySource(
      company({
        domain: 'acme.test',
        endPdpUrl: 'https://facebook.com/acme/',
        linkedProfiles: ['https://www.linkedin.com/company/acme-supplies'],
      }),
    )
    expect(r.kind).toBe('primary_website')
    expect(r.socialSources.map((s) => s.platform).sort()).toEqual(['facebook', 'linkedin'])
  })
})

// ── 5. DANUC regression ──────────────────────────────────────────────────

describe('DANUC Hardware Store — the record that caused this', () => {
  // Its real NXT Sales values, verbatim.
  const danuc = company({
    name: 'DANUC Hardware Store',
    domain: 'facebook.com',
    endPdpUrl: 'https://www.facebook.com/danucstore/',
    email: 'admin@danielpetrilagroup.com',
    emails: ['admin@danielpetrilagroup.com'],
    linkedProfiles: [],
  })

  it('does not treat facebook.com as its website', () => {
    expect(resolveCompanySource(danuc).websiteUrl).toBeNull()
    expect(chooseWebsite(danuc)).toBeNull()
  })

  it('never sends the platform root to a crawler', () => {
    const r = resolveCompanySource(danuc)
    const everything = JSON.stringify({ website: r.websiteUrl, candidate: r.candidateWebsiteUrl })
    expect(everything).not.toContain('facebook.com/"')
    expect(r.socialSources.every((s) => s.url !== 'https://facebook.com')).toBe(true)
  })

  it('keeps its real Facebook page for Intent Signals', () => {
    expect(resolveCompanySource(danuc).socialSources[0]!.url).toBe('https://facebook.com/danucstore')
  })

  it('reports a record problem, not an unreadable website', () => {
    const r = resolveCompanySource(danuc)
    expect(r.reason).not.toMatch(/could not be read|unreachable/i)
    expect(r.reason).toContain('rather than a company website')
  })
})
