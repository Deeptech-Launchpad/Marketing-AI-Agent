import { z } from 'zod'
import { getLlm } from '../llm/index.js'
import { logger } from '../platform/logger.js'
import { fetchPageRaw, type RawPageResult } from '../research/pageFetch.js'
import { discoverPublicSources } from '../research/publicResearch.js'
import { htmlToText } from '../research/htmlToText.js'
import { extractJsonLd, extractMeta, jsonLdNodes } from '../websiteaudit/htmlStructure.js'
import { isHistoryStatement } from './eventReader.js'
import type { SocialProfile } from './socialProfiles.js'
import type { SignalCategory } from './types.js'

// WHAT A COMPANY HAS RECENTLY POSTED — NOT WHAT ITS PROFILE SAYS (2026-10-07).
//
// A profile's follower count, bio or mere existence says nothing about what
// the company is doing now. Its posts do: a launch, a catalogue update, a new
// branch, a move to a new website. So the social source reads POSTS, from the
// company's OWN accounts only (the ones its website or NXT Sales record links
// to), and only what a logged-out visitor can see:
//
//   · YouTube   — the channel's videos page lists its newest videos; each
//                 video's own page states its title, description, publish
//                 date and the channel it belongs to.
//   · Posts found by search — individual post pages (Facebook, LinkedIn, X,
//                 Instagram) on those accounts. A post page serves the post's
//                 text in its metadata and, on most platforms, its date.
//   · Posts the profile page itself renders, where a platform renders any.
//
// A post counts only when it is provably the company's: its address sits under
// the company's own account, or the page names that account as its owner. Its
// date is the one the post's own markup states, or none. Nothing is guessed.

/** One public post by the company, as the platform served it. */
export interface SocialPost {
  platform: SocialProfile['platform']
  platformLabel: string
  /** The company account it was published on. */
  profileUrl: string
  /** The post's own address — what a person opens to see it. */
  url: string
  /** The post's text (or a video's title and description), as served. */
  text: string
  /** Public comments the page served with the post, where it served any. */
  comments: string[]
  /** ISO date the post's own markup states, or null. */
  publishedAt: string | null
  via: 'youtube_channel' | 'post_page' | 'profile_page'
}

type Fetcher = (url: string, opts?: { as?: 'html' | 'xml' | 'asset' }) => Promise<RawPageResult>

const meta = (html: string, key: string): string | null => {
  const v = extractMeta(html, key)?.value
  return v ? htmlToText(v).replace(/\s+/g, ' ').trim() || null : null
}

function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const t = typeof raw === 'number' ? new Date(raw * 1000) : new Date(raw)
  if (Number.isNaN(t.getTime()) || t.getTime() > Date.now() + 86_400_000 || t.getFullYear() < 2004) return null
  return t.toISOString()
}

const bare = (h: string) => h.replace(/^(www|m|mobile)\./i, '').toLowerCase()

/**
 * Whether a post address sits under the company's own account. Instagram and
 * YouTube post addresses carry no account, so they are decided from the page
 * (see ownedByPage).
 */
export function postBelongsTo(url: string, profile: Pick<SocialProfile, 'platform' | 'handle'>): boolean | 'check_page' {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const host = bare(u.hostname)
  const path = u.pathname
  const handle = profile.handle.replace(/^@/, '').toLowerCase()
  if (!handle) return false
  switch (profile.platform) {
    case 'facebook':
      if (!['facebook.com', 'fb.com'].includes(host)) return false
      return new RegExp(`^/${escape(handle)}/(posts|videos|photos|reel)/`, 'i').test(path)
    case 'linkedin':
      if (host !== 'linkedin.com') return false
      // A company post: /posts/<company-page-name>_<slug>-activity-<id>-<code>
      return new RegExp(`^/posts/${escape(handle)}_`, 'i').test(path)
    case 'x':
      if (!['x.com', 'twitter.com'].includes(host)) return false
      return new RegExp(`^/${escape(handle)}/status/\\d+`, 'i').test(path)
    case 'instagram':
      return host === 'instagram.com' && /^\/(p|reel)\/[\w-]+/i.test(path) ? 'check_page' : false
    case 'youtube':
      return host === 'youtube.com' && (path === '/watch' || path.startsWith('/shorts/')) ? 'check_page' : false
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** For a post address that carries no account: does the page name the company's account as its owner? */
function ownedByPage(html: string, profile: Pick<SocialProfile, 'platform' | 'handle'>, channelId: string | null): boolean {
  const handle = profile.handle.replace(/^@/, '').toLowerCase()
  if (profile.platform === 'youtube') {
    const owner = html.match(/"videoDetails":\{"videoId":"[\w-]{11}"[^}]*?"channelId":"(UC[\w-]{22})"/)?.[1] ?? html.match(/<meta itemprop="channelId" content="(UC[\w-]{22})"/)?.[1] ?? null
    if (channelId && owner) return owner === channelId
    const ownerHandle = html.match(/"ownerProfileUrl":"https?:\/\/www\.youtube\.com\/(@[^"]+)"/)?.[1]?.toLowerCase() ?? null
    return Boolean(ownerHandle && ownerHandle === `@${handle}`)
  }
  if (profile.platform === 'instagram') {
    const head = `${meta(html, 'og:title') ?? ''} ${meta(html, 'og:description') ?? ''}`.toLowerCase()
    return head.includes(`@${handle}`) || head.includes(`(@${handle})`)
  }
  return false
}

/** The post's own date, from markup that dates THIS post. */
function postDateOf(html: string, url: string): string | null {
  for (const { node } of jsonLdNodes(extractJsonLd(html))) {
    const d = isoOrNull(node.datePublished ?? node.uploadDate ?? node.dateCreated)
    if (d) return d
  }
  const itemprop = html.match(/<meta itemprop="(?:datePublished|uploadDate)" content="([^"]+)"/)?.[1]
  if (itemprop) return isoOrNull(itemprop)
  const article = meta(html, 'article:published_time')
  if (article) return isoOrNull(article)
  // Facebook: the creation time stated beside this post's own id.
  const id = url.match(/\/(\d{10,})\/?(?:[?#]|$)/)?.[1] ?? new URL(url).searchParams.get('story_fbid')
  if (id) {
    const at = html.indexOf(`"post_id":"${id}"`)
    if (at >= 0) {
      const m = html.slice(at, at + 400).match(/"creation_time":(\d{10})/)
      if (m) return isoOrNull(Number(m[1]))
    }
  }
  return null
}

/**
 * Engagement counts a platform puts in front of a title ("1.3K views · 15
 * reactions | …"). Counts are not activity, and are never kept.
 */
const COUNTS_PREFIX = /^(?:[\d.,]+\s*[KkMm]?\s+(?:views?|reactions?|likes?|comments?|shares?|plays?)\s*(?:·\s*)?)+\|\s*/i

/** The post's text and any public comments the page served with it. */
function postTextOf(html: string, url = ''): { text: string | null; comments: string[] } {
  for (const { node } of jsonLdNodes(extractJsonLd(html))) {
    const type = String(node['@type'] ?? '')
    if (!/SocialMediaPosting|DiscussionForumPosting|VideoObject|BlogPosting|NewsArticle|Article/i.test(type)) continue
    const body = [node.articleBody, node.text, node.description, node.headline, node.name].find((v) => typeof v === 'string' && v.trim().length >= 15)
    if (typeof body !== 'string') continue
    const raw = Array.isArray(node.comment) ? node.comment : node.comment ? [node.comment] : []
    const comments = raw
      .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).text : null))
      .filter((t): t is string => typeof t === 'string' && t.trim().length >= 10)
      .map((t) => htmlToText(t).replace(/\s+/g, ' ').trim().slice(0, 500))
      .slice(0, 10)
    return { text: htmlToText(body).replace(/\s+/g, ' ').trim(), comments }
  }
  const title = meta(html, 'og:title')?.replace(COUNTS_PREFIX, '').trim() ?? null
  const description = meta(html, 'og:description') ?? meta(html, 'twitter:description')
  const text = description && description.length >= 15 ? description : null
  // A video's, photo's or reel's title is the post's own headline ("Hello
  // Geelong! Our store is now open"); a post page's og:title is only the
  // account's name, so it is not added there.
  const headlined = /youtube/i.test(html.slice(0, 3000)) || /\/(videos|photos|reel)\//i.test(url)
  if (headlined && title && title.length >= 8) {
    const flat = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!text) return { text: title, comments: [] }
    return { text: flat(text).includes(flat(title).slice(0, 40)) ? text : `${title}. ${text}`, comments: [] }
  }
  return { text, comments: [] }
}

/** Reads one post page. Null when it is not the company's, or carries no post text. */
export async function readPostPage(
  url: string,
  profile: SocialProfile,
  opts: { fetcher?: Fetcher; channelId?: string | null; via?: SocialPost['via'] } = {},
): Promise<SocialPost | null> {
  const fetcher = opts.fetcher ?? fetchPageRaw
  const page = await fetcher(url).catch(() => null)
  return page ? postFromPage(page, url, profile, opts) : null
}

/** A fetched page as one of the company's posts, or null. */
function postFromPage(
  page: RawPageResult,
  url: string,
  profile: SocialProfile,
  opts: { channelId?: string | null; via?: SocialPost['via'] } = {},
): SocialPost | null {
  if (!page.ok || !page.html) return null
  const finalUrl = page.finalUrl ?? url
  const belongs = postBelongsTo(finalUrl, profile)
  if (belongs === false) return null
  if (belongs === 'check_page' && !ownedByPage(page.html, profile, opts.channelId ?? null)) return null
  const { text, comments } = postTextOf(page.html, finalUrl)
  if (!text || /^(log ?in|sign ?in|sign up)\b/i.test(text)) return null
  return {
    platform: profile.platform,
    platformLabel: profile.platformLabel,
    profileUrl: profile.url,
    url: finalUrl,
    text: text.slice(0, 3000),
    comments,
    publishedAt: postDateOf(page.html, finalUrl),
    via: opts.via ?? 'post_page',
  }
}

/** The channel's newest videos, each read from its own page. */
export async function youtubeRecentVideos(
  profile: SocialProfile,
  channelHtml: string | null,
  opts: { fetcher?: Fetcher; max?: number } = {},
): Promise<SocialPost[]> {
  const fetcher = opts.fetcher ?? fetchPageRaw
  const channelId =
    profile.handle.match(/^UC[\w-]{22}$/)?.[0] ??
    channelHtml?.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
    null
  const list = await fetcher(`${profile.url.replace(/\/+$/, '')}/videos`).catch(() => null)
  if (!list?.ok || !list.html) return []
  const ids = [...new Set([...list.html.matchAll(/"videoId":"([\w-]{11})"/g)].map((m) => m[1]!))].slice(0, opts.max ?? 5)
  const out: SocialPost[] = []
  for (const id of ids) {
    const post = await readPostPage(`https://www.youtube.com/watch?v=${id}`, profile, { fetcher, channelId, via: 'youtube_channel' })
    if (post) out.push(post)
  }
  return out
}

/**
 * Individual posts on the company's own accounts, found by one search and then
 * read and attributed by us. The search only says where to look.
 */
export async function searchRecentPosts(input: {
  tenantId: string
  companyName: string
  domain: string | null
  profiles: SocialProfile[]
  fetcher?: Fetcher
  maxPosts?: number
  budgetMs?: number
}): Promise<{ posts: SocialPost[]; queriesRun: string[]; costUsd: number; found: number; failed: string | null }> {
  const searchable = input.profiles.filter((p) => p.platform !== 'youtube')
  if (!searchable.length) return { posts: [], queriesRun: [], costUsd: 0, found: 0, failed: null }
  const discovery = await discoverPublicSources({
    tenantId: input.tenantId,
    companyName: input.companyName,
    domain: input.domain,
    topic: 'social_activity',
    accounts: searchable.map((p) => p.url),
    maxSources: 20,
    feature: 'intent_social_activity',
  })
  if (discovery.status !== 'available') {
    return { posts: [], queriesRun: discovery.queriesRun, costUsd: discovery.costUsd, found: 0, failed: discovery.reason ?? 'The search failed.' }
  }
  const started = Date.now()
  const fetcher = input.fetcher ?? fetchPageRaw
  const posts: SocialPost[] = []
  const seen = new Set<string>()
  for (const source of discovery.sources) {
    if (posts.length >= (input.maxPosts ?? 10)) break
    if (Date.now() - started >= (input.budgetMs ?? 90_000)) break
    // Fetched once; the landing address (or the page) decides the account.
    const page = await fetcher(source.url).catch(() => null)
    if (!page) continue
    for (const profile of searchable) {
      const post = postFromPage(page, source.url, profile)
      if (!post) continue
      if (!seen.has(post.url)) {
        seen.add(post.url)
        posts.push(post)
      }
      break
    }
  }
  return { posts, queriesRun: discovery.queriesRun, costUsd: discovery.costUsd, found: discovery.sources.length, failed: null }
}

// ── What each post is about ────────────────────────────────────────────────

/**
 * What a company's own recent post can be about, as a signal. Fixed: the
 * reader picks one and quotes the post; WHY it matters and WHAT TO DO NEXT are
 * written here, never by a model. Hiring is not a kind (jobSignals.ts).
 */
export const POST_KINDS = [
  'product_launch',
  'product_promotion',
  'catalog_update',
  'ecommerce_or_website',
  'ai_or_technology',
  'product_data_issue',
  'expansion',
  'partnership',
  'event',
  'customer_feedback',
] as const
export type PostKind = (typeof POST_KINDS)[number]

export const POST_KIND_INFO: Record<PostKind, { category: SignalCategory; label: string; why: string; next: string }> = {
  product_launch: {
    category: 'catalog',
    label: 'New product launch',
    why: 'New products need complete descriptions, attributes and specifications from day one, across every channel they are sold through.',
    next: 'Open on the launch, and offer to check that the new product’s pages carry complete specifications, attributes and identifiers from day one.',
  },
  product_promotion: {
    category: 'catalog',
    label: 'Product promotion',
    why: 'The company is putting effort behind this product now. How completely its page presents the product decides whether that effort converts in search and AI answers. It may point to a need; it does not establish one.',
    next: 'Refer to the product they are promoting, and offer a quick check of how completely its product page presents it for search and AI answers.',
  },
  catalog_update: {
    category: 'catalog',
    label: 'Catalogue update',
    why: 'A catalogue being added to or reorganised is product data being changed — the moment its completeness and structure matter most.',
    next: 'Refer to the catalogue update, and offer to review how consistently the new or changed product data is structured.',
  },
  ecommerce_or_website: {
    category: 'technology',
    label: 'Website or online-store change',
    why: 'A new or changed website, online store or ordering system means product data is being moved or rebuilt — the moment its quality and structure matter most.',
    next: 'Refer to the website or online-store change, and offer to check the product data it publishes: structured data, attributes, identifiers.',
  },
  ai_or_technology: {
    category: 'technology',
    label: 'AI or technology adoption',
    why: 'AI and new systems only pay off on clean, structured product data; the company is investing in exactly the area our services support. It may point to a need; it does not establish one.',
    next: 'Refer to the technology move, and explain how clean, structured product data makes it pay off — in search, AI answers and their own systems.',
  },
  product_data_issue: {
    category: 'catalog',
    label: 'Product-data problem',
    why: 'The company’s own post describes a problem with product information — a direct, first-party sign of a need.',
    next: 'Lead with help on the specific problem the post describes, before mentioning any service.',
  },
  expansion: {
    category: 'business',
    label: 'Expansion',
    why: 'Growth — new locations, markets or facilities — usually means more products, more channels and more product data to keep consistent. It may create a need; it does not establish one.',
    next: 'Congratulate them on the expansion, and ask how they keep product information consistent across the new locations or markets.',
  },
  partnership: {
    category: 'business',
    label: 'New brand or partnership',
    why: 'A new brand or partner relationship usually arrives as a block of new products to publish.',
    next: 'Refer to the new brand or partner, and offer to help publish its products with complete, consistent data.',
  },
  event: {
    category: 'business',
    label: 'Event',
    why: 'A named event is a dated, checkable reason to make contact.',
    next: 'Mention the event by name, and offer to meet there — or to follow up afterwards with something useful.',
  },
  customer_feedback: {
    category: 'catalog',
    label: 'Customer feedback on a post',
    why: 'Customers raised this in public on the company’s own post. Where it concerns product details, ordering or finding products, it is a direct sign the product information is not doing its job; otherwise it is context.',
    next: 'Do not quote the customer; use the theme of the feedback to offer help with the product information behind it.',
  },
}

const Readings = z.object({
  signals: z
    .array(
      z.object({
        post: z.number().int().positive(),
        kind: z.enum(POST_KINDS),
        quote: z.string().min(10).max(600),
        about: z.string().max(160).nullable().optional(),
      }),
    )
    .max(30)
    .default([]),
})

export interface PostReading {
  post: SocialPost
  kind: PostKind
  quote: string
  /** What the post is about, in its own words — or null when the reader's wording was not the post's. */
  about: string | null
}

function flatten(s: string): string {
  return s.toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]/g, '')
}

/** The reader's short "about" line, kept only when it is made of the post's own words. */
function groundedAbout(about: string | null | undefined, post: SocialPost): string | null {
  const t = about?.replace(/\s+/g, ' ').trim()
  if (!t) return null
  const words = (t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
  if (!words.length) return null
  const hay = [post.text, ...post.comments].join(' ').toLowerCase()
  const found = words.filter((w) => hay.includes(w)).length
  return found / words.length >= 0.6 ? t.slice(0, 120) : null
}

/**
 * Reads the company's recent posts: every reading names its post, quotes it
 * VERBATIM (checked here character by character against that post and its
 * comments) and is one of the fixed kinds. The post being on the company's own
 * account is what ties it to the company, so the quote need not repeat the
 * name. Nothing that is not in the post survives.
 */
export async function readPosts(input: {
  posts: SocialPost[]
  companyName: string
  companyHost: string | null
  tenantId: string
}): Promise<{ readings: PostReading[]; rejected: number; costUsd: number; failed: string | null }> {
  if (!input.posts.length) return { readings: [], rejected: 0, costUsd: 0, failed: null }
  const posts = input.posts
    .map((p, i) =>
      [
        `POST ${i + 1} — ${p.platformLabel}${p.publishedAt ? `, ${p.publishedAt.slice(0, 10)}` : ''}:`,
        p.text,
        ...(p.comments.length ? ['Public comments on this post:', ...p.comments.map((c) => `- ${c}`)] : []),
      ].join('\n'),
    )
    .join('\n\n')
    .slice(0, 14_000)
  try {
    const result = await getLlm().generate({
      promptKey: 'intent.read_company_posts',
      variables: {
        companyName: input.companyName,
        companyDomain: input.companyHost ? ` (${input.companyHost})` : '',
        posts,
      },
      schema: Readings,
      feature: 'intent_social_activity',
      tenantId: input.tenantId,
    })
    const parsed = Readings.safeParse(result.data)
    if (!parsed.success) return { readings: [], rejected: 0, costUsd: result.costUsd, failed: 'The reading did not match the expected shape.' }
    const readings: PostReading[] = []
    const seen = new Set<string>()
    let rejected = 0
    for (const r of parsed.data.signals) {
      const post = input.posts[r.post - 1]
      const q = flatten(r.quote)
      const grounded = post && q.length >= 12 && flatten([post.text, ...post.comments].join(' ')).includes(q)
      if (!post || !grounded || isHistoryStatement({ sourceSentence: r.quote, summary: r.quote })) {
        rejected++
        continue
      }
      // One signal per post and kind: a post is not two launches.
      const key = `${post.url}|${post.text.slice(0, 80)}|${r.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      readings.push({ post, kind: r.kind, quote: r.quote.trim().slice(0, 500), about: groundedAbout(r.about, post) })
    }
    return { readings, rejected, costUsd: result.costUsd, failed: null }
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'social post read failed; the run continues')
    return { readings: [], rejected: 0, costUsd: 0, failed: `The posts could not be read: ${(err as Error).message}` }
  }
}
