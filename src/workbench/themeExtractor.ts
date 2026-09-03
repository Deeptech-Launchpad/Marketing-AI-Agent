import { fetchPageRaw } from '../research/pageFetch.js'
import { NEUTRAL_THEME, type ThemeProfile } from './types.js'

// TASK #981 — sampling the prospect's visual style, safely.
//
// The requirement is that the Workbench "should replicate the client's existing
// UX design". What is built here is a STYLED APPROXIMATION, and the page says
// so — because an actual replica would mean serving the prospect's markup,
// stylesheets and scripts from our origin, which is the one thing that turns a
// sales demo into a security incident.
//
// So nothing is copied. A small set of TOKENS is read out of their page,
// validated against strict formats, and injected into our own template as CSS
// custom properties. The output of this module is at most a handful of hex
// colours, a font-family string built from an allowlist, and one image URL.
//
// Every value that fails validation is dropped in favour of a neutral default.
// A page that supplies no usable token yields the neutral theme, and the
// Workbench still works.

/** Only these families are ever emitted. Anything else falls back. */
const FONT_ALLOWLIST = [
  'arial',
  'helvetica',
  'helvetica neue',
  'georgia',
  'times new roman',
  'garamond',
  'verdana',
  'tahoma',
  'trebuchet ms',
  'courier new',
  'system-ui',
  'segoe ui',
  'roboto',
  'open sans',
  'lato',
  'montserrat',
  'source sans pro',
  'raleway',
  'poppins',
  'nunito',
  'inter',
  'work sans',
  'noto sans',
  'pt sans',
  'oswald',
  'merriweather',
  'playfair display',
  'ubuntu',
  'rubik',
  'karla',
  'mulish',
  'manrope',
]

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** A colour is emitted only if it is a literal hex value. Nothing else. */
export function safeColor(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  return HEX.test(v) ? v : null
}

/**
 * Builds a font stack from allowlisted families only.
 *
 * A `font-family` declaration is attacker-controlled text that ends up inside
 * a CSS property. Rather than escaping it, families are matched against a
 * fixed list and anything unrecognised is discarded — so no character from the
 * prospect's page ever reaches the stylesheet.
 */
export function safeFontStack(raw: string | null | undefined): string | null {
  if (!raw) return null
  const families = raw
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter((f) => FONT_ALLOWLIST.includes(f))
  if (!families.length) return null
  const quoted = families.slice(0, 2).map((f) => (f.includes(' ') ? `'${f}'` : f))
  return `${quoted.join(', ')}, sans-serif`
}

/** Absolute http(s) image URLs only; no data:, no javascript:, no relative. */
export function safeImageUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!/\.(png|jpe?g|gif|svg|webp|avif)(\?|#|$)/i.test(u.pathname + u.search)) return null
    return u.toString()
  } catch {
    return null
  }
}

/** Perceived brightness, used to keep text readable against a sampled colour. */
function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6)
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

/** Rejects colours too close to white or black to work as a brand accent. */
function usableAccent(hex: string | null): string | null {
  if (!hex) return null
  const l = luminance(hex)
  return l > 0.08 && l < 0.85 ? hex : null
}

function firstMatch(html: string, re: RegExp, group = 1): string | null {
  const m = html.match(re)
  return m?.[group] ?? null
}

/** Reads tokens out of already-fetched markup. Pure, so it is testable. */
export function extractTheme(html: string, pageUrl: string): ThemeProfile {
  const themeColor = usableAccent(safeColor(firstMatch(html, /<meta\b[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)))

  // CSS custom properties are where modern storefronts keep their palette.
  const customProps = [...html.matchAll(/--[\w-]*(?:primary|brand|accent|main)[\w-]*\s*:\s*(#[0-9a-fA-F]{3,8})/g)]
    .map((m) => usableAccent(safeColor(m[1])))
    .filter((c): c is string => Boolean(c))

  // Otherwise, the most repeated hex in the markup is usually the brand colour.
  const counts = new Map<string, number>()
  for (const m of html.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const c = usableAccent(safeColor(m[0]))
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const commonest = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)

  const palette = [themeColor, ...customProps, ...commonest].filter((c): c is string => Boolean(c))
  const primary = palette[0] ?? NEUTRAL_THEME.primary
  const accent = palette.find((c) => c !== primary) ?? NEUTRAL_THEME.accent

  const bodyFont =
    safeFontStack(firstMatch(html, /body\s*\{[^}]*font-family\s*:\s*([^;}]+)/i)) ??
    safeFontStack(firstMatch(html, /font-family\s*:\s*([^;}]+)/i)) ??
    safeFontStack(firstMatch(html, /fonts\.googleapis\.com\/css2?\?family=([A-Za-z+]+)/i)?.replace(/\+/g, ' ')) ??
    NEUTRAL_THEME.fontFamily

  const logo =
    safeImageUrl(firstMatch(html, /<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i), pageUrl) ??
    safeImageUrl(firstMatch(html, /<img\b[^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i), pageUrl) ??
    safeImageUrl(firstMatch(html, /<img\b[^>]*src=["']([^"']*logo[^"']*)["']/i), pageUrl)

  // Layout family is an enumerated label, never markup. It only selects which
  // of OUR pre-written card treatments to use.
  const layoutFamily = /product-details-page|item-box|product-item/i.test(html)
    ? 'storefront-grid'
    : /woocommerce|shopify|magento/i.test(html)
      ? 'platform-storefront'
      : 'generic'

  const radius = firstMatch(html, /border-radius\s*:\s*(\d{1,2})px/i)
  const safeRadius = radius && Number(radius) <= 24 ? `${radius}px` : NEUTRAL_THEME.radius

  return {
    source: 'live_sample',
    reason: null,
    primary,
    accent,
    ink: NEUTRAL_THEME.ink,
    surface: NEUTRAL_THEME.surface,
    muted: NEUTRAL_THEME.muted,
    fontFamily: bodyFont,
    headingFamily: bodyFont,
    logoUrl: logo,
    radius: safeRadius,
    layoutFamily,
  }
}

/**
 * Samples the live page for styling only.
 *
 * Deliberately bounded and deliberately optional: a customer opening the
 * Workbench must never wait on a website. This runs once at BUILD time, and a
 * failure produces the neutral theme with the reason recorded rather than an
 * error.
 */
export async function sampleTheme(pageUrl: string): Promise<ThemeProfile> {
  try {
    const res = await fetchPageRaw(pageUrl)
    if (!res.ok || !res.html) {
      return {
        ...NEUTRAL_THEME,
        reason: res.reason ?? 'The page could not be re-fetched for styling.',
      }
    }
    return extractTheme(res.html, res.finalUrl ?? pageUrl)
  } catch (err) {
    return { ...NEUTRAL_THEME, reason: (err as Error).message }
  }
}
