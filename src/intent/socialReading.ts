import { decode, extractMeta, extractTitle } from '../websiteaudit/htmlStructure.js'

// WHAT A PUBLIC SOCIAL PAGE ACTUALLY GIVES AN UNAUTHENTICATED READER.
//
// Every platform here serves something different to a logged-out request, and
// the difference matters more than the content does:
//
//   · some serve full Open Graph metadata and a readable page
//   · some serve metadata and nothing else
//   · some serve a login wall with the company name in the <title>
//   · some serve a consent interstitial
//
// A collector that treats all four as "no signals found" tells an operator the
// company has no social presence when in fact the platform refused to answer.
// So the first thing this module does is name WHICH of those happened, and the
// engine reports that verbatim.
//
// Nothing in this file logs in, defeats a wall, or pretends a wall is a result.

export type SocialAccess =
  /** The page answered and carried readable public content. */
  | 'public'
  /** The page answered with metadata only — a title and a description. */
  | 'metadata_only'
  /** The platform demands a session before it will show the page. */
  | 'login_required'
  /** A consent or interstitial page stood in front of the content. */
  | 'consent_required'
  /** The profile is gone, renamed, or never existed. */
  | 'not_found'
  /** The platform refused us specifically — rate limit, bot block. */
  | 'blocked'
  /** Nothing came back at all. */
  | 'unreachable'

export interface SocialReading {
  access: SocialAccess
  /** One sentence naming what happened, for the operator, never paraphrased away. */
  accessNote: string
  /** The account's own name, as the page states it. */
  title: string | null
  /** The account's own description, as the page states it. */
  description: string | null
  /** Publicly rendered post/announcement text, longest first. Never inferred. */
  posts: string[]
  /**
   * For each entry of `posts`, the date that post's own markup states, or
   * null. Parallel to `posts`.
   */
  postDates: Array<string | null>
  /** ISO dates the page published for its content, in the order found. */
  dates: string[]
}

const LOGIN_WALL =
  /(sign in to (?:see|continue|view)|log in to (?:see|continue|view)|join linkedin|create an account or sign in|you must log in|please log in to continue|authwall)/i
const CONSENT_WALL =
  /(before you continue|we use cookies to|accept all cookies|consent to (?:the use of )?cookies|manage your (?:cookie|privacy) (?:choices|settings))/i
const NOT_FOUND =
  /(this (?:page|content|profile) isn'?t available|page not found|sorry, this page isn'?t available|content unavailable|user not found)/i

/**
 * Text of every element of one tag name, markup stripped, with the date that
 * ELEMENT's own markup states (a <time datetime>, a data-date on the element)
 * or null. A post is never dated from somewhere else on the page.
 */
function itemsOf(html: string, tag: string, max: number): Array<{ text: string; date: string | null }> {
  const out: Array<{ text: string; date: string | null }> = []
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]{0,4000}?)</${tag}>`, 'gi')
  for (const m of html.matchAll(re)) {
    const t = decode(m[1]!.replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
    if (t) out.push({ text: t, date: publishedDates(m[0], 1)[0] ?? null })
    if (out.length >= max) break
  }
  return out
}

/** ISO-8601 dates a page states about its own content. */
function publishedDates(html: string, max: number): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(
    /(?:datetime|datePublished|data-date|content)\s*=\s*["'](\d{4}-\d{2}-\d{2}(?:[T ][\d:.+Z-]{2,})?)["']/gi,
  )) {
    out.add(m[1]!)
    if (out.size >= max) break
  }
  return [...out]
}

/**
 * Reads one fetched social page.
 *
 * `html` is untrusted. Everything returned is a literal substring of it or a
 * status this function decided from it — nothing is composed.
 */
export function readSocialPage(input: {
  html: string
  status: number | null
  /** True when the transport itself failed. */
  transportFailed?: boolean
  transportReason?: string | null
  platformLabel: string
}): SocialReading {
  const empty = {
    title: null,
    description: null,
    posts: [] as string[],
    postDates: [] as Array<string | null>,
    dates: [] as string[],
  }

  if (input.transportFailed || input.status === null) {
    return {
      ...empty,
      access: 'unreachable',
      accessNote: `${input.platformLabel} did not respond${input.transportReason ? `: ${input.transportReason}` : '.'}`,
    }
  }
  if (input.status === 404 || input.status === 410) {
    return {
      ...empty,
      access: 'not_found',
      accessNote: `${input.platformLabel} returned HTTP ${input.status} for this profile — the page is gone or was renamed.`,
    }
  }
  if (input.status === 429 || input.status === 403 || input.status === 401) {
    return {
      ...empty,
      access: 'blocked',
      accessNote: `${input.platformLabel} returned HTTP ${input.status} to an unauthenticated request, so its public page could not be read.`,
    }
  }

  const html = input.html
  const meta = (key: string): string | null => extractMeta(html, key)?.value ?? null
  const title = meta('og:title') ?? meta('twitter:title') ?? extractTitle(html)?.value ?? null
  const description = meta('og:description') ?? meta('twitter:description') ?? meta('description') ?? null

  // The walls are checked AFTER metadata, because a wall usually still carries
  // an accurate og:title and og:description — which is a real, citable public
  // fact about the account even when the timeline behind it is not readable.
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  if (NOT_FOUND.test(body)) {
    return {
      title,
      description,
      posts: [],
      postDates: [],
      dates: [],
      access: 'not_found',
      accessNote: `${input.platformLabel} says this profile is not available.`,
    }
  }
  if (LOGIN_WALL.test(body)) {
    return {
      title,
      description,
      posts: [],
      postDates: [],
      dates: [],
      access: 'login_required',
      accessNote: `${input.platformLabel} requires a signed-in session to show this page, so only its public profile metadata could be read. No post was collected.`,
    }
  }
  if (CONSENT_WALL.test(body) && !/<article\b/i.test(body)) {
    return {
      title,
      description,
      posts: [],
      postDates: [],
      dates: [],
      access: 'consent_required',
      accessNote: `${input.platformLabel} served a consent interstitial instead of the page, so only its public profile metadata could be read.`,
    }
  }

  // Publicly rendered posts, where the platform actually serves them.
  const items = [...itemsOf(body, 'article', 12), ...itemsOf(body, 'blockquote', 6)]
    .filter((t) => t.text.length >= 40)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 6)
  const posts = items.map((i) => (i.text.length > 600 ? `${i.text.slice(0, 597)}…` : i.text))
  const postDates = items.map((i) => i.date)

  if (posts.length === 0) {
    return {
      title,
      description,
      posts: [],
      postDates: [],
      dates: publishedDates(body, 6),
      access: title || description ? 'metadata_only' : 'blocked',
      accessNote:
        title || description
          ? `${input.platformLabel} served this profile's public description but rendered no post content to an unauthenticated reader.`
          : `${input.platformLabel} returned a page carrying neither profile metadata nor readable posts.`,
    }
  }

  return {
    title,
    description,
    posts,
    postDates,
    dates: publishedDates(body, 6),
    access: 'public',
    accessNote: `${input.platformLabel} served this profile publicly; ${posts.length} publicly rendered item(s) were read.`,
  }
}

// ── Personalization ───────────────────────────────────────────────────────
//
// A narrow, closed list of non-sensitive public-interest topics, matched only
// against text the account itself published. It exists so outreach can open
// with something human, and it is deliberately unable to express anything else:
// there is no rule here for health, religion, politics, ethnicity, sexuality,
// family, finances or location, and none may be added.

const INTEREST_TOPICS: Array<{ topic: string; pattern: RegExp }> = [
  { topic: 'Formula 1', pattern: /\b(formula\s*1|f1 (?:race|season|grand prix)|grand prix)\b/i },
  { topic: 'Football', pattern: /\b(premier league|champions league|world cup|fa cup|football match)\b/i },
  { topic: 'Cricket', pattern: /\b(test match|ipl|cricket (?:match|world cup))\b/i },
  { topic: 'Rugby', pattern: /\b(six nations|rugby (?:match|world cup))\b/i },
  { topic: 'Golf', pattern: /\b(golf (?:day|tournament|open)|the masters)\b/i },
  { topic: 'Marathon / running', pattern: /\b(marathon|half[- ]marathon|parkrun|10k run)\b/i },
  { topic: 'Cycling', pattern: /\b(tour de france|charity (?:bike )?ride|cycl(?:ing|e) (?:event|challenge))\b/i },
  { topic: 'Motorsport', pattern: /\b(le mans|rally championship|motogp)\b/i },
  { topic: 'Film', pattern: /\b(watched|watching|saw) (?:the )?(?:new |latest )?(?:film|movie)\b/i },
  { topic: 'Gaming', pattern: /\b(gaming (?:setup|night|tournament)|e-?sports)\b/i },
  { topic: 'Music / live events', pattern: /\b(live gig|concert|music festival)\b/i },
  { topic: 'Chess', pattern: /\bchess (?:tournament|club|match)\b/i },
]

export interface PersonalizationSignal {
  topic: string
  /** The sentence the topic was found in, verbatim. */
  quote: string
  sourceUrl: string
  platformLabel: string
}

/**
 * A non-sensitive public interest stated in the account's own post text.
 *
 * Returns null far more often than not, and that is the intended behaviour:
 * "no public personalization signal observed" is a perfectly good answer, and a
 * far better one than a guess about somebody's life.
 */
export function personalizationSignal(input: {
  posts: string[]
  sourceUrl: string
  platformLabel: string
}): PersonalizationSignal | null {
  for (const post of input.posts) {
    for (const sentence of post.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim()
      if (s.length < 12 || s.length > 300) continue
      for (const rule of INTEREST_TOPICS) {
        if (rule.pattern.test(s)) {
          return {
            topic: rule.topic,
            quote: s,
            sourceUrl: input.sourceUrl,
            platformLabel: input.platformLabel,
          }
        }
      }
    }
  }
  return null
}
