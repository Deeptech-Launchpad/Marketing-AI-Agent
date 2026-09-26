import { fetchPageRaw, type RawPageResult } from '../research/pageFetch.js'
import { htmlToText } from '../research/htmlToText.js'
import { recordFromObservations, type EnrichedRecord } from '../websiteaudit/enrichedRecord.js'
import { extractPageObservations, extractProductObservations } from '../websiteaudit/extraction.js'
import {
  extractHeadings,
  extractJsonLd,
  extractLinks,
  extractMeta,
  extractProductTileLinks,
  extractSpecPairs,
  extractTitle,
  hasType,
  jsonLdNodes,
  wordCount,
} from '../websiteaudit/htmlStructure.js'
import { linkPriority } from '../websiteaudit/pageClassifier.js'
import { assessPdpPage, productLinksOn } from '../websiteaudit/pdpTarget.js'
import { registrableDomain } from '../enrichment/siteIdentity.js'
import { readProductWithModel, type ProductReader, type VerifiedRead } from './productReader.js'
import { readBreadcrumb, readProductPageDetails, readableHtml, type ProductPageDetails } from './productPageDetails.js'
import { addressPageLink, locationsOnPage, placeCompany, shortLocation, stateInObjective, type CompanyLocation } from './companyLocation.js'
import { hostOf, normalizeUrlForDedup, resolveLink, sameSite } from '../websiteaudit/urls.js'

// PROSPECT DISCOVERY — ONE COMPANY, ONE GENUINE PRODUCT, ONE ANSWER.
//
//   Company's own website → one real individual product page → analyse that
//   product's information → is our service genuinely needed, and why?
//
// This is NOT a website audit. Nothing here scores the site, checks its SEO,
// its canonical tags or its pricing policy, or looks at more than one product.
// It answers a narrower question a salesperson can act on: does THIS product's
// own page present its information — description, attributes, values,
// specifications, identifiers — completely and in a usable structure? If it
// does, in whatever style the company chose, there is no need to sell into.
// If it does not, the page itself is the evidence, and the gaps are the pitch.
//
// "One genuine individual product" is enforced, not assumed. A page is only
// accepted when it shows ONE purchasable/specifiable item: it names a single
// product AND carries something only an individual product has — a product
// code or model number, a Product declaration with an identifier or offer, or
// a specification table. Product-family, category, solution, article, FAQ and
// general pages are rejected by name, and a rejected catalogue page is
// descended into, since its products are one click further down.
//
// Nothing here asks a model for an opinion. Every finding is read off the
// fetched page, so each one can be checked by opening the product URL.

/** Page requests per company, homepage included. */
const MAX_PAGE_FETCHES = 10
/** Catalogue pages opened when the homepage links to no product directly. */
const MAX_CATEGORY_PAGES = 2
/** Candidate pages queued before any is opened. */
const MAX_CANDIDATES = 20

export type ServiceNeed = 'needed' | 'possible' | 'not_needed' | 'not_assessed'

export type AnalysisStatus =
  | 'analysed'
  | 'source_unreadable'
  | 'not_relevant'
  | 'no_website'
  | 'duplicate'
  | 'website_unreachable'
  | 'no_product_page'
  | 'blocked'
  | 'browser_only'
  | 'time_budget'

export interface ProductAttribute {
  name: string
  value: string
  /** Where on the page it was read: a spec table, the Product declaration, or the description's own words. */
  source: 'specification table' | 'structured data' | 'product page text' | 'description text'
}

/** One thing missing or badly structured in the product's information. */
export interface ProductGap {
  key: string
  /** major — the core of the product information is missing; gap — a clear shortfall; minor — worth mentioning, not a reason on its own. */
  severity: 'major' | 'gap' | 'minor'
  title: string
  /** What the page shows today, in terms of this product. */
  detail: string
}

export interface ProductPageAnalysis {
  status: AnalysisStatus
  /** One sentence: what happened, in words a salesperson can read. */
  statusReason: string
  websiteUrl: string | null
  /**
   * A product page that exists but could not be read (bot protection, or
   * built in the browser) — for Sales to open themselves. Null otherwise.
   */
  reviewUrl?: string | null
  /** Every page opened while looking for the product, and what each turned out to be. */
  pagesChecked: Array<{ url: string; outcome: string }>
  product: {
    name: string
    url: string
    description: string | null
    imageUrl: string | null
    brand: string | null
    sku: string | null
    category: string | null
    price: string | null
    attributes: ProductAttribute[]
    /** Feature statements the page lists, verbatim. */
    featureBullets?: string[]
    /**
     * The page as a buyer sees it — pictures, price and how it is sold,
     * buying options, downloads. Absent on rows analysed before 2026-09-26.
     */
    page?: ProductPageDetails
    /** How the page was read: by rule only, or also by a verified read of its text. */
    readBy?: string
    /** How the product's information is built. */
    structure: {
      structuredData: string[]
      fieldsPublished: number
      fieldsTotal: number
      specificationRows: number
      wordCount: number
      descriptionSentences: number
      fields: Array<{ label: string; state: 'observed' | 'restructured' | 'absent' }>
    }
  } | null
  /** Kept on rows written before 2026-09-25's change; never produced now. */
  audit?: null
  /** What is missing or problematic in this product's information, most serious first. */
  gaps: ProductGap[]
  /** The same, as plain sentences. */
  issues: string[]
  /** Product-information fields this page does not publish, with what to publish instead. */
  missingInformation: Array<{ label: string; recommendation: string }>
  /** What our service would do about each gap. */
  recommendedActions: Array<{ title: string; remediation: string; impact: string; effort: string }>
  serviceNeed: ServiceNeed
  /** Why our service is (or is not) relevant, in terms of this product. Null unless analysed. */
  whyNeeded: string | null
  /** What the Marketing Agent should do next. */
  nextStep: string | null
  /** Where the company is, as its own website (or the listing that named it) states. Absent when no page stated it. */
  companyLocation?: CompanyLocation | null
}

/** A result with nothing analysed, for every way the analysis can stop short. */
export function notAnalysed(
  status: Exclude<AnalysisStatus, 'analysed'>,
  statusReason: string,
  extra: { websiteUrl?: string | null; pagesChecked?: ProductPageAnalysis['pagesChecked']; reviewUrl?: string | null } = {},
): ProductPageAnalysis {
  return {
    status,
    statusReason,
    websiteUrl: extra.websiteUrl ?? null,
    reviewUrl: extra.reviewUrl ?? null,
    pagesChecked: extra.pagesChecked ?? [],
    product: null,
    gaps: [],
    issues: [],
    missingInformation: [],
    recommendedActions: [],
    serviceNeed: 'not_assessed',
    whyNeeded: null,
    nextStep: null,
  }
}

type Fetcher = (url: string, opts?: { as?: 'html' | 'xml' }) => Promise<RawPageResult>

/** Sitemap files read per company, on top of the page budget. */
const MAX_SITEMAP_FETCHES = 5

/**
 * Bot-protection walls, recognised by what they serve instead of the page.
 *
 * A wall is the site saying "no automated readers". It is reported as that —
 * never as "no product page", which would be a false statement about the
 * company — and it is never worked around: the analysis stops at the first
 * wall rather than retrying the same site.
 */
const BOT_WALLS: Array<[RegExp, string]> = [
  [/_Incapsula_Resource|Incapsula incident/i, 'Incapsula'],
  [/cf-chl-|\/cdn-cgi\/challenge-platform|<title>Just a moment\.\.\.<\/title>|Attention Required! \| Cloudflare/i, 'Cloudflare'],
  [/captcha-delivery\.com|datadome/i, 'DataDome'],
  [/px-captcha|perimeterx|_pxAppId/i, 'PerimeterX'],
  [/errors\.edgesuite\.net|<title>Access Denied<\/title>/i, 'Akamai'],
  [/Pardon Our Interruption|distil_r_captcha/i, 'Imperva'],
  [/sgcaptcha|<title>Human Verification<\/title>/i, 'a bot check'],
]

export function blockedBy(res: RawPageResult | null): string | null {
  if (!res) return null
  const head = (res.html ?? '').slice(0, 20_000)
  for (const [pattern, name] of BOT_WALLS) if (pattern.test(head)) return name
  if ((res.status === 403 || res.status === 429) && wordCount(head) < 200) return 'access control'
  return null
}

/** An address that looks like one product's page, used to point Sales at it when it cannot be read. */
function looksLikeProductUrl(url: string): boolean {
  return /\/(product|products|p|dp|item|sku|pd|pdp)\/[^/?#]+/i.test(safePath(url)) || Boolean(modelToken(url))
}

/** The product's own text: from its heading down, where navigation no longer dominates. */
function productText(html: string): string {
  const h1 = html.search(/<h1\b/i)
  const from = h1 > 0 ? Math.max(0, h1 - 200) : 0
  const title = extractTitle(html)?.value ?? ''
  return `${title}\n${htmlToText(html.slice(from))}`.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, 15_000)
}

/**
 * Opens the company's website, finds ONE genuine individual product page, and
 * analyses that product only.
 *
 * Never throws: a site that cannot be read is a result, reported as one.
 */
export async function analyseCompanyWebsite(input: {
  websiteUrl: string
  objective: string
  fetch?: Fetcher
  /** Reads the product page's own text. Null reads by rule only (tests; a model outage). */
  read?: ProductReader | null
  tenantId?: string
}): Promise<ProductPageAnalysis> {
  // Where the company is, as its own pages state it — kept on every result
  // that got as far as the website, analysed or not.
  const found: { location: CompanyLocation | null } = { location: null }
  const result = await analyseWebsite(input, found)
  return found.location ? { ...result, companyLocation: found.location } : result
}

async function analyseWebsite(
  input: Parameters<typeof analyseCompanyWebsite>[0],
  found: { location: CompanyLocation | null },
): Promise<ProductPageAnalysis> {
  const fetchPage: Fetcher = input.fetch ?? ((url, opts) => fetchPageRaw(url, opts))
  const reader = input.read === undefined ? readProductWithModel : input.read
  const pagesChecked: ProductPageAnalysis['pagesChecked'] = []
  let budget = MAX_PAGE_FETCHES
  // Pages that arrived as a large script bundle with almost no readable text:
  // a catalogue built in the browser, which this reader cannot see into.
  let opened = 0
  let scriptBuilt = 0

  const open = async (url: string): Promise<RawPageResult | null> => {
    if (budget <= 0) return null
    budget--
    try {
      const res = await fetchPage(url)
      if (res.ok && res.html) {
        opened++
        if (res.html.length > 20_000 && htmlToText(res.html).split(/\s+/).filter(Boolean).length < 250) scriptBuilt++
      }
      return res
    } catch (err) {
      // The SSRF guard throws for a destination it will not follow.
      pagesChecked.push({ url, outcome: `not opened: ${(err as Error).message}` })
      return null
    }
  }

  const blockedResult = (wall: string, productUrl: string | null, websiteUrl: string) =>
    notAnalysed(
      'blocked',
      productUrl
        ? `A product page was found, but the website blocks automated reading (${wall} bot protection), so it could not be analysed. Open the product link to review it manually.`
        : `The website blocks automated reading (${wall} bot protection), so its products could not be analysed. Review the website manually.`,
      { websiteUrl, pagesChecked, reviewUrl: productUrl },
    )

  // ── 1. The company's own website ──────────────────────────────────────
  const home = await open(input.websiteUrl)
  const homeWall = blockedBy(home)
  if (homeWall) {
    pagesChecked.push({ url: input.websiteUrl, outcome: `blocked by ${homeWall}` })
    // The sitemap is the file a site publishes FOR automated readers. Reading
    // it (a few requests, never the blocked pages themselves) is how Sales
    // still gets a direct product link to open.
    const listed = await productSitemapUrls(originOf(input.websiteUrl), fetchPage)
    const productUrl = listed.products.find((u) => looksLikeProductUrl(u)) ?? null
    if (productUrl) pagesChecked.push({ url: `${originOf(input.websiteUrl)}/sitemap.xml`, outcome: 'sitemap read — a product page is listed' })
    return blockedResult(homeWall, productUrl, input.websiteUrl)
  }
  if (!home || !home.ok || !home.html.trim()) {
    const why = home ? (home.status ? `HTTP ${home.status}` : (home.reason ?? 'no response')) : 'the request was refused'
    pagesChecked.push({ url: input.websiteUrl, outcome: `could not be opened (${why})` })
    return notAnalysed('website_unreachable', `The company's website could not be opened (${why}), so no product could be checked.`, {
      websiteUrl: input.websiteUrl,
      pagesChecked,
    })
  }
  let homeHtml = home.html
  let homeUrl = home.finalUrl ?? input.websiteUrl
  pagesChecked.push({ url: homeUrl, outcome: 'homepage opened' })

  // ── Where the company is ──────────────────────────────────────────────
  // The homepage's own address, or — when it states none — its contact or
  // locations page: one extra request, outside the product budget.
  let locations = locationsOnPage(homeHtml, homeUrl)
  let locationText = htmlToText(homeHtml)
  if (locations.length === 0) {
    const contact = addressPageLink(homeHtml, homeUrl)
    if (contact) {
      const page = await fetchPage(contact).catch(() => null)
      if (page?.ok && page.html && !blockedBy(page)) {
        locations = locationsOnPage(page.html, page.finalUrl ?? contact)
        locationText += `\n${htmlToText(page.html)}`
        pagesChecked.push({ url: page.finalUrl ?? contact, outcome: locations.length ? 'contact page opened — address read' : 'contact page opened — no address stated' })
      }
    }
  }
  const area = stateInObjective(input.objective)
  const placed = placeCompany(locations, area, locationText)
  found.location = placed.location
  if (placed.outsideArea && placed.location && area) {
    return notAnalysed(
      'not_relevant',
      `The company's own website places it in ${shortLocation(placed.location)} — outside ${area.name}, the area the search asked for — so its products were not checked.`,
      { websiteUrl: homeUrl, pagesChecked },
    )
  }

  // A global homepage that only offers a choice of country ("msasafety.com/
  // global") holds no catalogue; the company's products live on its regional
  // site (us.msasafety.com). Same company, same registrable domain — step in.
  if (productLinksOn(homeHtml, homeUrl, 3).length === 0 && !rankedLinks(homeHtml, homeUrl).some((l) => l.score >= 40)) {
    const regional = regionalSite(homeHtml, homeUrl)
    if (regional) {
      const page = await open(regional)
      if (page?.ok && page.html.trim() && !blockedBy(page)) {
        homeHtml = page.html
        homeUrl = page.finalUrl ?? regional
        pagesChecked.push({ url: homeUrl, outcome: 'regional website opened (the homepage only offered a choice of country)' })
      }
    }
  }

  // ── 2. Candidate pages, from links the site itself publishes ──────────
  const words = objectiveWords(input.objective)
  const seen = new Set<string>([key(homeUrl)])
  const queue: string[] = []
  const enqueue = (urls: string[], front = false) => {
    const fresh = urls.filter((u) => {
      const k = key(u)
      if (seen.has(k) || !sameCompany(u, homeUrl) || nonProductPath(u)) return false
      seen.add(k)
      return true
    })
    const ranked = rankCandidates(fresh, words)
    if (front) queue.unshift(...ranked)
    else queue.push(...ranked)
    queue.splice(MAX_CANDIDATES)
  }

  // A product the homepage features is a product the company chose to show.
  enqueue(productLinksOn(homeHtml, homeUrl, 8))

  if (queue.length < 3) {
    // Catalogue pages first — the products live one level down on most sites.
    const categories = rankedLinks(homeHtml, homeUrl)
      .filter((l) => l.score >= 40 && !seen.has(key(l.url)) && !nonProductPath(l.url))
      .slice(0, MAX_CATEGORY_PAGES)
    for (const c of categories) {
      const page = await open(c.url)
      seen.add(key(c.url))
      const wall = blockedBy(page)
      if (wall) {
        pagesChecked.push({ url: c.url, outcome: `blocked by ${wall}` })
        return blockedResult(wall, null, homeUrl)
      }
      if (!page || !page.ok) {
        pagesChecked.push({ url: c.url, outcome: `catalogue page could not be opened${page?.status ? ` (HTTP ${page.status})` : ''}` })
        continue
      }
      const found = productLinksBelow(page.html, page.finalUrl ?? c.url)
      pagesChecked.push({ url: c.url, outcome: `catalogue page — ${found.length} product link(s) on it` })
      enqueue(found)
    }
  }

  // The site's own index of itself — its PRODUCT sitemaps first. Read when
  // the links run out, not only when there were none: a catalogue whose
  // category pages lead nowhere readable often lists every product there.
  let sitemapRead = false
  const readSitemap = async () => {
    sitemapRead = true
    const found = await productSitemapUrls(originOf(homeUrl), fetchPage)
    pagesChecked.push({
      url: `${originOf(homeUrl)}/sitemap.xml`,
      outcome: `sitemap read — ${found.listed} address(es) listed, ${found.products.length} product page(s) among them`,
    })
    enqueue(found.products.slice(0, 8), true)
  }
  if (queue.length === 0) await readSitemap()

  // ── 3. The first genuine individual product ───────────────────────────
  let browserOnly: string | null = null
  while (budget > 0) {
    if (queue.length === 0) {
      if (sitemapRead) break
      await readSitemap()
      if (queue.length === 0) break
    }
    const url = queue.shift()!
    const fetched = await open(url)
    if (!fetched) break
    const pageUrl = fetched.finalUrl ?? url

    const wall = blockedBy(fetched)
    if (wall) {
      // Stop here: a site that refuses automated readers is not retried page
      // after page. Sales gets the product link to open themselves.
      pagesChecked.push({ url: pageUrl, outcome: `blocked by ${wall}` })
      return blockedResult(wall, looksLikeProductUrl(pageUrl) && !nonProductPath(pageUrl) ? pageUrl : null, homeUrl)
    }

    const check = assessPdpPage({ endPdpValue: url, companyWebsite: homeUrl, fetched, fetchUrl: url })
    if (check.case === 'valid_product') {
      const genuine = genuineProduct(fetched.html, pageUrl, check.productName)
      if (genuine.ok) {
        pagesChecked.push({ url: pageUrl, outcome: `individual product — "${check.productName}" (${genuine.evidence})` })
        // A footer address on the product page, when the homepage stated none.
        found.location ??= placeCompany(locationsOnPage(fetched.html, pageUrl), area, locationText).location
        const modelRead = reader ? await reader({ pageText: productText(fetched.html), url: pageUrl, tenantId: input.tenantId }) : null
        return analyseProductPage({
          html: fetched.html,
          url: pageUrl,
          httpStatus: fetched.status,
          websiteUrl: homeUrl,
          productName: check.productName,
          pagesChecked,
          modelRead,
        })
      }
      pagesChecked.push({ url: pageUrl, outcome: `not an individual product — ${genuine.reason}` })
    } else {
      pagesChecked.push({ url: pageUrl, outcome: plainHeadline(check.headline) })
      if (check.issue === 'javascript_only' && looksLikeProductUrl(pageUrl)) browserOnly ??= pageUrl
    }

    // A family or category page lists its products: go one level down.
    if (fetched.ok && fetched.html) enqueue(productLinksBelow(fetched.html, pageUrl), true)
  }

  if (browserOnly) {
    return notAnalysed(
      'browser_only',
      'A product page was found, but its content is built by JavaScript in the browser, so it could not be read reliably. Open the product link to review it manually.',
      { websiteUrl: homeUrl, pagesChecked, reviewUrl: browserOnly },
    )
  }

  // Most pages were script bundles with little text: the catalogue is built
  // in the browser. "No product page" would be a false statement about it.
  if (scriptBuilt >= 1 && scriptBuilt / opened >= 0.6) {
    return notAnalysed(
      'browser_only',
      'The website builds its catalogue in the browser with JavaScript, so its product pages could not be read reliably. Review the website manually.',
      { websiteUrl: homeUrl, pagesChecked },
    )
  }

  return notAnalysed(
    'no_product_page',
    pagesChecked.length <= 2
      ? 'The website was opened, but it links to no individual product page — no catalogue links and no product addresses in its sitemap.'
      : `No genuine individual product page was found: ${pagesChecked.length - 1} page(s) on the website were checked, and each was a category, product-family, solution or general page rather than one specific product.`,
    { websiteUrl: homeUrl, pagesChecked },
  )
}

/**
 * Product-page addresses from the site's sitemaps, product sitemaps first.
 *
 * Large catalogues split their sitemap by type (…/sitemap_products_1.xml,
 * …/product-sitemap.xml). Reading the product one is what finds a product on
 * a site whose first few hundred listed pages are marketing and blog posts.
 */
export async function productSitemapUrls(
  origin: string,
  fetchPage: Fetcher,
): Promise<{ listed: number; products: string[] }> {
  let budget = MAX_SITEMAP_FETCHES
  const read = async (url: string): Promise<string> => {
    if (budget <= 0) return ''
    budget--
    try {
      const res = await fetchPage(url, { as: 'xml' })
      return res.ok && !blockedBy(res) ? res.html : ''
    } catch {
      return ''
    }
  }
  const locs = (xml: string) =>
    [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, '&'))

  const roots: string[] = []
  const robots = await read(`${origin}/robots.txt`)
  for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.push(m[1]!)
  // No sitemap declared in robots.txt: the two names nearly every platform uses.
  if (roots.length === 0) roots.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`)

  const pages: string[] = []
  const indexes: string[] = []
  for (const root of roots.slice(0, 2)) {
    const xml = await read(root)
    if (/<sitemapindex/i.test(xml)) indexes.push(...locs(xml))
    else pages.push(...locs(xml))
  }
  // Child sitemaps that name products, first.
  const children = indexes
    .map((u, i) => ({ u, i, product: /product|items?|catalog|sku|pdp/i.test(u.replace(/sitemap/gi, '')) ? 0 : 1 }))
    .sort((a, b) => a.product - b.product || a.i - b.i)
    .map((c) => c.u)
  for (const child of children) {
    if (budget <= 0) break
    pages.push(...locs(await read(child)))
    if (pages.filter((u) => looksLikeProductUrl(u)).length >= 40) break
  }

  const products = pages
    .filter((u) => sameCompany(u, origin) && !nonProductPath(u) && looksLikeProductUrl(u))
    .slice(0, 400)
  // Bare-slug catalogues ("/skullerz-3215-strap") name no product path at all.
  return { listed: pages.length, products: products.length ? products : sitemapCandidates(pages, `${origin}/`).slice(0, 40) }
}

// ── Is this ONE genuine individual product? ──────────────────────────────

/**
 * Path segments that name something other than one product. A page under
 * /solutions/ or /faq/ is that, whatever product words its title uses.
 */
const NON_PRODUCT_SEGMENT =
  /^(solutions?|industr(y|ies)|applications?|markets?|sectors?|blogs?|news|articles?|stories|faqs?|help|resources?|support|learn(ing)?|insights?|guides?|case-stud(y|ies)|about(-us)?|company|careers?|jobs|events?|press|media|knowledge(-base)?|training|services?|contact(-us)?|webinars?|videos?|downloads?|literature|brochures?|catalogs?|catalogues?|search|cart|account|login|privacy|terms|legal|sitemap|categories|category|collections?|brands?|shop-by|compare|wishlist)$/i

/** JSON-LD types that declare a page to be something other than one product. */
const NON_PRODUCT_TYPES = ['Article', 'BlogPosting', 'NewsArticle', 'FAQPage', 'CollectionPage', 'SearchResultsPage', 'HowTo', 'Event']

/** Files and upload folders: a PDF or an image is never the product page. */
const FILE_PATH = /(\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mov)$)|\/(wp-content|uploads|media|assets|static)\//i

/**
 * Words that mark a page as something other than a product wherever they
 * appear in a segment: "a2z_crescent-contest_landing-page", "recall",
 * "news-release-details", "newsroom".
 */
const NON_PRODUCT_WORD =
  /(contest|sweepstake|giveaway|landing[-_]?page|recalls?\b|news[-_]?releases?|press[-_]?releases?|newsroom|investors?\b|warranty|registration|rebates?\b|promotions?\b|coupons?\b)/i

/** Side sites of a company that never carry its product pages. */
const NON_PRODUCT_HOST = /^(newsroom|pressroom|press|news|media|ir|investors?|careers?|jobs|blog|community|events)\./i

function nonProductPath(url: string): boolean {
  try {
    const u = new URL(url)
    if (NON_PRODUCT_HOST.test(u.hostname.replace(/^www\./i, ''))) return true
    const path = u.pathname
    if (FILE_PATH.test(path)) return true
    return path
      .split('/')
      .filter(Boolean)
      .some((seg) => {
        const s = decodeURIComponent(seg)
        return NON_PRODUCT_SEGMENT.test(s) || NON_PRODUCT_WORD.test(s)
      })
  } catch {
    return true
  }
}

/**
 * Whether a link stays with the same company: the same registrable domain,
 * so a regional site (us.msasafety.com) counts and a marketplace does not.
 */
function sameCompany(url: string, companyUrl: string): boolean {
  const a = hostOf(url)
  const b = hostOf(companyUrl)
  if (!a || !b) return false
  return sameSite(a, b) || registrableDomain(a) === registrableDomain(b)
}

/**
 * The regional site a country-chooser homepage links to — another host of
 * the same company. The US or English site first, since the search is run
 * in English; otherwise the first one listed.
 */
function regionalSite(html: string, pageUrl: string): string | null {
  const here = hostOf(pageUrl)
  const sites: string[] = []
  for (const l of extractLinks(html, 600)) {
    const abs = resolveLink(l.href, pageUrl)
    const host = abs ? hostOf(abs) : null
    if (!abs || !host || host === here || !sameCompany(abs, pageUrl)) continue
    // A country or language site only (us., en., de-de., www2.) — never the
    // investor, press or careers subdomain a global homepage also links to.
    const label = host.replace(/^www\./, '').split('.')[0] ?? ''
    // "ir" and "hr" are two letters but investor relations and human resources.
    if (!/^([a-z]{2}|[a-z]{2}-[a-z]{2}|www\d?)$/i.test(label) || /^(ir|hr)$/i.test(label)) continue
    const root = `${new URL(abs).origin}/`
    if (!sites.includes(root)) sites.push(root)
  }
  const preferred = sites.find((s) => /\/\/(us|en-us|en)\./i.test(s))
  return preferred ?? sites[0] ?? null
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

/** The address's last path segment, lower-cased. */
function lastSegment(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).toLowerCase().split('/').filter(Boolean).pop() ?? ''
  } catch {
    return ''
  }
}

/** An address naming two models side by side: "gvx-or-88vx", "x200-vs-x300". */
function comparesModels(url: string): boolean {
  const m = lastSegment(url).match(/([a-z0-9]+)[-_](?:or|vs|versus)[-_]([a-z0-9]+)/)
  return Boolean(m && (/\d/.test(m[1]!) || /\d/.test(m[2]!)))
}

/** A token in the address that looks like a model or product code: "x200", "hk4", "3215", "teey2lshc301". */
function modelToken(url: string): string | null {
  try {
    const slug = decodeURIComponent(new URL(url).pathname).toLowerCase().split('/').filter(Boolean).pop() ?? ''
    const tokens = slug.replace(/\.(html?|php|aspx?)$/, '').split(/[^a-z0-9]+/)
    return (
      tokens.find(
        (t) =>
          t.length >= 2 &&
          /\d/.test(t) &&
          (/[a-z]/.test(t) ? t.length >= 3 || /^[a-z]+\d+$/.test(t) : t.length >= 3 && !/^(19|20)\d{2}$/.test(t)),
      ) ?? null
    )
  } catch {
    return null
  }
}

const CODE_LABEL = /\b(sku|mpn|upc|ean|gtin|part\s*(no|number|#)|item\s*(no|number|code|#)|product\s*(code|no|number)|model\s*(no|number|#)?|style\s*(no|number|#)?|catalog(ue)?\s*(no|number|#))\s*[:#]/i
const CODE_KEY = /^(sku|mpn|upc|ean|gtin|part\s*(no|number|#)?|item\s*(no|number|code|#)?|product\s*(code|no|number|id)|model(\s*(no|number|#))?|style(\s*(no|number|#))?|catalog(ue)?\s*(no|number|#)?|article\s*(no|number)?)\.?$/i

/**
 * Whether a page the PDP check accepted is one specific product rather than
 * a family, category, solution, article, FAQ or general page.
 *
 * Needs BOTH: nothing declaring it to be something else, and at least one
 * thing only an individual product carries.
 */
export function genuineProduct(
  html: string,
  url: string,
  productName: string | null = null,
): { ok: true; evidence: string } | { ok: false; reason: string } {
  if (nonProductPath(url)) {
    return { ok: false, reason: 'the address places it in a solutions, resources, article or other non-product section' }
  }

  const nodes = jsonLdNodes(extractJsonLd(html))
  const products = nodes.filter(({ node }) => hasType(node, 'Product', 'IndividualProduct', 'ProductModel'))
  const other = NON_PRODUCT_TYPES.find((t) => nodes.some(({ node }) => hasType(node, t)))
  if (other && products.length === 0) return { ok: false, reason: `the page declares itself a ${other}, not a product` }
  if (products.length > 3) return { ok: false, reason: `the page declares ${products.length} products — it is a listing` }
  // The same declaration in microdata: a catalogue's "View Items" page marks
  // each of its rows as its own Product, where a product page marks one.
  const microdataProducts = html.match(/itemtype\s*=\s*["']https?:\/\/schema\.org\/(?:Product|IndividualProduct|ProductModel)["']/gi)?.length ?? 0
  if (microdataProducts > 3) return { ok: false, reason: `the page declares ${microdataProducts} products — it is a listing` }

  const text = htmlToText(html)
  if (/\bfrequently asked questions\b/i.test(text.slice(0, 400))) return { ok: false, reason: 'it is an FAQ page' }

  // Promotions and comparisons feature products without being one:
  // "blast-with-the-best-gvx-or-88vx", "5 FREE respirators with purchase of a bundle".
  const headings = `${extractTitle(html)?.value ?? ''} ${extractHeadings(html, 8)
    .map((h) => h.text)
    .join(' ')}`
  if (/\b(with (the )?purchase of|special offer|limited[- ]time|promotion|giveaway|free with|\d+ free)\b/i.test(headings)) {
    return { ok: false, reason: 'it is a promotion page that features products rather than one product' }
  }
  if (comparesModels(url)) {
    return { ok: false, reason: 'it compares several products rather than presenting one' }
  }
  // One product shows one product code. A page labelling four or more is a
  // listing of items ("Adhesives & Chemicals", each with its "Item #:").
  const codeLabels = text.match(new RegExp(CODE_LABEL.source, 'gi'))?.length ?? 0
  if (codeLabels >= 4) {
    return { ok: false, reason: `it lists ${codeLabels} product codes — a listing of several items, not one product` }
  }

  const specs = extractSpecPairs(html, 80).filter((p) => !/cookie|consent|duration|provider|expiry/i.test(`${p.key} ${p.value}`))
  const declaredId = products.find(
    ({ node }) => node.sku || node.mpn || node.gtin || node.gtin8 || node.gtin12 || node.gtin13 || node.gtin14 || node.productID || node.model || node.offers,
  )
  const codeInSpecs = specs.find((p) => CODE_KEY.test(p.key.trim().replace(/[:：]\s*$/, '')))
  // A model code in the address counts only when the product's own name (or the
  // page title) carries it: "/blast-with-the-best-gvx-or-88vx/" titled "Blast with
  // the Best!" is a campaign page, not the 88VX.
  const token = modelToken(url)
  const heading = `${extractTitle(html)?.value ?? ""} ${productName ?? ""}`.toLowerCase().replace(/[^a-z0-9]+/g, "")
  const code = token && heading.includes(token) ? token : null

  if (declaredId) return { ok: true, evidence: 'declares a product with an identifier' }
  if (codeInSpecs) return { ok: true, evidence: `${codeInSpecs.key.replace(/[:：]\s*$/, '')} ${codeInSpecs.value}` }
  if (CODE_LABEL.test(text)) return { ok: true, evidence: 'shows a product code' }
  if (code) return { ok: true, evidence: `model "${code.toUpperCase()}" in its address` }
  // A store's own record number for one item: /p/000060003900001001, or a
  // model code as its own segment right after /product/: /product/j325agah120/…
  const recordId =
    /\/(p|product|products|item|sku)\/(\d{5,})(\/|$)/i.exec(safePath(url)) ??
    /\/(p|product|item|sku)\/([a-z]*\d[a-z0-9-]{2,})(\/|$)/i.exec(safePath(url))
  if (recordId) return { ok: true, evidence: `product record ${recordId[2]!.toUpperCase()} in its address` }
  // Specification rows alone prove one item only when the name is one item's:
  // "Combination Tools" is a category with a filter table, not a product.
  const name = (productName ?? extractTitle(html)?.value ?? '').trim()
  // And a few spec-like rows appear on service and category pages too
  // ("Reliable Industrial Adhesives & Chemicals in Scranton, PA"), so they need
  // one more sign of a single item: a model number in its name, a cart or
  // quote button, or a single declared product.
  const oneItem =
    // The visible text, not the markup: "addtocart" sits in every page's shared
    // scripts on many shops, whether or not this page sells anything.
    /\d/.test(name) || /\badd to (cart|basket|bag|quote)\b/i.test(text) || products.length === 1
  const specificName = oneItem && !/s$/i.test(name.split(/[\s|–—-]+/).filter(Boolean).pop() ?? '') || /\d/.test(name)
  if (specs.length >= 3 && specificName) return { ok: true, evidence: `${specs.length} specification rows` }

  return {
    ok: false,
    reason: 'it names a product line but shows no model number, product code or specifications of one specific item — a product-family page',
  }
}

// ── Analysing that one product ───────────────────────────────────────────

/**
 * Reads one product page's information and decides whether our service is
 * genuinely needed.
 *
 * Pure: takes markup, reaches no network.
 */
export function analyseProductPage(input: {
  html: string
  url: string
  httpStatus: number | null
  websiteUrl: string
  /** The name the PDP check read off the page, for a page whose record carries none. */
  productName?: string | null
  pagesChecked?: ProductPageAnalysis['pagesChecked']
  /** What a careful read of the page's own text found, already checked against that text. */
  modelRead?: VerifiedRead | null
}): ProductPageAnalysis {
  const { url } = input
  // What a person actually sees: no commented-out blocks, no hidden
  // placeholder text glued onto values.
  const html = readableHtml(input.html)
  const modelRead = input.modelRead ?? null
  const observations = [...extractPageObservations(html, url), ...extractProductObservations(html, url)]
  const observed = (field: string): string | null => {
    const o = observations.find((x) => x.field === field && x.status === 'observed')
    return o?.value?.trim() ? o.value.trim() : null
  }

  // The Website Audit's product-record builder, over an extraction that was
  // never stored — so the fields are read the same way everywhere.
  const record = recordFromObservations({ crmCompanyId: '', auditRunId: '', pageId: '', sourceUrl: url, observations })

  const structuredData = (observed('page.structuredDataTypes') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const words = Number(observed('page.wordCount')) || wordCount(html)
  const specPairs = extractSpecPairs(html, 80).filter(
    (p) => !/cookie|consent|duration|provider|expiry/i.test(`${p.key} ${p.value}`) && !SITE_FURNITURE_KEY.test(p.key.replace(/\s*[:：]\s*$/, '').trim()),
  )
  // Specs a custom layout keeps outside tables, found by the careful read and
  // verified against the page, count exactly like a table row.
  const readPairs = (modelRead?.attributes ?? []).map((a) => ({ key: a.name, value: a.value }))
  const allPairs = [...specPairs, ...readPairs]
  const attributes = attributesOf(specPairs, record, readPairs)
  const featureBullets = modelRead?.featureBullets ?? []

  // The record's title falls back to the URL path when no name field was
  // extracted; the heading-and-title name the PDP check read is better than that.
  //
  // A name that is not the page's JSON-LD declaration is only trusted when it
  // agrees with the heading: microdata "name" is also used by breadcrumbs, and
  // one page's product came out as "All Categories".
  const nameField = record.fields.find((f) => f.field === 'product.name')
  const h1 = extractHeadings(html).find((h) => h.level === 1)?.text ?? null
  const declaredName = nameField?.before ?? null
  const rawName =
    declaredName && (nameField?.method === 'json_ld' || !h1 || sharesWords(declaredName, h1))
      ? declaredName
      : h1 ?? input.productName ?? declaredName ?? record.title
  const productName = clip(plainText(rawName), 140)

  // The extractor reads a description from declared fields; many sites put
  // theirs in their own layout, and saying "no description" about a page that
  // has one would be a false finding. So the product's own copy after its
  // heading is read too, and the page's meta description last. A catalogue's
  // SEO line ("Browse Item # … in the catalog including Item #, Item Name, …")
  // lists field names, not the product, and is not a description.
  const description = [descriptionOf(record), modelRead?.description ?? null, descriptionFromPage(html)].find(
    (d): d is string => Boolean(d) && !isBoilerplateDescription(d!),
  ) ?? null
  const sentences = description ? description.split(/[.!?](\s|$)/).filter((s) => s && s.trim().length > 20).length : 0

  const facts = readFacts(record, allPairs, attributes, structuredData, observed('page.breadcrumbs'), {
    description,
    pageText: htmlToText(html),
    url,
    productName,
    hasDocumentLink: hasDocumentLink(html, url),
  })
  const gaps = findGaps({ description, sentences, facts, featureCount: featureBullets.length })
  const serviceNeed = decideServiceNeed(gaps)

  const missingInformation = MISSING_FIELDS.filter((f) => !facts.present[f.key]).map((f) => ({
    label: f.label,
    recommendation: f.recommendation,
  }))

  return {
    status: 'analysed',
    statusReason: `One individual product analysed: "${productName}".`,
    websiteUrl: input.websiteUrl,
    pagesChecked: input.pagesChecked ?? [{ url, outcome: 'individual product' }],
    product: {
      name: productName,
      url,
      description,
      imageUrl: record.imageUrl,
      brand: fieldValue(record, 'product.brand'),
      sku: fieldValue(record, 'product.sku') ?? facts.codeValue,
      category: observed('page.breadcrumbs') ?? fieldValue(record, 'product.category') ?? readBreadcrumb(html),
      price: fieldValue(record, 'product.price'),
      attributes,
      featureBullets,
      page: readProductPageDetails({
        html,
        url,
        declared: {
          imageUrl: record.imageUrl,
          price: fieldValue(record, 'product.price') ?? observed('product.price'),
          currency: observed('product.currency'),
          availability: observed('product.availability'),
          sku: fieldValue(record, 'product.sku') ?? facts.codeValue,
          mpn: fieldValue(record, 'product.mpn'),
          gtin: fieldValue(record, 'product.gtin'),
          brand: fieldValue(record, 'product.brand'),
        },
        specPairs: allPairs,
      }),
      readBy: modelRead ? 'rules and a verified text read' : 'rules',
      structure: {
        structuredData,
        fieldsPublished: MISSING_FIELDS.length - missingInformation.length,
        fieldsTotal: MISSING_FIELDS.length,
        specificationRows: allPairs.length,
        wordCount: words,
        descriptionSentences: sentences,
        fields: record.fields.map((f) => ({ label: f.label, state: f.state })),
      },
    },
    gaps,
    issues: gaps.map((g) => `${g.title}: ${g.detail}`),
    missingInformation,
    recommendedActions: actionsFor(gaps),
    serviceNeed,
    whyNeeded: whyFor(serviceNeed, productName, gaps, facts, sentences),
    nextStep: nextStepFor(serviceNeed, productName, gaps),
  }
}

interface Facts {
  structuredAttributes: number
  proseOnlyAttributes: number
  codeValue: string | null
  present: Record<string, boolean>
  hasProductSchema: boolean
}

/**
 * The product-information fields a salesperson can talk about. Price and
 * availability are deliberately absent: a pricing policy is a commercial
 * choice, not a gap in product data.
 */
const MISSING_FIELDS: Array<{ key: string; label: string; recommendation: string }> = [
  { key: 'description', label: 'Product description', recommendation: 'Publish a description that says what the product is, what it is for and where it is used.' },
  { key: 'attributes', label: 'Attributes and values', recommendation: 'Publish the product’s attributes as named fields with values, so buyers can filter and compare.' },
  { key: 'code', label: 'Product code / SKU / model', recommendation: 'Show the product code, so an enquiry or order can quote it.' },
  { key: 'gtin', label: 'GTIN / UPC / barcode', recommendation: 'Publish the barcode, so distributors and marketplaces can match the product.' },
  { key: 'brand', label: 'Brand', recommendation: 'State the brand as its own field.' },
  { key: 'category', label: 'Category', recommendation: 'Place the product in a category path, so it can be browsed alongside its peers.' },
  { key: 'measurements', label: 'Dimensions / weight / sizes', recommendation: 'Publish measurements with their units as their own fields.' },
  { key: 'documents', label: 'Datasheet / certificates', recommendation: 'Link the datasheet or compliance certificate from the product page.' },
  { key: 'image', label: 'Product image', recommendation: 'Show a product image on the page.' },
]

function readFacts(
  record: EnrichedRecord,
  specPairs: Array<{ key: string; value: string }>,
  attributes: ProductAttribute[],
  structuredData: string[],
  breadcrumbs: string | null,
  page: { description: string | null; pageText: string; url: string; productName: string; hasDocumentLink: boolean },
): Facts {
  const has = (field: string) => record.fields.some((f) => f.field === field && f.state !== 'absent')
  const specKey = (re: RegExp) => specPairs.find((p) => re.test(p.key.replace(/[:：]\s*$/, '').trim()))
  const code = has('product.sku') || has('product.mpn') ? null : specKey(CODE_KEY)
  // A model number in the address that the product's own name repeats ("DPG22")
  // is that product's code, published in its name.
  const model = modelToken(page.url)
  const codeInName = Boolean(model && page.productName.toLowerCase().includes(model))
  const gtinSpec = specPairs.find((p) => /\b(upc|ean|gtin|barcode)\b/i.test(p.key) && /\d{8,}/.test(p.value.replace(/\s/g, '')))

  return {
    structuredAttributes: attributes.filter((a) => a.source !== 'description text').length,
    proseOnlyAttributes: attributes.filter((a) => a.source === 'description text').length,
    codeValue: code ? clip(plainText(code.value), 60) : null,
    hasProductSchema: structuredData.some((t) => /product/i.test(t)),
    present: {
      description: Boolean(page.description),
      attributes: attributes.filter((a) => a.source !== 'description text').length >= 3,
      code: has('product.sku') || has('product.mpn') || Boolean(code) || CODE_LABEL.test(page.pageText) || codeInName,
      gtin: has('product.gtin') || Boolean(gtinSpec),
      brand: has('product.brand') || Boolean(specKey(/^brand$/i)),
      category: Boolean(breadcrumbs) || has('product.category') || Boolean(specKey(/^(category|product type|type)$/i)),
      measurements:
        has('product.dimensions') ||
        has('product.weight') ||
        has('product.units') ||
        Boolean(specKey(/dimension|length|width|height|depth|weight|size|capacity|diameter|volume/i)),
      documents: has('product.documents') || page.hasDocumentLink,
      image: has('product.image'),
    },
  }
}

function findGaps(input: { description: string | null; sentences: number; facts: Facts; featureCount?: number }): ProductGap[] {
  const { description, sentences, facts } = input
  const features = input.featureCount ?? 0
  const gaps: ProductGap[] = []

  if (!description && features >= 3) {
    gaps.push({
      key: 'description',
      severity: 'gap',
      title: 'No descriptive copy',
      detail: `The page lists ${features} feature points but no paragraph describing the product — what it is for and where it is used.`,
    })
  } else if (!description) {
    gaps.push({
      key: 'description',
      severity: 'major',
      title: 'No product description',
      detail: 'The page does not describe the product — what it is, what it is for, or where it is used.',
    })
  } else if (sentences <= 1 && features < 4) {
    gaps.push({
      key: 'description',
      severity: 'gap',
      title: 'Thin product description',
      detail: `The description is ${sentences === 0 ? 'a fragment' : 'a single sentence'}; it names the product without explaining it to a buyer.`,
    })
  }

  if (facts.structuredAttributes < 3) {
    gaps.push({
      key: 'attributes',
      severity: 'major',
      title: 'Attributes and values missing',
      detail:
        facts.structuredAttributes === 0
          ? 'No attribute is published as a named field with a value.'
          : `Only ${facts.structuredAttributes} attribute(s) are published as named fields with values.`,
    })
  } else if (facts.structuredAttributes < 6) {
    gaps.push({
      key: 'attributes',
      severity: 'gap',
      title: 'Few attributes',
      detail: `Only ${facts.structuredAttributes} attributes are published with values — not enough to compare or filter this product.`,
    })
  }

  if (facts.proseOnlyAttributes >= 2 && facts.structuredAttributes < 6) {
    gaps.push({
      key: 'prose',
      severity: 'gap',
      title: 'Values buried in text',
      detail: `${facts.proseOnlyAttributes} value(s) — such as material, size or application — are stated only inside sentences, not as attributes.`,
    })
  }

  if (!facts.present.code) {
    gaps.push({
      key: 'code',
      severity: 'gap',
      title: 'No product code',
      detail: 'No SKU, part number or model number is shown for the product.',
    })
  }

  if (!facts.present.measurements) {
    gaps.push({ key: 'measurements', severity: 'minor', title: 'No measurements', detail: 'No dimensions, weight or sizes with units are published.' })
  }
  if (!facts.present.gtin) {
    gaps.push({ key: 'gtin', severity: 'minor', title: 'No barcode', detail: 'No GTIN, UPC or EAN is published.' })
  }
  if (!facts.present.category) {
    gaps.push({ key: 'category', severity: 'minor', title: 'No category', detail: 'The page does not state which category the product belongs to.' })
  }
  if (!facts.present.documents) {
    gaps.push({ key: 'documents', severity: 'minor', title: 'No datasheet', detail: 'No datasheet or certificate is linked from the product.' })
  }
  if (!facts.hasProductSchema) {
    gaps.push({
      key: 'schema',
      severity: 'minor',
      title: 'Not machine-readable',
      detail: 'The product information is not published as structured product data, so feeds and search engines cannot read it as fields.',
    })
  }

  const order = { major: 0, gap: 1, minor: 2 }
  return gaps.sort((a, b) => order[a.severity] - order[b.severity])
}

/**
 * The rule that turns one product's information into "is our service needed".
 *
 *   needed      the core of the product information is missing (no
 *               description, or fewer than three attributes with values), or
 *               two or more clear shortfalls
 *   possible    one clear shortfall
 *   not_needed  none — the product is presented completely, in whatever
 *               style the company chose. Minor points (no barcode, no
 *               datasheet, not machine-readable) are never a reason on
 *               their own.
 */
export function decideServiceNeed(gaps: ProductGap[]): ServiceNeed {
  const major = gaps.filter((g) => g.severity === 'major').length
  const clear = gaps.filter((g) => g.severity === 'gap').length
  if (major > 0 || clear >= 2) return 'needed'
  if (clear === 1) return 'possible'
  return 'not_needed'
}

const ACTIONS: Record<string, { title: string; remediation: string; impact: string; effort: string }> = {
  description: {
    title: 'Write a complete product description',
    remediation: 'Write buyer-facing copy from the product’s own specifications: what it is, what it is for, where it is used, and what sets it apart.',
    impact: 'Buyers and search engines understand the product without having to ask.',
    effort: 'Low',
  },
  attributes: {
    title: 'Build the product’s full attribute set',
    remediation: 'Enrich the product with the attributes buyers compare on — material, size, standards, performance — each as a named field with a value.',
    impact: 'The product can be filtered, compared and syndicated to distributors.',
    effort: 'Medium',
  },
  prose: {
    title: 'Turn the values in the text into attributes',
    remediation: 'Lift the values the page states inside sentences into named attributes, in the page’s own words.',
    impact: 'Information the page already has becomes usable by filters and feeds.',
    effort: 'Low',
  },
  code: {
    title: 'Add product identifiers',
    remediation: 'Show the SKU, part or model number — and the GTIN where one exists — as their own fields.',
    impact: 'Enquiries, orders and distributor catalogues can match the product exactly.',
    effort: 'Low',
  },
  measurements: {
    title: 'Publish measurements with units',
    remediation: 'Add dimensions, weight and sizes as separate fields with their units.',
    impact: 'Buyers can confirm fit and suitability before ordering.',
    effort: 'Low',
  },
  gtin: {
    title: 'Add the barcode',
    remediation: 'Publish the GTIN/UPC for the product.',
    impact: 'Marketplaces and distributors can match it.',
    effort: 'Low',
  },
  category: {
    title: 'Classify the product',
    remediation: 'Place the product in a clear category path.',
    impact: 'It can be browsed alongside comparable products.',
    effort: 'Low',
  },
  documents: {
    title: 'Link the datasheet',
    remediation: 'Attach the datasheet or certificate to the product page.',
    impact: 'Specifiers can check the product without requesting documents.',
    effort: 'Low',
  },
  schema: {
    title: 'Make the product data machine-readable',
    remediation: 'Publish the product’s information as structured product data alongside the page.',
    impact: 'Search engines and AI assistants read the product as fields, not prose.',
    effort: 'Medium',
  },
}

function actionsFor(gaps: ProductGap[]): ProductPageAnalysis['recommendedActions'] {
  return gaps.map((g) => ACTIONS[g.key]).filter((a): a is NonNullable<typeof a> => Boolean(a)).slice(0, 4)
}

function whyFor(need: ServiceNeed, productName: string, gaps: ProductGap[], facts: Facts, sentences: number): string {
  if (need === 'not_needed') {
    return (
      `The "${productName}" page already presents its product information completely: ` +
      `${sentences >= 2 ? 'a full description' : 'a description'}, ${facts.structuredAttributes} attributes with values` +
      `${facts.present.code ? ', and a product code' : ''}. There is no genuine gap for our service to fill` +
      `${gaps.length ? ` — only minor points (${gaps.map((g) => g.title.toLowerCase()).join(', ')}).` : '.'}`
    )
  }
  const main = gaps.filter((g) => g.severity !== 'minor')
  return (
    `The "${productName}" page is missing core product information: ` +
    `${main.map((g) => g.detail.replace(/\.$/, '').replace(/^\w/, (c) => c.toLowerCase())).join('; ')}. ` +
    `Creating and structuring exactly this information — descriptions, attributes, values and identifiers — is what our service does.`
  )
}

function nextStepFor(need: ServiceNeed, productName: string, gaps: ProductGap[]): string {
  const lead = gaps.find((g) => g.severity !== 'minor')
  switch (need) {
    case 'needed':
      return `Contact this company. Use the "${productName}" page as the example${lead ? `, lead with "${ACTIONS[lead.key]?.title ?? lead.title}"` : ''}, and offer to show the same product with its information completed.`
    case 'possible':
      return `Worth a conversation. Show them the "${productName}" page${lead ? ` and the one clear gap: ${lead.title.toLowerCase()}` : ''}.`
    default:
      return 'No action: this product’s information is already complete, so there is no clear need to approach them with.'
  }
}

// ── Reading the page ─────────────────────────────────────────────────────

function attributesOf(
  specPairs: Array<{ key: string; value: string }>,
  record: EnrichedRecord,
  readPairs: Array<{ key: string; value: string }> = [],
): ProductAttribute[] {
  const out: ProductAttribute[] = []
  const seen = new Set<string>()
  const push = (name: string, value: string, source: ProductAttribute['source']) => {
    // "SKU:" in a spec row is the label's punctuation, not part of its name.
    const n = clip(plainText(name).replace(/\s*[:：]\s*$/, ''), 80)
    const v = clip(plainText(value), 200)
    const k = `${n.toLowerCase()}\u0000${v.toLowerCase()}`
    if (!n || !v || seen.has(k) || out.length >= 40) return
    seen.add(k)
    out.push({ name: n, value: v, source })
  }
  for (const p of specPairs) push(p.key, p.value, 'specification table')
  for (const p of readPairs) push(p.key, p.value, 'product page text')
  for (const f of record.fields) {
    if (f.method === 'json_ld' && f.before && ['product.brand', 'product.sku', 'product.mpn', 'product.gtin'].includes(f.field)) {
      push(f.label, f.before, 'structured data')
    }
  }
  for (const a of record.fields.flatMap((f) => f.derivedAttributes)) push(a.label, a.value, 'description text')
  return out
}

/** Site-wide contact and registration rows that sit in footers, not product specifications. */
const SITE_FURNITURE_KEY = /^(tel|telephone|phone|fax|e-?mail|address|cage(?: code)?|duns|hours|opening hours|toll[- ]free|call us|customer service)$/i

/** Two names describe the same thing when they share at least two real words. */
function sharesWords(a: string, b: string): boolean {
  const words = (s: string) => new Set(plainText(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  const bw = words(b)
  return [...words(a)].filter((w) => bw.has(w)).length >= 2
}

/** A catalogue's SEO line — "Browse …", or a list of field names — rather than words about the product. */
export function isBoilerplateDescription(text: string): boolean {
  const t = plainText(text)
  if (/^(browse|shop|buy|view|explore|discover)\b[\s\S]{0,250}\b(catalog|catalogue|range|selection|collection)\b/i.test(t)) return true
  if (/\bincluding\s+([^,.]{1,25},\s*){4,}/i.test(t)) return true
  return false
}

function descriptionOf(record: EnrichedRecord): string | null {
  const raw = record.fields.find((f) => f.field === 'product.description')?.before
  const text = raw ? plainText(raw) : ''
  return text.length >= 40 ? clip(text, 900) : null
}

/** A datasheet, certificate or spec sheet linked from the product page. */
function hasDocumentLink(html: string, pageUrl: string): boolean {
  return extractLinks(html, 800).some((l) => {
    const abs = resolveLink(l.href, pageUrl) ?? l.href
    return (
      /\.pdf(\?|#|$)/i.test(abs) ||
      /\b(data ?sheet|spec(ification)? sheet|technical data|safety data sheet|sds|tds|certificate|declaration of conformity|user manual|instructions)\b/i.test(l.text)
    )
  })
}

/** The product's own copy: the first real paragraph after its heading, else its meta description. */
export function descriptionFromPage(html: string): string | null {
  const start = Math.max(0, html.search(/<h1\b/i))
  const body = html.slice(start).replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ')
  for (const m of body.matchAll(/<(p|div|span|section)\b[^>]*>([^<]{80,})</gi)) {
    const text = plainText(m[2] ?? '')
    if (text.split(/\s+/).length < 12) continue
    if (/copyright|all rights reserved|cookie|privacy|javascript|©|warning:/i.test(text)) continue
    return clip(text, 900)
  }
  const meta = extractMeta(html, 'description')?.value
  const metaText = meta ? plainText(meta) : ''
  return metaText.split(/\s+/).length >= 12 ? clip(metaText, 900) : null
}

function fieldValue(record: EnrichedRecord, field: string): string | null {
  const v = record.fields.find((f) => f.field === field)?.before
  return v ? clip(plainText(v), 200) : null
}

/**
 * Model-numbered and objective-matching addresses first; a page in another
 * script (a Korean or Chinese product page for an English-language search)
 * last. Otherwise the site's own order.
 */
function rankCandidates(urls: string[], words: string[]): string[] {
  return urls
    .map((url, i) => ({
      url,
      i,
      score:
        (modelToken(url) ? 2 : 0) +
        words.filter((w) => url.toLowerCase().includes(w)).length -
        (/[^\x00-\x7FÀ-ɏ]/.test(safeDecode(safePath(url))) ? 10 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((c) => c.url)
}

/**
 * Sitemap pages worth opening as a product, best first.
 *
 * Excludes what is plainly not a product and the homepage; prefers a
 * product-shaped path, then a slug carrying a model number, then a slug of
 * several words.
 */
export function sitemapCandidates(urls: string[], homeUrl: string): string[] {
  const home = key(homeUrl)
  return urls
    .filter((u) => key(u) !== home && linkPriority(u, '') >= 0 && !nonProductPath(u))
    .map((u, i) => {
      let path = ''
      try {
        path = decodeURIComponent(new URL(u).pathname).toLowerCase()
      } catch {
        return null
      }
      const slug = path.split('/').filter(Boolean).pop() ?? ''
      const rank =
        (linkPriority(u, '') >= 60 ? 0 : 3) + (/\d/.test(slug) ? 0 : 1) + (slug.split(/[-_]/).length >= 3 ? 0 : 1)
      return { u, i, rank, slug }
    })
    .filter((x): x is { u: string; i: number; rank: number; slug: string } => x !== null && x.slug.length > 0)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.u)
}

/**
 * The products a family or category page lists.
 *
 * Unlike the audit's productLinksOn, a sibling address is kept: the items of
 * /products/hard-hats live at /products/titan-x200, right beside it.
 */
// Collects generously: a category page's menu repeats links already tried,
// and the enqueue step drops those, then puts model-numbered products first.
function productLinksBelow(html: string, pageUrl: string, max = 80): string[] {
  const host = hostOf(pageUrl)
  const here = key(pageUrl)
  const out: string[] = []
  const push = (href: string) => {
    const abs = resolveLink(href, pageUrl)
    if (!abs || out.length >= max || !sameCompany(abs, pageUrl)) return
    const k = key(abs)
    if (k === here || out.some((u) => key(u) === k) || nonProductPath(abs)) return
    out.push(abs)
  }
  // A listing that declares its products names each one's own page: those
  // links first, ahead of the listing's email / print / sort links.
  declaredProductLinks(html).forEach(push)
  extractProductTileLinks(html, 40).forEach(push)
  for (const l of extractLinks(html, 600)) {
    if (/\/(products?|item|sku|pd|pdp|p)\/[^/?#]+/i.test(l.href) || modelToken(resolveLink(l.href, pageUrl) ?? '')) push(l.href)
  }
  return out
}

/**
 * The page of each product a listing declares: the first link inside each
 * microdata Product block, and the url of each JSON-LD Product. In the
 * listing's own order.
 */
export function declaredProductLinks(html: string, max = 20): string[] {
  const out: string[] = []
  const starts = [...html.matchAll(/itemtype\s*=\s*["']https?:\/\/schema\.org\/(?:Product|IndividualProduct|ProductModel)["']/gi)].map((m) => m.index!)
  starts.forEach((start, i) => {
    const block = html.slice(start, Math.min(starts[i + 1] ?? html.length, start + 6000))
    const own = block.match(/itemprop\s*=\s*["']url["'][^>]*\s(?:href|content)\s*=\s*["']([^"']+)["']/i)?.[1] ?? extractLinks(block, 5)[0]?.href
    if (own && out.length < max) out.push(own)
  })
  for (const { node } of jsonLdNodes(extractJsonLd(html))) {
    if (hasType(node, 'Product', 'IndividualProduct', 'ProductModel') && typeof node.url === 'string' && out.length < max) out.push(node.url)
  }
  return out
}

/** Same-site links from a page, best catalogue candidates first. */
function rankedLinks(html: string, pageUrl: string): Array<{ url: string; score: number }> {
  const host = hostOf(pageUrl)
  const out = new Map<string, { url: string; score: number }>()
  for (const l of extractLinks(html, 600)) {
    const abs = resolveLink(l.href, pageUrl)
    if (!abs || !sameSite(hostOf(abs), host)) continue
    const k = key(abs)
    const score = linkPriority(abs, l.text ?? '')
    const prev = out.get(k)
    if (!prev || prev.score < score) out.set(k, { url: abs, score })
  }
  return [...out.values()].sort((a, b) => b.score - a.score)
}

/** The PDP check's headline, reworded for a page that is not an End PDP link. */
function plainHeadline(headline: string): string {
  return headline
    .replace(/^End PDP (link )?(points to|holds|is)?\s*/i, '')
    .replace(/^\w/, (c) => c.toUpperCase())
}

const STOP = new Set(['companies', 'company', 'with', 'that', 'from', 'this', 'their', 'they', 'find', 'which', 'based', 'usa', 'and', 'the', 'for', 'products', 'manufacturers', 'suppliers'])

function objectiveWords(objective: string): string[] {
  return [...new Set(objective.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))]
}

/** Query parameters that pick a language or tag a visit — the same page either way. */
const PRESENTATION_PARAMS = /^(locale|lang|language|default|hslang|ref|source|src|view)$/i

function key(url: string): string {
  const base = normalizeUrlForDedup(url) ?? url
  try {
    const u = new URL(base)
    // A product-shaped path names the product by itself; its query string
    // only records how the visitor arrived (?tid=574996).
    if (/\/(p|product|products|item|dp)\/[^/]+/i.test(u.pathname)) u.search = ''
    for (const name of [...u.searchParams.keys()]) if (PRESENTATION_PARAMS.test(name)) u.searchParams.delete(name)
    return u.toString().replace(/\?$/, '')
  } catch {
    return base
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

function plainText(s: string): string {
  return htmlToText(s).replace(/\s+/g, ' ').trim()
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
