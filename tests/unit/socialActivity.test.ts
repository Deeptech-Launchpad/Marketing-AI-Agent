import { beforeEach, describe, expect, it, vi } from 'vitest'

// SOCIAL SIGNALS COME FROM WHAT THE COMPANY RECENTLY POSTED (2026-10-07).
//
// Not from a profile: "publishes a LinkedIn profile", a follower count or a bio
// is not a signal. A signal is a recent post on the company's OWN account
// (one its website links to), read for what it is about, with the exact post,
// its platform, its date, its own URL, why it matters and what to do next.
// Nothing is guessed: a post on another account, an old post, a hiring post or
// a quote that is not in any post never becomes a signal.

const generate = vi.fn()
const searchWeb = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate, searchWeb }) }))
const fetchPageRaw = vi.fn()
vi.mock('../../src/research/pageFetch.js', () => ({ fetchPageRaw: (...a: unknown[]) => fetchPageRaw(...a) }))
vi.mock('../../src/research/webSearch.js', () => ({ webSearch: async () => ({ ok: false, hits: [], provider: 'none' }) }))
vi.mock('../../src/config/env.js', () => ({
  env: {
    PUBLIC_RESEARCH_ENABLED: true,
    PUBLIC_RESEARCH_MAX_SOURCES: 6,
    PUBLIC_RESEARCH_MAX_PAGES: 4,
    INTENT_FRESH_DAYS: 90,
    INTENT_AGING_DAYS: 180,
    DM_TEAM_PAGE_PATHS: [],
  },
}))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

const { SocialProfileProvider } = await import('../../src/intent/providers/socialProvider.js')
const { postBelongsTo, readPostPage } = await import('../../src/intent/socialActivity.js')
const { isProfileOnlySignal } = await import('../../src/intent/signalView.js')

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
const CHANNEL = 'UCacmetoolsAAAAAAAAAAAAA'.slice(0, 24)

const ok = (url: string, html: string) => ({
  ok: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', html,
  truncated: false, bytes: html.length, redirectChain: [], reason: null, durationMs: 1,
})
const missing = (url: string) => ({ ...ok(url, ''), ok: false, status: 404, reason: 'The site returned HTTP 404.' })

const VIDEO_TEXT = 'New range of cordless drills now in stock across all branches'
const FB_TEXT = 'We have moved to a new online store, so you can now order online with live stock levels.'
const LI_TEXT = 'We are hiring a warehouse manager for our Leeds depot.'

const PAGES: Record<string, string> = {
  'https://acmetools.test/':
    '<html><body><a href="https://www.facebook.com/acmetools">Facebook</a> <a href="https://www.linkedin.com/company/acme-tools">LinkedIn</a> ' +
    '<a href="https://www.youtube.com/@acmetools">YouTube</a></body></html>',
  // A profile: metadata only. Its follower count and description are NOT signals.
  'https://facebook.com/acmetools':
    '<html><head><meta property="og:title" content="Acme Tools"><meta property="og:description" content="Acme Tools. 12,400 likes. Your local tool specialists since 1980, supplying trade and DIY customers."></head><body></body></html>',
  'https://linkedin.com/company/acme-tools': '<html><head><title>Sign in to see more | LinkedIn</title></head><body>Join LinkedIn to see more. authwall</body></html>',
  'https://youtube.com/@acmetools': `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}"><meta property="og:description" content="Acme Tools channel, 3k subscribers"></head></html>`,
  'https://youtube.com/@acmetools/videos': '<html><script>{"videoId":"vidOwnRecen"},{"videoId":"vidSomeoneE"},{"videoId":"vidOwnOld01"}</script></html>',
  'https://www.youtube.com/watch?v=vidOwnRecen': video(CHANNEL, 'Cordless drill range', VIDEO_TEXT, daysAgo(12)),
  'https://www.youtube.com/watch?v=vidSomeoneE': video('UCsomeoneelseBBBBBBBBBBB', 'Somebody else', 'We launched a new product line today across our stores', daysAgo(5)),
  'https://www.youtube.com/watch?v=vidOwnOld01': video(CHANNEL, 'Old video', 'We launched our first catalogue of hand tools for trade customers', daysAgo(800)),
  'https://www.facebook.com/acmetools/posts/new-online-store/1234567890123/':
    `<html><head><meta property="og:title" content="Acme Tools"><meta property="og:description" content="${FB_TEXT}"></head><body><script>{"post_id":"1234567890123","creation_time":${Math.floor(daysAgo(20).getTime() / 1000)}}</script></body></html>`,
  'https://www.facebook.com/otherco/posts/their-launch/9999999999999/':
    '<html><head><meta property="og:description" content="Otherco launched a new product line today for every customer."></head></html>',
  'https://www.linkedin.com/posts/acme-tools_hiring-activity-1-abc':
    `<html><script type="application/ld+json">{"@type":"SocialMediaPosting","articleBody":"${LI_TEXT}","datePublished":"${daysAgo(3).toISOString()}"}</script></html>`,
}

function video(channelId: string, title: string, description: string, at: Date): string {
  return (
    `<html><head><meta property="og:title" content="${title}"><meta property="og:description" content="${description}">` +
    `<meta itemprop="datePublished" content="${at.toISOString()}"></head><body><script>{"videoDetails":{"videoId":"abcdefghijk","channelId":"${channelId}"}}</script>youtube</body></html>`
  )
}

const SEARCH_RESULTS = [
  'https://www.facebook.com/acmetools/posts/new-online-store/1234567890123/',
  'https://www.facebook.com/otherco/posts/their-launch/9999999999999/',
  'https://www.linkedin.com/posts/acme-tools_hiring-activity-1-abc',
]

const company = {
  id: 'co_1', name: 'Acme Tools', domain: 'acmetools.test', email: null, emails: [], phone: null, industry: null, country: null, cms: null,
  leadStatus: null, status: null, remarks: null, notes: null, endPdpUrl: null, contactPersons: [], linkedProfiles: [], ownerId: null,
  ownerName: null, dealCount: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
}
const ctx = { tenantId: 't1', company, maxResults: 10 } as never

beforeEach(() => {
  vi.clearAllMocks()
  fetchPageRaw.mockImplementation(async (url: string) => {
    const key = url.replace('://www.facebook.com/acmetools', '://facebook.com/acmetools').replace('://www.linkedin.com/company', '://linkedin.com/company').replace('://www.youtube.com/@', '://youtube.com/@')
    const html = PAGES[url] ?? PAGES[key]
    return html ? ok(url, html) : missing(url)
  })
  searchWeb.mockResolvedValue({
    ok: true, provider: 'gemini', queriesRun: ['q'], modelText: '', model: 'm', costUsd: 0, reason: null,
    references: SEARCH_RESULTS.map((url) => ({ url, title: null })),
  })
  // The reader answers by post number, as the prompt asks. It also returns a
  // quote that is in no post and one pointed at the wrong post; both must be
  // dropped. The hiring post is simply not a kind it can report.
  generate.mockImplementation(async ({ variables }: { variables: { posts: string } }) => {
    const numberOf = (text: string) => {
      for (const block of variables.posts.split(/\n\n(?=POST \d+)/)) {
        const n = Number(block.match(/^POST (\d+)/)?.[1])
        if (block.includes(text)) return n
      }
      return 1
    }
    return {
      costUsd: 0,
      data: {
        signals: [
          { post: numberOf(VIDEO_TEXT), kind: 'product_launch', quote: VIDEO_TEXT, about: 'cordless drills now in stock' },
          { post: numberOf(FB_TEXT), kind: 'ecommerce_or_website', quote: FB_TEXT, about: 'Revolutionary AI-powered omnichannel platform' },
          { post: numberOf(VIDEO_TEXT), kind: 'expansion', quote: 'Acme Tools is opening twelve new branches across Europe this year.' },
          { post: numberOf(LI_TEXT), kind: 'catalog_update', quote: VIDEO_TEXT },
        ],
      },
    }
  })
})

describe('a profile is not a signal', () => {
  it('records no "has a profile" and no "profile describes" signal', async () => {
    const r = await new SocialProfileProvider().collect(ctx)
    for (const s of r.signals) expect(s.signalType).not.toMatch(/^social_(presence|description)_/)
    expect(JSON.stringify(r.signals)).not.toMatch(/12,400 likes|3k subscribers/)
  })

  it('keeps profile-only signals stored by earlier runs off every screen', () => {
    expect(isProfileOnlySignal({ signalType: 'social_presence_linkedin' })).toBe(true)
    expect(isProfileOnlySignal({ signalType: 'social_description_facebook' })).toBe(true)
    expect(isProfileOnlySignal({ signalType: 'social_activity_product_launch' })).toBe(false)
  })

  it('says why there is nothing when the accounts show no recent posts', async () => {
    searchWeb.mockResolvedValue({ ok: true, provider: 'gemini', queriesRun: ['q'], modelText: '', model: 'm', costUsd: 0, reason: null, references: [] })
    PAGES['https://youtube.com/@acmetools/videos'] = '<html></html>'
    try {
      const r = await new SocialProfileProvider().collect(ctx)
      expect(r.signals).toHaveLength(0)
      expect(r.reason).toMatch(/no recent post could be read/)
      expect(r.reason).toMatch(/Profile details \(followers, description\) are not signals/)
      expect(generate).not.toHaveBeenCalled()
    } finally {
      PAGES['https://youtube.com/@acmetools/videos'] = '<html><script>{"videoId":"vidOwnRecen"},{"videoId":"vidSomeoneE"},{"videoId":"vidOwnOld01"}</script></html>'
    }
  })
})

describe('a signal is a recent post on the company’s own account', () => {
  it('turns a recent video and a recent post into signals, with the exact post, date, URL, why and next action', async () => {
    const r = await new SocialProfileProvider().collect(ctx)
    const launch = r.signals.find((s) => s.signalType === 'social_activity_product_launch')!
    const tech = r.signals.find((s) => s.signalType === 'social_activity_ecommerce_or_website')!

    expect(launch.sourceUrl).toBe('https://www.youtube.com/watch?v=vidOwnRecen')
    expect(launch.evidence).toContain(VIDEO_TEXT)
    // What it is about, in the post's own words, then the post's own quote.
    expect(launch.summary).toMatch(/^New product launch — Acme Tools on YouTube: cordless drills now in stock\. “/)
    expect(launch.observedAt!.getTime()).toBeGreaterThan(daysAgo(13).getTime())
    expect(launch.interpretation).toMatch(/New products need complete descriptions/)
    expect(launch.outreachAngle).toMatch(/^Open on the launch/)

    expect(tech.sourceUrl).toBe('https://www.facebook.com/acmetools/posts/new-online-store/1234567890123/')
    expect(tech.evidence).toBe(FB_TEXT)
    expect(Math.abs(tech.observedAt!.getTime() - daysAgo(20).getTime())).toBeLessThan(2000)
    expect((tech.metadata as { platformLabel: string }).platformLabel).toBe('Facebook')
    // An "about" line in words the post does not use is not kept.
    expect((tech.metadata as { about: string | null }).about).toBeNull()
    expect(tech.summary).not.toMatch(/Revolutionary/)
  })

  it('reads no post on another account, no old post, and keeps no hiring post or unquoted claim', async () => {
    const r = await new SocialProfileProvider().collect(ctx)
    const read = (r.metadata as { postsRead: Array<{ url: string }> }).postsRead.map((p) => p.url)
    expect(read).not.toContain('https://www.youtube.com/watch?v=vidSomeoneE')
    expect(read).not.toContain('https://www.youtube.com/watch?v=vidOwnOld01')
    expect(read.some((u) => u.includes('otherco'))).toBe(false)
    expect((r.metadata as { postsOlderThanRecent: number }).postsOlderThanRecent).toBe(1)
    expect(r.signals.some((s) => /hiring|catalog_update/i.test(s.signalType))).toBe(false)
    expect(r.signals.some((s) => /twelve new branches/.test(s.summary))).toBe(false)
    expect((r.metadata as { claimsRejectedAsUngrounded: number }).claimsRejectedAsUngrounded).toBe(2)
  })
})

describe('whose post is it', () => {
  it('decides by the account in the post address', () => {
    expect(postBelongsTo('https://www.facebook.com/acmetools/posts/x/123/', { platform: 'facebook', handle: 'acmetools' })).toBe(true)
    expect(postBelongsTo('https://www.facebook.com/otherco/posts/x/123/', { platform: 'facebook', handle: 'acmetools' })).toBe(false)
    expect(postBelongsTo('https://www.linkedin.com/posts/acme-tools_launch-activity-1', { platform: 'linkedin', handle: 'acme-tools' })).toBe(true)
    expect(postBelongsTo('https://www.linkedin.com/posts/acme-tools-fan_x', { platform: 'linkedin', handle: 'acme-tools' })).toBe(false)
    expect(postBelongsTo('https://x.com/acmetools/status/1800000000', { platform: 'x', handle: 'acmetools' })).toBe(true)
    // Addresses that name no account are decided from the page itself.
    expect(postBelongsTo('https://www.youtube.com/watch?v=abc', { platform: 'youtube', handle: '@acmetools' })).toBe('check_page')
    expect(postBelongsTo('https://www.facebook.com/acmetools', { platform: 'facebook', handle: 'acmetools' })).toBe(false)
  })
})

describe('the fixed phrases are a fallback for a failed reader, never a second opinion', () => {
  it('adds nothing when the reader worked and found nothing in a post', async () => {
    generate.mockResolvedValue({ costUsd: 0, data: { signals: [] } })
    const r = await new SocialProfileProvider().collect(ctx)
    expect(r.signals.filter((s) => s.signalType.startsWith('social_'))).toHaveLength(0)
    expect(r.reason).toMatch(/none was about a launch, a change/)
  })

  it('reports what the posts plainly say when the reader failed — and never hiring', async () => {
    generate.mockRejectedValue(new Error('model unavailable'))
    const r = await new SocialProfileProvider().collect(ctx)
    const themed = r.signals.filter((s) => s.signalType.startsWith('social_post_'))
    expect(themed.map((s) => s.sourceUrl)).toContain('https://www.facebook.com/acmetools/posts/new-online-store/1234567890123/')
    expect(themed.some((s) => /hiring/.test(s.signalType))).toBe(false)
  })
})

describe('a video post is read by its headline, never by its counts', () => {
  it('keeps the headline and drops "1.3K views · 15 reactions"', async () => {
    const url = 'https://www.facebook.com/acmetools/videos/leeds-store/1234567890123/'
    const html =
      '<html><head><meta property="og:title" content="1.3K views · 15 reactions | Hello Leeds! Our new Leeds store is now open">' +
      '<meta property="og:description" content="Come and visit us at 1 High Street for trade prices and expert advice."></head></html>'
    const post = await readPostPage(url, { platform: 'facebook', platformLabel: 'Facebook', url: 'https://facebook.com/acmetools', handle: 'acmetools', discoveredOn: 'x', anchorText: null }, {
      fetcher: async (u: string) => ok(u, html),
    })
    expect(post!.text).toBe('Hello Leeds! Our new Leeds store is now open. Come and visit us at 1 High Street for trade prices and expert advice.')
    expect(post!.text).not.toMatch(/views|reactions/)
  })
})

