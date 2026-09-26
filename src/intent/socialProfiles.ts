import { normalizeUrl } from '../research/ssrfGuard.js'

// WHICH PUBLIC PROFILES A COMPANY ITSELF CLAIMS.
//
// The only trustworthy way to say "this LinkedIn page belongs to this company"
// is that the company's own website links to it. Searching a platform for the
// company name finds namesakes, franchisees, resellers and parody accounts, and
// nothing in the result tells you which one you have — so this module does not
// search. It reads the links the company published, which is a claim the
// company made about itself.
//
// Nothing here fetches. Discovery is pure string work over HTML that some other
// part of the system already fetched, so it is cheap, deterministic and
// testable without a network.

/** The platforms this engine understands. Closed set: see `PLATFORMS`. */
export const SOCIAL_PLATFORMS = [
  'linkedin',
  'facebook',
  'instagram',
  'x',
  'youtube',
] as const
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

export interface SocialProfile {
  platform: SocialPlatform
  /** The platform's display name, for the interface. */
  platformLabel: string
  /** The canonical profile URL, query and tracking parameters removed. */
  url: string
  /** The account handle or company slug, as the URL carries it. */
  handle: string
  /** The page on the company's own site that linked to it. */
  discoveredOn: string
  /** The link's own anchor text, when it carried any. */
  anchorText: string | null
}

interface PlatformSpec {
  platform: SocialPlatform
  label: string
  /** Hosts that belong to this platform, without `www.`. */
  hosts: string[]
  /**
   * Path shapes that identify a PROFILE rather than a share button, a login
   * page or a post. The first capture group is the handle.
   */
  profile: RegExp[]
  /** Paths that are never a profile, whatever else matches. */
  reject?: RegExp
}

const NEVER_A_PROFILE =
  /^\/(?:sharer|share|share\.php|dialog|login|signup|home|help|legal|privacy|policies|tos|about|intent|plugins|widgets|embed|oauth|uas|authwall|checkpoint|feed|search|explore|accounts|watch|results|hashtag|tr|pixel|events|groups|marketplace|reels?|stories|people|pg|media|notes|bookmarks|gaming|business|ads)\b/i

/**
 * A platform's own scripts, which a bare-handle shape would otherwise read as
 * a company page.
 *
 * `facebook.com/photo.php` matches the "/<handle>" shape and became a profile
 * with the handle "photo.php". It was found inside a real company's own
 * JavaScript bundle, sitting beside that company's genuine page — so a reader
 * would have been shown two Facebook "profiles" for one company, one of which
 * is a Facebook utility that identifies nobody.
 *
 * profile.php is the deliberate exception: Facebook serves real numeric-id
 * profiles from it, and the profile shapes above handle it.
 */
const PLATFORM_SCRIPT = /^\/(?!profile\.php$)[^/]*\.php\b/i

const PLATFORMS: PlatformSpec[] = [
  {
    platform: 'linkedin',
    label: 'LinkedIn',
    hosts: ['linkedin.com', 'lnkd.in'],
    // Company pages only. A personal /in/ profile linked from a company site
    // is a named individual, and this module does not collect people.
    profile: [/^\/company\/([^/?#]+)/i, /^\/school\/([^/?#]+)/i, /^\/showcase\/([^/?#]+)/i],
  },
  {
    platform: 'facebook',
    label: 'Facebook',
    hosts: ['facebook.com', 'fb.com', 'fb.me'],
    profile: [/^\/pages\/[^/]+\/([^/?#]+)/i, /^\/profile\.php$/i, /^\/([^/?#]+)\/?$/],
    reject: NEVER_A_PROFILE,
  },
  {
    platform: 'instagram',
    label: 'Instagram',
    hosts: ['instagram.com', 'instagr.am'],
    profile: [/^\/([^/?#]+)\/?$/],
    reject: NEVER_A_PROFILE,
  },
  {
    platform: 'x',
    label: 'X (Twitter)',
    hosts: ['twitter.com', 'x.com'],
    profile: [/^\/([^/?#]+)\/?$/],
    reject: NEVER_A_PROFILE,
  },
  {
    platform: 'youtube',
    label: 'YouTube',
    hosts: ['youtube.com', 'youtu.be'],
    profile: [/^\/(?:c|channel|user)\/([^/?#]+)/i, /^\/(@[^/?#]+)/],
  },
]

const bareHost = (host: string): string => host.replace(/^www\./i, '').toLowerCase()

/**
 * Reads one URL as a social profile, or returns null.
 *
 * Exported because "is this a profile link" is the whole judgement here, and it
 * is worth testing on its own against the share buttons and login walls that
 * make up most social links on a commercial website.
 */
export function readProfileUrl(raw: string): { platform: SocialPlatform; label: string; url: string; handle: string } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  const host = bareHost(u.hostname)
  const spec = PLATFORMS.find((p) => p.hosts.includes(host))
  if (!spec) return null

  const path = u.pathname.replace(/\/+$/, '') || '/'
  if (spec.reject?.test(path)) return null
  if (PLATFORM_SCRIPT.test(path)) return null

  for (const shape of spec.profile) {
    const m = shape.exec(path)
    if (!m) continue
    const handle = (m[1] ?? '').trim()
    // A bare platform homepage carries no handle and identifies nobody.
    if (!handle && path !== '/profile.php') continue
    // Tracking parameters are not part of an identity.
    const clean = `https://${host}${path}`
    return { platform: spec.platform, label: spec.label, url: clean, handle: handle || u.search.replace(/^\?/, '') }
  }
  return null
}

/**
 * Every social profile the given page links to.
 *
 * `html` is UNTRUSTED page source. Nothing here executes it or follows
 * anything; the links are evidence, and the caller decides what to do with
 * them.
 */
export function discoverSocialProfiles(input: {
  html: string
  /** The page the HTML came from, used to resolve relative links and to cite. */
  pageUrl: string
  /** Caps the work and the result. */
  max?: number
}): SocialProfile[] {
  const max = input.max ?? 12
  const base = normalizeUrl(input.pageUrl)
  const found = new Map<string, SocialProfile>()

  const anchors = input.html.matchAll(
    /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi,
  )
  for (const m of anchors) {
    if (found.size >= max) break
    const href = m[1]!.trim()
    let absolute = href
    if (!/^https?:\/\//i.test(href)) {
      if (!base) continue
      try {
        absolute = new URL(href, base).toString()
      } catch {
        continue
      }
    }
    const read = readProfileUrl(absolute)
    if (!read) continue
    if (found.has(read.url)) continue

    const anchorText = m[2]!
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    found.set(read.url, {
      platform: read.platform,
      platformLabel: read.label,
      url: read.url,
      handle: read.handle,
      discoveredOn: input.pageUrl,
      anchorText: anchorText.length > 0 && anchorText.length <= 120 ? anchorText : null,
    })
  }

  return [...found.values()]
}

// ── A SITE THAT RENDERS ITSELF IN THE BROWSER ─────────────────────────────
//
// ultratapsmt.com serves 640 bytes to every visitor: one <div id="root"> and a
// script. There are no anchors to read, so link discovery found nothing and
// the company came back with no social presence at all — while its Facebook
// page sat inside the bundle its own shell loads.
//
// The shell detection and the first-party asset reader now live in
// research/appShell.ts, because the Website Audit needs exactly the same two
// judgements to find a client-rendered site's PRODUCT pages. One
// implementation, so the two engines cannot drift about what a shell is.
// Re-exported here so this module stays the one place the intent engine reads
// profile discovery from.
export { firstPartyAssetUrls, looksLikeAppShell } from '../research/appShell.js'

/**
 * Social profile URLs stated anywhere in a block of text.
 *
 * For asset bytes, where there is no markup to parse. Every candidate still
 * goes through readProfileUrl, so a platform root, a share link, a login page
 * or a platform script is rejected here exactly as it is in an anchor.
 */
export function discoverSocialProfilesInText(input: {
  text: string
  discoveredOn: string
  max?: number
}): SocialProfile[] {
  const max = input.max ?? 12
  const found = new Map<string, SocialProfile>()

  const re = /https?:\/\/(?:www\.)?(?:facebook|fb|instagram|instagr|linkedin|lnkd|twitter|x|youtube|youtu)\.[a-z.]{2,6}\/[A-Za-z0-9._~:@!$&'()*+,;=%/-]{1,120}/gi
  for (const raw of input.text.match(re) ?? []) {
    if (found.size >= max) break
    // Bundles concatenate strings, so a trailing quote or punctuation is
    // common. Trimmed before classification, never after.
    const cleaned = raw.replace(/[,'")\];}>.]+$/, '')
    const read = readProfileUrl(cleaned)
    if (!read || found.has(read.url)) continue
    found.set(read.url, {
      platform: read.platform,
      platformLabel: read.label,
      url: read.url,
      handle: read.handle,
      discoveredOn: input.discoveredOn,
      anchorText: null,
    })
  }
  return [...found.values()]
}
