import { describe, expect, it, vi, beforeEach } from 'vitest'

// INTENT SIGNALS AND DECISION MAKER, CONNECTED.
//
// Stage 3 reads the public profiles a company links from its own website. When
// that content pairs a name with a role it stores a `social_person_named`
// signal — evidence, dated, with the page it came from.
//
// Stage 4 used to ignore all of it and start from nothing, which meant the
// platform could find a name and then act as though it had not. These tests
// pin the connection, and pin its limit: a person Stage 3 named is a person
// Stage 4 EVALUATES. Nothing here ranks, verifies employment, assigns
// confidence, or lets a social name outrank a leadership page.

const rows: Array<Record<string, unknown>> = []
vi.mock('../../src/platform/db.js', () => ({
  prisma: {
    intentSignal: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
        rows.filter(
          (r) =>
            r.crmCompanyId === args.where.crmCompanyId &&
            r.tenantId === args.where.tenantId &&
            r.signalType === args.where.signalType,
        ),
      ),
    },
  },
}))

const { SocialSignalProvider } = await import('../../src/decisionmakers/providers/socialSignalProvider.js')

const ctx = (companyId = 'cmp-acme') => ({
  tenantId: 't1',
  company: { id: companyId, name: 'Acme Supplies' } as never,
  companyDomain: 'acme.test',
  maxResults: 10,
})

const signal = (over: Record<string, unknown> = {}) => ({
  tenantId: 't1',
  crmCompanyId: 'cmp-acme',
  signalType: 'social_person_named',
  sourceUrl: 'https://linkedin.com/company/acme-supplies',
  evidence: 'Dana Reed, Head of Ecommerce',
  observedAt: new Date('2026-08-14T00:00:00.000Z'),
  detectedAt: new Date('2026-09-01T00:00:00.000Z'),
  metadata: {
    kind: 'person',
    platform: 'linkedin',
    platformLabel: 'LinkedIn',
    fullName: 'Dana Reed',
    title: 'Head of Ecommerce',
    profileUrl: 'https://linkedin.com/company/acme-supplies',
  },
  ...over,
})

beforeEach(() => {
  rows.length = 0
})

describe('a person Intent Signals named becomes a candidate to evaluate', () => {
  it('turns a stored person signal into a candidate', async () => {
    rows.push(signal())
    const r = await new SocialSignalProvider().search(ctx())

    expect(r.status).toBe('available')
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]).toMatchObject({
      fullName: 'Dana Reed',
      rawTitle: 'Head of Ecommerce',
      statedCompany: 'Acme Supplies',
    })
  })

  it('carries the page the name was read from, and when', async () => {
    rows.push(signal())
    const e = (await new SocialSignalProvider().search(ctx())).candidates[0]!.evidence[0]!
    expect(e.sourceUrl).toBe('https://linkedin.com/company/acme-supplies')
    expect(e.observedAt?.toISOString().slice(0, 10)).toBe('2026-08-14')
    expect(e.snippet).toContain('Dana Reed, Head of Ecommerce')
    expect(e.supports).toEqual(['name', 'title'])
  })

  // Social content names people; it does not publish their inbox.
  it('claims no email or phone for a socially-named person', async () => {
    rows.push(signal())
    const c = (await new SocialSignalProvider().search(ctx())).candidates[0]!
    expect(c.email).toBeNull()
    expect(c.phone).toBeNull()
  })

  it('makes no network request', async () => {
    rows.push(signal())
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await new SocialSignalProvider().search(ctx())
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not repeat the same person found on two platforms', async () => {
    rows.push(signal())
    rows.push(signal({ metadata: { ...signal().metadata, platform: 'facebook', platformLabel: 'Facebook' } }))
    expect((await new SocialSignalProvider().search(ctx())).candidates).toHaveLength(1)
  })
})

describe('nothing found is said, not implied', () => {
  it('distinguishes "Intent Signals has nothing" from a failure', async () => {
    const r = await new SocialSignalProvider().search(ctx())
    expect(r.status).toBe('no_results')
    expect(r.candidates).toEqual([])
    expect(r.reason).toContain('recorded no person for this company')
  })

  it('ignores a signal that carries no usable name', async () => {
    rows.push(signal({ metadata: { kind: 'person', fullName: '  ' } }))
    const r = await new SocialSignalProvider().search(ctx())
    expect(r.candidates).toEqual([])
    expect(r.reason).toContain('none carrying a usable name')
  })

  it('ignores a signal that is not about a person', async () => {
    rows.push(signal({ metadata: { kind: 'personalization', topic: 'Formula 1' } }))
    expect((await new SocialSignalProvider().search(ctx())).candidates).toEqual([])
  })
})

describe('one company’s people never reach another', () => {
  it('reads only signals belonging to the company it was given', async () => {
    rows.push(signal())
    rows.push(
      signal({
        crmCompanyId: 'cmp-other',
        evidence: 'Sam Okonjo, Operations Director',
        metadata: { kind: 'person', fullName: 'Sam Okonjo', title: 'Operations Director' },
      }),
    )

    const acme = await new SocialSignalProvider().search(ctx('cmp-acme'))
    const other = await new SocialSignalProvider().search(ctx('cmp-other'))

    expect(acme.candidates.map((c) => c.fullName)).toEqual(['Dana Reed'])
    expect(other.candidates.map((c) => c.fullName)).toEqual(['Sam Okonjo'])
    expect(JSON.stringify(acme)).not.toContain('Sam Okonjo')
  })
})

describe('a company page is never a person’s identity', () => {
  // Candidates are keyed on profile URL. Giving everyone named on one company
  // page that page's URL merged them into a single invented person.
  it('sets no profileUrl, and keeps the company page in the evidence', async () => {
    rows.push(signal())
    rows.push(
      signal({
        evidence: 'Sam Okonjo, Operations Director',
        metadata: { ...signal().metadata, fullName: 'Sam Okonjo', title: 'Operations Director' },
      }),
    )
    const r = await new SocialSignalProvider().search(ctx())
    expect(r.candidates.map((c) => c.fullName)).toEqual(['Dana Reed', 'Sam Okonjo'])
    for (const c of r.candidates) {
      expect(c.profileUrl).toBeNull()
      expect(c.evidence[0]!.sourceUrl).toBe('https://linkedin.com/company/acme-supplies')
    }
  })

  it('de-duplicates names BEFORE applying the limit', async () => {
    for (let i = 0; i < 5; i++) rows.push(signal())
    rows.push(
      signal({
        evidence: 'Sam Okonjo, Operations Director',
        metadata: { ...signal().metadata, fullName: 'Sam Okonjo', title: 'Operations Director' },
      }),
    )
    const r = await new SocialSignalProvider().search({ ...ctx(), maxResults: 2 })
    expect(r.candidates.map((c) => c.fullName)).toEqual(['Dana Reed', 'Sam Okonjo'])
  })

  it('reads only signals that have not expired', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    await new SocialSignalProvider().search(ctx())
    const where = (prisma.intentSignal.findMany as unknown as { mock: { calls: Array<[{ where: Record<string, unknown> }]> } })
      .mock.calls.at(-1)![0].where
    expect(where.status).toEqual({ not: 'expired' })
  })

  it('words the snippet from where the profile link was found', async () => {
    rows.push(signal({ metadata: { ...signal().metadata, discoveredOn: 'the NXT Sales company record (linked profiles)' } }))
    const crmSnippet = (await new SocialSignalProvider().search(ctx())).candidates[0]!.evidence[0]!.snippet
    expect(crmSnippet).not.toContain('links from its own website')
    expect(crmSnippet).toContain('NXT Sales company record')

    rows.length = 0
    rows.push(signal({ metadata: { ...signal().metadata, discoveredOn: 'https://acme.test/contact' } }))
    const siteSnippet = (await new SocialSignalProvider().search(ctx())).candidates[0]!.evidence[0]!.snippet
    expect(siteSnippet).toContain('links from its own website')
  })

  it('leaves observedAt null when the source stated no date, rather than using detection time', async () => {
    rows.push(signal({ observedAt: null }))
    const e = (await new SocialSignalProvider().search(ctx())).candidates[0]!.evidence[0]!
    expect(e.observedAt).toBeNull()
  })
})
