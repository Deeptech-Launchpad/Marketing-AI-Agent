import { registrableDomain } from '../../enrichment/siteIdentity.js'
import { nonProductPath } from '../../prospects/productPath.js'

// THE PRODUCT PAGE AN EMAIL MAY LINK TO (2026-09-28).
//
// Versions 1, 2 and 3 name the product that was checked and, since Sales
// asked, link its page. That link is the genuine individual product page
// Prospects analysed for THIS company — a product is only "analysed" once
// Prospects' genuine-product check accepted the page, so it is never a
// category, listing, search page or homepage — and only when it is on this
// company's own website domain and is not its homepage. Anything else gives
// null, and the email then carries no product page line at all.

/** Sections that hold articles, posts or listings — never one product's own page. */
const NOT_A_PRODUCT_SECTION =
  /^(news|blog|blogs|article|articles|press|press-releases|pressroom|newsroom|stories|story|events?|insights|case-studies|case-study|posts?|tags?|category|categories|search|resources|media)$/i
/** A section index: the page that lists products rather than being one. */
const LISTING_ROOT = /^(products?|shop|store|catalog|catalogue|collections?|brands?|range|ranges|items?)$/i

/**
 * Whether an address is shaped like one product's own page rather than an
 * article, a post, a search or a listing. A second line of defence behind
 * Prospects' own check: a dated news post ("/2024/09/23/vio3-…-at-mater-dei-
 * hospital/") once came through as a "product page", and an email must not
 * call an article the product page that was checked.
 */
export function looksLikeProductPageAddress(u: URL): boolean {
  const segments = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase())
  if (segments.length === 0) return false // the homepage
  // Prospects' own rule: recalls, contests, newsrooms, press releases, files…
  if (nonProductPath(u.toString())) return false
  // A dated press-release slug ("2026-09-08-Company-to-Present-at-…").
  if (segments.some((s) => /^(19|20)\d{2}-\d{2}-\d{2}-/.test(s))) return false
  if (/\/(19|20)\d{2}\/(0?[1-9]|1[0-2])(\/|$)/.test(u.pathname)) return false // a dated post
  if (segments.some((s) => NOT_A_PRODUCT_SECTION.test(s))) return false
  if (LISTING_ROOT.test(segments[segments.length - 1]!)) return false
  if (['q', 's', 'search', 'query', 'keyword', 'keywords'].some((k) => u.searchParams.has(k))) return false
  return true
}

export function verifiedProductPageUrl(product: { url: string | null } | null, companyDomain: string | null): string | null {
  if (!product?.url || !companyDomain) return null
  let u: URL
  try {
    u = new URL(product.url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!looksLikeProductPageAddress(u)) return null
  let companyHost: string
  try {
    const d = companyDomain.trim()
    companyHost = new URL(/^https?:\/\//i.test(d) ? d : `https://${d}`).hostname
  } catch {
    return null
  }
  const own = (h: string) => registrableDomain(h.toLowerCase().replace(/^www\./, ''))
  return own(u.hostname) === own(companyHost) ? u.toString() : null
}
