import { beforeEach, describe, expect, it, vi } from 'vitest'

// A DiscoveredCompany (2026-09-24 restructure — open-web prospecting) has to
// pass for a CrmCompany everywhere Enrichment, Intent Signals, Decision Maker
// Discovery and Outreach already read one, so those engines can run against a
// company before it has ever reached NXT Sales. Every CRM-only fact this
// platform cannot yet answer must come back null or empty — never guessed.

const discoveredFindFirst = vi.fn()
vi.mock('../../src/platform/db.js', () => ({ prisma: { discoveredCompany: { findFirst: (...a: unknown[]) => discoveredFindFirst(...a) } } }))
const getCompany = vi.fn()
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ getCompany: (...a: unknown[]) => getCompany(...a) }) }))

const { companyFromDiscovered, discoveredWebsiteDomain, resolvePipelineCompany } = await import(
  '../../src/prospects/discoveredCompanyAdapter.js'
)

beforeEach(() => {
  discoveredFindFirst.mockReset()
  getCompany.mockReset()
})

describe('reading a DiscoveredCompany as the CRM-shaped contract', () => {
  it('carries the id, name and domain straight through', () => {
    const c = companyFromDiscovered({ id: 'disc_1', companyName: 'Acme Safety Co', domain: 'acmesafety.test' })
    expect(c.id).toBe('disc_1')
    expect(c.name).toBe('Acme Safety Co')
    expect(c.domain).toBe('acmesafety.test')
  })

  it('leaves every CRM-only fact null or empty, never invented', () => {
    const c = companyFromDiscovered({ id: 'disc_2', companyName: 'Acme Safety Co', domain: null })
    expect(c.email).toBeNull()
    expect(c.emails).toEqual([])
    expect(c.phone).toBeNull()
    expect(c.industry).toBeNull()
    expect(c.country).toBeNull()
    expect(c.contactPersons).toEqual([])
    expect(c.linkedProfiles).toEqual([])
    expect(c.ownerId).toBeNull()
    expect(c.dealCount).toBe(0)
  })

  it('passes a null domain through as null, not a guess', () => {
    expect(companyFromDiscovered({ id: 'disc_3', companyName: 'No Site Yet Ltd', domain: null }).domain).toBeNull()
  })
})

// The fit assessment names a domain only when the page it read confirmed the
// company's own site. When it did not, the page the company was read from is
// its website only if that site is spelt from the company's own name.
describe("which website is the company's own", () => {
  it('uses the confirmed domain whenever there is one', () => {
    expect(discoveredWebsiteDomain({ companyName: 'Bullard', domain: 'bullard.com', websiteUrl: 'https://other.test/x' })).toBe(
      'bullard.com',
    )
  })

  it("accepts the page's own site when its name is spelt from the company's words", () => {
    expect(
      discoveredWebsiteDomain({
        companyName: 'Magid Glove & Safety Manufacturing Company LLC',
        domain: null,
        websiteUrl: 'https://www.magidglove.com/careers-in-safety',
      }),
    ).toBe('magidglove.com')
    expect(discoveredWebsiteDomain({ companyName: 'Lioncare', domain: null, websiteUrl: 'https://www.lioncare.net/news/x' })).toBe(
      'lioncare.net',
    )
  })

  it('never takes a news article or directory for the company’s website', () => {
    expect(
      discoveredWebsiteDomain({
        companyName: 'Radians',
        domain: null,
        websiteUrl: 'https://www.prnewswire.com/news-releases/radians-expands-302885252.html',
      }),
    ).toBeNull()
  })

  it('does not match on a shared generic word', () => {
    // "safety" is in both, but "news" is not one of this company's words.
    expect(discoveredWebsiteDomain({ companyName: 'Safety Solutions', domain: null, websiteUrl: 'https://safetynews.com/a' })).toBeNull()
  })

  it('accepts a name made only of generic words when the address spells all of it', () => {
    expect(discoveredWebsiteDomain({ companyName: 'Global Industrial Company Inc.', domain: null, websiteUrl: 'https://www.globalindustrial.com/' })).toBe('globalindustrial.com')
  })

  it('accepts the words companies add to their name to make an address', () => {
    expect(discoveredWebsiteDomain({ companyName: 'PROTO', domain: null, websiteUrl: 'https://www.protoindustrial.com/' })).toBe('protoindustrial.com')
  })

  it('never takes an encyclopedia page for the company’s website', () => {
    expect(discoveredWebsiteDomain({ companyName: 'Fastenal Company', domain: null, websiteUrl: 'https://en.wikipedia.org/wiki/Fastenal' })).toBeNull()
  })

  it('is null when there is nothing to go on', () => {
    expect(discoveredWebsiteDomain({ companyName: 'Acme', domain: null, websiteUrl: null })).toBeNull()
  })
})

describe('resolving the company a pipeline run is about', () => {
  it('reads a discovered company from the platform, and never asks NXT Sales', async () => {
    discoveredFindFirst.mockResolvedValue({ id: 'disc_9', companyName: 'Bullard', domain: 'bullard.com', websiteUrl: null })

    const r = await resolvePipelineCompany('t1', 'disc_9')

    expect(r?.discoveredCompanyId).toBe('disc_9')
    expect(r?.company.name).toBe('Bullard')
    expect(r?.company.domain).toBe('bullard.com')
    expect(getCompany).not.toHaveBeenCalled()
    // Tenant-scoped: another tenant's discovered company is not this one.
    expect(discoveredFindFirst.mock.calls[0]![0]).toMatchObject({ where: { id: 'disc_9', tenantId: 't1' } })
  })

  it('reads anything else from NXT Sales, as before', async () => {
    discoveredFindFirst.mockResolvedValue(null)
    getCompany.mockResolvedValue({ id: 'crm_1', name: 'Ac Cleaning' })

    const r = await resolvePipelineCompany('t1', 'crm_1')

    expect(r?.discoveredCompanyId).toBeNull()
    expect(r?.company.name).toBe('Ac Cleaning')
    expect(getCompany).toHaveBeenCalledWith('crm_1')
  })

  it('is null when neither holds the company', async () => {
    discoveredFindFirst.mockResolvedValue(null)
    getCompany.mockResolvedValue(null)
    expect(await resolvePipelineCompany('t1', 'gone')).toBeNull()
  })
})
