import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmCompany } from '../../src/crm/types.js'

// BEHAVIOUR MUST FOLLOW THE SOURCE, NEVER THE COMPANY.
//
// Every fix in this engine was found on a real company, and the risk that
// creates is obvious: a change made because of one customer quietly becomes a
// change that only works for that customer. This file is the guard against it.
//
// The method is a controlled comparison. Seven fixtures differ in SHAPE — a
// team page with explicit titles, an about page written in prose, a
// JavaScript shell, an unreachable site, a CRM-only record, a social-only
// record, and a record with everything at once — and the company identities on
// them are meaningless strings. Then the same fixtures are run again with
// every identity swapped. If any outcome moves, something is reading the
// company instead of the evidence.
//
// Nothing here asserts a particular company gets a particular answer. It
// asserts that the ANSWER TRACKS THE SHAPE.

const fetched: string[] = []
const pages = new Map<string, string>()
/** URL -> where the site actually lands, for redirect cases. */
const redirects = new Map<string, string>()

// The transport, stubbed per URL. fetchPageRaw returns MARKUP (the homepage,
// for link discovery); fetchPage returns TEXT with the markup stripped, which
// is what the real one does and what people extraction reads.
const look = (url: string) => pages.get(url.replace(/\/+$/, '')) ?? pages.get(url)
/** Block elements become line breaks, as a real HTML-to-text pass does. */
const NL = String.fromCharCode(10)
const toText = (html: string) =>
  html
    .replace(/<\/?(?:p|div|h[1-6]|li|br|tr|section|article)\b[^>]*>/gi, NL)
    .replace(/<[^>]*>/g, ' ')
    .split(NL)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(NL)
vi.mock('../../src/research/pageFetch.js', () => ({
  fetchPage: async (url: string) => {
    fetched.push(url)
    const html = look(url)
    return html
      ? { ok: true, text: toText(html), finalUrl: url }
      : { ok: false, reason: 'The site returned HTTP 404.', finalUrl: url }
  },
  fetchPageRaw: async (url: string) => {
    fetched.push(url)
    const landed = redirects.get(url) ?? url
    const html = look(landed)
    return html
      ? { ok: true, html, status: 200, bytes: html.length, finalUrl: landed, reason: null }
      : { ok: false, html: '', status: 404, bytes: 0, finalUrl: url, reason: 'The site returned HTTP 404.' }
  },
}))

const modelPeople = new Map<string, Array<{ fullName: string; rawTitle: string | null; sourceSentence: string }>>()
vi.mock('../../src/decisionmakers/modelReader.js', () => ({
  readPeopleFromPage: async ({ text }: { text: string }) => ({
    // Still grounded: the stub only returns people whose sentence is in the
    // text, exactly as the real reader does after verification.
    people: (modelPeople.get('any') ?? []).filter((p) => text.includes(p.sourceSentence)),
    rejected: 0,
    reason: null,
    model: 'stub',
    costUsd: 0,
  }),
}))

const { WebCorroborationProvider } = await import('../../src/decisionmakers/providers/webCorroborationProvider.js')
const { CrmContactProvider } = await import('../../src/decisionmakers/providers/crmContactProvider.js')
const { resolveCompanySource } = await import('../../src/crm/companySource.js')
const { discoverPeoplePageUrls, teamPagePaths } = await import('../../src/decisionmakers/peopleExtraction.js')

const company = (over: Partial<CrmCompany> = {}): CrmCompany =>
  ({
    id: 'co_x',
    name: 'Company X',
    email: null,
    emails: [],
    phone: null,
    domain: 'x.test',
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

const ctx = (c: CrmCompany) => ({ company: c, companyDomain: c.domain, maxResults: 10, tenantId: 't1' }) as never

// ── Seven shapes, described only by their evidence ────────────────────────

interface Shape {
  label: string
  /** The CRM record. Identity fields are deliberately meaningless. */
  crm: Partial<CrmCompany>
  /** url -> page text this site serves. Empty means an unreachable site. */
  site: Record<string, string>
  /** What a grounded reader would find in the prose, if anything. */
  prose?: Array<{ fullName: string; rawTitle: string | null; sourceSentence: string }>
  expect: {
    websiteResolves: boolean
    crmPeople: number
    sitePeople: number
    socialSources: number
  }
}

const TEAM_PAGE =
  '<html><body><h1>Our team</h1>' +
  '<a href="/our-people">Our people</a>' +
  '</body></html>'

const PEOPLE_LIST =
  '<html><body><h2>Our people</h2>' +
  '<p>Avery Lund, Head of Ecommerce</p>' +
  '<p>Kai Osei, Operations Manager</p>' +
  '</body></html>'

const PROSE_ABOUT =
  '<html><body><h1>About</h1>' +
  '<p>Rowan Tate heads up our ecommerce team and has done since 2019.</p>' +
  '</body></html>'

const SHAPES: Shape[] = [
  {
    label: 'team page with explicit titles',
    crm: { domain: 'a.test' },
    site: { 'https://a.test': TEAM_PAGE, 'https://a.test/our-people': PEOPLE_LIST },
    expect: { websiteResolves: true, crmPeople: 0, sitePeople: 2, socialSources: 0 },
  },
  {
    label: 'about page with people only in prose',
    crm: { domain: 'b.test' },
    site: { 'https://b.test': '<html><body><a href="/about">About</a></body></html>', 'https://b.test/about': PROSE_ABOUT },
    prose: [
      { fullName: 'Rowan Tate', rawTitle: 'Head of Ecommerce', sourceSentence: 'Rowan Tate heads up our ecommerce team' },
    ],
    expect: { websiteResolves: true, crmPeople: 0, sitePeople: 1, socialSources: 0 },
  },
  {
    label: 'JavaScript shell that names nobody in its markup',
    crm: { domain: 'c.test' },
    site: { 'https://c.test': '<html><body><div id="root"></div><script src="/a.js"></script></body></html>' },
    expect: { websiteResolves: true, crmPeople: 0, sitePeople: 0, socialSources: 0 },
  },
  {
    label: 'unreachable website',
    crm: { domain: 'd.test' },
    site: {},
    expect: { websiteResolves: true, crmPeople: 0, sitePeople: 0, socialSources: 0 },
  },
  {
    label: 'CRM only, no site content',
    crm: { domain: 'e.test', contactPersons: ['Noor Haddad - Purchasing Manager'] },
    site: {},
    expect: { websiteResolves: true, crmPeople: 1, sitePeople: 0, socialSources: 0 },
  },
  {
    label: 'social reference but no website',
    crm: { domain: 'facebook.com', endPdpUrl: 'https://www.facebook.com/somepage/' },
    site: {},
    expect: { websiteResolves: false, crmPeople: 0, sitePeople: 0, socialSources: 1 },
  },
  {
    label: 'CRM contact and a readable site together',
    crm: {
      domain: 'g.test',
      contactPersons: ['Noor Haddad - Purchasing Manager'],
      email: 'noor.haddad@g.test',
      emails: ['noor.haddad@g.test'],
      linkedProfiles: ['https://www.linkedin.com/company/g-co/'],
    },
    site: { 'https://g.test': TEAM_PAGE, 'https://g.test/our-people': PEOPLE_LIST },
    expect: { websiteResolves: true, crmPeople: 1, sitePeople: 2, socialSources: 1 },
  },
]

/** Runs both source-reading providers over one shape. */
async function run(shape: Shape, identity: { id: string; name: string }) {
  fetched.length = 0
  pages.clear()
  modelPeople.clear()
  for (const [url, html] of Object.entries(shape.site)) pages.set(url.replace(/\/+$/, ''), html)
  if (shape.prose) modelPeople.set('any', shape.prose)

  const c = company({ ...shape.crm, id: identity.id, name: identity.name })
  const crmResult = await new CrmContactProvider().search(ctx(c))
  const webResult = await new WebCorroborationProvider().search(ctx(c))
  const source = resolveCompanySource(c)

  return {
    websiteResolves: Boolean(source.websiteUrl),
    crmPeople: crmResult.candidates.length,
    sitePeople: webResult.candidates.length,
    socialSources: source.socialSources.length,
    names: [...crmResult.candidates, ...webResult.candidates].map((x) => x.fullName).sort(),
  }
}

beforeEach(() => {
  fetched.length = 0
  pages.clear()
  modelPeople.clear()
})
afterEach(() => vi.clearAllMocks())

// ── Each shape produces the outcome its evidence supports ─────────────────

describe('the outcome follows the shape of the evidence', () => {
  for (const shape of SHAPES) {
    it(`handles: ${shape.label}`, async () => {
      const got = await run(shape, { id: 'co_1', name: 'First Company' })
      expect({
        websiteResolves: got.websiteResolves,
        crmPeople: got.crmPeople,
        sitePeople: got.sitePeople,
        socialSources: got.socialSources,
      }).toEqual(shape.expect)
    })
  }
})

// ── The same shapes, different identities, identical outcomes ─────────────

describe('the outcome does NOT follow the company identity', () => {
  for (const shape of SHAPES) {
    it(`is identical under a different name and id: ${shape.label}`, async () => {
      const a = await run(shape, { id: 'co_alpha', name: 'Alpha Industrial Supply Ltd' })
      const b = await run(shape, { id: 'zz_9', name: 'Zeta Bathroom Fittings' })
      expect(b).toEqual(a)
    })
  }

  it('finds the same people whatever the company is called', async () => {
    const teamShape = SHAPES[0]!
    const a = await run(teamShape, { id: 'co_1', name: 'Anything At All' })
    const b = await run(teamShape, { id: 'co_2', name: '' })
    expect(a.names).toEqual(['Avery Lund', 'Kai Osei'])
    expect(b.names).toEqual(a.names)
  })
})

// ── Page discovery is driven by the site, not by a list ───────────────────

describe('which pages get read is decided by the site', () => {
  it('follows a people page under a name no fixed list contains', () => {
    const html = '<html><body><a href="/meet-the-crew">Meet the crew</a></body></html>'
    const found = discoverPeoplePageUrls(html, 'https://x.test/')
    expect(found).toContain('https://x.test/meet-the-crew')
    // …and no built-in list contains that path, which is the point.
    expect(teamPagePaths()).not.toContain('/meet-the-crew')
  })

  it('ranks a path that names the page above a link that only says so', () => {
    const html =
      '<html><body><a href="/x1">Meet the team</a><a href="/leadership">Info</a></body></html>'
    expect(discoverPeoplePageUrls(html, 'https://x.test/')[0]).toBe('https://x.test/leadership')
  })

  it('stays on the company own origin', () => {
    const html = '<html><body><a href="https://elsewhere.test/about">About</a></body></html>'
    expect(discoverPeoplePageUrls(html, 'https://x.test/')).toEqual([])
  })

  it('ignores shopping and account plumbing that happens to match a word', () => {
    const html = '<html><body><a href="/cart">About your cart</a><a href="/logo.png">Our team</a></body></html>'
    expect(discoverPeoplePageUrls(html, 'https://x.test/')).toEqual([])
  })

  it('falls back to conventional paths only when the site suggests none', async () => {
    await run(
      { label: 'x', crm: { domain: 'f.test' }, site: { 'https://f.test': '<html><body><p>Hello</p></body></html>' },
        expect: { websiteResolves: true, crmPeople: 0, sitePeople: 0, socialSources: 0 } },
      { id: 'co_1', name: 'X' },
    )
    // The homepage, then the conventional list — no company-specific path.
    expect(fetched[0]).toBe('https://f.test/')
    expect(fetched.length).toBeGreaterThan(1)
    for (const u of fetched.slice(1)) {
      expect(teamPagePaths().some((p) => u.endsWith(p))).toBe(true)
    }
  })

  it('does not fall back when the site did suggest pages', async () => {
    await run(SHAPES[0]!, { id: 'co_1', name: 'X' })
    expect(fetched).toEqual(['https://a.test/', 'https://a.test/our-people'])
  })
})

// ── The invariants that must hold for every shape ─────────────────────────

describe('no shape can produce an unsupported person', () => {
  it('never yields a person no source named', async () => {
    for (const shape of SHAPES) {
      const got = await run(shape, { id: 'co_1', name: 'Whoever Ltd' })
      const allText = Object.values(shape.site).join(' ') + JSON.stringify(shape.crm)
      for (const name of got.names) {
        expect(allText, `${shape.label} invented ${name}`).toContain(name)
      }
    }
  })

  it('never puts the company name into a person', async () => {
    for (const shape of SHAPES) {
      const got = await run(shape, { id: 'co_1', name: 'Distinctive Trading Name' })
      expect(got.names).not.toContain('Distinctive Trading Name')
    }
  })
})

// A SITE THAT REDIRECTS TO ANOTHER COMPANY'S (2026-10-06). The other site's
// staff used to be stamped as stated on THIS company's website and verified
// by name — so a parent company's people became this company's contacts.
describe('a website that redirects to a different company', () => {
  afterEach(() => redirects.clear())

  it('reads nothing there and says why', async () => {
    const team =
      '<html><body><h1>Our team</h1><p>Jane Porter is Head of eCommerce at Parentgroup.</p></body></html>'
    pages.set('https://parentgroup.test', team)
    redirects.set('https://acquired.test/', 'https://parentgroup.test/')
    const company = { id: 'co_9', name: 'Acquired Ltd', domain: 'acquired.test' } as unknown as CrmCompany

    const r = await new WebCorroborationProvider().search(ctx(company))

    expect(r.status).toBe('unavailable')
    expect(r.candidates).toHaveLength(0)
    expect(r.reason).toMatch(/redirects to a different site \(parentgroup\.test\)/)
    // Only the homepage request was made; nothing on the other site was read.
    expect(fetched.filter((u) => u.includes('parentgroup'))).toHaveLength(0)
  })

  it('still reads a site that only moves to its own www address', async () => {
    pages.set('https://www.acquired.test', '<html><body><p>Welcome</p></body></html>')
    redirects.set('https://acquired.test/', 'https://www.acquired.test/')
    const company = { id: 'co_9', name: 'Acquired Ltd', domain: 'acquired.test' } as unknown as CrmCompany
    const r = await new WebCorroborationProvider().search(ctx(company))
    expect(r.reason ?? '').not.toMatch(/different site/)
  })
})
