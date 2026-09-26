import { fetchPageRaw } from '../research/pageFetch.js'
import { normalizeUrl } from '../research/ssrfGuard.js'
import { decode, extractTitle } from '../websiteaudit/htmlStructure.js'

// THE CUSTOMER'S OWN WEBSITE, AS FURNITURE.
//
// WHY THIS EXISTS AT ALL.
//
// The Workbench's job is to say "this is YOUR page, and this is the same page
// done properly". It could never say the first half, because the website audit
// records a product page's FIELDS and nothing about the page it sits on: no
// logo, no navigation, no footer. Image extraction actively discards logos, on
// the entirely correct grounds that a company's logo where its product should
// be is worse than no image. The result was a demonstration wrapped in a site
// name and a breadcrumb — a generic card, which is exactly what a customer
// says when they look at it.
//
// So the shell is captured here, separately and on purpose: the parts of a page
// that make it recognisably somebody's, extracted as DATA.
//
// WHAT IS AND IS NOT TAKEN.
//
// Text, link targets and the logo's image URL. Never markup, never CSS, never
// script. The Workbench renders its own elements from these values, which is
// what keeps the existing promise that no prospect HTML is ever served — and
// it is also why the enhanced tab can keep the same shell while replacing what
// sits inside it. A screenshot could not do that.
//
// Whatever is not found is NAMED. A missing footer is reported as a missing
// footer, because the alternative — quietly substituting our own — is the
// exact failure this module was written to correct.

export interface ShellLink {
  label: string
  /** Absolute, http(s) only. Null when the anchor had no usable target. */
  href: string | null
}

export interface WebsiteShell {
  /** True when at least the header could be read from the live page. */
  captured: boolean
  /** Why nothing was captured, when nothing was. */
  reason: string | null
  /** The page the shell was read from. */
  sourceUrl: string | null
  /** The site's own name, as its title or logo alt states it. */
  siteName: string | null
  host: string | null
  /** The masthead logo, absolute. Null when the header carried no image. */
  logoUrl: string | null
  /** The logo's alt text, which is often the company's legal name. */
  logoAlt: string | null
  /** Primary navigation, in the order the page lists it. */
  nav: ShellLink[]
  /** True when the header carried a search control. */
  hasSearch: boolean
  /** Account, login, cart — the controls on the right of a masthead. */
  utility: ShellLink[]
  footerLinks: ShellLink[]
  /** The copyright line, or the nearest thing the footer has to one. */
  footerText: string | null
  /** Social profiles the page links to, for the footer row. */
  social: Array<{ platform: string; href: string }>
  /**
   * Parts that could not be read, named so the interface can say so.
   * Rendered to the operator verbatim.
   */
  notCaptured: string[]
}

export const EMPTY_SHELL: WebsiteShell = {
  captured: false,
  reason: null,
  sourceUrl: null,
  siteName: null,
  host: null,
  logoUrl: null,
  logoAlt: null,
  nav: [],
  hasSearch: false,
  utility: [],
  footerLinks: [],
  footerText: null,
  social: [],
  notCaptured: [],
}

/**
 * Visible text, with the invisible kind removed first.
 *
 * Stripping tags does NOT remove a <style> or <script> element's CONTENTS —
 * those are text nodes, not markup, so `<style>a{color:red}</style>` survives
 * tag removal as `a{color:red}`. Real sites put both inside headers and
 * footers, and a Squarespace footer read this way produced:
 *
 *   "© 2026 Unicare Ltd - All Rights Reserved #block-yui_3_17_2_1_… {
 *    --stroke-style: none;--stroke-thickness…"
 *
 * — a copyright line with a stylesheet welded to it, which is what the
 * customer would have seen in their own demonstration. So both elements are
 * removed whole before anything else looks at the fragment.
 */
const text = (raw: string): string =>
  decode(
    raw
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()

/** Anchors that are furniture rather than navigation. */
const NOT_NAV = /^(?:skip (?:to|navigation)\b.*|menu|toggle|close|open|back to top|read more|view all)$/i

/**
 * Contact details that sit in a masthead but are not navigation.
 *
 * A phone number and an email address are commonly the first two anchors in a
 * header, and rendering them as menu items produces a navigation bar reading
 * "(02) 8711 3520 | [email protected] | About Us". Two shapes cover it: a
 * label that is mostly digits, and an address — including the bracketed
 * placeholder that email-obfuscation plugins leave behind.
 */
function isContactDetail(label: string): boolean {
  if (/^\[[^\]]+\]$/.test(label)) return true
  if (/[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(label)) return true
  const compact = label.replace(/[\s()+.-]/g, '')
  return compact.length >= 6 && /^\d+$/.test(compact)
}

const UTILITY =
  /\b(log ?in|sign ?in|log ?out|sign ?up|register|my account|account|cart|basket|checkout|wishlist|quote)\b/i

const SOCIAL_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)linkedin\.com$/i, 'LinkedIn'],
  [/(^|\.)facebook\.com$/i, 'Facebook'],
  [/(^|\.)instagram\.com$/i, 'Instagram'],
  [/(^|\.)(twitter|x)\.com$/i, 'X'],
  [/(^|\.)youtube\.com$/i, 'YouTube'],
  [/(^|\.)pinterest\.[a-z.]+$/i, 'Pinterest'],
  [/(^|\.)tiktok\.com$/i, 'TikTok'],
]

/** The region between two markers, or null. Cheap, and enough for furniture. */
function region(html: string, tag: 'header' | 'footer'): string | null {
  const semantic = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html)
  // Accepted when it holds something to render, rather than when it exceeds
  // an arbitrary length: a compact masthead of one logo and one link is a real
  // header, and an empty <header></header> is not.
  if (semantic?.[1] && /<(?:a|img)\b/i.test(semantic[1])) return semantic[1]

  // Older catalogues mark these with a class or an id instead of a tag.
  const byClass = new RegExp(
    `<(?:div|section)\\b[^>]*(?:class|id)\\s*=\\s*["'][^"']*\\b(?:site-)?${tag}\\b[^"']*["'][^>]*>([\\s\\S]{40,20000}?)</(?:div|section)>`,
    'i',
  ).exec(html)
  return byClass?.[1] ?? null
}

/** Every anchor in a region, as label and absolute href. */
function links(fragment: string, base: URL | null, limit: number): ShellLink[] {
  const out: ShellLink[] = []
  const seen = new Set<string>()
  for (const m of fragment.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    if (out.length >= limit) break
    const label = text(m[2]!)
    if (!label || label.length > 40) continue
    if (NOT_NAV.test(label) || isContactDetail(label)) continue

    let href: string | null = null
    const raw = m[1]!.trim()
    if (/^https?:\/\//i.test(raw)) href = raw
    else if (base && !raw.startsWith('#') && !/^(mailto|tel|javascript):/i.test(raw)) {
      try {
        href = new URL(raw, base).toString()
      } catch {
        href = null
      }
    }

    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label, href })
  }
  return out
}

/** The masthead image, absolute, with whatever it says about itself. */
function logo(headerHtml: string, base: URL | null): { url: string | null; alt: string | null } {
  const imgs = [...headerHtml.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0])
  const pick =
    imgs.find((tag) => /(?:class|id|alt|src)\s*=\s*["'][^"']*logo/i.test(tag)) ??
    imgs.find((tag) => !/(icon|sprite|pixel|spacer|blank|search|cart|menu)/i.test(tag)) ??
    null
  if (!pick) return { url: null, alt: null }

  const src =
    /\bsrc\s*=\s*["']([^"']+)["']/i.exec(pick)?.[1] ??
    // Lazy-loaded mastheads keep the real file in a data attribute.
    /\bdata-(?:src|original|lazy-src)\s*=\s*["']([^"']+)["']/i.exec(pick)?.[1] ??
    /\bsrcset\s*=\s*["']([^"'\s,]+)/i.exec(pick)?.[1] ??
    null
  const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(pick)?.[1] ?? null

  let url: string | null = null
  if (src) {
    if (/^https?:\/\//i.test(src)) url = src
    else if (/^data:image\//i.test(src)) url = src
    else if (base) {
      try {
        url = new URL(src, base).toString()
      } catch {
        url = null
      }
    }
  }
  return { url, alt: alt ? decode(alt).trim() || null : null }
}

/** The copyright line, or the longest sentence the footer offers instead. */
function footerLine(fragment: string): string | null {
  const flat = text(fragment)
  // Stops at a CSS brace or a selector marker as well as at a sentence end.
  // Belt and braces beside the <style> strip above: a footer can also carry a
  // style attribute or an inlined rule the element filter never sees, and a
  // copyright line is never the place a "{" legitimately appears.
  const copyright = /(?:©|&copy;|copyright)[^.|{}#]{0,120}/i.exec(flat)?.[0]
  if (copyright) return copyright.replace(/&copy;/gi, '©').trim().slice(0, 140)
  return null
}

/**
 * Reads one page's furniture.
 *
 * `html` is untrusted. Everything returned is a decoded substring of it or a
 * URL resolved from one; nothing is composed and nothing is executed.
 */
export function extractWebsiteShell(html: string, pageUrl: string): WebsiteShell {
  const base = normalizeUrl(pageUrl)
  const host = base?.hostname.replace(/^www\./, '') ?? null
  const notCaptured: string[] = []

  const headerHtml = region(html, 'header')
  const footerHtml = region(html, 'footer')

  if (!headerHtml) notCaptured.push('Header')
  if (!footerHtml) notCaptured.push('Footer')

  const { url: logoUrl, alt: logoAlt } = headerHtml ? logo(headerHtml, base) : { url: null, alt: null }
  if (headerHtml && !logoUrl) notCaptured.push('Logo')

  const headerLinks = headerHtml ? links(headerHtml, base, 24) : []
  const utility = headerLinks.filter((l) => UTILITY.test(l.label)).slice(0, 4)
  const nav = headerLinks.filter((l) => !UTILITY.test(l.label)).slice(0, 8)
  if (headerHtml && nav.length === 0) notCaptured.push('Navigation')

  const hasSearch = headerHtml
    ? /<input\b[^>]*type\s*=\s*["']search["']|role\s*=\s*["']search["']|(?:name|id|class)\s*=\s*["'][^"']*\bsearch\b/i.test(
        headerHtml,
      )
    : false

  const footerLinks = footerHtml ? links(footerHtml, base, 10) : []
  const footerText = footerHtml ? footerLine(footerHtml) : null

  // Social links, from wherever on the page they sit — many sites put them in
  // the header, many in the footer, plenty in both.
  const social: Array<{ platform: string; href: string }> = []
  const seenPlatforms = new Set<string>()
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    if (social.length >= 6) break
    try {
      const u = new URL(m[1]!)
      const hit = SOCIAL_HOSTS.find(([re]) => re.test(u.hostname))
      if (!hit || seenPlatforms.has(hit[1])) continue
      // A share widget is not the company's own account.
      if (/\/(sharer|share|intent|dialog)\b/i.test(u.pathname)) continue
      seenPlatforms.add(hit[1])
      social.push({ platform: hit[1], href: u.toString() })
    } catch {
      /* not a URL we can read */
    }
  }

  const titleSite = extractTitle(html)?.value ?? null
  const siteName =
    logoAlt && logoAlt.length <= 60
      ? logoAlt
      : titleSite
        ? (titleSite.split(/\s+[|–—-]\s+/).pop() ?? titleSite).trim().slice(0, 60) || null
        : null

  return {
    captured: Boolean(headerHtml || footerHtml),
    reason: headerHtml || footerHtml ? null : 'The page carried no recognisable header or footer region.',
    sourceUrl: pageUrl,
    siteName,
    host,
    logoUrl,
    logoAlt,
    nav,
    hasSearch,
    utility,
    footerLinks,
    footerText,
    social,
    notCaptured,
  }
}

/**
 * Fetches the product page and reads its furniture.
 *
 * Failure is a shell that says why, never a shell that looks plausible. The
 * Workbench then states which parts it could not capture rather than drawing
 * something in their place.
 */
export async function sampleWebsiteShell(pageUrl: string): Promise<WebsiteShell> {
  try {
    const res = await fetchPageRaw(pageUrl)
    if (!res.ok || !res.html) {
      return {
        ...EMPTY_SHELL,
        sourceUrl: pageUrl,
        reason: res.reason ?? `The page could not be re-fetched (HTTP ${res.status ?? 'no response'}).`,
        notCaptured: ['Header', 'Navigation', 'Logo', 'Footer'],
      }
    }
    return extractWebsiteShell(res.html, res.finalUrl ?? pageUrl)
  } catch (err) {
    return {
      ...EMPTY_SHELL,
      sourceUrl: pageUrl,
      reason: (err as Error).message,
      notCaptured: ['Header', 'Navigation', 'Logo', 'Footer'],
    }
  }
}
