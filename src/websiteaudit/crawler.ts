import { createHash } from 'node:crypto'
import { fetchPageRaw } from '../research/pageFetch.js'
import {
  extractCategoryObservations,
  extractPageObservations,
  extractProductObservations,
} from './extraction.js'
import { extractRouteUrls, firstPartyAssetUrls, looksLikeAppShell } from '../research/appShell.js'
import { catalogObservations, extractCatalogEntries } from './catalogEvidence.js'
import { extractCanonical, extractLinks, extractProductTileLinks } from './htmlStructure.js'
import { discoverSitemapUrls, type SitemapDiscovery } from './sitemap.js'
import { classifyPage, linkPriority } from './pageClassifier.js'
import { depthOf, hostOf, isDescendantPath, normalizeUrlForDedup, resolveLink, samePath, sameSite } from './urls.js'
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
  /** What the site's own index of itself said, including that it has none. */
  sitemap: SitemapDiscovery
}

/** A sitemap this site published has no sitemap of its own to look for. */
const NO_SITEMAP_LOOKED_FOR: SitemapDiscovery = {
  urls: [],
  sourcesRead: [],
  note: 'No sitemap was looked for, because the start URL could not be read.',
}

interface Frontier {
  url: string
  depth: number
  priority: number
  /**
   * How this URL was discovered — an anchor, the sitemap, a product tile, or
   * the site's own JavaScript bundle.
   *
   * Carried onto the fetched page so every product this audit reports can be
   * traced back to the thing that named it. "We found a product page" and "we
   * found it in the company's own bundle because the site publishes no HTML
   * links" are different claims, and a reader checking the work needs the
   * second one.
   */
  via: string
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
    unreliableCanonicals: 0,
    soft404s: 0,
    httpErrors: 0,
    unreachable: 0,
    totalBytes: 0,
    structuredDataPages: 0,
    catalogEntries: 0,
    assetsRead: [],
    limitsHit: [],
  }

  // Canonicals this site declared on pages whose content differs. Declared
  // here so every exit path can report it.
  const conflictingCanonicals = new Set<string>()

  // First-party assets read because a page turned out to be a client-rendered
  // shell. Bounded for the whole run, not per page: a site of shells must not
  // become a crawl of its own bundles.
  const assetsRead: string[] = []
  const MAX_ASSETS = 3

  const rootHost = hostOf(startUrl)
  if (!rootHost) {
    stats.unreliableCanonicals = conflictingCanonicals.size
    stats.assetsRead = []
    return {
      pages,
      stats,
      homepageReachable: false,
      failureReason: `"${startUrl}" is not a usable URL.`,
      sitemap: NO_SITEMAP_LOOKED_FOR,
    }
  }

  const origin = new URL(startUrl).origin
  const soft404 = await probeSoft404(origin)

  const seenUrls = new Set<string>()
  const seenContent = new Map<string, string>()
  const seenCanonical = new Map<string, string>()
  const frontier: Frontier[] = [{ url: startUrl, depth: 0, priority: 1000, via: 'the start URL' }]

  // ── THE SITE'S OWN INDEX OF ITSELF ──────────────────────────────────────
  //
  // A link-following crawl can only reach what the homepage links to, and on a
  // catalogue site the products are three clicks down behind a grid that is
  // frequently rendered by JavaScript. A sitemap is the company telling us
  // where its pages are, which is both cheaper and more reliable than
  // inferring it — and its absence is a finding in its own right, so the note
  // travels back with the result either way.
  //
  // Sitemap URLs are QUEUED, never trusted: each one is still fetched and
  // classified on its own content. Nothing here decides a URL is a product.
  const sitemap = await discoverSitemapUrls(origin)
  for (const url of sitemap.urls) {
    const key = normalizeUrlForDedup(url)
    if (!key || key === normalizeUrlForDedup(startUrl)) continue
    // Depth 1: the site published it directly, so it is one step from the root
    // however deep its path happens to be. Priority comes from the URL's own
    // shape, plus a bonus for having been listed at all.
    frontier.push({ url, depth: 1, priority: linkPriority(url, '') + 15, via: "the site's own sitemap" })
  }

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
    //
    // THE START URL IS EXEMPT, and that exemption is not a special case — it
    // is the difference between two things this check cannot otherwise tell
    // apart.
    //
    // A site that answers every unknown path with the same body makes the
    // probe's fingerprint equal to its HOMEPAGE's fingerprint. The homepage
    // was then discarded as a soft 404, no observation was recorded, and the
    // run reported "1 page was read and none names a product" — a claim about
    // a catalogue that nothing had examined. One real company's site, a
    // single-response catch-all, produced exactly that: 16,545 bytes of real
    // content fetched, thrown away, and then pronounced on.
    //
    // Whatever else is true, the body a company serves at its own root is the
    // page it published there. It is read. That the site also serves it for
    // unknown paths stays recorded — on the page, as a finding about the site,
    // and in the stats below.
    const isStartUrl = next.depth === 0
    if (soft404.hash && hash === soft404.hash && !isStartUrl) {
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
    const homepageIsAlsoTheNotFoundBody = Boolean(soft404.hash) && hash === soft404.hash && isStartUrl

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

    let canonicalConflict: string | null = null
    const canonical = extractCanonical(res.html)
    if (canonical) {
      const resolved = resolveLink(canonical.value, res.finalUrl ?? next.url)
      const canonKey = resolved ? normalizeUrlForDedup(resolved) : null
      base.canonicalUrl = resolved
      if (canonKey) {
        const canonFirstSeen = seenCanonical.get(canonKey)
        if (canonFirstSeen && canonFirstSeen !== next.url) {
          // A canonical is only honoured when it points at a VARIANT OF THIS
          // SAME PAGE — the same path reached by a different query string,
          // trailing slash or host. That is what canonical is for, and those
          // really are one page.
          //
          // A canonical pointing at a DIFFERENT PATH is a cross-page claim,
          // and a common CMS-template mistake: every category page on a site
          // emitting <link rel="canonical" href="/products">. Honouring it
          // discarded thirteen distinct category pages on one real site, burnt
          // the page budget on them, and produced an audit reporting zero
          // products for a company with a full catalogue.
          //
          // The decisive evidence is already in hand by this point: the
          // content-hash check above passed, which means these pages DIFFER.
          // A declaration that contradicts what was actually observed loses to
          // the observation — and the contradiction is itself a real finding
          // about the site, so it is recorded rather than silently dropped.
          if (samePath(resolved, next.url)) {
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
          conflictingCanonicals.add(canonKey)
          canonicalConflict = `This page declares the canonical URL ${resolved}, which ${canonFirstSeen} also declares, but the two pages carry different content. The canonical is unreliable and was not used to discard this page.`
        }
        seenCanonical.set(canonKey, next.url)
      }
    }

    // ── Classification and extraction ──────────────────────────────────────
    const { pageType, signals } = classifyPage(res.html, res.finalUrl ?? next.url)
    // Where this URL came from, on every page. A product found only because
    // the site's own bundle named it is a different kind of evidence from one
    // linked in the markup, and the difference has to survive to the report.
    signals.unshift(`Discovered via ${next.via}.`)
    // Kept as a finding about the site rather than a reason to discard the
    // page: a root that is byte-identical to an unknown path means this site
    // serves one response for every URL, which is worth reporting and is not
    // evidence that the homepage is empty.
    if (homepageIsAlsoTheNotFoundBody) signals.push(soft404.note)
    if (canonicalConflict) signals.push(canonicalConflict)
    const pageObs = extractPageObservations(res.html, next.url)
    base.wordCount = Number(pageObs.find((o) => o.field === 'page.wordCount')?.value ?? 0)
    if (pageObs.some((o) => o.field === 'page.structuredDataTypes' && o.status === 'observed')) {
      stats.structuredDataPages++
    }

    // ── CATALOGUE EVIDENCE, ON EVERY PAGE ─────────────────────────────────
    //
    // Deliberately NOT gated on pageType. The case that forced this module was
    // a site whose category pages classify correctly and whose products are
    // named only in image alt text: gating on "is this a product page" is the
    // exact mistake that reported zero products for a full catalogue.
    const catalog = extractCatalogEntries(res.html, res.finalUrl ?? next.url)
    stats.catalogEntries += catalog.length

    const observations = [...pageObs, ...catalogObservations(catalog)]
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
      let priority = isTileLink ? 90 : linkPriority(resolved, link.text)

      // DESCENDING BEATS SPREADING SIDEWAYS.
      //
      // On a catalogue every category page links to every other category page,
      // so a breadth-first crawl spends its whole budget on one level and
      // never reaches the detail pages below. A link that goes DEEPER INTO THE
      // PAGE WE ARE ALREADY ON is the one step that can reach a product, so it
      // outranks a sibling at the same level. Nothing is skipped by this — it
      // is an ordering, and the budget is what limits the crawl.
      if (isDescendantPath(next.url, resolved)) priority += 30

      // Once a type's quota is full, stop queuing more of that shape rather
      // than fetching pages whose fields will not be extracted.
      const looksProduct = isTileLink || /\/(products?|item|sku|pd|pdp)\/[^/]+|\/p\/[^/]+/i.test(resolved)
      const looksCategory = /\/(category|categories|collections?|range|shop|catalog(ue)?)\b/i.test(resolved)
      if (productQuotaFull && looksProduct) continue
      if (categoryQuotaFull && looksCategory) continue

      frontier.push({
        url: resolved,
        depth: next.depth + 1,
        priority: priority - depthOf(resolved),
        via: isTileLink ? `a product tile on ${next.url}` : `a link on ${next.url}`,
      })
    }

    // ── A PAGE THAT RENDERS ITSELF IN THE BROWSER ─────────────────────────
    //
    // A client-rendered site serves one empty <div> and a script, so the loop
    // above finds no links and the crawl ends with one page and no products —
    // which is a statement about the rendering, not about the catalogue. One
    // such site publishes several hundred real products; its server HTML
    // mentions none of them.
    //
    // So the routes the application declares are read out of the company's own
    // same-origin bundle and queued as CANDIDATES. Each one is still fetched
    // and classified on its own content, exactly like a URL found in an
    // anchor: nothing here decides that a path is a product. Nothing is
    // executed — the bytes are searched as text.
    if (assetsRead.length < MAX_ASSETS && looksLikeAppShell(res.html)) {
      const pageUrl = res.finalUrl ?? next.url
      for (const assetUrl of firstPartyAssetUrls(res.html, pageUrl, MAX_ASSETS - assetsRead.length)) {
        if (assetsRead.length >= MAX_ASSETS) break
        const asset = await fetchPageRaw(assetUrl, { as: 'asset' })
        stats.totalBytes += asset.bytes
        if (!asset.ok || !asset.html) continue
        assetsRead.push(assetUrl)

        for (const routeUrl of extractRouteUrls(asset.html, pageUrl)) {
          const key = normalizeUrlForDedup(routeUrl)
          if (!key || seenUrls.has(key)) continue
          if (frontier.some((f) => normalizeUrlForDedup(f.url) === key)) continue
          frontier.push({
            url: routeUrl,
            depth: next.depth + 1,
            priority: linkPriority(routeUrl, '') - depthOf(routeUrl),
            via: `the site's own JavaScript (${assetUrl})`,
          })
        }
      }
    }
  }

  if (frontier.length && pages.length >= limits.maxPages) noteLimit('frontier not exhausted')

  stats.unreliableCanonicals = conflictingCanonicals.size
  stats.assetsRead = assetsRead

  return {
    pages,
    stats,
    homepageReachable,
    failureReason: homepageReachable ? null : 'The homepage could not be fetched.',
    sitemap,
  }
}
