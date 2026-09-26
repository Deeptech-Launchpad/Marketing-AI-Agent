import { describe, expect, it, vi } from 'vitest'

// THE COMMUNITY ENGAGEMENT & TRUST-BUILDING METHOD, AS RULES.
//
// Six phrase clusters decide what a question is about; cluster 1 or 2 is
// flagged on its own, 3/4/5 only with a matching persona, 6 never. Job
// posts, consumer-chatbot questions, ChatGPT pricing and vendor promotion
// are excluded. Every quote must be on the page and tied to the company.

vi.mock('../../src/config/env.js', () => ({ env: { PUBLIC_RESEARCH_ENABLED: true, RESEARCH_USER_AGENT: 'test' } }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate: vi.fn() }) }))

const { clustersIn, communityOf, decide, excludedAs, judgeQuestions } = await import('../../src/intent/communityQuestions.js')
const { readRedditThread, redditThreadPath, redditThreadText } = await import('../../src/intent/redditThread.js')

describe('Reddit threads, through the official API only', () => {
  it('accepts only a real thread address, and nothing but its sub and id travels on', () => {
    expect(redditThreadPath('https://www.reddit.com/r/TechSEO/comments/1abc2d/why_no_rich_results/?utm=x')).toBe('/r/TechSEO/comments/1abc2d')
    expect(redditThreadPath('https://www.reddit.com/r/TechSEO/')).toBeNull()
    expect(redditThreadPath('https://evil.test/r/x/comments/abc')).toBeNull()
  })

  it('turns a thread into text with who, when and flair — so dates and titles can be checked against it', () => {
    const text = redditThreadText([
      { data: { children: [{ kind: 't3', data: { title: 'Products missing from ChatGPT', selftext: 'Our catalogue never shows up.', author: 'jsmith', author_flair_text: 'eCommerce Manager', subreddit: 'TechSEO', created_utc: 1767225600 } }] } },
      { data: { children: [{ kind: 't1', data: { body: 'Check your JSON-LD.', author: 'helper', created_utc: 1767312000 } }] } },
    ])
    expect(text).toContain('Post by u/jsmith, flair: eCommerce Manager on 2026-01-01:\nProducts missing from ChatGPT\nOur catalogue never shows up.')
    expect(text).toContain('Comment by u/helper on 2026-01-02:\nCheck your JSON-LD.')
  })

  it('requests nothing from Reddit without API credentials, and says why', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const r = await readRedditThread('https://www.reddit.com/r/TechSEO/comments/1abc2d/x')
    expect(spy).not.toHaveBeenCalled()
    expect(r).toMatchObject({ text: '', refused: true })
    expect(r.reason).toMatch(/REDDIT_CLIENT_ID/)
    spy.mockRestore()
  })
})

const ACME = { name: 'Acme Industrial Supply', host: 'acmeindustrial.com' }

describe('filter one — what the question is about', () => {
  it('recognises each cluster from the method’s own phrases', () => {
    expect(clustersIn('Why is our product not showing up in ChatGPT when a buyer asks for the part number?')[0]).toBe(1)
    expect(clustersIn('Perplexity doesn’t recommend us even though we stock the item')[0]).toBe(1)
    expect(clustersIn('Our JSON-LD product markup throws errors in Search Console')[0]).toBe(2)
    expect(clustersIn('Google Merchant Center feed errors: GTIN missing on 4,000 items')[0]).toBe(2)
    expect(clustersIn('We are starting a PIM implementation to clean up SKU data')[0]).toBe(3)
    expect(clustersIn('Customers can’t find our products online even when they search the part number')[0]).toBe(4)
    expect(clustersIn('Grainger shows up but we don’t, for the exact same fittings')[0]).toBe(5)
    expect(clustersIn('We are working on digital transformation for our distribution business')).toEqual([6])
    expect(clustersIn('What torque spec should I use on M8 bolts?')).toEqual([])
  })

  it('excludes what the method excludes', () => {
    expect(excludedAs('We’re hiring an eCommerce Manager — apply now')).toBe('a job posting')
    expect(excludedAs('Best AI chatbot for customer service?')).toBe('a consumer chatbot question')
    expect(excludedAs('Is ChatGPT Plus worth it for the price?')).toBe('a ChatGPT subscription question')
    expect(excludedAs('Our PIM helps distributors fix product data — book a demo')).toBe('a vendor promoting its own tool')
  })
})

describe('the decision point', () => {
  it('flags cluster 1 or 2 alone, 3/4/5 only with a persona, and never 6 alone', () => {
    expect(decide([1], { matched: false }).flag).toBe(true)
    expect(decide([2, 6], { matched: false }).flag).toBe(true)
    expect(decide([3], { matched: false }).flag).toBe(false)
    expect(decide([4], { matched: true }).flag).toBe(true)
    expect(decide([6], { matched: true }).flag).toBe(false)
    expect(decide([], { matched: true }).flag).toBe(false)
  })

  it('knows which communities already tell the industry', () => {
    expect(communityOf('https://www.reddit.com/r/Machinists/comments/abc/x')).toEqual({ name: 'r/Machinists', industryEvident: true })
    expect(communityOf('https://www.reddit.com/r/TechSEO/comments/abc/x')).toEqual({ name: 'r/TechSEO', industryEvident: false })
    expect(communityOf('https://www.eng-tips.com/threadminder.cfm?pid=1')).toEqual({ name: 'Eng-Tips', industryEvident: true })
  })
})

describe('judging what a reader proposed from one page', () => {
  const page = (body: string) => `Thread: product visibility help. ${body} Posted by jsmith, eCommerce Manager at Acme Industrial Supply. 3 replies.`

  it('keeps a cluster-1 question tied to the company, verbatim, with its persona', () => {
    const text = page('Why don’t our products show up in ChatGPT answers when buyers ask for the part number?')
    const r = judgeQuestions(
      [{ quote: 'Why don’t our products show up in ChatGPT answers when buyers ask for the part number?', posterTitle: 'eCommerce Manager' }],
      text,
      'https://www.reddit.com/r/TechSEO/comments/1/x',
      ACME,
    )
    expect(r.flagged).toHaveLength(1)
    expect(r.flagged[0]).toMatchObject({ cluster: 1, clusterLabel: 'AI / LLM discoverability', posterTitle: 'eCommerce Manager', persona: { matched: true } })
  })

  it('logs — does not flag — a cluster-3 question with no persona, outside an industry community', () => {
    const text = page('We need to clean up our catalogue data before the PIM goes live.')
    const r = judgeQuestions([{ quote: 'We need to clean up our catalogue data before the PIM goes live.' }], text, 'https://www.reddit.com/r/SEO/comments/1/x', ACME)
    expect(r.flagged).toEqual([])
    expect(r.logged).toBe(1)
  })

  it('flags the same cluster-3 question when asked in an industry community', () => {
    const text = page('We need to clean up our catalogue data before the PIM goes live.')
    const r = judgeQuestions([{ quote: 'We need to clean up our catalogue data before the PIM goes live.' }], text, 'https://www.reddit.com/r/manufacturing/comments/1/x', ACME)
    expect(r.flagged[0]).toMatchObject({ cluster: 3, persona: { matched: true } })
  })

  it('rejects a quote that is not on the page, or not tied to the company', () => {
    const r1 = judgeQuestions([{ quote: 'Our JSON-LD markup is broken on every product page.' }], page('Something else entirely.'), 'https://www.reddit.com/r/SEO/comments/1/x', ACME)
    expect(r1.rejected).toBe(1)
    const unrelated = 'x '.repeat(400) + 'Our JSON-LD markup is broken on every product page. Posted by a stranger.'
    const r2 = judgeQuestions([{ quote: 'Our JSON-LD markup is broken on every product page.' }], unrelated, 'https://www.reddit.com/r/SEO/comments/1/x', ACME)
    expect(r2.flagged).toEqual([])
    expect(r2.rejected).toBe(1)
  })

  it('never keeps a title that is not on the page', () => {
    const text = page('Why don’t our products show up in ChatGPT answers when buyers ask for the part number?')
    const r = judgeQuestions(
      [{ quote: 'Why don’t our products show up in ChatGPT answers when buyers ask for the part number?', posterTitle: 'VP of Marketing' }],
      text,
      'https://www.reddit.com/r/TechSEO/comments/1/x',
      ACME,
    )
    expect(r.flagged[0]!.posterTitle).toBeNull()
  })
})
