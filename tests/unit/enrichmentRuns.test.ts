import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmCompany } from '../../src/crm/types.js'

// Stage 2 run lifecycle: duplicate-run guard, stranded rows, enqueue failure,
// redelivery, cache honesty and off-site redirects. Generic fixtures only.

const db = {
  // Null unless a test says otherwise: then the id is a CRM company.
  discoveredCompany: { findFirst: vi.fn(async (): Promise<unknown> => null) },
  companyEnrichment: {
    create: vi.fn(async () => ({})),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
}
vi.mock('../../src/platform/db.js', () => {
  let n = 0
  return { prisma: db, newId: () => `enr_${++n}` }
})

const fetchPage = vi.fn()
const fetchPageRaw = vi.fn()
vi.mock('../../src/research/pageFetch.js', () => ({
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  fetchPageRaw: (...a: unknown[]) => fetchPageRaw(...a),
}))

const getCompany = vi.fn()
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ getCompany }) }))
vi.mock('../../src/platform/audit.js', () => ({ audit: vi.fn(async () => undefined) }))

const mod = await import('../../src/enrichment/companyEnrichment.js')
const { requestCompanyEnrichments, runCompanyEnrichment, failStaleEnrichments, IN_FLIGHT_WINDOW_MS } = mod
const { registrableDomain, sameRegistrableSite } = await import('../../src/enrichment/siteIdentity.js')

const company = (over: Partial<CrmCompany> = {}): CrmCompany =>
  ({
    id: 'co_1',
    name: 'Acme Supplies',
    email: null,
    emails: [],
    phone: null,
    domain: 'acme-supplies.example',
    industry: 'Industrial',
    country: 'US',
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
  }) as CrmCompany

const lastFinish = () => {
  const calls = db.companyEnrichment.update.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>
  return calls[calls.length - 1]![0].data
}

beforeEach(() => {
  vi.clearAllMocks()
  db.companyEnrichment.findFirst.mockResolvedValue(null)
  db.companyEnrichment.updateMany.mockResolvedValue({ count: 0 })
  db.discoveredCompany.findFirst.mockResolvedValue(null)
})

describe('requestCompanyEnrichments — duplicate-run guard', () => {
  it('de-duplicates ids so one company is one run', async () => {
    const enqueueJob = vi.fn(async () => 'job')
    const out = await requestCompanyEnrichments({
      tenantId: 't1',
      crmCompanyIds: ['co_1', 'co_1', ' co_1 ', 'co_2'],
      requestedByCrmUserId: 'u1',
      enqueueJob,
    })
    expect(out.map((r) => r.crmCompanyId)).toEqual(['co_1', 'co_2'])
    expect(db.companyEnrichment.create).toHaveBeenCalledTimes(2)
    expect(enqueueJob).toHaveBeenCalledTimes(2)
  })

  it('returns the existing queued/running row instead of creating another', async () => {
    db.companyEnrichment.findFirst.mockResolvedValue({ id: 'enr_live', status: 'running' })
    const enqueueJob = vi.fn()
    const out = await requestCompanyEnrichments({ tenantId: 't1', crmCompanyIds: ['co_1'], requestedByCrmUserId: 'u1', enqueueJob })
    expect(out).toEqual([{ id: 'enr_live', crmCompanyId: 'co_1', existing: true, status: 'running' }])
    expect(db.companyEnrichment.create).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
    // Only rows inside the in-flight window count as in flight.
    const where = (db.companyEnrichment.findFirst.mock.calls[0] as unknown as [{ where: { updatedAt: { gte: Date } } }])[0].where
    expect(Date.now() - where.updatedAt.gte.getTime()).toBeGreaterThanOrEqual(IN_FLIGHT_WINDOW_MS - 1000)
  })

  it('fails stranded rows for the requested companies first', async () => {
    await requestCompanyEnrichments({ tenantId: 't1', crmCompanyIds: ['co_1'], requestedByCrmUserId: 'u1', enqueueJob: async () => 'j' })
    const arg = (db.companyEnrichment.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0]
    expect(arg.where).toMatchObject({ tenantId: 't1', crmCompanyId: { in: ['co_1'] }, status: { in: ['queued', 'running'] } })
    expect(arg.data).toMatchObject({ status: 'failed' })
  })

  it('marks the row failed when the job cannot be enqueued', async () => {
    const out = await requestCompanyEnrichments({
      tenantId: 't1',
      crmCompanyIds: ['co_1'],
      requestedByCrmUserId: 'u1',
      enqueueJob: async () => {
        throw new Error('queue down')
      },
    })
    expect(out[0]).toMatchObject({ existing: false, status: 'failed' })
    expect(lastFinish()).toMatchObject({ status: 'failed' })
    expect(String(lastFinish().failureReason)).toMatch(/could not be queued/)
  })
})

describe('failStaleEnrichments', () => {
  it('only touches active rows older than the window', async () => {
    db.companyEnrichment.updateMany.mockResolvedValue({ count: 2 })
    expect(await failStaleEnrichments('t1')).toBe(2)
    const where = (db.companyEnrichment.updateMany.mock.calls[0] as unknown as [{ where: { updatedAt: { lt: Date } } }])[0].where
    expect(Date.now() - where.updatedAt.lt.getTime()).toBeGreaterThanOrEqual(IN_FLIGHT_WINDOW_MS - 1000)
  })
})

describe('runCompanyEnrichment', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'enr_run',
    tenantId: 't1',
    crmCompanyId: 'co_1',
    status: 'queued',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  })
  const shopifyPage = (over: Record<string, unknown> = {}) => ({
    ok: true,
    requestedUrl: 'https://acme-supplies.example/',
    finalUrl: 'https://www.acme-supplies.example/',
    signals: {
      technologies: [{ name: 'Shopify', category: 'ecommerce', evidence: 'cdn.shopify.com/s/files' }],
      platforms: ['Shopify'],
      generator: null,
      title: 'Acme',
      metaDescription: null,
      hasStructuredData: false,
      productSchema: false,
    },
    cached: false,
    fetchedAt: '2026-09-15T10:00:00.000Z',
    ...over,
  })

  it('ignores a redelivered job for a row that already finished', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row({ status: 'enriched' }))
    await runCompanyEnrichment('enr_run')
    expect(db.companyEnrichment.update).not.toHaveBeenCalled()
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('records a cached page honestly, with the original fetch time', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    getCompany.mockResolvedValue(company())
    fetchPage.mockResolvedValue(shopifyPage({ cached: true, fetchedAt: '2026-09-10T08:00:00.000Z' }))
    await runCompanyEnrichment('enr_run')

    const data = lastFinish()
    expect(data.status).toBe('enriched')
    expect((data.fetchedAt as Date).toISOString()).toBe('2026-09-10T08:00:00.000Z')
    const statements = (data.provenance as Array<{ statement: string }>).map((c) => c.statement)
    expect(statements.some((s) => /served from the research cache/.test(s))).toBe(true)
    expect(statements.some((s) => /^Fetched /.test(s))).toBe(false)
  })

  it('uses the cache on a first run and bypasses it on a re-run', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    getCompany.mockResolvedValue(company())
    fetchPage.mockResolvedValue(shopifyPage())

    await runCompanyEnrichment('enr_run')
    expect((fetchPage.mock.calls[0]![1] as { fresh: boolean }).fresh).toBe(false)

    db.companyEnrichment.findFirst.mockResolvedValue({ id: 'enr_earlier' })
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    await runCompanyEnrichment('enr_run')
    expect((fetchPage.mock.calls[1]![1] as { fresh: boolean }).fresh).toBe(true)
  })

  it('treats a same-site redirect (apex -> www) as the company site', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    getCompany.mockResolvedValue(company())
    fetchPage.mockResolvedValue(shopifyPage())
    await runCompanyEnrichment('enr_run')
    expect(lastFinish()).toMatchObject({ status: 'enriched', technologyCount: 1 })
  })

  it('records a redirect to another registrable domain as partial, without attributing its technologies', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    getCompany.mockResolvedValue(company())
    fetchPage.mockResolvedValue(shopifyPage({ finalUrl: 'https://www.parent-group.example/home' }))
    await runCompanyEnrichment('enr_run')

    const data = lastFinish()
    expect(data.status).toBe('partial')
    expect(data.technologyCount).toBe(0)
    expect(data.sourceUrl).toBe('https://acme-supplies.example/')
    expect(String(data.failureReason)).toMatch(/redirected to a different domain \(www\.parent-group\.example\)/)
    const statements = (data.provenance as Array<{ statement: string }>).map((c) => c.statement)
    expect(statements.some((s) => /NOT attributed/.test(s) && /Shopify/.test(s))).toBe(true)
    expect((data.signals as { finalUrl: string }).finalUrl).toBe('https://www.parent-group.example/home')
  })

  it("stores the resolver's own reason when there is no usable website", async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    getCompany.mockResolvedValue(company({ domain: 'https://www.facebook.com/acmesupplies' }))
    await runCompanyEnrichment('enr_run')
    const data = lastFinish()
    expect(data.status).toBe('no_website')
    expect(typeof data.failureReason).toBe('string')
    expect(String(data.failureReason)).not.toMatch(/neither a domain nor a product URL/)
    expect(fetchPage).not.toHaveBeenCalled()
  })
})

// ── A company found by the web search, and the country (2026-10-07) ───────
//
// Not being in NXT Sales never stops enrichment, and the country comes from
// the first source that states it: NXT Sales, the company's own website, the
// listing page Prospects verified. Never guessed.

describe('runCompanyEnrichment — companies found by the web search, and their country', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'enr_web', tenantId: 't1', crmCompanyId: 'dc_1', status: 'queued', createdAt: new Date('2026-10-01T00:00:00Z'), ...over,
  })
  const page = (over: Record<string, unknown> = {}) => ({
    ok: true,
    requestedUrl: 'https://acme-supplies.example/',
    finalUrl: 'https://www.acme-supplies.example/',
    signals: { technologies: [], platforms: [], generator: null, title: 'Acme', metaDescription: null, hasStructuredData: false, productSchema: false },
    cached: false,
    fetchedAt: '2026-10-01T10:00:00.000Z',
    ...over,
  })
  const discovered = (over: Record<string, unknown> = {}) => ({
    id: 'dc_1',
    companyName: 'Acme Supplies',
    domain: 'acme-supplies.example',
    websiteUrl: 'https://acme-supplies.example/',
    crmCompanyId: null,
    productAnalysis: {
      companyLocation: {
        text: 'Indianapolis, IN 46278', city: 'Indianapolis', region: 'IN', postalCode: '46278', country: 'US',
        source: 'company website (address on page)', sourceUrl: 'https://www.acme-supplies.example/',
      },
    },
    ...over,
  })
  const signalsOf = () => lastFinish().signals as Record<string, unknown>

  it('enriches a company that is not in NXT Sales, with the country its own website states', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    db.discoveredCompany.findFirst.mockResolvedValue(discovered())
    fetchPage.mockResolvedValue(page())
    await runCompanyEnrichment('enr_web')

    const data = lastFinish()
    expect(data.status).toBe('enriched')
    expect(signalsOf()).toMatchObject({
      companySource: 'web_search',
      country: 'United States',
      countrySource: 'company website (address on page)',
      countrySourceUrl: 'https://www.acme-supplies.example/',
      countryStatedAs: 'Indianapolis, IN 46278',
    })
    expect(getCompany).not.toHaveBeenCalled()
    // Prospects already read the address: no second request for it.
    expect(fetchPageRaw).not.toHaveBeenCalled()
    const statements = (data.provenance as Array<{ statement: string }>).map((c) => c.statement)
    expect(statements[0]).toMatch(/not in NXT Sales yet\. That does not stop enrichment/)
  })

  it('uses the linked NXT Sales record for reference when the company has been matched to one', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    db.discoveredCompany.findFirst.mockResolvedValue(discovered({ crmCompanyId: 'co_9' }))
    getCompany.mockResolvedValue(company({ id: 'co_9', country: 'MALTA', industry: 'Retail' }))
    fetchPage.mockResolvedValue(page())
    await runCompanyEnrichment('enr_web')

    expect(signalsOf()).toMatchObject({ companySource: 'web_search', country: 'MALTA', countrySource: 'NXT Sales record', industry: 'Retail' })
  })

  it('reads the website for a CRM company whose record holds no country', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row({ crmCompanyId: 'co_1' }))
    getCompany.mockResolvedValue(company({ country: null }))
    fetchPage.mockResolvedValue(page())
    fetchPageRaw.mockImplementation(async (url: string) => ({
      ok: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', truncated: false, bytes: 1,
      redirectChain: [], reason: null, durationMs: 1,
      html: '<script type="application/ld+json">{"@type":"Organization","address":{"addressLocality":"Hamburg","addressCountry":"DE"}}</script>',
    }))
    await runCompanyEnrichment('enr_web')

    expect(signalsOf()).toMatchObject({ companySource: 'crm', country: 'Germany', countrySource: 'company website (structured data)' })
  })

  it('records the country as unknown, and says why, when no source states one', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    db.discoveredCompany.findFirst.mockResolvedValue(discovered({ productAnalysis: null }))
    fetchPage.mockResolvedValue(page())
    fetchPageRaw.mockImplementation(async (url: string) => ({
      ok: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', truncated: false, bytes: 1,
      redirectChain: [], reason: null, durationMs: 1, html: '<p>Industrial supplies since 1980.</p>',
    }))
    await runCompanyEnrichment('enr_web')

    expect(lastFinish().status).toBe('enriched')
    expect(signalsOf().country).toBe('UNKNOWN')
    const statements = (lastFinish().provenance as Array<{ statement: string }>).map((c) => c.statement)
    expect(statements.some((s) => /Country not established from the website: No address was stated/.test(s))).toBe(true)
  })

  it('keeps the country of a company with no website of its own from the listing page that named it', async () => {
    db.companyEnrichment.findUnique.mockResolvedValue(row())
    db.discoveredCompany.findFirst.mockResolvedValue(
      discovered({
        domain: null,
        websiteUrl: 'https://directory.example/listing/123',
        productAnalysis: {
          companyLocation: {
            text: 'Akron, OH 44301', city: 'Akron', region: 'OH', postalCode: '44301', country: 'US',
            source: 'listing page', sourceUrl: 'https://directory.example/listing/123',
          },
        },
      }),
    )
    await runCompanyEnrichment('enr_web')

    expect(lastFinish().status).toBe('no_website')
    expect(signalsOf()).toMatchObject({ country: 'United States', countrySource: 'listing page that named the company' })
    expect(fetchPage).not.toHaveBeenCalled()
  })
})

describe('siteIdentity', () => {
  it('computes registrable domains generically', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com')
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('example.com.au')).toBe('example.com.au')
  })
  it('compares sites', () => {
    expect(sameRegistrableSite('https://example.com/', 'https://www.example.com/x')).toBe(true)
    expect(sameRegistrableSite('https://a-brand.example/', 'https://parent.example/')).toBe(false)
    expect(sameRegistrableSite('https://one.co.uk/', 'https://two.co.uk/')).toBe(false)
  })
})
