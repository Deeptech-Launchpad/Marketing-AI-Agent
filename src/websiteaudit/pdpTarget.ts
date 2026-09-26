import { classifyCompanyUrl } from '../crm/companySource.js'
import { looksLikeAppShell } from '../research/appShell.js'
import type { RawPageResult } from '../research/pageFetch.js'
import { htmlToText } from '../research/htmlToText.js'
import { extractProductObservations } from './extraction.js'
import {
  countProductTiles,
  extractHeadings,
  extractLinks,
  extractMeta,
  extractProductTileLinks,
  extractSpecPairs,
  extractTitle,
  productDetailSignals,
  wordCount,
} from './htmlStructure.js'
import { classifyPage } from './pageClassifier.js'
import type { PageType } from './types.js'
import { hostOf, resolveLink, sameSite } from './urls.js'

// THE END PDP LINK — WHICH OF THREE SITUATIONS THIS COMPANY IS IN.
//
// The Website Audit audits ONE page: the product detail page recorded against
// the company in NXT Sales (Company.endPdpUrl). Before anything is audited, the
// link itself is checked, because a large share of stored values are not a
// product page at all — a placeholder word, a Facebook page, a homepage, a
// category listing, a link that no longer resolves.
//
//   valid_product  the link loads a page that shows one product → audit it
//   link_problem   a link exists but is not a usable product page → say exactly
//                  what is wrong and what the marketing agent should do next
//   no_link        nothing usable is recorded → recommend how to get one
//
// The decision is made from what the page SERVED (its markup, its declared
// type, its content), never from the company's name or domain. There is no
// company-specific rule anywhere here, and no guessed replacement URL: a
// suggested product link is only ever a link the page itself published.

export type PdpCase = 'valid_product' | 'link_problem' | 'no_link'

export type PdpIssue =
  | 'no_link'
  | 'not_a_url'
  | 'social_profile'
  | 'unreachable'
  | 'http_error'
  | 'not_html'
  | 'product_missing'
  | 'redirected_away'
  | 'category_page'
  | 'homepage'
  | 'not_a_product_page'
  | 'javascript_only'
  | 'search_results_link'

export interface PdpAssessment {
  case: PdpCase
  issue: PdpIssue | null
  /** Exactly what NXT Sales holds in End PDP, before any cleaning. */
  endPdpValue: string | null
  /** The link as it was requested, when it could be read as one. */
  url: string | null
  /** Where the request landed after redirects. */
  finalUrl: string | null
  httpStatus: number | null
  pageType: PageType | null
  /** The product the page names, when it names one. */
  productName: string | null
  /** One line for a status chip. */
  headline: string
  /** What was found, in plain words. */
  explanation: string
  /** What the marketing agent should do next, in order. */
  recommendations: string[]
  /** Product links THIS page published, offered as replacements. Never guessed. */
  suggestedProductUrls: string[]
  /** The classifier's own reasons, kept so the verdict can be checked. */
  signals: string[]
}

/** Title or heading wording that means the product is no longer there. */
const MISSING_PRODUCT =
  /\b(page (was )?not found|404|not found|no longer (available|exists)|product (is )?(unavailable|not available|discontinued)|does not exist|cannot be found|could not be found|nothing (was )?found|no products? (were )?found|item (is )?no longer)\b/i

const UPDATE_FIELD = 'Update the End PDP field on the company in NXT Sales, then run the Website Audit again.'

function recommendationForMissingLink(website: string | null): string[] {
  return [
    website
      ? `Open the customer's website (${website}) and choose one representative product page — ideally a product with specifications, so the enrichment has something to show.`
      : 'Find the customer\'s online catalogue or web shop (check their email domain, the CRM notes, or ask the account owner) and choose one representative product page.',
    'Paste that product page URL into the End PDP field on the company in NXT Sales.',
    'Run the Website Audit again — the PDP audit and the enrichment report are generated from that one page.',
  ]
}

export interface AssessInput {
  endPdpValue: string | null | undefined
  /** The company's own website, when NXT Sales records one. Used only in advice. */
  companyWebsite: string | null
  /** The fetch of the link. Null when there was nothing to fetch. */
  fetched: RawPageResult | null
}

/**
 * Whether the End PDP value can be fetched at all, and what to fetch.
 *
 * Split from `assessPdpPage` so the caller only reaches the network for a value
 * that is actually a link to a website.
 */
export function readEndPdpValue(
  endPdpValue: string | null | undefined,
  companyWebsite: string | null,
): { fetchUrl: string } | { assessment: PdpAssessment } {
  const raw = String(endPdpValue ?? '').trim()
  const base = {
    endPdpValue: endPdpValue ?? null,
    finalUrl: null,
    httpStatus: null,
    pageType: null,
    productName: null,
    suggestedProductUrls: [],
    signals: [],
  }

  if (!raw) {
    return {
      assessment: {
        ...base,
        case: 'no_link',
        issue: 'no_link',
        url: null,
        headline: 'No End PDP link recorded',
        explanation: 'NXT Sales has no End PDP link for this company, so there is no product page to audit.',
        recommendations: recommendationForMissingLink(companyWebsite),
      },
    }
  }

  const classified = classifyCompanyUrl(raw)
  if (classified.kind === 'invalid' || !classified.url) {
    return {
      assessment: {
        ...base,
        case: 'no_link',
        issue: 'not_a_url',
        url: null,
        headline: 'End PDP holds text, not a link',
        explanation: `The End PDP field contains "${raw.slice(0, 80)}", which is not a web address, so there is no product page to audit.`,
        recommendations: recommendationForMissingLink(companyWebsite),
      },
    }
  }

  if (classified.kind === 'social_profile' || classified.kind === 'platform_root') {
    return {
      assessment: {
        ...base,
        case: 'link_problem',
        issue: 'social_profile',
        url: classified.url,
        headline: `End PDP points to ${classified.platform ?? 'a social platform'}`,
        explanation:
          `The End PDP link is a ${classified.platform ?? 'social media'} page, not a product page on the customer's own website. ` +
          'Social pages carry no structured product record, so a PDP audit cannot be run on it.',
        recommendations: [
          companyWebsite
            ? `Check whether the customer sells online at ${companyWebsite}; if so, pick one product page there.`
            : 'Check whether the customer has a website or web shop at all (search their name, check their email domain, ask the account owner).',
          'If they do, paste a product page URL into End PDP and run the audit again.',
          'If they have no online catalogue, treat this as a catalogue-creation opportunity: request a product list or price file from the customer instead of a PDP audit.',
        ],
      },
    }
  }

  // A link to a search engine's results is a search someone ran, not a page
  // the customer publishes.
  try {
    const u = new URL(classified.url)
    if (/(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu)\.[a-z.]+$/i.test(u.hostname) && /\/(search|maps|url)\b/i.test(u.pathname)) {
      return {
        assessment: {
          ...base,
          case: 'link_problem',
          issue: 'search_results_link',
          url: classified.url,
          headline: 'End PDP holds a search-engine link',
          explanation:
            'The End PDP field contains a search-engine results link (for example a Google search or map listing), not a page on the customer\'s own website.',
          recommendations: [
            companyWebsite
              ? `Open the customer's website (${companyWebsite}) and choose one product page with specifications.`
              : 'Find the customer\'s own website from the search listing (the "Website" button on a map listing), then choose one product page on it.',
            'Paste that product page URL into End PDP and run the Website Audit again.',
            'If the customer has no website, this is a catalogue-creation opportunity rather than a PDP audit: request their product list or price file.',
          ],
        },
      }
    }
  } catch {
    /* classified.url is already a valid URL */
  }

  return { fetchUrl: classified.url }
}

/** Names a page heading or title uses for something other than the product. */
const GENERIC_NAME =
  /^(product details?|details|more details|about( us)?|contact( us)?|home|shop|store|products?|overview|description|specifications?|our showroom|showroom|welcome|catalog(ue)?|categories|search results?|cart|checkout|my account|login)$/i

export interface ProductEvidence {
  score: number
  listingScore: number
  name: string | null
  reasons: string[]
}

/**
 * How strongly ONE page presents ONE product.
 *
 * The crawler's classifier is tuned to steer a crawl, and accepts a single
 * add-to-cart button as a product page — which is also true of a homepage with
 * a featured-products strip. Deciding whether a link the sales team saved is a
 * usable PDP needs corroboration, so this sums independent, generic signals:
 * what the page declares about itself, whether its title and heading agree on
 * a name, whether it carries product identifiers and specification rows, and
 * whether it looks like one item or a grid of many.
 */
export function productEvidence(html: string, url: string): ProductEvidence {
  const reasons: string[] = []
  let score = 0
  let listingScore = 0
  const add = (n: number, why: string) => {
    score += n
    reasons.push(`+${n} ${why}`)
  }

  const product = extractProductObservations(html, url)
  const ldName = product.find((o) => o.field === 'product.name' && o.status === 'observed' && o.method === 'json_ld')?.value?.trim()
  if (ldName) add(3, 'declares a schema.org Product')
  else if (/itemtype\s*=\s*["']https?:\/\/schema\.org\/Product["']/i.test(html)) add(3, 'declares schema.org/Product microdata')

  const ogType = extractMeta(html, 'og:type')?.value?.toLowerCase() ?? ''
  if (ogType.includes('product')) add(2, `og:type is "${ogType}"`)
  if (productDetailSignals(html).length) add(2, 'has a single-product detail container')

  // Title and main heading agreeing on a name is how a product page reads.
  const title = extractTitle(html)?.value ?? ''
  const titleName = title.split(/\s+[|–—]\s+/)[0]!.trim()
  const headings = extractHeadings(html, 30)
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const agrees = (h: string) =>
    Boolean(titleName) && norm(h).length >= 4 && (norm(titleName).includes(norm(h)) || norm(h).includes(norm(titleName)))
  // The heading that names the same item as the title — not merely the first
  // heading, which on many templates is "Product details" or a section label.
  const matching = headings.find((h) => h.level <= 2 && !GENERIC_NAME.test(h.text.trim()) && agrees(h.text))?.text.trim() ?? null
  const h1 = matching ?? headings.find((h) => h.level === 1 && !GENERIC_NAME.test(h.text.trim()))?.text.trim() ?? null
  if (matching) add(1, 'title and a main heading name the same item')

  const text = htmlToText(html)
  if (/\b(sku|mpn|part\s*(no|number|#)|item\s*(code|no)|product\s*code|model\s*(no|number)|ref(erence)?\s*(no|code)?)\s*[:#]/i.test(text)) {
    add(1, 'shows a product identifier label')
  }
  const specs = extractSpecPairs(html, 60).filter((p) => !/cookie|consent|duration|provider|expiry/i.test(`${p.key} ${p.value}`))
  if (specs.length >= 3) add(1, `carries ${specs.length} specification rows`)

  if (/\/(products?|item|sku|pd\d*|pdp|p|product-page|productdetails?)\/?[^/]*[a-z0-9]/i.test(new URL(url).pathname + new URL(url).search)) {
    add(1, 'URL is shaped like a product page')
  }

  // A URL slug that repeats the title's words names one specific item; a
  // category slug ("accessories", "water-heaters") shares one or two at most.
  const slugWords = new Set(
    decodeURIComponent(new URL(url).pathname)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  )
  const titleWords = norm(titleName).split(' ').filter((w) => w.length >= 3)
  const shared = titleWords.filter((w) => slugWords.has(w)).length
  if (!GENERIC_NAME.test(titleName) && shared >= 3) add(2, `URL slug repeats ${shared} words of the page title`)

  const cartButtons =(html.match(/\b(add[-_\s]?to[-_\s]?(cart|basket|bag|quote)|addtocart)\b/gi) ?? []).length
  if (cartButtons >= 1 && cartButtons <= 3) add(1, 'has an add-to-cart control')

  const prices = new Set(text.match(/(?:[€£$]|\b(?:EUR|GBP|USD|AED|AUD)\s?)\s?\d[\d,]*(?:\.\d{2})?/g) ?? [])
  if (prices.size >= 1 && prices.size <= 3) add(1, 'shows a single price')

  // A grid of many items is a listing, however product-like each tile is.
  const tiles = countProductTiles(html)
  if (tiles >= 6) listingScore += 2
  if (cartButtons >= 6) listingScore += 2
  if (prices.size >= 8) listingScore += 1

  const name =
    ldName ||
    matching ||
    (titleName && !GENERIC_NAME.test(titleName) ? titleName : null) ||
    (h1 && !GENERIC_NAME.test(h1) ? h1 : null) ||
    null

  return { score, listingScore, name: name ? name.slice(0, 200) : null, reasons }
}

/**
 * Decides the case from what the page actually served.
 *
 * Pure: takes the fetch result, reaches no network. Every branch below is a
 * property of the response or the markup, which is what keeps it generic.
 */
export function assessPdpPage(input: AssessInput & { fetchUrl: string }): PdpAssessment {
  const { fetched, fetchUrl, companyWebsite } = input
  const base = {
    endPdpValue: input.endPdpValue ?? null,
    url: fetchUrl,
    finalUrl: fetched?.finalUrl ?? null,
    httpStatus: fetched?.status ?? null,
    pageType: null as PageType | null,
    productName: null as string | null,
    suggestedProductUrls: [] as string[],
    signals: [] as string[],
  }
  const problem = (
    issue: PdpIssue,
    headline: string,
    explanation: string,
    recommendations: string[],
    extra: Partial<PdpAssessment> = {},
  ): PdpAssessment => ({ ...base, case: 'link_problem', issue, headline, explanation, recommendations, ...extra })

  if (!fetched || (fetched.status === null && !fetched.ok)) {
    return problem(
      'unreachable',
      'End PDP link could not be reached',
      `The link could not be loaded: ${fetched?.reason ?? 'no response'}. The site may be down, the domain may have lapsed, or the address may be mistyped.`,
      [
        'Open the link in a browser to confirm whether the site is down or the address is wrong.',
        'If the product has moved, find its current page on the customer\'s website.',
        UPDATE_FIELD,
      ],
    )
  }

  if (!fetched.ok) {
    const gone = fetched.status === 404 || fetched.status === 410
    return problem(
      'http_error',
      gone ? 'Product page no longer exists' : `End PDP link returned HTTP ${fetched.status}`,
      gone
        ? `The site answered HTTP ${fetched.status}: the product page has been removed or renamed.`
        : `The site answered HTTP ${fetched.status}, so no product content could be read.`,
      [
        gone
          ? 'Find the product (or a comparable one) on the customer\'s current website.'
          : 'Try the link again later; if it keeps failing, choose another product page.',
        UPDATE_FIELD,
      ],
    )
  }

  const html = fetched.html
  const finalUrl = fetched.finalUrl ?? fetchUrl
  if (!html.trim()) {
    return problem(
      'not_html',
      'End PDP link is not a web page',
      `The link returned ${fetched.contentType ?? 'a non-HTML response'} rather than a web page.`,
      ['If this is a PDF or file download, find the product\'s web page instead.', UPDATE_FIELD],
    )
  }

  const classification = classifyPage(html, finalUrl)
  base.pageType = classification.pageType
  base.signals = classification.signals.slice(0, 8)

  const suggestions = productLinksOn(html, finalUrl)
  base.suggestedProductUrls = suggestions

  // Redirected somewhere else entirely — usually the homepage after a product
  // was deleted. The requested path had content; the landing path is the root.
  const requestedPath = pathOf(fetchUrl)
  const landedPath = pathOf(finalUrl)
  if (requestedPath !== '/' && landedPath === '/' && sameSite(hostOf(fetchUrl), hostOf(finalUrl))) {
    return problem(
      'redirected_away',
      'Product link now redirects to the homepage',
      'The End PDP link redirects to the site\'s homepage, which is what most shops do after a product is removed.',
      [
        'Search the customer\'s website for the product; if it is gone, choose a current product page.',
        UPDATE_FIELD,
      ],
      { finalUrl },
    )
  }

  const title = extractTitle(html)?.value ?? ''
  const h1 = extractHeadings(html, 5).find((h) => h.level === 1)?.text ?? ''
  if (MISSING_PRODUCT.test(`${title} ${h1}`)) {
    return problem(
      'product_missing',
      'Page loads, but the product is missing',
      `The page responds, but it says "${(h1 || title).slice(0, 120)}" — the product is no longer listed there.`,
      [
        'Find the product (or a comparable one) on the customer\'s current website.',
        UPDATE_FIELD,
      ],
    )
  }

  // A homepage is never the product page, whatever it features.
  if (landedPath === '/') {
    return problem(
      'homepage',
      'End PDP points to the homepage',
      "The link opens the website's homepage, not a product page.",
      [
        suggestions.length > 0
          ? 'Pick one of the product pages the homepage links to (listed below), and paste it into End PDP.'
          : "Open the website, click through to a single product, and copy that product page's URL into End PDP.",
        'Run the Website Audit again.',
      ],
    )
  }

  const evidence = productEvidence(html, finalUrl)
  base.signals = [...evidence.reasons, ...base.signals].slice(0, 12)
  // Product pages routinely carry a "related products" strip, so listing
  // signals only outweigh product evidence that is itself weak.
  const isProduct = Boolean(evidence.name) && (evidence.score >= 4 || (evidence.score >= 3 && evidence.listingScore < 2))

  if (isProduct) {
    const name = evidence.name!
    return {
      ...base,
      case: 'valid_product',
      issue: null,
      productName: name,
      finalUrl,
      headline: 'Valid product page',
      explanation: `The End PDP link loads a single product page for "${name}". The audit and enrichment report are built from this page.`,
      recommendations: [],
      suggestedProductUrls: [],
    }
  }

  if (evidence.score >= 3 && evidence.listingScore < 2 && !evidence.name) {
    return problem(
      'product_missing',
      'Product page shows no product',
      'The page has product-page markup but names no product — it is most likely an empty or removed listing.',
      ['Choose a product page that shows a named product with its details.', UPDATE_FIELD],
    )
  }

  // A page rendered entirely by JavaScript serves an empty shell to anything
  // that is not a full browser. That is a real limitation to name, not a
  // reason to call the page broken.
  if (looksLikeAppShell(html) && wordCount(html) < 60) {
    return problem(
      'javascript_only',
      'Product page only renders in a browser',
      'The page loads its content with JavaScript, so its product details could not be read from the page source.',
      [
        'Open the link in a browser and confirm it shows a product.',
        'If it does, note that the site is JavaScript-rendered; choose a product page that shows details without scripts if one exists, or request the product data from the customer directly.',
        UPDATE_FIELD,
      ],
    )
  }

  const pickFromList =
    suggestions.length > 0
      ? `Pick one of the product pages this page links to (listed below), and paste it into End PDP.`
      : 'Open the page, click through to a single product, and copy that product page\'s URL into End PDP.'

  if (
    evidence.listingScore >= 2 ||
    classification.pageType === 'category' ||
    classification.pageType === 'listing' ||
    classification.pageType === 'search'
  ) {
    return problem(
      'category_page',
      'End PDP points to a category page, not a product',
      'The link opens a page that lists several products rather than one product\'s detail page. A PDP audit needs a single product.',
      [pickFromList, 'Run the Website Audit again.'],
    )
  }

  return problem(
    'not_a_product_page',
    'End PDP link is not a product page',
    `The link opens a ${classification.pageType === 'unknown' ? 'page that shows no single product' : `${classification.pageType} page`}, not a product detail page.`,
    [
      pickFromList,
      companyWebsite ? `If nothing suitable is linked, browse ${companyWebsite} for a product with specifications.` : 'Run the Website Audit again.',
    ].filter(Boolean),
  )
}

function pathOf(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '')
    return p || '/'
  } catch {
    return '/'
  }
}

/**
 * Product-looking links the page itself published, on the same site.
 *
 * Offered to the marketing agent as candidates only. Nothing is audited from
 * this list automatically — a person chooses.
 */
export function productLinksOn(html: string, pageUrl: string, max = 5): string[] {
  const host = hostOf(pageUrl)
  const out: string[] = []
  const push = (href: string) => {
    const abs = resolveLink(href, pageUrl)
    if (!abs || out.includes(abs) || !sameSite(hostOf(abs), host)) return
    if (pathOf(abs) === pathOf(pageUrl)) return
    // A sibling or parent of this page is another listing, not a product:
    // /products/room/indoor-tiles next to /products/room/water-heaters.
    const here = pathOf(pageUrl).split('/').filter(Boolean)
    const there = pathOf(abs).split('/').filter(Boolean)
    const sameParent = here.length === there.length && here.slice(0, -1).join('/') === there.slice(0, -1).join('/')
    const isAncestor = there.length < here.length && here.slice(0, there.length).join('/') === there.join('/')
    if (sameParent || isAncestor) return
    out.push(abs)
  }
  for (const href of extractProductTileLinks(html, 40)) {
    if (out.length >= max) break
    push(href)
  }
  if (out.length < max) {
    for (const l of extractLinks(html, 400)) {
      if (out.length >= max) break
      if (/\/(products?|item|sku|pd|pdp|p|product-page)\/[^/?#]+/i.test(l.href)) push(l.href)
    }
  }
  return out
}
