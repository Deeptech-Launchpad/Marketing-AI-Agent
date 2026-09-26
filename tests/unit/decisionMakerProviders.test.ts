import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApolloProvider } from '../../src/decisionmakers/providers/apolloProvider.js'
import { CrmContactProvider, matchProfileUrl } from '../../src/decisionmakers/providers/crmContactProvider.js'
import { LinkedInReferenceProvider } from '../../src/decisionmakers/providers/linkedInReferenceProvider.js'
import { runDmProvider, type DecisionMakerProvider, type DmProviderContext } from '../../src/decisionmakers/providers/provider.js'
import { RocketReachProvider } from '../../src/decisionmakers/providers/rocketReachProvider.js'
import { WebCorroborationProvider } from '../../src/decisionmakers/providers/webCorroborationProvider.js'
import { ZoomInfoProvider } from '../../src/decisionmakers/providers/zoomInfoProvider.js'
import { PROVIDER_STATUSES } from '../../src/decisionmakers/types.js'
import type { CrmCompany } from '../../src/crm/types.js'

// Stage 4 — PROVIDER FAILURES, RATE LIMITING, UNAUTHORIZED PROVIDERS.
//
// External providers are exercised against FIXTURES only. No test in this file
// reaches the network or spends a credit — the paid paths are asserted by
// stubbing fetch, which is also the only way to test a 429 on demand.

function company(over: Partial<CrmCompany> = {}): CrmCompany {
  return {
    id: 'co_1',
    name: 'Acme Industrial Supply Ltd',
    email: null,
    emails: [],
    phone: null,
    domain: 'acme-industrial.example',
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

const ctx = (over: Partial<DmProviderContext> = {}): DmProviderContext => ({
  tenantId: 't1',
  company: company(),
  companyDomain: 'acme-industrial.example',
  maxResults: 20,
  ...over,
})

/** Minimal Response stand-in — only what the adapters actually read. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

afterEach(() => vi.restoreAllMocks())

// ── 9. PROVIDER FAILURES ───────────────────────────────────────────────────

describe('provider isolation — one dead source must not fail the run', () => {
  const stub = (over: Partial<DecisionMakerProvider> = {}): DecisionMakerProvider => ({
    name: 'stub',
    sourceType: 'data_provider',
    available: () => ({ status: 'available' }),
    search: async () => ({ provider: 'stub', status: 'available', candidates: [], durationMs: 1 }),
    ...over,
  })

  it('converts a thrown provider into a recorded failure, not a crash', async () => {
    const r = await runDmProvider(
      stub({
        search: async () => {
          throw new Error('upstream exploded')
        },
      }),
      ctx(),
    )
    expect(r.status).toBe('error')
    expect(r.reason).toBe('upstream exploded')
    expect(r.candidates).toEqual([])
  })

  it('does not call search when the provider is unavailable', async () => {
    let called = false
    await runDmProvider(
      stub({
        available: () => ({ status: 'unauthorized', reason: 'no key' }),
        search: async () => {
          called = true
          return { provider: 'stub', status: 'available' as const, candidates: [], durationMs: 0 }
        },
      }),
      ctx(),
    )
    expect(called).toBe(false)
  })

  it('never lets an unavailable provider return without a reason', async () => {
    const r = await runDmProvider(stub({ available: () => ({ status: 'unavailable' }) }), ctx())
    expect(r.reason).toBeTruthy()
  })

  it('rewrites an empty success as no_results, so it cannot read as a blocker', async () => {
    const r = await runDmProvider(stub(), ctx())
    expect(r.status).toBe('no_results')
    expect(r.reason).toMatch(/no matching people/i)
  })

  it('surfaces a timeout as a normal failed result', async () => {
    const r = await runDmProvider(
      stub({
        search: async () => {
          throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        },
      }),
      ctx(),
    )
    expect(r.status).toBe('error')
    expect(r.reason).toMatch(/aborted/)
  })
})

// ── 10. RATE-LIMIT HANDLING ────────────────────────────────────────────────

describe('rate limiting is distinguished from failure', () => {
  it('classifies a thrown 429 as rate_limited, not error', async () => {
    // The distinction matters: rate_limited means try later, error means the
    // integration is wrong. Collapsing them loses that.
    const r = await runDmProvider(
      {
        name: 'stub',
        sourceType: 'data_provider',
        available: () => ({ status: 'available' }),
        search: async () => {
          throw new Error('Request failed with status 429 Too Many Requests')
        },
      },
      ctx(),
    )
    expect(r.status).toBe('rate_limited')
  })

  it('Apollo reports a 429 response as rate_limited', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(429, {}))
    const r = await new ApolloProvider().search(ctx())
    expect(r.status).toBe('rate_limited')
  })

  it('RocketReach reports a 429 response as rate_limited', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(429, {}))
    const r = await new RocketReachProvider().search(ctx())
    expect(r.status).toBe('rate_limited')
  })
})

// ── 11. UNAUTHORIZED PROVIDERS ─────────────────────────────────────────────

describe('unauthorized providers report a precise blocker', () => {
  const gated = [
    { p: new ApolloProvider(), expect: /APOLLO_API_KEY/ },
    { p: new ZoomInfoProvider(), expect: /ZoomInfo credentials/ },
    { p: new RocketReachProvider(), expect: /ROCKETREACH_API_KEY/ },
    { p: new LinkedInReferenceProvider(), expect: /LINKEDIN_ACCESS_TOKEN/ },
  ]

  gated.forEach(({ p, expect: pattern }) => {
    it(`${p.name} states WHY it cannot run`, () => {
      const a = p.available(ctx())
      // These tests hold in THIS environment, where none of the four have
      // credentials. With a key configured the provider becomes available,
      // which is the intended outcome and is asserted as the alternative.
      if (a.status === 'available') return
      expect(a.status).toBe('unauthorized')
      expect(a.reason).toMatch(pattern)
      expect(a.reason!.length).toBeGreaterThan(40)
    })
  })

  it('every provider is registered and callable even while unavailable', async () => {
    // ORDER CHANGED BY BUSINESS DECISION — Team Answer, Sections A.3 and E.2:
    //   Apollo -> ZoomInfo -> RocketReach -> official LinkedIn -> AI web search
    // with the two sources the CRM already holds ahead of all of them
    // (E.4: use stored data rather than re-collecting; E.5: CRM-held LinkedIn
    // references are allowed). The company-website search was previously
    // second; it is the "AI-assisted web search" the document calls a last
    // resort, so it is now last.
    const { providerNames } = await import('../../src/decisionmakers/discovery.js')
    expect(providerNames()).toEqual([
      'crm_contacts',
      'linkedin_reference',
      // Stage 3's own findings, before any paid provider is asked: a person
      // the company already published and Intent Signals already stored is
      // evaluated here rather than rediscovered, and it costs nothing.
      'intent_social',
      'apollo',
      'zoominfo',
      'rocketreach',
      // Hunter sits after the people-databases and before the open-web
      // fallback: it reports addresses seen on public pages, so it answers
      // "how do we reach them" rather than "who are they".
      'hunter',
      'company_website',
      // The open web, searched rather than guessed at. Last on purpose: every
      // source above either holds a record of this company or reads the
      // company's own site, and both are better evidence about who works
      // somewhere than a third-party page is.
      'public_web_research',
    ])
  })

  it('LinkedIn records that scraping was available and deliberately refused', () => {
    // The Apify account CAN reach LinkedIn scraper Actors. Not using them is a
    // decision, and a decision that is not written down gets quietly reversed.
    const a = new LinkedInReferenceProvider().available()
    if (a.status !== 'available') {
      expect(a.reason).toMatch(/scrap/i)
      expect(a.reason).toMatch(/Partner Program/)
    }
  })

  it('Apollo reports a 401 response as unauthorized rather than no results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, {}))
    const r = await new ApolloProvider().search(ctx())
    expect(r.status).toBe('unauthorized')
  })

  it('every reported status is one of the declared values', async () => {
    const r = await new ApolloProvider().available(ctx())
    expect(PROVIDER_STATUSES).toContain(r.status)
  })
})

// ── Provider parsing, against fixtures ─────────────────────────────────────

describe('Apollo adapter — fixture parsing', () => {
  it('maps a person without requesting a paid email reveal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        people: [
          {
            id: 'p1',
            name: 'Jane Smith',
            title: 'VP of Ecommerce',
            linkedin_url: 'https://linkedin.example/in/jane-smith',
            city: 'London',
            country: 'UK',
            organization: { name: 'Acme Industrial Supply Ltd' },
          },
        ],
      }),
    )
    const r = await new ApolloProvider().search(ctx())
    expect(r.status).toBe('available')
    expect(r.candidates[0]).toMatchObject({
      fullName: 'Jane Smith',
      rawTitle: 'VP of Ecommerce',
      statedCompany: 'Acme Industrial Supply Ltd',
      providerPersonId: 'apollo:p1',
      email: null,
      phone: null,
    })
  })

  it('drops a record with no name rather than completing one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { people: [{ id: 'p2', title: 'Catalog Manager' }] }),
    )
    const r = await new ApolloProvider().search(ctx())
    expect(r.candidates).toEqual([])
    expect(r.status).toBe('no_results')
  })

  it('reports an empty result set as no_results with a reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { people: [] }))
    const r = await new ApolloProvider().search(ctx())
    expect(r.status).toBe('no_results')
    expect(r.reason).toBeTruthy()
  })

  it('refuses to run without a company domain to scope by', () => {
    const a = new ApolloProvider().available(ctx({ companyDomain: null }))
    expect(['unauthorized', 'unavailable']).toContain(a.status)
    expect(a.reason).toBeTruthy()
  })
})

describe('ZoomInfo adapter — fixture parsing', () => {
  it('maps a contact and keeps its last-updated date as the observation date', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { jwt: 'fake-jwt' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              id: 42,
              firstName: 'Bob',
              lastName: 'Jones',
              jobTitle: 'Director of Catalog',
              companyName: 'Acme Industrial Supply',
              lastUpdatedDate: '2026-06-01',
              externalUrls: [{ type: 'linkedin', url: 'https://linkedin.example/in/bob-jones' }],
            },
          ],
        }),
      )
    const r = await new ZoomInfoProvider().search(ctx())
    expect(r.candidates[0]).toMatchObject({
      fullName: 'Bob Jones',
      rawTitle: 'Director of Catalog',
      providerPersonId: 'zoominfo:42',
      email: null,
    })
    expect(r.candidates[0]!.evidence[0]!.observedAt).toBeInstanceOf(Date)
  })

  it('surfaces an authentication failure as a thrown error the wrapper classifies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(403, {}))
    const zi = new ZoomInfoProvider()
    // Availability is forced so the authentication path itself is reachable
    // without credentials. Delegating rather than spreading, because spreading
    // a class instance drops its prototype methods.
    const r = await runDmProvider(
      {
        name: zi.name,
        sourceType: zi.sourceType,
        available: () => ({ status: 'available' as const }),
        search: (c) => zi.search(c),
      },
      ctx(),
    )
    expect(r.status).toBe('error')
    expect(r.reason).toMatch(/authentication failed/i)
  })
})

// ── CRM contact provider, against the real stored format ───────────────────

describe('CRM contact provider — the real NXT Sales storage format', () => {
  it('splits "Name - Title" as the CRM actually stores it', async () => {
    const r = await new CrmContactProvider().search(
      ctx({ company: company({ contactPersons: ['Joanna Rose - Ecommerce Manager'] }) }),
    )
    expect(r.candidates[0]).toMatchObject({ fullName: 'Joanna Rose', rawTitle: 'Ecommerce Manager' })
  })

  it('keeps a bare name with a NULL title rather than inventing one', async () => {
    const r = await new CrmContactProvider().search(ctx({ company: company({ contactPersons: ['Mark Gannon'] }) }))
    expect(r.candidates[0]).toMatchObject({ fullName: 'Mark Gannon', rawTitle: null })
  })

  it('never attributes a company-level email or phone to an individual', async () => {
    const r = await new CrmContactProvider().search(
      ctx({
        company: company({
          contactPersons: ['Gary Harte - Shop Manager'],
          email: 'info@acme-industrial.example',
          phone: '+44 20 7946 0000',
        }),
      }),
    )
    expect(r.candidates[0]!.email).toBeNull()
    expect(r.candidates[0]!.phone).toBeNull()
  })

  it('keeps a parenthesised nickname inside the NAME, not in the title', async () => {
    // Verbatim from the restored CRM. Splitting on the parenthesis produced the
    // name "Bronc" and the title "Phillip) Kau President" — a mangled name for
    // a real person, which is the exact failure Stage 4 must not produce.
    const r = await new CrmContactProvider().search(
      ctx({ company: company({ contactPersons: ['Bronc (Phillip) Kau - President'] }) }),
    )
    expect(r.candidates[0]).toMatchObject({ fullName: 'Bronc (Phillip) Kau', rawTitle: 'President' })
  })

  it('keeps a multi-part title verbatim instead of rewriting it', async () => {
    // Also verbatim from the CRM. Splitting on the pipe and rejoining produced
    // "Sales President", a title nobody wrote.
    const r = await new CrmContactProvider().search(
      ctx({ company: company({ contactPersons: ['Tommy Schreiner - Sales | President'] }) }),
    )
    expect(r.candidates[0]).toMatchObject({ fullName: 'Tommy Schreiner', rawTitle: 'Sales | President' })
  })

  it('keeps a quoted nickname inside the name', async () => {
    const r = await new CrmContactProvider().search(
      ctx({ company: company({ contactPersons: ['H.A. "Buzz" Mills - President'] }) }),
    )
    expect(r.candidates[0]!.fullName).toBe('H.A. "Buzz" Mills')
  })

  it('splits only at the FIRST dash, so a hyphenated title survives', async () => {
    const r = await new CrmContactProvider().search(
      ctx({ company: company({ contactPersons: ['Jane Smith - Head of E-Commerce - EMEA'] }) }),
    )
    expect(r.candidates[0]).toMatchObject({ fullName: 'Jane Smith', rawTitle: 'Head of E-Commerce - EMEA' })
  })

  it('does not treat a surname-first name as a title', async () => {
    const r = await new CrmContactProvider().search(
      ctx({ company: company({ contactPersons: ['Smith, Jane'] }) }),
    )
    expect(r.candidates[0]).toMatchObject({ fullName: 'Smith, Jane', rawTitle: null })
  })

  it('accepts a comma separator when what follows is genuinely a title', async () => {
    const r = await new CrmContactProvider().search(
      ctx({ company: company({ contactPersons: ['Jane Smith, VP of Ecommerce'] }) }),
    )
    expect(r.candidates[0]).toMatchObject({ fullName: 'Jane Smith', rawTitle: 'VP of Ecommerce' })
  })

  it('strips a phone number embedded in the name field', async () => {
    // Verbatim from the CRM. Leaving it in wrote a phone number into the
    // fullName column, where the contact-data redaction does not reach.
    const r = await new CrmContactProvider().search(
      ctx({ company: company({ contactPersons: ['Tom Crowhurst, 073597767046 - Marketing Manager'] }) }),
    )
    expect(r.candidates[0]!.fullName).toBe('Tom Crowhurst')
    // Discarded, not reattributed: it could be the company switchboard.
    expect(r.candidates[0]!.phone).toBeNull()
  })

  it('does not mistake a short number in a name for a phone number', async () => {
    const r = await new CrmContactProvider().search(
      ctx({ company: company({ contactPersons: ['Bob Smith II - Catalog Manager'] }) }),
    )
    expect(r.candidates[0]!.fullName).toBe('Bob Smith II')
  })

  it('reports a company with no contacts as no_results, not as an error', () => {
    const a = new CrmContactProvider().available(ctx({ company: company({ contactPersons: [] }) }))
    expect(a.status).toBe('no_results')
    expect(a.reason).toMatch(/no contact persons/i)
  })
})

describe('LinkedIn URL attribution — from the URL, never from the name', () => {
  const blob = ['https://www.linkedin.com/in/pat-o-brien-4259aa4b/ / https://www.linkedin.com/in/joanna-rose-69708b111/']

  it('attaches a profile only when the URL slug contains the person name', () => {
    expect(matchProfileUrl('Joanna Rose', blob)).toBe('https://www.linkedin.com/in/joanna-rose-69708b111')
    expect(matchProfileUrl('Pat O Brien', blob)).toBe('https://www.linkedin.com/in/pat-o-brien-4259aa4b')
  })

  it('returns null for a person whose name is not in any URL', () => {
    // The alternative — handing the first URL to the first contact — is
    // inferring a profile from a name, which Stage 4 forbids outright.
    expect(matchProfileUrl('Someone Else', blob)).toBeNull()
  })

  it('returns null when more than one URL could claim the name', () => {
    expect(
      matchProfileUrl('Jane Smith', [
        'https://www.linkedin.com/in/jane-smith-1',
        'https://www.linkedin.com/in/jane-smith-2',
      ]),
    ).toBeNull()
  })

  it('ignores non-URL noise in the field', () => {
    expect(matchProfileUrl('Jane Smith', ['see her profile', 'n/a'])).toBeNull()
  })

  it('ignores a parenthesised nickname, since slugs are built from the formal name', () => {
    // Requiring "phillip" from "Bronc (Phillip) Kau" would reject that person's
    // own real profile.
    expect(matchProfileUrl('Bronc (Phillip) Kau', ['https://www.linkedin.com/in/bronc-kau-10751869'])).toBe(
      'https://www.linkedin.com/in/bronc-kau-10751869',
    )
  })

  it('ignores a quoted nickname the same way', () => {
    expect(matchProfileUrl('H.A. "Buzz" Mills', ['https://www.linkedin.com/in/h-a-buzz-mills-49215947'])).toBe(
      'https://www.linkedin.com/in/h-a-buzz-mills-49215947',
    )
  })
})

describe('company website provider', () => {
  it('refuses to run without a verified domain rather than guessing one', () => {
    const a = new WebCorroborationProvider().available(ctx({ companyDomain: null }))
    expect(a.status).toBe('unavailable')
    expect(a.reason).toMatch(/no verified website domain/i)
  })

  it('reports an unusable domain instead of constructing a URL from it', async () => {
    const r = await new WebCorroborationProvider().search(ctx({ companyDomain: 'not a hostname' }))
    expect(r.status).toBe('unavailable')
    expect(r.candidates).toEqual([])
  })

  it('recognises a site that answers 200 for every path as having no team page', async () => {
    // Found in the validation run: 4kbm.com returned byte-identical content for
    // all eight paths. Reporting that as eight readable team pages would turn
    // "the server answered" into "the company lists nobody".
    const { fetchPage } = await import('../../src/research/pageFetch.js')
    const mod = await import('../../src/research/pageFetch.js')
    vi.spyOn(mod, 'fetchPage').mockImplementation(async (url: string) => ({
      ok: true,
      requestedUrl: url,
      finalUrl: url,
      text: 'Home\nCompany\nPartners\nContact Us\nSuppliers of premium woodworking solutions',
    }))
    expect(typeof fetchPage).toBe('function')

    const r = await new WebCorroborationProvider().search(ctx())
    expect(r.status).toBe('no_results')
    expect(r.reason).toMatch(/identical content for \d+ different paths/)
    expect((r.metadata as { distinctPages: number }).distinctPages).toBe(1)
  })

  it('still reads people when the pages are genuinely distinct', async () => {
    const mod = await import('../../src/research/pageFetch.js')
    vi.spyOn(mod, 'fetchPage').mockImplementation(async (url: string) => ({
      ok: true,
      requestedUrl: url,
      finalUrl: url,
      // Unique per path, so none is treated as a soft 404.
      text: `Leadership at ${url}\nJane Smith\nVP of Ecommerce`,
    }))
    const r = await new WebCorroborationProvider().search(ctx())
    expect(r.status).toBe('available')
    expect(r.candidates[0]).toMatchObject({ fullName: 'Jane Smith', rawTitle: 'VP of Ecommerce' })
    expect(r.candidates[0]!.evidence[0]!.sourceType).toBe('company_website')
  })
})

// APOLLO'S TWO DIFFERENT 403s.
//
// A key can authenticate perfectly and still be refused: Apollo excludes the
// people-search API from its Free plan and answers 403 with error_code
// API_INACCESSIBLE, while /auth/health for that same key returns
// { healthy: true, is_logged_in: true }.
//
// Reporting that as "Apollo rejected the credential" — which this adapter did
// for every 403 — sends whoever reads it hunting for a key that is not broken.
// "Your key is wrong" and "your plan excludes this" lead to different actions,
// so they have to read differently.
describe('a plan limit is not a rejected credential', () => {
  const ctx = {
    tenantId: 't1',
    company: { id: 'c1', name: 'Acme' } as never,
    companyDomain: 'acme.test',
    maxResults: 10,
  }

  afterEach(() => vi.unstubAllGlobals())

  const apolloSays = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    )

  it('says the key is valid when the plan is what blocked the call', async () => {
    apolloSays(403, {
      error: 'The api/v1/mixed_people/search API is not included in your Free plan and is not accessible.',
      error_code: 'API_INACCESSIBLE',
    })
    const r = await new ApolloProvider().search(ctx)

    expect(r.status).toBe('unauthorized')
    expect(r.reason).toContain('authenticated this key')
    expect(r.reason).toContain('plan does not include')
    expect(r.reason).not.toContain('rejected the credential')
    expect(r.metadata?.credentialValid).toBe(true)
    expect(r.metadata?.apolloErrorCode).toBe('API_INACCESSIBLE')
  })

  it('still says "rejected" when the credential really was rejected', async () => {
    apolloSays(401, { error: 'Unauthorized' })
    const r = await new ApolloProvider().search(ctx)

    expect(r.status).toBe('unauthorized')
    expect(r.reason).toContain('rejected the credential')
    expect(r.metadata?.credentialValid).toBe(false)
  })

  // Whichever kind of 403 it was, no candidate may be produced from it.
  it('produces no candidate from either refusal', async () => {
    apolloSays(403, { error_code: 'API_INACCESSIBLE', error: 'nope' })
    expect((await new ApolloProvider().search(ctx)).candidates).toEqual([])
    apolloSays(401, {})
    expect((await new ApolloProvider().search(ctx)).candidates).toEqual([])
  })
})
