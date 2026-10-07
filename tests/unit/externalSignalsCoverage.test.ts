import { beforeEach, describe, expect, it, vi } from 'vitest'

// THIRD-PARTY SIGNALS, FOR EVERY COMPANY, FROM MORE PLACES (2026-10-07).
//
// Ten links and eight fetches per company left most companies with two or
// three pages actually read, because about half of what a search returns
// refuses a server reader. Now: five searches (one more for vendors' and
// partners' case studies that name the company), up to twenty links, and
// fetching continues past refusals until ten pages were read. The standard
// of proof does not move — every signal is still a verbatim quote, from a
// fetched page, that names the company.

const generate = vi.fn()
const searchWeb = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate, searchWeb }) }))

const fetchPageRaw = vi.fn()
vi.mock('../../src/research/pageFetch.js', () => ({ fetchPageRaw }))
vi.mock('../../src/research/webSearch.js', () => ({ webSearch: async () => ({ ok: false, hits: [], provider: 'none' }) }))
vi.mock('../../src/config/env.js', () => ({
  env: { PUBLIC_RESEARCH_ENABLED: true, PUBLIC_RESEARCH_MAX_SOURCES: 6, PUBLIC_RESEARCH_MAX_PAGES: 4 },
}))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

const { ExternalSourcesProvider } = await import('../../src/intent/providers/externalSourcesProvider.js')
const { discoverPublicSources, readPublicSource, readPublicSourcesUntil } = await import('../../src/research/publicResearch.js')

const COMPANIES = [
  { id: 'c1', name: 'Harbor Valve Supply', domain: 'harborvalve.test' },
  { id: 'c2', name: 'Kestrel Medical Distributors', domain: 'kestrelmed.test' },
]

const page = (url: string, html: string) => ({
  ok: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', html,
  truncated: false, bytes: html.length, redirectChain: [], reason: null, durationMs: 1,
})
const refused = (url: string) => ({
  ok: false, requestedUrl: url, finalUrl: url, status: 403, contentType: 'text/html', html: '',
  truncated: false, bytes: 0, redirectChain: [], reason: 'The site returned HTTP 403.', durationMs: 1,
})

/** A third-party page stating one dated, attributable event about the company. */
function articleFor(name: string, n: number): { sentence: string; html: string } {
  const sentence = `${name} announced it will open distribution centre number ${n} to serve new regional customers next year.`
  const filler = 'The trade association publishes member news every month for its readers across the region. '.repeat(3)
  return { sentence, html: `<html><body><h1>Member news</h1><p>${filler}</p><p>${sentence}</p><p>${filler}</p></body></html>` }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The reader quotes the one sentence the page states; the verifier still
  // checks it is on the page and names the company.
  generate.mockImplementation(async ({ variables }: { variables: { pageText: string } }) => {
    const m = variables.pageText.match(/[^.]*announced it will open[^.]*\./)
    return { data: { signals: m ? [{ kind: 'expansion', quote: m[0].trim() }] : [] }, costUsd: 0 }
  })
})

describe('the same searches for every company', () => {
  for (const c of COMPANIES) {
    it(`asks five searches, including vendors' and partners' case studies — ${c.name}`, async () => {
      searchWeb.mockResolvedValue({ ok: true, provider: 'gemini', queriesRun: [], modelText: '', model: 'm', costUsd: 0, reason: null, references: [] })
      await discoverPublicSources({ tenantId: 't1', companyName: c.name, domain: c.domain, topic: 'external_signals', feature: 'test' })
      const queries = searchWeb.mock.calls.map((call) => (call[0] as { query: string }).query)
      expect(queries).toHaveLength(5)
      for (const q of queries) expect(q).toContain(c.name)
      expect(queries[4]).toMatch(/case studies/i)
      expect(queries[4]).toMatch(/only report pages you actually retrieved/i)
    })
  }

  it('returns up to twenty links when asked (was ten)', async () => {
    const refs = Array.from({ length: 25 }, (_, i) => ({ url: `https://news${i}.test/a`, title: null }))
    searchWeb.mockResolvedValue({ ok: true, provider: 'gemini', queriesRun: [], modelText: '', model: 'm', costUsd: 0, reason: null, references: refs })
    const r = await discoverPublicSources({ tenantId: 't1', companyName: 'Harbor Valve Supply', domain: null, topic: 'external_signals', maxSources: 20, feature: 'test' })
    expect(r.sources).toHaveLength(20)
  })
})

describe('pages that refuse a server reader no longer use up the budget', () => {
  it('reads past refusals until the wanted number of pages were read', async () => {
    const sources = Array.from({ length: 8 }, (_, i) => ({ url: `https://s${i}.test/`, title: null, discoveredVia: 'gemini' }))
    const read = vi.fn(async (s: { url: string; title: string | null; discoveredVia: string }) => ({
      ...s, finalUrl: s.url, loginWall: false, reason: null,
      text: Number(s.url.match(/s(\d)/)![1]) % 2 === 0 ? '' : 'readable text',
    }))
    const out = await readPublicSourcesUntil(sources, { readable: 3, maxAttempts: 8 }, read)
    expect(out.filter((p) => p.text)).toHaveLength(3)
    expect(read).toHaveBeenCalledTimes(6)
  })

  it('reads a page once when several search links lead to it', async () => {
    const sources = ['https://r.test/1', 'https://r.test/2', 'https://r.test/3'].map((url) => ({ url, title: null, discoveredVia: 'gemini' }))
    const read = vi.fn(async (s: { url: string; title: string | null; discoveredVia: string }) => ({
      ...s, finalUrl: s.url === 'https://r.test/3' ? 'https://other.test/b' : 'https://www.same.test/a/#top', loginWall: false, reason: null, text: 'readable',
    }))
    const out = await readPublicSourcesUntil(sources, { readable: 5, maxAttempts: 5 }, read)
    expect(out.map((p) => p.finalUrl)).toEqual(['https://www.same.test/a/#top', 'https://other.test/b'])
  })

  it("does not spend the budget on the company's own pages", async () => {
    const sources = Array.from({ length: 6 }, (_, i) => ({ url: `https://s${i}.test/`, title: null, discoveredVia: 'gemini' }))
    const read = vi.fn(async (s: { url: string; title: string | null; discoveredVia: string }) => ({
      ...s, finalUrl: Number(s.url.match(/s(\d)/)![1]) < 3 ? `https://own.test/p${s.url.match(/s(\d)/)![1]}` : s.url, loginWall: false, reason: null, text: 'readable',
    }))
    const out = await readPublicSourcesUntil(sources, { readable: 2, maxAttempts: 6, counts: (p) => !p.finalUrl.includes('own.test') }, read)
    expect(read).toHaveBeenCalledTimes(5)
    expect(out.filter((p) => !p.finalUrl.includes('own.test'))).toHaveLength(2)
  })

  it('stops starting new fetches once its time budget is spent', async () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ url: `https://s${i}.test/`, title: null, discoveredVia: 'gemini' }))
    const now = vi.spyOn(Date, 'now')
    let t = 0
    now.mockImplementation(() => t)
    const read = vi.fn(async (s: { url: string; title: string | null; discoveredVia: string }) => {
      t += 1000
      return { ...s, finalUrl: s.url, loginWall: false, reason: 'HTTP 403', text: '' }
    })
    await readPublicSourcesUntil(sources, { readable: 5, maxAttempts: 5, budgetMs: 2500 }, read)
    now.mockRestore()
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('records where a refused page landed, not the search link', async () => {
    fetchPageRaw.mockResolvedValue({ ...refused('https://forum.test/thread/1'), requestedUrl: 'https://search.test/redirect/abc' })
    const r = await readPublicSource({ url: 'https://search.test/redirect/abc', title: null, discoveredVia: 'gemini' })
    expect(r.finalUrl).toBe('https://forum.test/thread/1')
    expect(r.text).toBe('')
  })

  for (const c of COMPANIES) {
    it(`collects a signal from every readable page, past six refusals — ${c.name}`, async () => {
      const urls = [
        ...Array.from({ length: 6 }, (_, i) => `https://blocked${i}.test/post`),
        ...Array.from({ length: 12 }, (_, i) => `https://memberhub${i}.test/news`),
      ]
      searchWeb.mockResolvedValue({
        ok: true, provider: 'gemini', queriesRun: ['q'], modelText: '', model: 'm', costUsd: 0, reason: null,
        references: urls.map((url) => ({ url, title: null })),
      })
      fetchPageRaw.mockImplementation(async (url: string) => {
        if (url.includes('blocked')) return refused(url)
        const n = Number(url.match(/memberhub(\d+)/)![1])
        return page(url, articleFor(c.name, n).html)
      })

      // The shared per-company setting is the paid scraper's budget; it no
      // longer cuts this source off.
      const r = await new ExternalSourcesProvider().collect({ tenantId: 't1', company: c, maxResults: 5 } as never)

      expect(fetchPageRaw).toHaveBeenCalledTimes(16)
      const pages = (r.metadata as { pagesRead: Array<{ ok: boolean }> }).pagesRead
      expect(pages.filter((p) => p.ok)).toHaveLength(10)
      expect(r.signals).toHaveLength(10)
      for (const s of r.signals) {
        expect(s.evidence).toContain(c.name)
        expect(s.sourceUrl).toMatch(/^https:\/\/memberhub\d+\.test\/news$/)
      }
    })
  }

  it('invents nothing for a company the pages do not name', async () => {
    searchWeb.mockResolvedValue({
      ok: true, provider: 'gemini', queriesRun: ['q'], modelText: '', model: 'm', costUsd: 0, reason: null,
      references: [{ url: 'https://memberhub0.test/news', title: null }],
    })
    fetchPageRaw.mockImplementation(async (url: string) => page(url, articleFor('Some Other Company', 0).html))
    const r = await new ExternalSourcesProvider().collect({ tenantId: 't1', company: COMPANIES[0], maxResults: 10 } as never)
    expect(r.signals).toHaveLength(0)
  })
})
