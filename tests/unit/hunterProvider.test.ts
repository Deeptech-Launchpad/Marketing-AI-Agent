import { afterEach, describe, expect, it, vi } from 'vitest'
import { HunterProvider } from '../../src/decisionmakers/providers/hunterProvider.js'
import type { DmProviderContext } from '../../src/decisionmakers/providers/provider.js'

// HUNTER — AN ADDRESS SOMEBODY SAW, NOT AN ADDRESS SOMEBODY WOULD HAVE.
//
// Hunter is the first source in this stage that returns contact details, which
// makes it the first place the platform's oldest rule can be broken: never
// present a guessed email as a found one. Hunter offers both. /v2/domain-search
// returns addresses it observed, each with the pages it saw them on;
// /v2/email-finder synthesises an address from the organisation's inferred
// pattern and scores its own guess.
//
// So the tests that matter are about which of those two this provider is
// willing to emit, and about the difference between "no people here" and "no
// answer here".

const ctx = (over: Partial<DmProviderContext> = {}): DmProviderContext => ({
  tenantId: 't1',
  company: { id: 'c1', name: 'Acme Supplies' } as never,
  companyDomain: 'acme.test',
  maxResults: 10,
  ...over,
})

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
  })
}

let calls: string[] = []
afterEach(() => {
  calls = []
  vi.unstubAllGlobals()
})

const person = (over: Record<string, unknown> = {}) => ({
  value: 'dana.reed@acme.test',
  type: 'personal',
  confidence: 94,
  first_name: 'Dana',
  last_name: 'Reed',
  position: 'Head of Ecommerce',
  linkedin: 'https://www.linkedin.com/in/dana-reed',
  sources: [
    { uri: 'https://acme.test/about/team', extracted_on: '2026-08-01', still_on_page: true },
    { uri: 'https://acme.test/contact', extracted_on: '2026-07-02', still_on_page: false },
  ],
  ...over,
})

const generic = (value: string) => ({ value, type: 'generic', confidence: 88, sources: [{ uri: 'https://acme.test/' }] })

describe('an observed address becomes a candidate', () => {
  it('emits the person Hunter actually recorded', async () => {
    respond(200, { data: { organization: 'Acme Supplies Ltd', pattern: '{first}.{last}', emails: [person()] } })
    const r = await new HunterProvider().search(ctx())

    expect(r.status).toBe('available')
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]).toMatchObject({
      fullName: 'Dana Reed',
      rawTitle: 'Head of Ecommerce',
      email: 'dana.reed@acme.test',
      statedCompany: 'Acme Supplies Ltd',
      profileUrl: 'https://www.linkedin.com/in/dana-reed',
    })
  })

  // The whole reason Hunter is usable here: an address arrives with the pages
  // it was seen on, so a contact detail can be checked without trusting us.
  it('carries the pages the address was seen on, with their dates', async () => {
    respond(200, { data: { emails: [person()] } })
    const r = await new HunterProvider().search(ctx())
    const evidence = r.candidates[0]!.evidence

    expect(evidence.length).toBe(2)
    expect(evidence[0]!.sourceUrl).toBe('https://acme.test/about/team')
    expect(evidence[0]!.observedAt?.toISOString().slice(0, 10)).toBe('2026-08-01')
    expect(evidence[0]!.supports).toContain('contact')
    // A page that no longer carries the address still counts as evidence, and
    // says so rather than being dropped or presented as current.
    expect(evidence[1]!.snippet).toContain('no longer on that page')
  })

  it('records no title when Hunter stated none', async () => {
    respond(200, { data: { emails: [person({ position: null })] } })
    const r = await new HunterProvider().search(ctx())
    expect(r.candidates[0]!.rawTitle).toBeNull()
    expect(r.candidates[0]!.evidence[0]!.supports).not.toContain('title')
  })
})

describe('a shared mailbox is not a person', () => {
  it('emits no candidate for info@, sales@ or admin@', async () => {
    respond(200, { data: { emails: [generic('info@acme.test'), generic('sales@acme.test')] } })
    const r = await new HunterProvider().search(ctx())
    expect(r.candidates).toEqual([])
  })

  // "There are addresses but nobody named" and "there is nothing here" are
  // different facts about a company, and a salesperson needs the difference.
  it('says how many shared mailboxes it found, and names them', async () => {
    respond(200, { data: { emails: [generic('info@acme.test'), generic('sales@acme.test')] } })
    const r = await new HunterProvider().search(ctx())
    expect(r.reason).toContain('none of them attributable to a named person')
    expect(r.reason).toContain('info@acme.test')
    expect(r.metadata?.genericMailboxes).toBe(2)
  })

  it('says plainly when Hunter holds nothing at all', async () => {
    respond(200, { data: { emails: [] } })
    const r = await new HunterProvider().search(ctx())
    expect(r.reason).toBe('Hunter holds no email address for acme.test.')
    expect(r.metadata?.addressesHeld).toBe(0)
  })

  it('drops a personal-typed address that carries no name', async () => {
    respond(200, { data: { emails: [person({ first_name: null, last_name: null })] } })
    expect((await new HunterProvider().search(ctx())).candidates).toEqual([])
  })
})

describe('no address is ever guessed', () => {
  // /v2/email-finder synthesises an address from the inferred pattern and
  // scores its own guess. It is a good guess and it is still a guess.
  it('only ever calls domain-search', async () => {
    respond(200, { data: { emails: [person()] } })
    await new HunterProvider().search(ctx())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/v2/domain-search')
    expect(calls.join(' ')).not.toContain('email-finder')
  })

  it('records the inferred pattern without ever building an address from it', async () => {
    respond(200, { data: { pattern: '{first}.{last}', emails: [generic('info@acme.test')] } })
    const r = await new HunterProvider().search(ctx())
    expect(r.metadata?.emailPatternHunterInferred).toBe('{first}.{last}')
    // The pattern is knowledge about the organisation, not a contact detail.
    expect(r.candidates).toEqual([])
    expect(r.reason).toContain('No address was guessed')
  })

  it('makes exactly one request, because a search is metered', async () => {
    respond(200, { data: { emails: [] } })
    await new HunterProvider().search(ctx())
    expect(calls).toHaveLength(1)
  })

  it('bounds the page it asks for by the caller’s cap', async () => {
    respond(200, { data: { emails: [] } })
    await new HunterProvider().search(ctx({ maxResults: 3 }))
    expect(calls[0]).toContain('limit=3')
  })
})

describe('a blocker is never reported as an empty market', () => {
  it('separates a rejected key from a company with no contacts', async () => {
    respond(401, { errors: [{ details: 'Invalid API key.' }] })
    const r = await new HunterProvider().search(ctx())
    expect(r.status).toBe('unauthorized')
    expect(r.reason).toBe('Invalid API key.')
    expect(r.candidates).toEqual([])
  })

  it('separates an exhausted allowance from an empty result', async () => {
    respond(429, { errors: [{ details: 'Too many requests.' }] })
    expect((await new HunterProvider().search(ctx())).status).toBe('rate_limited')
  })

  it('reports a server fault as an error rather than as no data', async () => {
    respond(500, {})
    const r = await new HunterProvider().search(ctx())
    expect(r.status).toBe('error')
    expect(r.reason).toContain('500')
  })

  // Hunter searches by domain. Matching on a company name instead would return
  // whichever organisation happened to share the string.
  it('refuses to run without a verified domain, and says why', () => {
    const a = new HunterProvider().available(ctx({ companyDomain: null }))
    expect(a.status).toBe('unavailable')
    expect(a.reason).toContain('searches by domain')
  })
})

// A 200 THAT IS NOT HUNTER'S DATA IS AN ERROR, NOT "NO EMAIL" (2026-10-06).
describe('a reply that is not Hunter’s data', () => {
  it('reports an error rather than "Hunter holds no email address"', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Bad gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    const r = await new HunterProvider().search(ctx())
    expect(r.status).toBe('error')
    expect(r.reason).toMatch(/result is unknown/)
    expect(r.reason).not.toMatch(/holds no email/)
  })

  it('still reports a genuinely empty Hunter answer as empty', async () => {
    respond(200, { data: { emails: [] } })
    const r = await new HunterProvider().search(ctx())
    expect(r.reason).toMatch(/holds no email address/)
  })
})

// THE "NOBODY FOUND" SENTENCE NAMES SOURCES THAT FAILED (2026-10-06).
describe('explaining an empty result', () => {
  it('says which sources failed instead of implying they found nobody', async () => {
    const { explainNoResults } = await import('../../src/decisionmakers/discovery.js')
    const text = explainNoResults(
      [
        { provider: 'apollo', status: 'error', candidates: [], reason: 'HTTP 500', durationMs: 1 },
        { provider: 'hunter', status: 'rate_limited', candidates: [], reason: 'Too many requests', durationMs: 1 },
        { provider: 'company_website', status: 'no_results', candidates: [], durationMs: 1 },
      ] as never,
      0,
      0,
    )
    expect(text).toMatch(/2 source\(s\) failed, so their answer is unknown: apollo \(error: HTTP 500\); hunter \(rate-limited: Too many requests\)/)
    expect(text).toMatch(/1 source\(s\) ran and returned nobody/)
  })
})
