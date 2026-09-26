import { beforeEach, describe, expect, it, vi } from 'vitest'

// INTENT FROM WHAT OTHERS PUBLISH ABOUT A COMPANY.
//
// Forums, Reddit, reviews, news, blogs and public social posts — never only the
// company's own site. Every signal is a verbatim quote from a page we fetched,
// names the company, carries its source URL and a date only if the page states
// one, and explains itself with a fixed sentence per kind. Nothing assumed.

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

const { verifyReadings, placeOf, KIND_INFO } = await import('../../src/intent/externalSignals.js')
const { ExternalSourcesProvider } = await import('../../src/intent/providers/externalSourcesProvider.js')

const REDDIT = 'https://www.reddit.com/r/Construction/comments/abc/acme_hard_hats'
const NEWS = 'https://www.industrynews.test/articles/acme-opens-texas-plant'
const OWN = 'https://acmesafety.test/news/launch'

const REDDIT_TEXT =
  'r/Construction. Posted 12 March 2026. Anyone else find the Acme Safety spec sheets useless? The Acme Safety website ' +
  'lists the X200 hard hat but gives no weight, no shell material and no certification details, so we had to call them. ' +
  'Other posters discussed unrelated boots from Beta Gear, which fit well and were cheaper than expected overall. '.repeat(2)
const NEWS_TEXT =
  'Industry News — 3 September 2026. Acme Safety Co announced it will open a new distribution centre in Texas to serve ' +
  'customers across the southern United States, adding 120 jobs by next spring. The company was founded in 1998. '.repeat(2)

const page = (url: string, html: string) => ({
  ok: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', html,
  truncated: false, bytes: html.length, redirectChain: [], reason: null, durationMs: 1,
})

const company = { id: 'c1', name: 'Acme Safety Co', domain: 'acmesafety.test' }
const ctx = { tenantId: 't1', company, maxResults: 20 } as never

beforeEach(() => {
  vi.clearAllMocks()
  searchWeb.mockResolvedValue({
    ok: true, provider: 'gemini', queriesRun: ['q'], modelText: '', model: 'm', costUsd: 0, reason: null,
    references: [{ url: REDDIT, title: 'reddit' }, { url: NEWS, title: 'news' }, { url: OWN, title: 'own' }],
  })
  fetchPageRaw.mockImplementation(async (url: string) =>
    page(url, `<html><body><p>${url === REDDIT ? REDDIT_TEXT : url === NEWS ? NEWS_TEXT : 'Acme Safety Co launches the X300. '.repeat(20)}</p></body></html>`),
  )
})

describe('verifying what a page says', () => {
  const co = { name: 'Acme Safety Co', host: 'acmesafety.test' }

  it('keeps a verbatim quote that names the company', () => {
    const r = verifyReadings(
      [{ kind: 'customer_complaint', quote: 'The Acme Safety website lists the X200 hard hat but gives no weight, no shell material and no certification details', statedDate: '12 March 2026' }],
      REDDIT_TEXT,
      co,
    )
    expect(r.readings).toHaveLength(1)
    expect(r.readings[0]!.statedDate).toBe('12 March 2026')
  })

  it('drops a quote that is not on the page — nothing is assumed', () => {
    const r = verifyReadings([{ kind: 'expansion', quote: 'Acme Safety is opening ten new stores across Europe this year.' }], REDDIT_TEXT, co)
    expect(r.readings).toHaveLength(0)
    expect(r.rejected).toBe(1)
  })

  it('drops a quote about another company', () => {
    const r = verifyReadings(
      [{ kind: 'product_discussion', quote: 'Other posters discussed unrelated boots from Beta Gear, which fit well and were cheaper than expected overall.' }],
      'x '.repeat(400) + REDDIT_TEXT.split('Other posters')[1]!.replace(/^/, 'Other posters'),
      co,
    )
    expect(r.readings).toHaveLength(0)
  })

  it('never keeps a date the page does not state', () => {
    const r = verifyReadings(
      [{ kind: 'customer_complaint', quote: 'Anyone else find the Acme Safety spec sheets useless?', statedDate: '1 January 2026' }],
      REDDIT_TEXT,
      co,
    )
    expect(r.readings[0]!.statedDate).toBeNull()
  })

  it('drops history presented as news', () => {
    const r = verifyReadings([{ kind: 'business_change', quote: 'The company was founded in 1998.' }], NEWS_TEXT, co)
    expect(r.readings).toHaveLength(0)
  })
})

describe('naming the source', () => {
  it('labels the platforms Sales will recognise', () => {
    expect(placeOf(REDDIT).platformLabel).toBe('Reddit')
    expect(placeOf('https://www.linkedin.com/posts/acme_x').platformLabel).toBe('LinkedIn')
    expect(placeOf('https://www.trustpilot.com/review/acmesafety.test').platformLabel).toBe('Trustpilot')
    expect(placeOf('https://forum.safetypros.test/t/acme').platformLabel).toBe('Forum')
    expect(placeOf(NEWS)).toMatchObject({ platformLabel: 'News', sourceType: 'news_article' })
  })
})

describe('the external sources provider', () => {
  it('searches outside sources, skips the company’s own site, and records source, URL, date and why it matters', async () => {
    generate.mockImplementation(async (opts: { variables: { sourceUrl: string } }) => ({
      costUsd: 0.001,
      data: {
        signals:
          opts.variables.sourceUrl === REDDIT
            ? [
                {
                  kind: 'customer_complaint',
                  quote: 'The Acme Safety website lists the X200 hard hat but gives no weight, no shell material and no certification details',
                  statedDate: '12 March 2026',
                },
                { kind: 'expansion', quote: 'Acme Safety is opening ten new stores across Europe this year.' },
              ]
            : [
                {
                  kind: 'expansion',
                  quote: 'Acme Safety Co announced it will open a new distribution centre in Texas',
                  statedDate: '3 September 2026',
                },
              ],
      },
    }))

    const r = await new ExternalSourcesProvider().collect(ctx)

    expect(r.ok).toBe(true)
    expect(r.signals).toHaveLength(2)
    // The company's own site was not read by this provider.
    expect(generate.mock.calls.map((c) => c[0].variables.sourceUrl)).not.toContain(OWN)

    const complaint = r.signals.find((s) => s.signalType === 'external_customer_complaint')!
    expect(complaint.sourceUrl).toBe(REDDIT)
    expect(complaint.evidence).toMatch(/gives no weight/)
    expect(complaint.observedAt?.getFullYear()).toBe(2026)
    expect(complaint.interpretation).toBe(KIND_INFO.customer_complaint.why)
    expect((complaint.metadata as { platformLabel: string }).platformLabel).toBe('Reddit')

    const expansion = r.signals.find((s) => s.signalType === 'external_expansion')!
    expect(expansion.sourceType).toBe('news_article')
    expect(expansion.sourceUrl).toBe(NEWS)
    // The invented European stores never became a signal.
    expect(JSON.stringify(r.signals)).not.toContain('Europe')
    expect((r.metadata as { claimsRejectedAsUngrounded: number }).claimsRejectedAsUngrounded).toBe(1)
  })

  it('reports a sign-in wall as one, and invents nothing from it', async () => {
    searchWeb.mockResolvedValue({
      ok: true, provider: 'gemini', queriesRun: ['q'], modelText: '', model: 'm', costUsd: 0, reason: null,
      references: [{ url: 'https://www.linkedin.com/posts/acme_1', title: 'post' }],
    })
    fetchPageRaw.mockResolvedValue(page('https://www.linkedin.com/posts/acme_1', '<html><body>Join LinkedIn to see this post. Sign in to continue.</body></html>'))

    const r = await new ExternalSourcesProvider().collect(ctx)

    expect(r.signals).toHaveLength(0)
    expect(generate).not.toHaveBeenCalled()
    expect(r.reason).toMatch(/sign-in wall/)
  })
})
