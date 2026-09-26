import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmCompany } from '../../src/crm/types.js'

// A PLATFORM IS NOT A COMPANY'S DOMAIN.
//
// The Decision Maker engine resolved the domain its domain-based providers
// search by straight from the raw `Company.domain` column, through hostOf(),
// without ever asking whether that string was a website. A record whose
// website column holds a social platform — common, and the exact case
// resolveCompanySource exists to recognise — therefore produced "facebook.com"
// as THE COMPANY'S DOMAIN.
//
// Two providers then acted on it, and both consequences were real:
//
//   Hunter          spent a METERED domain search looking for staff addresses
//                   at facebook.com
//   company_website fetched Facebook's own pages hunting for the company's
//                   team page
//
// Found on a live cross-company validation run: a social-only company took 80
// seconds against 2–17 for the others, entirely on requests to a domain that
// was never theirs.
//
// The judgement is not repeated in the engine. resolveCompanySource is the one
// place that decides what counts as a company's website, and the engine asks
// it. A company with no website of its own gets NO DOMAIN — which is the
// truth, and which both domain-based providers already decline on cleanly.

const db = {
  // No DiscoveredCompany in these tests: every id is a CRM company.
  discoveredCompany: { findFirst: async () => null },
  decisionMakerRun: { findUnique: vi.fn(), update: vi.fn() },
  decisionMakerCandidate: { create: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
  companyEnrichment: { findFirst: vi.fn() },
  // Candidate writes for one run happen in one transaction.
  $transaction: vi.fn(async (fn: unknown) => (typeof fn === 'function' ? (fn as (t: unknown) => unknown)(db) : fn)),
}
vi.mock('../../src/platform/db.js', () => ({
  prisma: db,
  newId: () => 'id_' + Math.random().toString(36).slice(2, 10),
}))
vi.mock('../../src/platform/audit.js', () => ({ audit: async () => undefined }))

let crmCompany: CrmCompany
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ getCompany: async () => crmCompany }) }))

/** Every provider invocation, with the domain it was handed. */
let invoked: Array<{ provider: string; companyDomain: string | null }> = []
vi.mock('../../src/decisionmakers/providers/provider.js', () => ({
  runDmProvider: async (provider: { name: string }, ctx: { companyDomain: string | null }) => {
    invoked.push({ provider: provider.name, companyDomain: ctx.companyDomain })
    return { provider: provider.name, status: 'no_results', candidates: [], durationMs: 1 }
  },
}))

const { runDecisionMakerDiscovery, providerNames } = await import('../../src/decisionmakers/discovery.js')

const company = (over: Partial<CrmCompany> = {}): CrmCompany =>
  ({
    id: 'co_1',
    name: 'A Company',
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

/** Runs the engine and reports the domain each provider was given. */
async function domainHandedToProviders(c: CrmCompany, enrichedSourceUrl: string | null = null) {
  invoked = []
  crmCompany = c
  db.companyEnrichment.findFirst.mockResolvedValue(enrichedSourceUrl ? { sourceUrl: enrichedSourceUrl } : null)
  await runDecisionMakerDiscovery('run_1')
  return invoked
}

const DOMAIN_BASED = ['hunter', 'company_website']

beforeEach(() => {
  vi.clearAllMocks()
  db.decisionMakerRun.findUnique.mockResolvedValue({
    id: 'run_1',
    tenantId: 't1',
    crmCompanyId: 'co_1',
    status: 'queued',
    retryCount: 0,
  })
  db.decisionMakerRun.update.mockResolvedValue({})
  db.companyEnrichment.findFirst.mockResolvedValue(null)
})
afterEach(() => vi.restoreAllMocks())

// ── A. and B. A social platform is never the company's domain ─────────────

describe('a company whose website column holds a social platform', () => {
  for (const platform of ['facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'youtube.com']) {
    it(`hands no domain to any provider for ${platform}`, async () => {
      const calls = await domainHandedToProviders(
        company({ domain: platform, endPdpUrl: `https://www.${platform}/somepage/` }),
      )
      expect(calls).toHaveLength(providerNames().length)
      for (const c of calls) expect(c.companyDomain, `${platform} -> ${c.provider}`).toBeNull()
    })
  }

  it('sends no platform root to Hunter or the website crawler', async () => {
    const calls = await domainHandedToProviders(
      company({ domain: 'facebook.com', endPdpUrl: 'https://www.facebook.com/somepage/' }),
    )
    for (const name of DOMAIN_BASED) {
      const call = calls.find((c) => c.provider === name)!
      expect(call.companyDomain).toBeNull()
    }
    // No DOMAIN handed to any provider carries a platform host. Checked on the
    // domains alone: one provider is itself named "linkedin_reference", and
    // matching the whole payload would catch its name rather than a domain.
    const domains = calls.map((c) => c.companyDomain).filter(Boolean).join(' ')
    expect(domains).toBe('')
  })

  it('derives nothing from the social profile, and adopts no email-implied guess', async () => {
    // resolveCompanySource offers candidateWebsiteUrl from a corporate address
    // as an UNVERIFIED hypothesis. Handing an unchecked guess to a metered
    // provider is exactly the inference this stage forbids.
    const calls = await domainHandedToProviders(
      company({
        domain: 'facebook.com',
        endPdpUrl: 'https://www.facebook.com/somepage/',
        email: 'admin@some-other-domain.example',
        emails: ['admin@some-other-domain.example'],
      }),
    )
    for (const c of calls) expect(c.companyDomain).toBeNull()
    expect(JSON.stringify(calls)).not.toContain('some-other-domain.example')
  })

  it('hands no domain when the record holds nothing usable at all', async () => {
    const calls = await domainHandedToProviders(company({ domain: null }))
    for (const c of calls) expect(c.companyDomain).toBeNull()
  })
})

// ── C. and D. A real website is still resolved, exactly as before ──────────

describe('a company with a website of its own', () => {
  it('keeps the CRM domain', async () => {
    const calls = await domainHandedToProviders(company({ domain: 'acme.test' }))
    for (const c of calls) expect(c.companyDomain).toBe('acme.test')
  })

  it('normalises a full URL to its host, as it always did', async () => {
    // hostOf() drops the scheme, the path and a leading "www." — unchanged by
    // this fix, and asserted so a future change to it is visible here.
    const calls = await domainHandedToProviders(company({ domain: 'https://www.acme.test/shop' }))
    for (const c of calls) expect(c.companyDomain).toBe('acme.test')
  })

  it('still prefers the host Stage 2 enrichment actually reached', async () => {
    const calls = await domainHandedToProviders(company({ domain: 'acme.test' }), 'https://shop.acme.test/')
    for (const c of calls) expect(c.companyDomain).toBe('shop.acme.test')
  })

  it('ignores an enrichment row that itself holds a platform URL', async () => {
    // Older rows predate the judgement being centralised, so the preferred
    // value is put through the same test rather than trusted.
    const calls = await domainHandedToProviders(company({ domain: 'acme.test' }), 'https://facebook.com/acme')
    for (const c of calls) expect(c.companyDomain).toBe('acme.test')
  })

  it('keeps the website when the record ALSO carries a social profile', async () => {
    const calls = await domainHandedToProviders(
      company({ domain: 'acme.test', linkedProfiles: ['https://www.linkedin.com/company/acme/'] }),
    )
    for (const c of calls) expect(c.companyDomain).toBe('acme.test')
  })

  it('falls back to a product URL when the domain column holds a platform', async () => {
    // resolveCompanySource reads every field that can hold a company URL, so a
    // real website elsewhere on the record is still found.
    const calls = await domainHandedToProviders(
      company({ domain: 'facebook.com', endPdpUrl: 'https://acme.test/p/1' }),
    )
    for (const c of calls) expect(c.companyDomain).toBe('acme.test')
  })
})

// ── E. The chain is unchanged ─────────────────────────────────────────────

describe('the provider chain is untouched by this fix', () => {
  it('runs every stage, in order, for a social-only company', async () => {
    const calls = await domainHandedToProviders(
      company({ domain: 'facebook.com', endPdpUrl: 'https://www.facebook.com/somepage/' }),
    )
    expect(calls.map((c) => c.provider)).toEqual(providerNames())
  })

  it('runs every stage, in order, for a company with a website', async () => {
    const calls = await domainHandedToProviders(company({ domain: 'acme.test' }))
    expect(calls.map((c) => c.provider)).toEqual(providerNames())
  })

  it('stops early for nobody', async () => {
    for (const c of [company({ domain: 'acme.test' }), company({ domain: 'facebook.com' }), company()]) {
      const calls = await domainHandedToProviders(c)
      expect(calls).toHaveLength(providerNames().length)
    }
  })
})
