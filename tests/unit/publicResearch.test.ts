import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// THE PUBLIC RESEARCH LAYER.
//
// One rule is under test throughout, and everything else follows from it:
//
//   A SEARCH ENGINE SAYS WHERE TO LOOK. IT NEVER SAYS WHAT IS TRUE.
//
// So the tests are mostly about what CANNOT come out of this layer: a person
// the fetched page does not name, a title the page did not state, a summary of
// a sign-in wall, an email, a date the source never gave. Widening the net is
// only safe if the standard of proof is unchanged, and these are the proof.
//
// THE GENERALISATION TEST AT THE BOTTOM IS THE POINT OF THE WHOLE FILE. Every
// fixture is run twice with the company's identity swapped — different name,
// different domain, different people, different URLs — and the two runs must
// produce structurally identical output. A layer that behaves differently for
// one company than another has a company-specific branch in it somewhere, and
// that is the one defect this design exists to make impossible.

// ── The doubles ───────────────────────────────────────────────────────────

const searchWeb = vi.fn()
const generate = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ searchWeb, generate }) }))

const fetchPageRaw = vi.fn()
vi.mock('../../src/research/pageFetch.js', () => ({ fetchPageRaw }))

vi.mock('../../src/config/env.js', () => ({
  env: {
    PUBLIC_RESEARCH_ENABLED: true,
    PUBLIC_RESEARCH_MAX_SOURCES: 6,
    PUBLIC_RESEARCH_MAX_PAGES: 4,
    DM_MODEL_READER_ENABLED: true,
    SEARCH_API_PROVIDER: 'none',
  },
}))

// Stubbed because the real logger builds itself from the real env, and this
// file deliberately supplies a minimal one.
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

const {
  discoverPublicSources,
  readPublicSource,
  readPublicSources,
  looksLikeLoginWall,
  NO_EVIDENCE,
} = await import('../../src/research/publicResearch.js')
const { PublicResearchProvider } = await import('../../src/decisionmakers/providers/publicResearchProvider.js')
const { isEventGrounded } = await import('../../src/intent/eventReader.js')
const { outreachAngleFor } = await import('../../src/intent/outreachAngles.js')

/**
 * Two companies that share NOTHING — name, domain, people, wording, URL shape.
 *
 * Used to run every fixture twice. If any assertion holds for one and not the
 * other, the layer is reading something it should not be.
 */
const COMPANIES = [
  {
    label: 'company A',
    id: 'co_a',
    name: 'Northwind Fasteners',
    domain: 'northwind-fasteners.test',
    person: 'Dana Reed',
    title: 'Head of Ecommerce',
    role: 'Product Data Manager',
    product: 'stainless fixings',
  },
  {
    label: 'company B',
    id: 'co_b',
    name: 'Lumière Sanitaire SARL',
    domain: 'lumiere-sanitaire.test',
    person: 'Arnaud Beaulieu',
    title: 'Directeur Commercial',
    role: 'Responsable Données Produit',
    product: 'robinetterie',
  },
] as const
type Company = (typeof COMPANIES)[number]

/**
 * Page-sized prose, because these fixtures must clear the same content floor a
 * real page does: readPublicSource refuses anything under 200 characters, and
 * that floor is what stops a navigation shell or a cookie banner being handed
 * to a reader as though it were a page.
 */
const FILLER =
  'The business has traded for over thirty years and serves trade customers across the region, ' +
  'holding the full range in stock and offering next-day delivery on every stocked line.'

const crmCompany = (c: Company) =>
  ({
    id: c.id,
    name: c.name,
    domain: c.domain,
    email: null,
    emails: [],
    phone: null,
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
  }) as never

const ctxFor = (c: Company) => ({
  tenantId: 't1',
  company: crmCompany(c),
  companyDomain: c.domain,
  maxResults: 5,
})

/** A search that returns these URLs, as the index would. */
const searchReturns = (...urls: string[]) => {
  searchWeb.mockResolvedValue({
    ok: true,
    provider: 'gemini',
    queriesRun: ['q'],
    references: urls.map((url) => ({ url, title: null })),
    modelText: 'ignored — never evidence',
    model: 'gemini-flash-latest',
    costUsd: 0,
    reason: null,
  })
}

/** A page that serves this HTML, as the guarded fetcher would report it. */
const pageServes = (html: string, finalUrl?: string) => {
  fetchPageRaw.mockImplementation(async (url: string) => ({
    ok: true,
    html,
    finalUrl: finalUrl ?? url,
    status: 200,
    contentType: 'text/html',
    reason: null,
  }))
}

/** The model claims these people; grounding then decides which survive. */
const modelClaims = (people: Array<{ fullName: string; rawTitle: string | null; sourceSentence: string }>) => {
  generate.mockResolvedValue({ data: { people }, model: 'gemini-flash-latest', costUsd: 0 })
}

beforeEach(() => {
  vi.clearAllMocks()
  searchWeb.mockResolvedValue({
    ok: true,
    provider: 'gemini',
    queriesRun: [],
    references: [],
    modelText: '',
    model: null,
    costUsd: 0,
    reason: 'The search returned no indexed pages for that query.',
  })
  fetchPageRaw.mockResolvedValue({ ok: false, html: '', finalUrl: null, reason: 'not stubbed' })
  generate.mockResolvedValue({ data: { people: [] }, model: 'gemini-flash-latest', costUsd: 0 })
})
afterEach(() => vi.restoreAllMocks())

// ── FIXTURE 1: a person named on an about page ────────────────────────────

describe('1. a person named on a company about page', () => {
  const run = async (c: Company) => {
    const url = `https://${c.domain}/about-us`
    searchReturns(url)
    pageServes(
      `<html><body><h1>About ${c.name}</h1>
       <p>${c.person} is our ${c.title} and has led the team since 2019.</p>
       <p>We supply ${c.product} across the region. ${FILLER}</p>
       </body></html>`,
    )
    modelClaims([
      { fullName: c.person, rawTitle: c.title, sourceSentence: `${c.person} is our ${c.title}` },
    ])
    return new PublicResearchProvider().search(ctxFor(c) as never)
  }

  for (const c of COMPANIES) {
    it(`finds them, with the page's own sentence as evidence — ${c.label}`, async () => {
      const result = await run(c)
      expect(result.status).toBe('available')
      expect(result.candidates).toHaveLength(1)

      const person = result.candidates[0]!
      expect(person.fullName).toBe(c.person)
      expect(person.rawTitle).toBe(c.title)

      const evidence = person.evidence[0]!
      expect(evidence.provider).toBe('public_web_research')
      // The company's OWN domain, so this counts as the company speaking.
      expect(evidence.sourceType).toBe('company_website')
      expect(evidence.sourceUrl).toBe(`https://${c.domain}/about-us`)
      expect(evidence.snippet).toContain(c.person)
      expect(evidence.supports).toContain('title')
      // Staff listings are undated; stamping "now" would assert the listing
      // is current when only the fetch is.
      expect(evidence.observedAt).toBeNull()
    })

    it(`takes no contact detail from it — ${c.label}`, async () => {
      const person = (await run(c)).candidates[0]!
      expect(person.email).toBeNull()
      expect(person.phone).toBeNull()
    })
  }
})

// ── FIXTURE 2: a person found on a third-party public page ────────────────

describe('2. a person found in a public web result', () => {
  const run = async (c: Company) => {
    searchReturns('https://trade-journal.test/2026/supply-chain-appointments')
    pageServes(
      `<html><body><article>
       <h1>Appointments this month</h1>
       <p>${c.person} has been appointed ${c.title} at ${c.name}, the ${c.product} distributor.</p>
       <p>The company said the role would focus on the catalogue. ${FILLER}</p>
       </article></body></html>`,
    )
    modelClaims([
      {
        fullName: c.person,
        rawTitle: c.title,
        sourceSentence: `${c.person} has been appointed ${c.title} at ${c.name}`,
      },
    ])
    return new PublicResearchProvider().search(ctxFor(c) as never)
  }

  for (const c of COMPANIES) {
    it(`records them as third-party evidence, not as the company speaking — ${c.label}`, async () => {
      const result = await run(c)
      const person = result.candidates[0]!
      const evidence = person.evidence[0]!

      expect(person.fullName).toBe(c.person)
      expect(evidence.sourceType).toBe('third_party')
      expect(evidence.sourceUrl).toBe('https://trade-journal.test/2026/supply-chain-appointments')
      // A trade article is not the authority on who a company employs, so the
      // employer is left for the engine's company-match step to judge from the
      // words the page used.
      expect(person.statedCompany).toBeNull()
      expect(evidence.supports).not.toContain('company')
    })
  }
})

// ── FIXTURE 3: a name found, but no title stated ──────────────────────────

describe('3. a name is found but the source states no title', () => {
  const run = async (c: Company) => {
    searchReturns(`https://${c.domain}/news/opening`)
    pageServes(
      `<html><body><p>The new depot was opened by ${c.person} last week, in front of staff and customers.</p>
       <p>${c.name} has traded in ${c.product} since the 1990s. ${FILLER}</p></body></html>`,
    )
    modelClaims([
      { fullName: c.person, rawTitle: null, sourceSentence: `The new depot was opened by ${c.person}` },
    ])
    return new PublicResearchProvider().search(ctxFor(c) as never)
  }

  for (const c of COMPANIES) {
    it(`returns the name with rawTitle null, never a supplied one — ${c.label}`, async () => {
      const result = await run(c)
      const person = result.candidates[0]!
      expect(person.fullName).toBe(c.person)
      // THE CENTRAL RULE: the source established a name and nothing more.
      expect(person.rawTitle).toBeNull()
      expect(person.evidence[0]!.supports).toEqual(['name', 'company'])
      expect(result.metadata?.namedWithoutARole).toBe(1)
    })
  }
})

// ── The grounding guarantee, which widening the net must not weaken ───────

describe('a person the fetched page does not name cannot survive', () => {
  for (const c of COMPANIES) {
    it(`drops a fluent invention — ${c.label}`, async () => {
      searchReturns(`https://${c.domain}/about`)
      pageServes(`<html><body><p>${c.name} supplies ${c.product}. Contact the office for a quote today. ${FILLER}</p></body></html>`)
      // Nobody is named on that page. The model says otherwise.
      modelClaims([
        { fullName: 'Robert Vance', rawTitle: 'Chief Executive', sourceSentence: 'Robert Vance, Chief Executive' },
      ])

      const result = await new PublicResearchProvider().search(ctxFor(c) as never)
      expect(result.candidates).toHaveLength(0)
      expect(result.status).toBe('no_results')
      // Counted, so the guard's work is visible rather than silent.
      expect(result.metadata?.claimsRejectedAsUngrounded).toBe(1)
    })

    it(`drops a real person given a title the page never stated — ${c.label}`, async () => {
      searchReturns(`https://${c.domain}/about`)
      pageServes(`<html><body><p>${c.person} joined the business in 2014 and works in the depot every day. ${FILLER}</p></body></html>`)
      modelClaims([
        // The name IS on the page. The title is not.
        { fullName: c.person, rawTitle: 'Managing Director', sourceSentence: `${c.person} joined the business in 2014` },
      ])

      const result = await new PublicResearchProvider().search(ctxFor(c) as never)
      expect(result.candidates).toHaveLength(0)
      expect(result.metadata?.claimsRejectedAsUngrounded).toBe(1)
    })
  }
})

// ── FIXTURE 6: a login wall ───────────────────────────────────────────────

describe('6. a platform that serves a sign-in wall', () => {
  const WALLS = [
    'Sign in to continue to your feed. Join LinkedIn today for free.',
    'Please log in to view this profile.',
    'Log in or sign up to view photos and videos.',
  ]

  for (const wall of WALLS) {
    it(`is recognised as a wall, not content: ${wall.slice(0, 32)}…`, () => {
      expect(looksLikeLoginWall(wall)).toBe(true)
    })
  }

  it('does not mistake ordinary prose containing the word "login" for a wall', () => {
    const page =
      'Our trade customers can order online through the portal. The login link is in the top right of every ' +
      'page, and a member of the team can set up an account for you within one working day. Delivery is next ' +
      'day for stocked lines and we keep the full range in the warehouse at all times for trade accounts.'
    expect(looksLikeLoginWall(page)).toBe(false)
  })

  for (const c of COMPANIES) {
    it(`yields no candidate and says why — ${c.label}`, async () => {
      searchReturns('https://social.test/company/whoever')
      pageServes('<html><body><p>Sign in to continue. Join LinkedIn today for free.</p></body></html>')

      const result = await new PublicResearchProvider().search(ctxFor(c) as never)
      expect(result.candidates).toHaveLength(0)
      expect(result.metadata?.loginWalls).toBe(1)
      expect(result.reason).toContain('sign-in wall')
      // The page's bytes were never handed to the reader.
      expect(generate).not.toHaveBeenCalled()
    })
  }

  it('reports the wall through readPublicSource without summarising it', async () => {
    pageServes('<html><body><p>Sign in to see who works here. Join LinkedIn today.</p></body></html>')
    const read = await readPublicSource({ url: 'https://social.test/x', title: null, discoveredVia: 'gemini' })
    expect(read.loginWall).toBe(true)
    expect(read.text).toBe('')
    expect(read.reason).toContain('sign-in wall')
  })
})

// ── FIXTURE 7: a company the open web has nothing on ──────────────────────

describe('7. a company with no public evidence at all', () => {
  for (const c of COMPANIES) {
    it(`returns "not found", never "does not exist" — ${c.label}`, async () => {
      // The default mock: the search ran and returned nothing.
      const result = await new PublicResearchProvider().search(ctxFor(c) as never)

      expect(result.status).toBe('no_results')
      expect(result.candidates).toHaveLength(0)
      expect(result.reason).toContain(NO_EVIDENCE)
      // The distinction the whole provider-status vocabulary exists for.
      expect(result.status).not.toBe('unavailable')
      expect(result.reason).not.toMatch(/does not exist|has no (staff|people|employees)|nobody works/i)
    })
  }

  it('tells "searched and found nothing" apart from "could not search"', async () => {
    const searched = await discoverPublicSources({
      tenantId: 't1',
      companyName: 'Any Company Ltd',
      domain: null,
      topic: 'people',
      feature: 'test',
    })
    expect(searched.status).toBe('available')
    expect(searched.reason).toBe(NO_EVIDENCE)

    searchWeb.mockResolvedValue({
      ok: false,
      provider: 'gemini',
      queriesRun: [],
      references: [],
      modelText: '',
      model: null,
      costUsd: 0,
      reason: 'No search capability is configured.',
    })
    const couldNot = await discoverPublicSources({
      tenantId: 't1',
      companyName: 'Any Company Ltd',
      domain: null,
      topic: 'people',
      feature: 'test',
    })
    expect(couldNot.status).toBe('error')
    expect(couldNot.reason).toContain('No search capability is configured.')
  })
})

// ── The query never asks who works somewhere ──────────────────────────────

describe('the search is asked for pages, never for an answer', () => {
  for (const c of COMPANIES) {
    it(`composes the query from facts we already hold — ${c.label}`, async () => {
      await new PublicResearchProvider().search(ctxFor(c) as never)

      const query = searchWeb.mock.calls[0]![0].query as string
      // It carries the company's own name and domain — facts from the CRM.
      expect(query).toContain(c.name)
      expect(query).toContain(c.domain)
      // It asks for PAGES. The forbidden question has an answer whether or not
      // one is true, which is exactly why it is never asked.
      expect(query).toMatch(/pages/i)
      expect(query).not.toMatch(/^who works at/i)
      expect(query).toMatch(/only report pages you actually retrieved/i)
    })
  }
})

// ── Where it looks, and how the budget is spent ───────────────────────────
//
// COH Sales: one query for "leadership or team pages" returned six pages of a
// four-page catalogue site - about, contact, faq, terms - and the company's
// managing director, named on a trade listing, was never looked for. Two
// things were wrong: the question, and who got to spend the budget.

describe('the people search looks in more than one kind of place', () => {
  for (const c of COMPANIES) {
    it(`asks the company site, the registries and the named roles — ${c.label}`, async () => {
      await new PublicResearchProvider().search(ctxFor(c) as never)

      const queries = searchWeb.mock.calls.map((call) => String(call[0].query))
      expect(queries.length).toBeGreaterThanOrEqual(3)
      expect(queries.some((q) => q.includes(c.domain) && /about|team|staff|contact/i.test(q))).toBe(true)
      expect(queries.some((q) => /registry|filing|director|officer/i.test(q))).toBe(true)
      expect(queries.some((q) => /managing director|owner|general manager|purchasing/i.test(q))).toBe(true)
      // Every one of them still asks for retrieved pages, and none asks who
      // works somewhere.
      for (const q of queries) {
        expect(q).toMatch(/only report pages you actually retrieved/i)
        expect(q).not.toMatch(/^who works at/i)
      }
    })
  }

  it('lets every search contribute, rather than the first one taking the budget', async () => {
    // The first query can answer with more pages than the whole budget. What
    // must not happen is the later questions going unasked and unheard.
    const site = Array.from({ length: 8 }, (_, i) => ({ url: `https://acme.test/page-${i}`, title: `Page ${i}` }))
    searchWeb
      .mockResolvedValueOnce({ ok: true, provider: 'gemini', costUsd: 0, queriesRun: ['q1'], references: site, modelText: '' })
      .mockResolvedValueOnce({
        ok: true, provider: 'gemini', costUsd: 0, queriesRun: ['q2'],
        references: [{ url: 'https://registry.test/acme', title: 'Acme — company officers' }], modelText: '',
      })
      .mockResolvedValueOnce({
        ok: true, provider: 'gemini', costUsd: 0, queriesRun: ['q3'],
        references: [{ url: 'https://trade.test/acme', title: 'Acme — managing director' }], modelText: '',
      })

    const out = await discoverPublicSources({
      tenantId: 't1', companyName: 'Acme Industrial Supply Ltd', domain: 'acme.test',
      topic: 'people', feature: 'test',
    })

    const urls = out.sources.map((s) => s.url)
    expect(urls).toContain('https://registry.test/acme')
    expect(urls).toContain('https://trade.test/acme')
    // And the budget is still respected.
    expect(out.sources.length).toBeLessThanOrEqual(6)
  })

  it('gives the whole budget to the one search that answered, when the others do not', async () => {
    const site = Array.from({ length: 8 }, (_, i) => ({ url: `https://acme.test/p${i}`, title: `P${i}` }))
    searchWeb
      .mockResolvedValueOnce({ ok: true, provider: 'gemini', costUsd: 0, queriesRun: ['q1'], references: site, modelText: '' })
      .mockResolvedValueOnce({ ok: true, provider: 'gemini', costUsd: 0, queriesRun: ['q2'], references: [], modelText: '' })
      .mockResolvedValueOnce({ ok: true, provider: 'gemini', costUsd: 0, queriesRun: ['q3'], references: [], modelText: '' })

    const out = await discoverPublicSources({
      tenantId: 't1', companyName: 'Acme Industrial Supply Ltd', domain: 'acme.test',
      topic: 'people', feature: 'test',
    })
    expect(out.sources).toHaveLength(6)
  })

  it('leaves a single-question topic exactly as it was', async () => {
    searchWeb.mockResolvedValue({
      ok: true, provider: 'gemini', costUsd: 0, queriesRun: ['q'],
      references: [{ url: 'https://acme.test/jobs', title: 'Careers' }], modelText: '',
    })
    const out = await discoverPublicSources({
      tenantId: 't1', companyName: 'Acme Industrial Supply Ltd', domain: 'acme.test',
      topic: 'hiring', feature: 'test',
    })
    expect(searchWeb.mock.calls).toHaveLength(1)
    expect(out.sources.map((s) => s.url)).toEqual(['https://acme.test/jobs'])
  })
})

// ── The model's prose is never evidence ───────────────────────────────────

describe('nothing is ever read out of the search reply itself', () => {
  for (const c of COMPANIES) {
    it(`ignores modelText entirely — ${c.label}`, async () => {
      searchWeb.mockResolvedValue({
        ok: true,
        provider: 'gemini',
        queriesRun: ['q'],
        references: [],
        // A complete, fluent, entirely unsupported answer.
        modelText: `${c.person} is the ${c.title} at ${c.name}, reachable at ${c.person.split(' ')[0]!.toLowerCase()}@${c.domain}.`,
        model: 'gemini-flash-latest',
        costUsd: 0,
        reason: null,
      })

      const result = await new PublicResearchProvider().search(ctxFor(c) as never)
      expect(result.candidates).toHaveLength(0)
      expect(JSON.stringify(result)).not.toContain(c.person)
      expect(JSON.stringify(result)).not.toContain('@')
    })
  }
})

// ── Intent: events, jobs and angles ───────────────────────────────────────

describe('4 & 5. what a public page establishes about a company', () => {
  for (const c of COMPANIES) {
    const page = `${c.name} has expanded its ${c.product} range. We are also recruiting a ${c.role} to join the team.`

    it(`accepts an event quoted verbatim from the page — ${c.label}`, () => {
      expect(
        isEventGrounded(
          {
            summary: 'The range was expanded',
            sourceSentence: `${c.name} has expanded its ${c.product} range`,
            jobTitle: null,
            statedDate: null,
            kind: 'announcement',
          },
          page,
        ),
      ).toBe(true)
    })

    it(`accepts a job title the page explicitly advertises — ${c.label}`, () => {
      expect(
        isEventGrounded(
          {
            summary: 'A role is advertised',
            sourceSentence: `We are also recruiting a ${c.role}`,
            jobTitle: c.role,
            statedDate: null,
            kind: 'job_posting',
          },
          page,
        ),
      ).toBe(true)
    })

    it(`refuses a job title the page never states — ${c.label}`, () => {
      expect(
        isEventGrounded(
          {
            summary: 'A role is advertised',
            sourceSentence: `We are also recruiting a ${c.role}`,
            // Plausible, adjacent, and not on the page.
            jobTitle: 'Head of Digital Transformation',
            statedDate: null,
            kind: 'job_posting',
          },
          page,
        ),
      ).toBe(false)
    })

    it(`refuses an event the page never states — ${c.label}`, () => {
      expect(
        isEventGrounded(
          {
            summary: 'The company was acquired',
            sourceSentence: `${c.name} has been acquired by a private equity group`,
            jobTitle: null,
            statedDate: null,
            kind: 'announcement',
          },
          page,
        ),
      ).toBe(false)
    })
  }
})

describe('the outreach angle is composed, never generated', () => {
  it('quotes back only a role a source actually published', () => {
    for (const c of COMPANIES) {
      const withRole = outreachAngleFor({ category: 'hiring', statedJobTitle: c.role })
      expect(withRole).toContain(c.role)

      const withoutRole = outreachAngleFor({ category: 'hiring', statedJobTitle: null })
      expect(withoutRole).not.toBeNull()
      expect(withoutRole).not.toContain(c.role)
      // No role is invented to fill the gap.
      expect(withoutRole).not.toMatch(/“[^”]+”/)
    }
  })

  it('is identical for two different companies in the same category', () => {
    // The angle is about OUR opening, so it cannot vary by company.
    expect(outreachAngleFor({ category: 'catalog' })).toBe(outreachAngleFor({ category: 'catalog' }))
    expect(outreachAngleFor({ category: 'business' })).toBe(outreachAngleFor({ category: 'business' }))
  })

  it('returns null rather than padding a category that suggests no opening', () => {
    expect(outreachAngleFor({ category: 'crm' })).toBeNull()
  })

  it('never states a fact about the company', () => {
    for (const category of ['catalog', 'hiring', 'technology', 'website', 'business', 'news'] as const) {
      const angle = outreachAngleFor({ category })!
      // Reads as a suggestion about a conversation, not a claim about them.
      expect(angle, category).toMatch(/^(Approach around|The role)/)
      expect(angle, category).not.toMatch(/\bthey (are|have|need|want)\b/i)
    }
  })
})

// ── FIXTURE 8: many sources at once ───────────────────────────────────────

describe('8. a company with evidence from several kinds of source at once', () => {
  for (const c of COMPANIES) {
    it(`keeps each person tied to the page they came from — ${c.label}`, async () => {
      const own = `https://${c.domain}/leadership`
      const press = 'https://industry-press.test/appointments'
      const wall = 'https://social.test/company/x'
      searchReturns(own, press, wall)

      fetchPageRaw.mockImplementation(async (url: string) => {
        if (url === own) {
          return {
            ok: true,
            finalUrl: own,
            html: `<html><body><p>${c.person}, ${c.title}, leads the commercial team at ${c.name}. The business supplies ${c.product}. ${FILLER}</p></body></html>`,
          }
        }
        if (url === press) {
          return {
            ok: true,
            finalUrl: press,
            html: `<html><body><p>Jules Ferreira was named Operations Lead at ${c.name} this spring, the company confirmed to this publication. ${FILLER}</p></body></html>`,
          }
        }
        return { ok: true, finalUrl: wall, html: '<html><body><p>Sign in to continue. Join LinkedIn today.</p></body></html>' }
      })

      generate.mockImplementation(async (opts: { variables: { pageText: string } }) => {
        const text = opts.variables.pageText
        if (text.includes(c.person)) {
          return {
            data: { people: [{ fullName: c.person, rawTitle: c.title, sourceSentence: `${c.person}, ${c.title}` }] },
            model: 'm',
            costUsd: 0,
          }
        }
        return {
          data: {
            people: [
              { fullName: 'Jules Ferreira', rawTitle: 'Operations Lead', sourceSentence: 'Jules Ferreira was named Operations Lead' },
            ],
          },
          model: 'm',
          costUsd: 0,
        }
      })

      const result = await new PublicResearchProvider().search(ctxFor(c) as never)

      expect(result.candidates).toHaveLength(2)
      const byName = new Map(result.candidates.map((p) => [p.fullName, p]))

      // Each person carries the URL they were actually read from.
      expect(byName.get(c.person)!.evidence[0]!.sourceUrl).toBe(own)
      expect(byName.get(c.person)!.evidence[0]!.sourceType).toBe('company_website')
      expect(byName.get('Jules Ferreira')!.evidence[0]!.sourceUrl).toBe(press)
      expect(byName.get('Jules Ferreira')!.evidence[0]!.sourceType).toBe('third_party')

      // The wall contributed nothing, and is reported as a wall.
      expect(result.metadata?.loginWalls).toBe(1)
      expect(result.candidates.every((p) => p.email === null)).toBe(true)
    })
  }
})

// ── THE GENERALISATION PROOF ──────────────────────────────────────────────

describe('every fixture behaves identically after the company identity is swapped', () => {
  /** Runs one fixture for a company and reduces it to its SHAPE. */
  const shapeOf = async (c: Company): Promise<string> => {
    const url = `https://${c.domain}/about-us`
    searchReturns(url)
    pageServes(
      `<html><body><p>${c.person} is our ${c.title}.</p><p>${c.name} supplies ${c.product} to the trade. ${FILLER}</p></body></html>`,
    )
    modelClaims([{ fullName: c.person, rawTitle: c.title, sourceSentence: `${c.person} is our ${c.title}` }])

    const result = await new PublicResearchProvider().search(ctxFor(c) as never)

    // Everything EXCEPT the identity: the structure the engine will act on.
    return JSON.stringify({
      status: result.status,
      candidates: result.candidates.map((p) => ({
        hasName: Boolean(p.fullName),
        hasTitle: p.rawTitle !== null,
        email: p.email,
        phone: p.phone,
        profileUrl: p.profileUrl,
        evidence: p.evidence.map((e) => ({
          provider: e.provider,
          sourceType: e.sourceType,
          hasUrl: Boolean(e.sourceUrl),
          hasSnippet: Boolean(e.snippet),
          observedAt: e.observedAt,
          supports: e.supports,
        })),
      })),
      rejected: result.metadata?.claimsRejectedAsUngrounded,
      untitled: result.metadata?.namedWithoutARole,
    })
  }

  it('produces the same structure for two companies sharing nothing', async () => {
    const a = await shapeOf(COMPANIES[0])
    const b = await shapeOf(COMPANIES[1])
    expect(a).toBe(b)
  })

  it('produces the same structure for a company whose name is punctuation-heavy', async () => {
    const odd = { ...COMPANIES[0], name: 'O’Brien & Sons (Ireland) Ltd.', domain: 'obrien-sons.test' } as Company
    const baseline = await shapeOf(COMPANIES[1])
    expect(await shapeOf(odd)).toBe(baseline)
  })

  it('carries no company name, domain or person into the query template shape', async () => {
    // The SAME templates, with only the substituted facts differing. Every
    // query is compared, not just the first: a company-specific branch could
    // as easily hide in the third question as in the opening one.
    await new PublicResearchProvider().search(ctxFor(COMPANIES[0]) as never)
    const qa = searchWeb.mock.calls.map((call) => String(call[0].query))
    searchWeb.mockClear()
    await new PublicResearchProvider().search(ctxFor(COMPANIES[1]) as never)
    const qb = searchWeb.mock.calls.map((call) => String(call[0].query))

    const strip = (q: string, c: Company) =>
      q
        .split(`${c.name} (${c.domain})`)
        .join('<COMPANY>')
        .split(c.name)
        .join('<NAME>')
        .split(c.domain)
        .join('<DOMAIN>')

    expect(qa.length).toBe(qb.length)
    expect(qa.map((q) => strip(q, COMPANIES[0]))).toEqual(qb.map((q) => strip(q, COMPANIES[1])))
  })
})

// ── Reading is bounded ────────────────────────────────────────────────────

describe('third-party hosts are not hammered', () => {
  it('reads at most the configured number of pages, in sequence', async () => {
    const urls = Array.from({ length: 9 }, (_, i) => `https://example-${i}.test/page`)
    pageServes('<html><body><p>Some ordinary page text that is long enough to be considered readable content here.</p></body></html>')
    await readPublicSources(urls.map((url) => ({ url, title: null, discoveredVia: 'gemini' })))
    // PUBLIC_RESEARCH_MAX_PAGES is 4 in this file's env double.
    expect(fetchPageRaw).toHaveBeenCalledTimes(4)
  })

  it('treats a blocked destination as a normal outcome, not a crash', async () => {
    fetchPageRaw.mockRejectedValue(new Error('That address is not publicly reachable.'))
    const read = await readPublicSource({ url: 'https://whatever.test/x', title: null, discoveredVia: 'gemini' })
    expect(read.text).toBe('')
    expect(read.reason).toContain('not publicly reachable')
  })
})

// ── PUBLISHED EMAIL ADDRESSES ─────────────────────────────────────────────
//
// An address reaches a candidate only when the fetched page prints it, on the
// company's own domain, and its local part names a person the verifier already
// confirmed. Nothing is composed, and the model never supplies an address.

describe('an email address the page publishes for a verified person', () => {
  const local = (c: Company) => c.person.toLowerCase().replace(/\s+/g, '.')
  const first = (c: Company) => c.person.split(' ')[0]!.toLowerCase()

  const runWith = async (c: Company, html: string, url = `https://${c.domain}/about-us`) => {
    searchReturns(url)
    pageServes(html)
    modelClaims([{ fullName: c.person, rawTitle: c.title, sourceSentence: `${c.person} is our ${c.title}` }])
    return new PublicResearchProvider().search(ctxFor(c) as never)
  }
  const page = (c: Company, extra: string) =>
    `<html><body><p>${c.person} is our ${c.title}.</p><p>${extra}</p><p>${c.name} supplies ${c.product}. ${FILLER}</p></body></html>`

  for (const c of COMPANIES) {
    it(`attaches a first.last address on the company domain, with the page as evidence — ${c.label}`, async () => {
      const email = `${local(c)}@${c.domain}`
      const result = await runWith(c, page(c, `Contact: ${email}`))
      const person = result.candidates[0]!
      expect(person.email).toBe(email)
      expect(person.evidence[0]!.supports).toContain('contact')
      expect(person.evidence[0]!.snippet).toContain(email)
      expect(result.metadata?.publishedEmailsMatched).toBe(1)
    })

    it(`accepts a first-name mailbox, as small businesses write them — ${c.label}`, async () => {
      const email = `${first(c)}@${c.domain}`
      expect((await runWith(c, page(c, `Email ${email}`))).candidates[0]!.email).toBe(email)
    })

    it(`never assigns a shared mailbox to a person — ${c.label}`, async () => {
      const person = (await runWith(c, page(c, `Write to info@${c.domain} or sales@${c.domain}`))).candidates[0]!
      expect(person.email).toBeNull()
      expect(person.evidence[0]!.supports).not.toContain('contact')
    })

    it(`refuses an address on another domain, even one naming the person — ${c.label}`, async () => {
      const person = (await runWith(c, page(c, `Reach ${local(c)}@gmail.com or ${local(c)}@trade-journal.test`))).candidates[0]!
      expect(person.email).toBeNull()
    })

    it(`refuses an address whose local part names somebody else — ${c.label}`, async () => {
      const person = (await runWith(c, page(c, `Press enquiries: morgan.blake@${c.domain}`))).candidates[0]!
      expect(person.email).toBeNull()
    })

    it(`constructs nothing when the page prints no address — ${c.label}`, async () => {
      const person = (await runWith(c, page(c, 'Call the office during working hours.'))).candidates[0]!
      expect(person.email).toBeNull()
    })

    it(`does not let an address introduce a person the verifier did not confirm — ${c.label}`, async () => {
      searchReturns(`https://${c.domain}/about-us`)
      pageServes(page(c, `Also: morgan.blake@${c.domain}`))
      modelClaims([
        { fullName: c.person, rawTitle: c.title, sourceSentence: `${c.person} is our ${c.title}` },
        // Not on the page, so the verifier drops them — and the address cannot bring them back.
        { fullName: 'Morgan Blake', rawTitle: 'Head of Catalog', sourceSentence: 'Morgan Blake is our Head of Catalog' },
      ])
      const result = await new PublicResearchProvider().search(ctxFor(c) as never)
      expect(result.candidates.map((p) => p.fullName)).toEqual([c.person])
      expect(result.candidates[0]!.email).toBeNull()
    })

    it(`takes a company-domain address from a third-party page that prints it — ${c.label}`, async () => {
      const email = `${local(c)}@${c.domain}`
      searchReturns('https://trade-journal.test/appointments')
      pageServes(
        `<html><body><p>${c.person} has been appointed ${c.title} at ${c.name}. Contact ${email}.</p><p>${FILLER}</p></body></html>`,
      )
      modelClaims([
        { fullName: c.person, rawTitle: c.title, sourceSentence: `${c.person} has been appointed ${c.title} at ${c.name}` },
      ])
      const person = (await new PublicResearchProvider().search(ctxFor(c) as never)).candidates[0]!
      expect(person.evidence[0]!.sourceType).toBe('third_party')
      expect(person.email).toBe(email)
    })
  }

  it('gives an address two verified people could claim to neither', async () => {
    const c = COMPANIES[0]
    searchReturns(`https://${c.domain}/team`)
    pageServes(
      `<html><body><p>Dana Reed is our Head of Ecommerce.</p><p>Dana Whitfield is our Catalog Manager.</p>` +
        `<p>Email dana@${c.domain}.</p><p>${FILLER}</p></body></html>`,
    )
    modelClaims([
      { fullName: 'Dana Reed', rawTitle: 'Head of Ecommerce', sourceSentence: 'Dana Reed is our Head of Ecommerce' },
      { fullName: 'Dana Whitfield', rawTitle: 'Catalog Manager', sourceSentence: 'Dana Whitfield is our Catalog Manager' },
    ])
    const result = await new PublicResearchProvider().search(ctxFor(c) as never)
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.every((p) => p.email === null)).toBe(true)
  })
})
