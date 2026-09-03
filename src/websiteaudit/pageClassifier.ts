import {
  countProductTiles,
  extractJsonLd,
  extractLinks,
  hasType,
  jsonLdNodes,
  listingControlSignals,
  productDetailSignals,
} from './htmlStructure.js'
import type { PageType } from './types.js'

// STAGE 5 — what KIND of page is this?
//
// "Do not rely only on URL naming" is the requirement, and it is a real one:
// /products/about-us is a company page, and plenty of shops serve products from
// /p/ or from a bare slug with no hint at all. So every signal is scored, the
// winner needs a declaration or corroboration rather than a URL alone, and the
// signals that fired are recorded alongside the verdict so the call can be
// checked without re-fetching.
//
// This classifies. It does NOT judge: "this is a product page" is an
// observation, and whether the page is any good is Stage 6's question.

export interface Classification {
  pageType: PageType
  /** Every signal that fired, as citable text. */
  signals: string[]
}

interface Scored {
  type: PageType
  score: number
  signal: string
}

/** URL shapes, worth something but never enough on their own. */
const URL_PATTERNS: Array<{ re: RegExp; type: PageType; label: string }> = [
  { re: /\/(products?|item|sku|pd|pdp)\/[^/]+/i, type: 'product', label: 'URL contains a /product/<slug> path' },
  { re: /\/p\/[^/]+/i, type: 'product', label: 'URL contains a /p/<slug> path' },
  { re: /\/(category|categories|collections?|range|shop|catalog(ue)?|c)\//i, type: 'category', label: 'URL contains a category path' },
  { re: /[?&](page|p|start|offset)=\d+/i, type: 'listing', label: 'URL carries a pagination parameter' },
  { re: /\/search\b|[?&](q|query|keyword|search)=/i, type: 'search', label: 'URL is a search query' },
  { re: /\/(datasheet|data-sheet|spec|specification|technical)/i, type: 'specification', label: 'URL names a specification page' },
  { re: /\/(about|contact|company|news|blog|careers|team|privacy|terms|delivery|returns)\b/i, type: 'company', label: 'URL names a company/information page' },
]

export function classifyPage(html: string, url: string): Classification {
  const scored: Scored[] = []
  const signals: string[] = []

  // ── Declarations. A site stating its own page type outranks everything. ──
  const nodes = jsonLdNodes(extractJsonLd(html))

  for (const { node, path } of nodes) {
    if (hasType(node, 'Product', 'IndividualProduct', 'ProductModel')) {
      scored.push({ type: 'product', score: 100, signal: `${path} declares @type Product` })
    }
    if (hasType(node, 'ItemList', 'CollectionPage', 'OfferCatalog')) {
      scored.push({ type: 'category', score: 90, signal: `${path} declares @type ${String(node['@type'])}` })
    }
    if (hasType(node, 'SearchResultsPage')) {
      scored.push({ type: 'search', score: 90, signal: `${path} declares @type SearchResultsPage` })
    }
    if (hasType(node, 'AboutPage', 'ContactPage', 'Organization', 'BlogPosting', 'Article')) {
      scored.push({ type: 'company', score: 60, signal: `${path} declares @type ${String(node['@type'])}` })
    }
  }

  if (/itemtype\s*=\s*["']https?:\/\/schema\.org\/Product["']/i.test(html)) {
    scored.push({ type: 'product', score: 85, signal: 'Microdata declares itemtype schema.org/Product' })
  }

  const ogType = html.match(/<meta\b[^>]*property\s*=\s*["']og:type["'][^>]*content\s*=\s*["']([^"']+)["']/i)
  if (ogType?.[1]) {
    const v = ogType[1].toLowerCase()
    if (v.includes('product')) scored.push({ type: 'product', score: 70, signal: `og:type is "${ogType[1]}"` })
  }

  // ── Behavioural markup. A buy button is a strong product tell. ───────────
  if (/\b(add[-_\s]?to[-_\s]?(cart|basket|bag|quote)|addtocart)\b/i.test(html)) {
    scored.push({ type: 'product', score: 45, signal: 'Page contains an add-to-cart/quote control' })
  }
  if (/name\s*=\s*["'](sku|product[-_]?id|variant[-_]?id)["']/i.test(html)) {
    scored.push({ type: 'product', score: 35, signal: 'A form field names a SKU or product id' })
  }

  // ── Structural shape, independent of URL naming. ────────────────────────
  //
  // This is the signal that matters on real distributor sites. 1stayd.com is
  // nopCommerce with bare-slug URLs and no JSON-LD at all: its category pages
  // are indistinguishable from any other page by URL, and every signal above
  // this point scores zero. What it does have is twelve repeated product tiles
  // and a sorting control, which is unambiguous.
  const tiles = countProductTiles(html)
  const listingControls = listingControlSignals(html)
  const detailContainers = productDetailSignals(html)

  if (tiles >= 8) {
    scored.push({ type: 'category', score: 70, signal: `Page repeats ${tiles} product-tile containers` })
  } else if (tiles >= 3) {
    scored.push({ type: 'category', score: 40, signal: `Page repeats ${tiles} product-tile containers` })
  }
  if (listingControls.length >= 2) {
    scored.push({
      type: 'category',
      score: 45,
      signal: `Page carries listing controls: ${listingControls.join(', ')}`,
    })
  }
  if (detailContainers.length) {
    // A single product's own page. Scored high because these containers appear
    // once per page and only on a product detail page.
    scored.push({
      type: 'product',
      score: 75,
      signal: `Page carries single-product containers: ${detailContainers.join(', ')}`,
    })
  }

  // ── Listing shape by link pattern, where URLs happen to be conventional. ─
  const links = extractLinks(html)
  const productish = links.filter((l) => /\/(products?|item|sku|p|pd|pdp)\//i.test(l.href))
  const distinctProductish = new Set(productish.map((l) => l.href)).size

  const hasPagination =
    /rel\s*=\s*["'](next|prev)["']/i.test(html) ||
    /class\s*=\s*["'][^"']*\b(pagination|pager|page-numbers)\b/i.test(html)
  const hasFacets = /class\s*=\s*["'][^"']*\b(facet|filter|refine|filters)\b/i.test(html)

  if (distinctProductish >= 8) {
    scored.push({
      type: 'category',
      score: 60,
      signal: `Page links to ${distinctProductish} distinct product-shaped URLs`,
    })
  }
  if (distinctProductish >= 4 && (hasPagination || hasFacets)) {
    scored.push({
      type: 'category',
      score: 55,
      signal: `Page links to ${distinctProductish} product-shaped URLs alongside ${
        hasPagination && hasFacets ? 'pagination and facets' : hasPagination ? 'pagination' : 'facets'
      }`,
    })
  }

  // ── URL shape, scored last and low. ─────────────────────────────────────
  for (const { re, type, label } of URL_PATTERNS) {
    if (re.test(url)) scored.push({ type, score: 25, signal: label })
  }

  if (!scored.length) return { pageType: 'unknown', signals: ['No page-type signal was found.'] }

  // Sum by type so corroborating signals beat one loud one.
  const totals = new Map<PageType, number>()
  for (const s of scored) totals.set(s.type, (totals.get(s.type) ?? 0) + s.score)

  const [winner, winnerScore] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]!
  scored.filter((s) => s.type === winner).forEach((s) => signals.push(s.signal))

  const others = [...totals.entries()].filter(([t]) => t !== winner)
  others.forEach(([t, v]) => signals.push(`Also scored ${t} (${v}).`))

  // A URL pattern alone (25) is not a classification — it is a hint. Anything
  // resting only on the URL is reported as `unknown` with the hint recorded,
  // because a confident wrong label costs Stage 6 more than an honest gap.
  if (winnerScore <= 25) {
    return {
      pageType: 'unknown',
      signals: [...signals, 'Only a URL-shape hint was available, which is not enough to classify the page.'],
    }
  }

  return { pageType: winner, signals }
}

/**
 * Ranks a discovered link by how likely it is to be worth fetching.
 *
 * This steers a bounded crawl toward catalogue pages instead of spending the
 * page budget on privacy policies. It is a crawl PRIORITY, not a claim about
 * the page — every fetched page is classified on its own content afterwards.
 */
export function linkPriority(href: string, anchorText: string): number {
  let score = 0
  const h = href.toLowerCase()
  const t = anchorText.toLowerCase()

  if (/\/(products?|item|sku|pd|pdp)\/[^/]+/.test(h) || /\/p\/[^/]+/.test(h)) score += 60
  if (/\/(category|categories|collections?|range|shop|catalog(ue)?)\b/.test(h)) score += 50
  if (/\b(shop|products|catalogue|catalog|browse|range)\b/.test(t)) score += 20
  if (/\/(datasheet|spec|specification|technical)/.test(h)) score += 25

  // Pages that exist on every site and tell us nothing about the catalogue.
  if (/\/(about|contact|news|blog|careers|privacy|terms|cookie|login|account|cart|basket|checkout|wishlist)\b/.test(h)) {
    score -= 60
  }
  // Query-heavy URLs are usually the same listing re-sorted.
  if ((h.match(/[?&]/g) ?? []).length > 2) score -= 15

  return score
}
