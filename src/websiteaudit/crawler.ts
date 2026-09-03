import { createHash } from 'node:crypto'
import { fetchPageRaw } from '../research/pageFetch.js'
import {
  extractCategoryObservations,
  extractPageObservations,
  extractProductObservations,
} from './extraction.js'
import { extractCanonical, extractLinks, extractProductTileLinks } from './htmlStructure.js'
import { classifyPage, linkPriority } from './pageClassifier.js'
import { depthOf, hostOf, normalizeUrlForDedup, resolveLink, sameSite } from './urls.js'
import type { CrawlStats, FetchOutcome, PageRecord, PageType } from './types.js'

// STAGE 5 — the bounded crawl.
//
// Every network request goes through fetchPageRaw, which is the SAME transport
// the rest of the service uses: per-hop SSRF revalidation, redirect cap, request
// timeout, streamed byte cap. There is no second HTTP client here, and adding
// one would mean maintaining those four protections twice.
//
// The crawl is small and steered. It is not a site mirror: a page budget, a
// depth limit, a byte ceiling and per-type quotas all bind, and whichever one
// binds first is recorded by name so a thin result can be read correctly.
//
// "Do not interpret HTTP 200 as proof that a page is valid" is enforced three
// ways: a soft-404 fingerprint probe, content-hash duplicate detection, and
// canonical-URL duplicate detection.

export interface CrawlLimits {
  maxPages: number
  maxProductPages: number
  maxCategoryPages: number
  maxBytes: number
  maxDepth: number
}

export interface CrawlResult {
  pages: PageRecord[]
  stats: CrawlStats
  homepageReachable: boolean
  failureReason: string | null
}

interface Frontier {
  url: string
  depth: number
  priority: number
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * A path no real site serves, used to learn what this site does with an unknown
 * URL. Fixed rather than random so a crawl is reproducible and so the probe
 * itself is cacheable and obvious in logs.
 */
const SOFT_404_PROBE_PATH = '/marketing-agent-audit-probe-404-do-not-index'

/**
 * Learns the site's not-found fingerprint.
 *
 * Plenty of sites answer 200 with a "page not found" template, or with the
 * homepage, for any unknown path. Without this, such a site looks like an
 * infinite supply of valid pages and the whole page budget is spent on copies
 * of one template. Costs exactly one request.
 */
async function probeSoft404(origin: string): Promise<{ hash: string | null; note: string }> {
  const r = await fetchPageRaw(`${origin}${SOFT_404_PROBE_PATH}`)
  if (!r.ok || !r.html) {
    return { hash: null, note: `Unknown paths return HTTP ${r.status ?? 'no response'} — normal 404 behaviour.` }
  }
  return {
    hash: sha(r.html),
    note: `Unknown paths return HTTP ${r.status} with a page body, so this site soft-404s; that body's fingerprint is used to discard copies of it.`,
  }
}

export async function crawlSite(startUrl: string, limits: CrawlLimits): Promise<CrawlResult> {
  const pages: PageRecord[] = []
  const stats: CrawlStats = {
    pagesFetched: 0,
    pagesSkipped: 0,
    productPages: 0,
    categoryPages: 0,
    otherPages: 0,
    duplicates: 0,
    canonicalDuplicates: 0,
    soft404s: 0,
    httpErrors: 0,
    unreachable: 0,
    totalBytes: 0,
    structuredDataPages: 0,
    limitsHit: [],
  }

  const rootHost = hostOf(startUrl)
  if (!rootHost) {
    return { pages, stats, homepageReachable: false, failureReason: `"${startUrl}" is not a usable URL.` }
  }

  const origin = new URL(startUrl).origin
  const soft404 = await probeSoft404(origin)

  const seenUrls = new Set<string>()
  const seenContent = new Map<string, string>()
  const seenCanonical = new Map<string, string>()
  const frontier: Frontier[] = [{ url: startUrl, depth: 0, priority: 1000 }]

  const noteLimit = (name: string) => {
    if (!stats.limitsHit.includes(name)) stats.limitsHit.push(name)
  }

  let homepageReachable = false

  while (frontier.length) {
    if (pages.length >= limits.maxPages) {
      noteLimit(`maxPages (${limits.maxPages})`)
      break
    }
    if (stats.totalBytes >= limits.maxBytes) {
      noteLimit(`maxBytes (${limits.maxBytes})`)
      break
    }

    // Highest priority first, shallowest as the tie-break, so the crawl reaches
    // the catalogue before it reaches the returns policy.
    frontier.sort((a, b) => b.priority - a.priority || a.depth - b.depth)
    const next = frontier.shift()!

    const key = normalizeUrlForDedup(next.url)
    if (!key || seenUrls.has(key)) {
      stats.pagesSkipped++
      continue
    }
    seenUrls.add(key)

    const started = Date.now()
    const res = await fetchPageRaw(next.url)
    stats.totalBytes += res.bytes

    const isHome = next.depth === 0
    if (isHome && res.ok) homepageReachable = true

    const base: Omit<PageRecord, 'outcome' | 'pageType' | 'typeSignals' | 'observations'> = {
      requestedUrl: next.url,
      finalUrl: res.finalUrl,
      httpStatus: res.status,
      contentType: res.contentType,
      depth: next.depth,
      bytes: res.bytes,
      wordCount: 0,
      contentHash: null,
      canonicalUrl: null,
      duplicateOfUrl: null,
      redirectChain: res.redirectChain,
      truncated: res.truncated,
      failureReason: res.reason,
      fetchedAt: new Date(),
      durationMs: Date.now() - started,
    }

    // ── Transport-level outcomes, recorded as evidence rather than dropped ──
    if (!res.ok) {
      const outcome: FetchOutcome =
        res.status !== null
          ? 'http_error'
          : /too long to respond|timed? ?out/i.test(res.reason ?? '')
            ? 'timeout'
            : /blocked|private|internal|not permitted/i.test(res.reason ?? '')
              ? 'blocked'
              : 'unreachable'
      if (outcome === 'http_error') stats.httpErrors++
      else stats.unreachable++
      pages.push({ ...base, outcome, pageType: 'unknown', typeSignals: [], observations: [] })
      continue
    }

    if (!res.html) {
      // A 2xx with no HTML body is a non-HTML document — a PDF datasheet, most
      // often. Recorded as evidence that the link exists and what type it is.
      pages.push({ ...base, outcome: 'non_html', pageType: 'unknown', typeSignals: [], observations: [] })
      continue
    }

    stats.pagesFetched++
    const hash = sha(res.html)
    base.contentHash = hash

    // ── "200 is not proof the page is valid" ───────────────────────────────
    if (soft404.hash && hash === soft404.hash) {
      stats.soft404s++
      pages.push({
        ...base,
        outcome: 'soft_404',
        pageType: 'unknown',
        typeSignals: [soft404.note],
        observations: [],
      })
      continue
    }

    const firstSeen = seenContent.get(hash)
    if (firstSeen) {
      stats.duplicates++
      pages.push({
        ...base,
        outcome: 'duplicate',
        pageType: 'unknown',
        typeSignals: [`Byte-identical to ${firstSeen}.`],
        duplicateOfUrl: firstSeen,
        observations: [],
      })
      continue
    }
    seenContent.set(hash, next.url)

    const canonical = extractCanonical(res.html)
    if (canonical) {
      const resolved = resolveLink(canonical.value, res.finalUrl ?? next.url)
      const canonKey = resolved ? normalizeUrlForDedup(resolved) : null
      base.canonicalUrl = resolved
      if (canonKey) {
        const canonFirstSeen = seenCanonical.get(canonKey)
        if (canonFirstSeen && canonFirstSeen !== next.url) {
          stats.canonicalDuplicates++
          pages.push({
            ...base,
            outcome: 'duplicate',
            pageType: 'unknown',
            typeSignals: [`Declares the same canonical URL as ${canonFirstSeen}: ${resolved}`],
            duplicateOfUrl: canonFirstSeen,
            observations: [],
          })
          continue
        }
        seenCanonical.set(canonKey, next.url)
      }
    }

    // ── Classification and extraction ──────────────────────────────────────
    const { pageType, signals } = classifyPage(res.html, res.finalUrl ?? next.url)
    const pageObs = extractPageObservations(res.html, next.url)
    base.wordCount = Number(pageObs.find((o) => o.field === 'page.wordCount')?.value ?? 0)
    if (pageObs.some((o) => o.field === 'page.structuredDataTypes' && o.status === 'observed')) {
      stats.structuredDataPages++
    }

    const observations = [...pageObs]
    let effectiveType: PageType = pageType

    if (pageType === 'product') {
      if (stats.productPages >= limits.maxProductPages) {
        noteLimit(`maxProductPages (${limits.maxProductPages})`)
        stats.pagesSkipped++
      } else {
        stats.productPages++
        observations.push(...extractProductObservations(res.html, next.url))
      }
    } else if (pageType === 'category' || pageType === 'listing' || pageType === 'search') {
      if (stats.categoryPages >= limits.maxCategoryPages) {
        noteLimit(`maxCategoryPages (${limits.maxCategoryPages})`)
        stats.pagesSkipped++
      } else {
        stats.categoryPages++
        observations.push(...extractCategoryObservations(res.html, next.url))
      }
    } else {
      stats.otherPages++
    }

    pages.push({ ...base, outcome: 'fetched', pageType: effectiveType, typeSignals: signals, observations })

    // ── Frontier expansion ─────────────────────────────────────────────────
    if (next.depth >= limits.maxDepth) {
      noteLimit(`maxDepth (${limits.maxDepth})`)
      continue
    }

    const productQuotaFull = stats.productPages >= limits.maxProductPages
    const categoryQuotaFull = stats.categoryPages >= limits.maxCategoryPages

    // Links taken from the listing's OWN STRUCTURE — the anchors inside product
    // tiles — rather than from URL shape.
    //
    // Without this the crawler cannot reach products on a site whose product
    // URLs are bare slugs. 1stayd.com is the case that forced it: 25 pages were
    // spent on depth-1 category pages because /foaming-carpet-cleaner-24x18-ozcs
    // is indistinguishable from any other URL by pattern, yet it is plainly a
    // product once you notice it is the anchor inside a product tile.
    const tileLinks = new Set(
      extractProductTileLinks(res.html)
        .map((href) => resolveLink(href, res.finalUrl ?? next.url))
        .filter((u): u is string => Boolean(u)),
    )

    for (const link of extractLinks(res.html)) {
      const resolved = resolveLink(link.href, res.finalUrl ?? next.url)
      if (!resolved) continue
      if (!sameSite(hostOf(resolved), rootHost)) continue

      const linkKey = normalizeUrlForDedup(resolved)
      if (!linkKey || seenUrls.has(linkKey)) continue
      if (frontier.some((f) => normalizeUrlForDedup(f.url) === linkKey)) continue

      const isTileLink = tileLinks.has(resolved)
      // A tile anchor is the strongest available evidence that a link leads to
      // a product, so it outranks every URL-shape heuristic.
      const priority = isTileLink ? 90 : linkPriority(resolved, link.text)

      // Once a type's quota is full, stop queuing more of that shape rather
      // than fetching pages whose fields will not be extracted.
      const looksProduct = isTileLink || /\/(products?|item|sku|pd|pdp)\/[^/]+|\/p\/[^/]+/i.test(resolved)
      const looksCategory = /\/(category|categories|collections?|range|shop|catalog(ue)?)\b/i.test(resolved)
      if (productQuotaFull && looksProduct) continue
      if (categoryQuotaFull && looksCategory) continue

      frontier.push({ url: resolved, depth: next.depth + 1, priority: priority - depthOf(resolved) })
    }
  }

  if (frontier.length && pages.length >= limits.maxPages) noteLimit('frontier not exhausted')

  return {
    pages,
    stats,
    homepageReachable,
    failureReason: homepageReachable ? null : 'The homepage could not be fetched.',
  }
}
