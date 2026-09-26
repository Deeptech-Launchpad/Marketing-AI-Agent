// STAGE 5 — URL identity.
//
// Two URLs that fetch the same page must compare equal, or a bounded crawl
// spends its whole page budget re-fetching the homepage with different tracking
// parameters. This is deliberately conservative: it removes things that
// provably do not change the response (fragments, tracking tags, a default
// port) and leaves everything else alone, because ?page=2 and ?colour=red are
// different pages and collapsing them would lose real evidence.

/** Query parameters that identify a referrer, never the content. */
const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_ga|ref|referrer|source|campaign|yclid|igshid)$/i

export function normalizeUrlForDedup(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  u.hash = ''
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = ''

  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k))
  // Sorted so ?a=1&b=2 and ?b=2&a=1 are one URL.
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  u.search = kept.length ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : ''

  // A trailing slash almost never changes the response, except at the root.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '')

  // The scheme is dropped from the key: http:// and https:// on one host are
  // the same page in practice, and sites redirect between them constantly.
  return `${u.hostname}${u.pathname}${u.search}`
}

/** Resolves a possibly-relative href against the page it was found on. */
export function resolveLink(href: string, baseUrl: string): string | null {
  try {
    const u = new URL(href, baseUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * Same site, allowing subdomains in either direction.
 *
 * shop.acme.com and acme.com are one company's catalogue, and refusing to
 * follow between them would miss the products on most distributor sites.
 */
export function sameSite(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

export function depthOf(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length
  } catch {
    return 0
  }
}

/**
 * Whether a canonical URL points at a variant of the SAME page.
 *
 * Canonical exists to collapse `?utm=`, trailing slashes, `www.` and http/https
 * into one address. Those all share a path. A canonical naming a DIFFERENT path
 * is making a claim about a different page — usually because a CMS template
 * hard-codes one value across a whole section — and that claim loses to the
 * observed fact that the two pages carry different content.
 */
export function samePath(canonical: string | null, pageUrl: string): boolean {
  if (!canonical) return false
  try {
    const a = new URL(canonical)
    const b = new URL(pageUrl)
    const norm = (u: URL) => u.pathname.replace(/\/+$/, '').toLowerCase() || '/'
    return norm(a) === norm(b)
  } catch {
    return false
  }
}

/**
 * Is `child` a strictly deeper path on the same host as `parent`?
 *
 * Used to steer a bounded crawl DOWN rather than sideways. On a catalogue
 * every category page links to every other category page, so a breadth-first
 * crawl exhausts its page budget on one level and never reaches the detail
 * pages beneath — which is how a site with a full catalogue was audited as
 * having no products. Descending is the only move that can reach a product.
 *
 * Ordering only. Nothing is excluded on the strength of this.
 */
export function isDescendantPath(parent: string, child: string): boolean {
  try {
    const a = new URL(parent)
    const b = new URL(child)
    if (a.hostname.replace(/^www\./i, '').toLowerCase() !== b.hostname.replace(/^www\./i, '').toLowerCase()) {
      return false
    }
    const seg = (u: URL) => u.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase())
    const pa = seg(a)
    const pb = seg(b)
    if (pb.length <= pa.length) return false
    return pa.every((s, i) => pb[i] === s)
  } catch {
    return false
  }
}
