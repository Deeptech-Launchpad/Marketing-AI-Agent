import { describe, expect, it } from 'vitest'
import { runProvider, type IntentProvider, type ProviderContext } from '../../src/intent/providers/provider.js'
import type { CrmCompany } from '../../src/crm/types.js'

// The provider boundary. A provider returns evidence; it never assigns
// confidence, computes freshness, deduplicates or scores. These tests pin the
// isolation guarantee: one failing source must not take down a collection.

function company(over: Partial<CrmCompany> = {}): CrmCompany {
  return {
    id: 'co_1',
    name: 'Acme Industrial',
    email: null,
    emails: [],
    phone: null,
    domain: 'acme.example',
    industry: 'Plumbing & PVF (Pipe, Valve, Fitting)',
    country: 'UK',
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

const ctx = (over: Partial<ProviderContext> = {}): ProviderContext => ({
  tenantId: 't1',
  company: company(),
  maxResults: 10,
  ...over,
})

function stub(over: Partial<IntentProvider> = {}): IntentProvider {
  return {
    name: 'stub',
    category: 'hiring',
    available: () => ({ ok: true }),
    collect: async () => ({ provider: 'stub', ok: true, signals: [], durationMs: 1 }),
    ...over,
  }
}

describe('provider isolation', () => {
  it('converts a thrown provider into a recorded failure, not a crash', async () => {
    // A dead job board must not lose the CRM signals collected alongside it.
    const r = await runProvider(
      stub({
        collect: async () => {
          throw new Error('upstream exploded')
        },
      }),
      ctx(),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('upstream exploded')
    expect(r.signals).toEqual([])
  })

  it('reports an unavailable provider with its reason instead of skipping silently', async () => {
    const r = await runProvider(
      stub({ available: () => ({ ok: false, reason: 'APIFY_TOKEN is not set' }) }),
      ctx(),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/APIFY_TOKEN/)
  })

  it('does not call collect when the provider is unavailable', async () => {
    let called = false
    await runProvider(
      stub({
        available: () => ({ ok: false, reason: 'disabled' }),
        collect: async () => {
          called = true
          return { provider: 'stub', ok: true, signals: [], durationMs: 0 }
        },
      }),
      ctx(),
    )
    expect(called).toBe(false)
  })

  it('surfaces a timeout as a normal failed result', async () => {
    const r = await runProvider(
      stub({
        collect: async () => {
          throw Object.assign(new Error('exceeded 120000ms and was abandoned'), { name: 'AbortError' })
        },
      }),
      ctx(),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/abandoned/)
  })

  it('passes results through untouched when the provider succeeds', async () => {
    const r = await runProvider(
      stub({
        collect: async () => ({
          provider: 'stub',
          ok: true,
          signals: [],
          durationMs: 5,
          costUsd: 0.012,
          metadata: { listingsReturned: 2 },
        }),
      }),
      ctx(),
    )
    expect(r.ok).toBe(true)
    expect(r.costUsd).toBe(0.012)
    expect(r.metadata).toEqual({ listingsReturned: 2 })
  })
})

describe('careers page provider — missing source data', () => {
  it('reports a company with no domain rather than inventing a URL', async () => {
    const { CareersPageProvider } = await import('../../src/intent/providers/careersPageProvider.js')
    const r = await runProvider(new CareersPageProvider(), ctx({ company: company({ domain: null }) }))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no domain/i)
    expect(r.signals).toEqual([])
  })

  it('refuses a stored domain that is not a usable http(s) URL', async () => {
    const { CareersPageProvider } = await import('../../src/intent/providers/careersPageProvider.js')
    // normalizeUrl must not repair file:// into a real host.
    const r = await runProvider(
      new CareersPageProvider(),
      ctx({ company: company({ domain: 'file:///etc/passwd' }) }),
    )
    expect(r.ok).toBe(false)
    expect(r.signals).toEqual([])
  })
})

describe('apify jobs provider — availability', () => {
  it('always states WHY it cannot run, rather than returning an empty success', async () => {
    const { ApifyJobsProvider } = await import('../../src/intent/providers/jobsProvider.js')
    const a = new ApifyJobsProvider().available()

    // Two independent reasons this provider can be unavailable, and both must
    // be reported: a missing token, or an Actor that cannot scope a search to
    // one company. The second was found against the real Apify Actor —
    // misceres~indeed-scraper ignores `company`, so a per-prospect search
    // returns arbitrary employers and bills per listing for nothing.
    if (!a.ok) {
      expect(a.reason).toMatch(/APIFY_TOKEN|cannot scope a search/i)
      expect(a.reason!.length).toBeGreaterThan(20)
    } else {
      // Only reachable with a token AND an Actor declared company-scoped.
      expect(process.env.APIFY_TOKEN).toBeTruthy()
    }
  })

  it('refuses to spend when the configured Actor cannot scope to a company', async () => {
    const { ApifyJobsProvider } = await import('../../src/intent/providers/jobsProvider.js')
    const { env } = await import('../../src/config/env.js')

    if (env.APIFY_TOKEN && !env.APIFY_JOBS_COMPANY_SCOPED) {
      const a = new ApifyJobsProvider().available()
      expect(a.ok).toBe(false)
      expect(a.reason).toMatch(/cannot scope a search to a single company/i)
    }
  })

  it('is registered in the engine even while unavailable, so the boundary stays intact', async () => {
    // The provider staying wired is the point: swapping in a capable Actor is a
    // config change, not a code change.
    const { ApifyJobsProvider } = await import('../../src/intent/providers/jobsProvider.js')
    const p = new ApifyJobsProvider()
    expect(p.name).toBe('apify_jobs')
    expect(p.category).toBe('hiring')
    expect(typeof p.collect).toBe('function')
  })
})
