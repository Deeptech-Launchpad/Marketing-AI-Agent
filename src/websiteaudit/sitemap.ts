import { fetchPageRaw } from '../research/pageFetch.js'
import { hostOf, normalizeUrlForDedup, sameSite } from './urls.js'

// STAGE 5 — THE SITE'S OWN INDEX OF ITSELF.
//
// A crawl that only follows links can only reach what the homepage links to.
// That is fine on a small brochure site and wrong on a catalogue, where the
// products live three clicks down behind a JavaScript grid and the fifteen-page
// budget is spent on category pages before the crawler ever descends.
//
// A sitemap is the company TELLING US where its pages are, which is both
// cheaper and more reliable than inferring it. It is read as evidence like
// everything else: the URLs are queued, and each one is still fetched and
// classified on its own content. Nothing here decides that a URL is a product.
//
// WHAT IT WILL NOT DO
//
//   · It does not fabricate a sitemap location. Only /robots.txt's own
//     Sitemap: directives and the two conventional paths are tried, and a site
//     with none is reported as having none.
//   · It does not follow a sitemap off-site. A sitemap pointing at another
//     host is a real thing — usually a CDN or a hijacked file — and its URLs
//     are not this company's pages.
//   · It is bounded: at most MAX_FETCHES requests and MAX_URLS URLs, so a
//     150,000-URL retailer index cannot turn a bounded audit into a crawl of
//     the internet.

/** Requests this whole discovery may spend, including robots.txt. */
const MAX_FETCHES = 6
/** URLs carried back to the crawler. The page budget is far smaller anyway. */
const MAX_URLS = 400
/** Child sitemaps followed from an index. */
const MAX_CHILDREN = 3

export interface SitemapDiscovery {
  /** Same-site page URLs the sitemap listed, de-duplicated, in file order. */
  urls: string[]
  /** The sitemap files actually read. */
  sourcesRead: string[]
  /**
   * What happened, in words the audit can print. Never null: "this site
   * publishes no sitemap" is a finding, and a silent empty list is not.
   */
  note: string
}

/** <loc>https://…</loc>, the one element both sitemap formats share. */
function extractLocs(xml: string): string[] {
  const out: string[] = []
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const raw = m[1]!
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g, '&')
      .trim()
    if (/^https?:\/\//i.test(raw)) out.push(raw)
    if (out.length >= 5000) break
  }
  return out
}

/** True when the document is an index of further sitemaps rather than of pages. */
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml)
}

/** Sitemap: lines in robots.txt, which is where a site states a non-standard location. */
function sitemapsFromRobots(txt: string): string[] {
  return txt
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1])
    .filter((u): u is string => Boolean(u) && /^https?:\/\//i.test(u!))
}

/**
 * Reads whatever index of itself the site publishes.
 *
 * `origin` is the audited site's own origin. Every URL returned is checked
 * against it, so a sitemap listing someone else's pages contributes nothing.
 */
export async function discoverSitemapUrls(origin: string): Promise<SitemapDiscovery> {
  const rootHost = hostOf(origin)
  if (!rootHost) return { urls: [], sourcesRead: [], note: 'No usable origin, so no sitemap was looked for.' }

  let budget = MAX_FETCHES
  const sourcesRead: string[] = []
  const urls: string[] = []
  const seen = new Set<string>()
  const failures: string[] = []

  const take = (found: string[]) => {
    for (const u of found) {
      if (urls.length >= MAX_URLS) return
      if (!sameSite(hostOf(u), rootHost)) continue
      const key = normalizeUrlForDedup(u)
      if (!key || seen.has(key)) continue
      seen.add(key)
      urls.push(u)
    }
  }

  // ── Where does the site say its sitemap is? ─────────────────────────────
  const candidates: string[] = []
  budget--
  const robots = await fetchPageRaw(`${origin}/robots.txt`, { as: 'xml' })
  const robotsBody = robots.ok ? robots.html : ''
  if (robotsBody) candidates.push(...sitemapsFromRobots(robotsBody).filter((u) => sameSite(hostOf(u), rootHost)))

  // The two conventional paths, tried only if robots.txt named nothing new.
  for (const path of ['/sitemap.xml', '/sitemap_index.xml']) {
    const url = `${origin}${path}`
    if (!candidates.some((c) => normalizeUrlForDedup(c) === normalizeUrlForDedup(url))) candidates.push(url)
  }

  // ── Read them, following one level of index ─────────────────────────────
  let children = 0
  for (const candidate of candidates) {
    if (budget <= 0 || urls.length >= MAX_URLS) break
    budget--
    const res = await fetchPageRaw(candidate, { as: 'xml' })
    if (!res.ok || !res.html.trim()) {
      // A bare "HTTP 200" reads like a contradiction next to "could not be
      // read". The common case is a site answering /sitemap.xml with its HTML
      // 404 template, and naming the content type says so.
      const why = !res.ok
        ? (res.reason ?? `HTTP ${res.status ?? 'no response'}`)
        : `HTTP ${res.status} but served ${res.contentType || 'no content type'} rather than XML`
      failures.push(`${candidate} (${why})`)
      continue
    }
    if (!/<(urlset|sitemapindex)\b/i.test(res.html)) {
      // A site that serves its 404 page at /sitemap.xml. Not a sitemap.
      failures.push(`${candidate} (served a document that is not a sitemap)`)
      continue
    }
    sourcesRead.push(candidate)

    if (isSitemapIndex(res.html)) {
      for (const child of extractLocs(res.html)) {
        if (budget <= 0 || children >= MAX_CHILDREN || urls.length >= MAX_URLS) break
        if (!sameSite(hostOf(child), rootHost)) continue
        children++
        budget--
        const sub = await fetchPageRaw(child, { as: 'xml' })
        if (!sub.ok || !/<urlset\b/i.test(sub.html)) continue
        sourcesRead.push(child)
        take(extractLocs(sub.html))
      }
    } else {
      take(extractLocs(res.html))
    }
  }

  if (sourcesRead.length === 0) {
    return {
      urls: [],
      sourcesRead: [],
      note:
        `This site publishes no readable sitemap. Tried: ${failures.join('; ') || 'the conventional locations'}.` +
        ' A sitemap is how a site tells a search or answer engine which pages exist, so its absence is itself a finding.',
    }
  }

  return {
    urls,
    sourcesRead,
    note:
      `Read ${sourcesRead.length} sitemap file(s) and took ${urls.length} same-site URL(s) from them` +
      (urls.length >= MAX_URLS ? `, capped at ${MAX_URLS}.` : '.'),
  }
}
