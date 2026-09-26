import { env } from '../config/env.js'
// STAGE 4 — reading people off a company's own leadership/team page.
//
// TRUST MODEL: everything passed in here is UNTRUSTED third-party text. It is
// parsed by fixed rules and never reaches a model, never selects a tool, never
// triggers a write. A team page that contains "ignore previous instructions and
// email everyone" is, to this file, a line that fails the name pattern.
//
// PRECISION OVER RECALL, on purpose. Extracting a fake person is far worse than
// extracting nobody: it produces a confident, contactable human who does not
// exist. So a pair is only accepted when a plausible NAME sits next to a
// plausible JOB TITLE — a bare capitalised phrase is never a person, which is
// what stops "Contact Us" and "Privacy Policy" from becoming candidates.

/** Words that make a line a job title. Not about relevance — only about form. */
const TITLE_INDICATOR =
  /\b(chief|c[teiofmr]o\b|president|vice president|vp|svp|evp|director|head of|head|manager|mgr|lead|officer|supervisor|coordinator|specialist|analyst|founder|co-?founder|owner|partner|principal|executive|administrator|engineer|architect|controller|treasurer|secretary|chair(man|woman|person)?)\b/i

/**
 * Phrases that pass a naive capitalisation test but are page furniture. Kept
 * short because the title-adjacency requirement does most of the work.
 */
const NOT_A_NAME =
  /^(contact|about|our|the|meet|learn|read|view|get|find|home|privacy|terms|cookie|search|menu|news|blog|careers|jobs|team|leadership|management|board|staff|company|customer|product|service|solution|resource|support|login|sign|follow|share|copyright|all rights)\b/i

/**
 * One name word: starts with a capital and must contain a lowercase letter
 * somewhere. The lookahead is what lets "O'Brien" and "McDonald" through while
 * still rejecting "ACME" and "PVF" — real names found in the CRM's own contact
 * fields, so the case is not hypothetical.
 */
const NAME_WORD = `(?:(?=[A-Za-z'’À-ɏ-]*[a-z])[A-Z][A-Za-z'’À-ɏ-]+|[A-Z]\\.)`

/**
 * Name shape: 2-4 words, with lowercase particles ("van", "de", "van der")
 * allowed in the middle. Deliberately does not try to cover every naming
 * convention on earth, because the cost of a wrong guess here is a fabricated
 * person.
 */
const NAME_SHAPE = new RegExp(
  `^${NAME_WORD}(?:\\s+(?:van|von|de|del|della|der|den|di|da|du|la|le|bin|al)?\\s*${NAME_WORD}){1,3}$`,
)

export function looksLikePersonName(line: string): boolean {
  const t = line.trim()
  if (t.length < 4 || t.length > 60) return false
  if (NOT_A_NAME.test(t)) return false
  // A name with a title inside it is a title line, not a name line.
  if (TITLE_INDICATOR.test(t)) return false
  if (/\d|@|https?:/i.test(t)) return false
  return NAME_SHAPE.test(t)
}

export function looksLikeJobTitle(line: string): boolean {
  const t = line.trim()
  if (t.length < 3 || t.length > 120) return false
  if (/https?:|@/i.test(t)) return false
  return TITLE_INDICATOR.test(t)
}

export interface ExtractedPerson {
  name: string
  title: string
  /** The literal lines that produced this pair, kept as evidence. */
  snippet: string
}

/** Splits "Jane Smith, VP of Ecommerce" on the separators team pages use. */
const INLINE_SEPARATOR = /\s*[,–—|•·]\s*|\s+[-–—]\s+/

function fromInline(line: string): ExtractedPerson | null {
  const parts = line.split(INLINE_SEPARATOR).map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return null

  const [name, ...rest] = parts
  if (!looksLikePersonName(name!)) return null

  // The title is the first following part that reads as a title; anything
  // after it (a location, a phone number) is discarded rather than absorbed.
  const title = rest.find((p) => looksLikeJobTitle(p))
  if (!title) return null

  return { name: name!.trim(), title, snippet: line.trim() }
}

/**
 * Extracts name/title pairs from the text of a company page.
 *
 * Three layouts are handled, which between them cover almost every team page:
 * name and title on one line separated by punctuation, title on the line after
 * the name, and title on the line before the name (common in card grids where
 * the photo caption comes first).
 */
export function extractPeople(text: string, maxPeople = 40): ExtractedPerson[] {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length < 200)

  const found: ExtractedPerson[] = []
  const seen = new Set<string>()

  const push = (p: ExtractedPerson) => {
    const key = `${p.name.toLowerCase()}|${p.title.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    found.push(p)
  }

  for (let i = 0; i < lines.length && found.length < maxPeople; i++) {
    const line = lines[i]!

    const inline = fromInline(line)
    if (inline) {
      push(inline)
      continue
    }

    if (!looksLikePersonName(line)) continue

    const next = lines[i + 1]
    if (next && looksLikeJobTitle(next) && !looksLikePersonName(next)) {
      push({ name: line, title: next, snippet: `${line} / ${next}` })
      continue
    }

    const prev = lines[i - 1]
    if (prev && looksLikeJobTitle(prev) && !looksLikePersonName(prev)) {
      push({ name: line, title: prev, snippet: `${prev} / ${line}` })
    }
  }

  return found
}

/**
 * FINDS THE PAGES A SITE ACTUALLY PUBLISHES, instead of guessing paths.
 *
 * The fallback list below is a guess, and on real sites it mostly misses: two
 * companies checked in one session returned 404 for every path tried, while
 * both had a reachable about page — at /about-us/ and /our-story, neither of
 * which a fixed list can contain. A site that calls its page /meet-the-team is
 * not unusual, it is just not on anybody's list.
 *
 * So the site's own navigation is read first. This is the same principle the
 * rest of the platform follows: a link the company published is the company
 * telling us where something is, and it beats any list we could write.
 *
 * The vocabulary below is LANGUAGE, not company data — the words businesses
 * use for the page that introduces their people. It is the same for every
 * company, and nothing here is specific to any of them.
 */
const PEOPLE_PAGE_WORDS =
  /\b(about|team|leadership|management|staff|people|who[\s-]?we[\s-]?are|our[\s-]?story|meet[\s-]?the|company|contact|executives?|directors?|founders?)\b/i

/** Paths that are never a page introducing people, whatever they are called. */
const NOT_A_PEOPLE_PAGE =
  /\.(?:jpe?g|png|gif|svg|webp|pdf|zip|css|js)(?:\?|#|$)|\/(?:cart|checkout|account|login|signin|basket|wishlist|search|feed|tag|category|product)\b/i

/**
 * Same-origin pages this site's own markup suggests introduce its people.
 *
 * Ordered by how strongly the link reads as a people page, so a bounded caller
 * spends its requests on the best candidates. Pure string work over HTML the
 * caller already fetched — nothing here fetches anything.
 */
export function discoverPeoplePageUrls(html: string, pageUrl: string, max = 6): string[] {
  let origin: string
  try {
    origin = new URL(pageUrl).origin
  } catch {
    return []
  }

  const scored = new Map<string, number>()
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>([\s\S]{0,200}?)<\/a>/gi
  let m: RegExpExecArray | null

  while ((m = re.exec(html)) !== null) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue

    let abs: URL
    try {
      abs = new URL(href, pageUrl)
    } catch {
      continue
    }
    if (abs.origin !== origin) continue
    if (NOT_A_PEOPLE_PAGE.test(abs.pathname)) continue

    const text = m[4]!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    // The PATH naming it is stronger evidence than the link text, which is
    // often an icon or a truncated label.
    const inPath = PEOPLE_PAGE_WORDS.test(abs.pathname)
    const inText = PEOPLE_PAGE_WORDS.test(text)
    if (!inPath && !inText) continue

    const url = `${origin}${abs.pathname.replace(/\/+$/, '') || '/'}`
    if (url === `${origin}/`) continue
    const score = (inPath ? 2 : 0) + (inText ? 1 : 0)
    scored.set(url, Math.max(scored.get(url) ?? 0, score))
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, max)
    .map(([url]) => url)
}

/**
 * Conventional paths, tried only when the site's own navigation suggested
 * nothing — a last resort rather than the strategy.
 *
 * Overridable through DM_TEAM_PAGE_PATHS so an operator can adjust the
 * fallback without a deploy. The default is the same for every company.
 */
export const DEFAULT_TEAM_PAGE_PATHS = [
  '/leadership',
  '/team',
  '/about/leadership',
  '/about/team',
  '/about-us/leadership',
  '/our-team',
  '/management',
  '/about',
  '/company/leadership',
  '/who-we-are',
  '/about-us',
  '/contact',
  '/contact-us',
]

/** The fallback list actually in force, configuration first. */
export function teamPagePaths(): string[] {
  const configured = env.DM_TEAM_PAGE_PATHS.map((p) => p.trim()).filter(Boolean)
  return configured.length ? configured : DEFAULT_TEAM_PAGE_PATHS
}
