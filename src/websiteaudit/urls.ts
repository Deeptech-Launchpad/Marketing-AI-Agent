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
