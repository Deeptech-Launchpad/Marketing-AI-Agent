import { beforeEach, describe, expect, it, vi } from 'vitest'

// STAGE 1b — OPEN-WEB COMPANY DISCOVERY.
//
//   A SEARCH ENGINE SAYS WHERE TO LOOK. IT NEVER SAYS WHAT IS TRUE.
//
// Every company recorded here must come from a page a searchWeb() reference
// pointed to, be named on that page, and — to be checked — have its own
// website stated by that page. One page may name many companies (a list or a
// directory); each is recorded once, however many results point to it.

const searchWeb = vi.fn()
const generate = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ searchWeb, generate }) }))

const fetchPageRaw = vi.fn()
vi.mock('../../src/research/pageFetch.js', () => ({ fetchPageRaw }))

let enabled = true
vi.mock('../../src/config/env.js', () => ({
  get env() {
    return { COMPANY_WEB_DISCOVERY_ENABLED: enabled }
  },
}))

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

// The website-resolution rule imports the CRM port; nothing here reaches it.
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({}) }))
// The NXT Sales duplicate check that follows a search (2026-09-29) has its
// own tests (crmLeads.test.ts); here it answers without touching a CRM.
vi.mock('../../src/crm/leads/leadWrite.js', () => ({ checkSearchAgainstCrm: vi.fn(async () => ({ checked: 0, inCrm: 0, unreachable: 0 })) }))

const audit = vi.fn()
vi.mock('../../src/platform/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const db = {
  companyDiscoverySearch: { findUnique: vi.fn(), update: vi.fn() },
  discoveredCompany: { upsert: vi.fn(), count: vi.fn() },
}
let idCounter = 0
vi.mock('../../src/platform/db.js', () => ({
  prisma: db,
  newId: () => `id_${idCounter++}`,
}))

const { runCompanyWebDiscovery, queryFor, queriesFor, cityQueries } = await import('../../src/prospects/companyWebDiscovery.js')

const SEARCH = {
  id: 'search_1',
  tenantId: 't1',
  objective: 'Safety and Health companies in the USA',
  requestedCount: null,
  requestedByCrmUserId: 'crm-user-1',
  status: 'queued',
}

const LONG =
  'They supply head, eye and hearing protection to construction and utility contractors across the country, with same-day dispatch, a technical desk, and a catalogue of several hundred certified products for site safety managers. '.repeat(2)

const pageAt = (url: string, html: string, status = 200) => ({
  ok: status < 400,
  requestedUrl: url,
  finalUrl: url,
  status,
  contentType: 'text/html',
  html,
  truncated: false,
  bytes: html.length,
  redirectChain: [],
  reason: status < 400 ? null : `HTTP ${status}`,
  durationMs: 1,
})

const DIRECTORY = 'https://safety-directory.test/listing/acme'
const HOME = 'https://acmesafety.test/'
const PRODUCT = 'https://acmesafety.test/products/titan-hard-hat-x200'

const SITE_PAGES: Record<string, string> = {
  [DIRECTORY]: `<html><body><h1>Acme Safety Co</h1><p>Acme Safety Co — <a href="https://acmesafety.test/">acmesafety.test</a>. ${LONG}</p></body></html>`,
  [HOME]: `<html><body><h1>Acme Safety Co</h1><a href="/products/titan-hard-hat-x200">Titan Hard Hat X200</a><p>${LONG}</p></body></html>`,
  [PRODUCT]: `<html><head><title>Titan Hard Hat X200 | Acme Safety Co</title></head><body>
    <h1>Titan Hard Hat X200</h1><p>SKU: X200-WHT</p>
    <table><tr><th>Colour</th><td>White</td></tr><tr><th>Shell material</th><td>HDPE</td></tr></table>
    <button>Add to cart</button><span>$24.99</span></body></html>`,
}

function serveSites(extra: Record<string, string> = {}) {
  const pages = { ...SITE_PAGES, ...extra }
  fetchPageRaw.mockImplementation(async (url: string) => (pages[url] ? pageAt(url, pages[url]!) : pageAt(url, '', 404)))
}

const acme = (over: Record<string, unknown> = {}) => ({
  companyName: 'Acme Safety Co',
  website: 'acmesafety.test',
  summary: 'Acme Safety Co supplies head, eye and hearing protection.',
  fitVerdict: 'likely_fit',
  reasons: ['Supplies safety equipment, matching the objective.'],
  ...over,
})

/** The model's answers, by prompt: which companies a page names, and a (here empty) product read. */
function modelAnswers(companies: unknown[]) {
  generate.mockImplementation(async (opts: { promptKey: string }) =>
    opts.promptKey === 'prospect.identify_companies'
      ? { data: { companies }, costUsd: 0.002 }
      : { data: { attributes: [], featureBullets: [] }, costUsd: 0.001 },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  enabled = true
  idCounter = 0
  db.companyDiscoverySearch.findUnique.mockResolvedValue({ ...SEARCH })
  db.companyDiscoverySearch.update.mockResolvedValue({})
  db.discoveredCompany.upsert.mockResolvedValue({})
  db.discoveredCompany.count.mockResolvedValue(0)
})

const okSearch = (refs: Array<{ url: string; title: string | null }>) => ({
  ok: true,
  provider: 'gemini',
  queriesRun: ['q1'],
  references: refs,
  modelText: 'Acme Safety Co, Beta Industrial Health Ltd, and a company that does not exist',
  model: 'gemini-x',
  costUsd: 0.01,
  reason: null,
})
const failedSearch = (reason: string) => ({
  ok: false,
  provider: 'gemini',
  queriesRun: [],
  references: [],
  modelText: '',
  model: null,
  costUsd: 0,
  reason,
})

const rows = () => db.discoveredCompany.upsert.mock.calls.map((c) => c[0].create)

describe('the queries composed from the objective', () => {
  it('carry the objective verbatim and ask only for pages actually retrieved', () => {
    const q = queryFor('Safety and Health companies in the USA')
    expect(q).toContain('Safety and Health companies in the USA')
    expect(q).toMatch(/only report pages you actually retrieved/i)
    expect(q).toMatch(/own public website that shows the products/i)
  })

  it('ask for makers, sellers, lists and smaller firms separately, to reach more companies', () => {
    const qs = queriesFor('Safety products')
    expect(qs).toHaveLength(8)
    expect(qs.some((q) => /lists, directories/i.test(q))).toBe(true)
    expect(qs.some((q) => /small and mid-sized/i.test(q))).toBe(true)
    // Like a map search: local listings with addresses, and branch pages.
    expect(qs.some((q) => /local business listings/i.test(q))).toBe(true)
    expect(qs.some((q) => /"locations", "branches"/i.test(q))).toBe(true)
    expect(qs.every((q) => q.includes('Safety products'))).toBe(true)
  })

  it('covers a named US state city by city, and adds no city searches when no state is named', () => {
    const qs = queriesFor('electrical products distributors in ohio usa')
    expect(qs).toHaveLength(8 + 6)
    expect(qs.filter((q) => /located in or near .+, Ohio/.test(q)).map((q) => q.match(/near ([^,]+), Ohio/)![1])).toEqual([
      'Columbus',
      'Cleveland',
      'Cincinnati',
      'Toledo',
      'Akron',
      'Dayton',
    ])
    // "in" is a word, not Indiana; "West Virginia" is not Virginia.
    expect(cityQueries('suppliers in the usa')).toEqual([])
    expect(cityQueries('distributors in West Virginia')[0]).toMatch(/Charleston, West Virginia/)
  })
})

describe('a company is real only if a page the search pointed to names it', () => {
  it('never persists a company named only in modelText', async () => {
    searchWeb.mockResolvedValue(okSearch([{ url: DIRECTORY, title: 'Acme listing' }]))
    serveSites()
    modelAnswers([acme()])

    await runCompanyWebDiscovery('search_1')

    expect(rows()).toHaveLength(1)
    expect(rows()[0].discoverySourceUrl).toBe(DIRECTORY)
    expect(JSON.stringify(rows())).not.toContain('Beta Industrial Health Ltd')
  })

  it('drops a company the page does not name, and a website the page does not state', async () => {
    searchWeb.mockResolvedValue(okSearch([{ url: DIRECTORY, title: null }]))
    serveSites()
    modelAnswers([acme({ companyName: 'A Totally Different Company' }), acme({ website: 'guessed-domain.test' })])

    await runCompanyWebDiscovery('search_1')

    expect(JSON.stringify(rows())).not.toContain('A Totally Different Company')
    expect(JSON.stringify(rows())).not.toContain('guessed-domain.test')
  })
})

describe('an unreadable search result is recorded once per site, not dropped', () => {
  it('persists it with the reason', async () => {
    searchWeb.mockResolvedValue(
      okSearch([
        { url: 'https://unreachable.test/news/a', title: 'Some Company Ltd' },
        { url: 'https://unreachable.test/news/b', title: 'Some Company Ltd' },
      ]),
    )
    fetchPageRaw.mockResolvedValue({ ok: false, reason: 'Connection refused', html: '', finalUrl: null, status: null })

    await runCompanyWebDiscovery('search_1')

    expect(rows()).toHaveLength(1)
    expect(rows()[0].productAnalysis.status).toBe('source_unreadable')
    expect(rows()[0].productAnalysis.statusReason).toMatch(/Connection refused/)
  })
})

describe('a result that lands on a company’s own site it cannot read', () => {
  it('still checks that company’s website for a product, rather than discarding it', async () => {
    const JS_HOME = 'https://jsbuilt.test/'
    const JS_PRODUCT = 'https://jsbuilt.test/products/titan-hard-hat-x200'
    searchWeb.mockResolvedValue(okSearch([{ url: JS_HOME, title: 'JS Built Supply' }]))
    // The homepage has too little text to identify anyone, but it links a product.
    serveSites({
      [JS_HOME]: '<html><body><a href="/products/titan-hard-hat-x200">Titan</a></body></html>',
      [JS_PRODUCT]: SITE_PAGES[PRODUCT]!,
    })
    modelAnswers([])

    await runCompanyWebDiscovery('search_1')

    expect(rows()).toHaveLength(1)
    expect(rows()[0].companyName).toBe('JS Built Supply')
    expect(rows()[0].domain).toBe('jsbuilt.test')
    expect(rows()[0].productAnalysis.status).toBe('analysed')
  })
})

describe('the feature flag', () => {
  it('no-ops with a clear reason when COMPANY_WEB_DISCOVERY_ENABLED is off', async () => {
    enabled = false
    await runCompanyWebDiscovery('search_1')

    expect(searchWeb).not.toHaveBeenCalled()
    expect(fetchPageRaw).not.toHaveBeenCalled()
    const update = db.companyDiscoverySearch.update.mock.calls[0]![0]
    expect(update.data.status).toBe('failed')
    expect(update.data.failureReason).toMatch(/COMPANY_WEB_DISCOVERY_ENABLED is off/)
  })
})

describe('a failed search', () => {
  it('records the failure reason rather than an empty success, when every phrasing failed', async () => {
    searchWeb.mockResolvedValue(failedSearch('The search provider returned a 500.'))

    await runCompanyWebDiscovery('search_1')

    expect(db.discoveredCompany.upsert).not.toHaveBeenCalled()
    const update = db.companyDiscoverySearch.update.mock.calls.at(-1)![0]
    expect(update.data.status).toBe('failed')
    expect(update.data.failureReason).toBe('The search provider returned a 500.')
  })
})

describe('search → company → its own website → one product → service need', () => {
  it('checks a product on the company’s own site, not the directory page it was found on', async () => {
    searchWeb.mockResolvedValue(okSearch([{ url: DIRECTORY, title: 'Acme Safety Co — directory listing' }]))
    serveSites()
    modelAnswers([acme()])

    await runCompanyWebDiscovery('search_1')

    const row = rows()[0]
    expect(row.discoverySourceUrl).toBe(DIRECTORY)
    expect(row.domain).toBe('acmesafety.test')
    expect(row.websiteUrl).toBe(HOME)
    expect(row.productPageUrl).toBe(PRODUCT)
    expect(row.serviceNeed).toBe('needed')
    expect(row.productAnalysis.product.name).toBe('Titan Hard Hat X200')
    const opened = fetchPageRaw.mock.calls.map((c) => String(c[0])).filter((u) => u !== DIRECTORY)
    expect(opened.every((u) => u.startsWith('https://acmesafety.test/'))).toBe(true)
  })

  it('records a company whose page states no website, and opens nothing else for it', async () => {
    const NEWS = 'https://press-wire.test/news/acme-expands'
    searchWeb.mockResolvedValue(okSearch([{ url: NEWS, title: 'Acme expands' }]))
    serveSites({ [NEWS]: `<html><body><p>Acme Safety Co announced an expansion. ${LONG}</p></body></html>` })
    modelAnswers([acme({ website: null })])

    await runCompanyWebDiscovery('search_1')

    expect(rows()[0].productAnalysis.status).toBe('no_website')
    expect(rows()[0].productPageUrl).toBeNull()
    expect(fetchPageRaw.mock.calls.map((c) => String(c[0]))).toEqual([NEWS])
  })

  it('does not check the website of a company the page gave no evidence for', async () => {
    searchWeb.mockResolvedValue(okSearch([{ url: DIRECTORY, title: 'Acme' }]))
    serveSites()
    modelAnswers([acme({ fitVerdict: 'unlikely_fit' })])

    await runCompanyWebDiscovery('search_1')

    expect(rows()[0].productAnalysis.status).toBe('not_relevant')
    expect(fetchPageRaw.mock.calls.map((c) => String(c[0]))).toEqual([DIRECTORY])
  })
})

describe('more companies', () => {
  it('reads every company a list page names, each with the website the page gives it', async () => {
    const LIST = 'https://industry-list.test/top-safety-suppliers'
    const BETA_HOME = 'https://betagloves.test/'
    const list = `<html><body><h1>Top safety suppliers</h1>
      <p>Acme Safety Co — <a href="https://acmesafety.test/">visit</a>. Beta Gloves Inc — <a href="https://betagloves.test/">visit</a>. ${LONG}</p></body></html>`
    searchWeb.mockResolvedValue(okSearch([{ url: LIST, title: 'Top safety suppliers' }]))
    serveSites({ [LIST]: list, [BETA_HOME]: `<html><body><h1>Beta Gloves</h1><p>${LONG}</p></body></html>` })
    modelAnswers([acme(), acme({ companyName: 'Beta Gloves Inc', website: 'betagloves.test' })])

    await runCompanyWebDiscovery('search_1')

    expect(rows().map((r) => r.companyName).sort()).toEqual(['Acme Safety Co', 'Beta Gloves Inc'])
    expect(rows().map((r) => r.domain).sort()).toEqual(['acmesafety.test', 'betagloves.test'])
    // Each has its own row, although both came from the same result.
    expect(new Set(rows().map((r) => r.discoverySourceUrl)).size).toBe(2)
  })

  it('runs each phrasing, merges the results, and records each company once', async () => {
    const OTHER = 'https://other-directory.test/acme'
    searchWeb
      .mockResolvedValue(failedSearch('x'))
      .mockResolvedValueOnce(okSearch([{ url: DIRECTORY, title: 'Acme listing' }]))
      .mockResolvedValueOnce(okSearch([{ url: DIRECTORY, title: 'Acme listing' }, { url: OTHER, title: 'Acme again' }]))
      .mockResolvedValueOnce(failedSearch('x'))
    serveSites({ [OTHER]: SITE_PAGES[DIRECTORY]! })
    modelAnswers([acme()])

    await runCompanyWebDiscovery('search_1')

    expect(searchWeb).toHaveBeenCalledTimes(8)
    expect(rows()).toHaveLength(1)
    const done = db.companyDiscoverySearch.update.mock.calls.at(-1)![0]
    expect(done.data.status).toBe('completed')
    expect(done.data.totalCandidatesFound).toBe(2)
  })

  it('records a company without a website once, however many pages name it', async () => {
    const A = 'https://press-wire.test/a'
    const B = 'https://press-wire.test/b'
    const news = `<html><body><p>Acme Safety Co announced an expansion. ${LONG}</p></body></html>`
    searchWeb.mockResolvedValue(okSearch([{ url: A, title: 'a' }, { url: B, title: 'b' }]))
    serveSites({ [A]: news, [B]: news })
    modelAnswers([acme({ website: null })])

    await runCompanyWebDiscovery('search_1')

    expect(rows()).toHaveLength(1)
  })
})
