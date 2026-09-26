import { htmlToText } from '../research/htmlToText.js'
import { extractHeadings, extractLinks } from '../websiteaudit/htmlStructure.js'
import { resolveLink } from '../websiteaudit/urls.js'

// THE PRODUCT PAGE, AS THE BUYER SEES IT.
//
// Prospects used to keep the product's link and a verdict. Sales asked for the
// page itself: the picture, the price and how it is sold (quantity, lot size,
// add-to-cart or request-a-quote), the downloads, and every specification row
// — the same things a buyer sees when they open the link.
//
// Everything here is read off the fetched page and kept verbatim. Nothing is
// inferred from the company, the category or another page: a price is only
// recorded when the page declares one or labels one, a download only when the
// page links it, a buying option only when the page shows it. What the page
// does not show stays absent.

export interface ProductPageDetails {
  /** The product's heading, as published. */
  title: string | null
  /** Product pictures, largest-first as the page lists them. */
  images: string[]
  /** SKU, part number, model, GTIN, brand — each as the page states it. */
  identifiers: Array<{ label: string; value: string }>
  price: {
    amount: string
    currency: string | null
    /** The page's own label for it: "List Price", "Your Price", … */
    label: string | null
    /** Where it was read: the page's price declaration, or labelled page text. */
    source: 'structured data' | 'page text'
  } | null
  /** When the page withholds a price and says so ("Call for price", "Login for pricing"), its words. */
  priceNote: string | null
  availability: string | null
  /** How the product is ordered: minimum quantity, multiples, lot or pack size, unit. */
  ordering: Array<{ label: string; value: string }>
  /** The buying actions the product page offers, in its own words ("Add To Cart", "Request Quote"). */
  buyingOptions: string[]
  /** Datasheets, spec sheets, manuals, certificates and drawings linked from the product. */
  downloads: Array<{ label: string; url: string; fileType: string | null }>
}

/** Markup a person never sees, which would otherwise be read as if they did. */
export function readableHtml(html: string): string {
  return (
    html
      // A commented-out block is not on the page; one old breadcrumb in a
      // comment was being read as the product's category.
      .replace(/<!--[\s\S]*?-->/g, '')
      // Hidden leaf text ("N/A" placeholders shown only when a value is
      // missing) was being glued onto every specification value. Leaf
      // elements only, and never one carrying microdata.
      .replace(
        /<(span|div|p|li|td|small|em|strong|b|i|label)\b(?![^>]*\bitemprop=)[^>]*?(?:\bclass\s*=\s*["'][^"']*\b(?:nodisplay|hidden|d-none|is-hidden|sr-only|visually-hidden|screen-reader-text)\b[^"']*["']|\bstyle\s*=\s*["'][^"']*display\s*:\s*none[^"']*["']|\shidden(?=[\s>]))[^>]*>[^<]*<\/\1>/gi,
        '',
      )
  )
}

/** The product's own part of the page: from its heading to the footer. */
export function productRegion(html: string): string {
  const h1 = html.search(/<h1\b/i)
  const start = h1 >= 0 ? h1 : Math.max(0, html.search(/<main\b/i))
  const rest = html.slice(start)
  const footer = rest.search(/<footer\b|id=["'](?:site-)?footer["']|class=["'][^"']*\bsite-footer\b/i)
  return footer > 0 ? rest.slice(0, footer) : rest
}

const IMAGE_FURNITURE = /(logo|sprite|icon|placeholder|blank|spacer|pixel|favicon|badge|flag|payment|social|banner|avatar|loading|spinner)/i

function imageSources(tag: string): string[] {
  const out: string[] = []
  for (const attr of ['data-zoom-image', 'data-large_image', 'data-large', 'data-src', 'data-original', 'data-lazy-src', 'src', 'data-srcset', 'srcset']) {
    const m = tag.match(new RegExp(`\\s${attr}\\s*=\\s*["']([^"']+)["']`, 'i'))
    const raw = m?.[1]?.split(',')[0]?.trim().split(/\s+/)[0]
    if (raw && !raw.startsWith('data:')) out.push(raw)
  }
  return out
}

function significantTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((t) => !['the', 'and', 'for', 'with', 'item', 'size', 'length'].includes(t))
}

function readImages(region: string, pageUrl: string, primary: string | null, title: string | null, sku: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | null) => {
    if (!raw) return
    const abs = resolveLink(raw, pageUrl)
    if (!abs || /\.svg(\?|$)/i.test(abs) || IMAGE_FURNITURE.test(abs)) return
    // The same picture in several sizes (/ImgSmall/X.png, /ImgMedium/X.png) is one picture.
    const file = (abs.split(/[?#]/)[0]!.split('/').pop() ?? abs).toLowerCase()
    if (seen.has(file) || out.length >= 6) return
    seen.add(file)
    out.push(abs)
  }
  push(primary)
  const nameTokens = new Set(significantTokens(title ?? ''))
  const skuLow = sku?.toLowerCase() ?? null
  for (const tag of region.match(/<img\b[^>]*>/gi) ?? []) {
    const alt = tag.match(/\salt\s*=\s*["']([^"']*)["']/i)?.[1] ?? ''
    const srcs = imageSources(tag)
    if (!srcs.length) continue
    const altMatch = significantTokens(alt).filter((t) => nameTokens.has(t)).length >= 2
    const skuMatch = Boolean(skuLow && skuLow.length >= 4 && srcs.some((s) => s.toLowerCase().includes(skuLow)))
    if (altMatch || skuMatch) push(srcs[0]!)
  }
  return out
}

const DOCUMENT_EXT = /\.(pdf|docx?|xlsx?|dwg|dxf|stp|step|igs|iges|zip|stl)(?:[?#]|$)/i
const DOCUMENT_WORDS = /\b(data ?sheet|spec(?:ification)?s?(?: sheet)?|technical data|safety data sheet|sds|msds|tds|certificate|declaration of conformity|user manual|manual|instructions|installation guide|brochure|drawing|cad|3d model|catalog page)\b/i
const NOT_PRODUCT_DOCUMENT = /\b(privacy|terms|conditions|cookie|credit application|w-?9|line ?card|careers?|job|returns? policy|sitemap)\b/i

function readDownloads(region: string, pageUrl: string): ProductPageDetails['downloads'] {
  const out: ProductPageDetails['downloads'] = []
  const seen = new Set<string>()
  // The asset type some catalogue platforms put on the link itself.
  const typeOf = new Map<string, string>()
  for (const m of region.matchAll(/<a\b[^>]*data-assettype\s*=\s*["']([^"']+)["'][^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    typeOf.set(m[2]!, m[1]!.toUpperCase())
  }
  for (const link of extractLinks(region, 800)) {
    const abs = resolveLink(link.href, pageUrl)
    if (!abs) continue
    const text = link.text.replace(/\s+/g, ' ').trim()
    const isDoc = DOCUMENT_EXT.test(abs) || (DOCUMENT_WORDS.test(text) && text.length <= 80)
    if (!isDoc || NOT_PRODUCT_DOCUMENT.test(`${text} ${abs}`)) continue
    const key = abs.toLowerCase()
    if (seen.has(key) || out.length >= 12) continue
    seen.add(key)
    let file = ''
    try {
      file = decodeURIComponent(new URL(abs).pathname.split('/').pop() ?? '')
    } catch {
      file = ''
    }
    const ext = abs.match(DOCUMENT_EXT)?.[1]?.toUpperCase() ?? typeOf.get(link.href) ?? null
    out.push({ label: text || file || abs, url: abs, fileType: ext })
  }
  return out
}

const BUYING = /^(add to (?:cart|basket|bag|quote|order|list)|buy(?: it)? now|order now|request (?:a )?quote|get (?:a )?quote|request (?:a )?price|request pricing|send (?:an )?(?:inquiry|enquiry)|inquire(?: now)?|enquire(?: now)?|check (?:stock|availability)|where to buy|find a (?:distributor|dealer|reseller)|contact (?:us )?(?:for|about) (?:price|pricing|this product)|request (?:a )?sample|add to rfq)$/i

function readBuyingOptions(region: string): string[] {
  const texts: string[] = []
  for (const m of region.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi)) texts.push(htmlToText(m[2]!))
  for (const m of region.matchAll(/<input\b[^>]*type\s*=\s*["'](?:submit|button)["'][^>]*>/gi)) {
    const v = m[0].match(/\svalue\s*=\s*["']([^"']+)["']/i)?.[1]
    if (v) texts.push(v)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of texts) {
    const clean = t.replace(/\s+/g, ' ').trim()
    if (!clean || clean.length > 40 || !BUYING.test(clean)) continue
    const k = clean.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(clean)
  }
  return out.slice(0, 6)
}

const PRICE_LABEL = /\b(list price|msrp|rrp|our price|your price|sale price|unit price|net price|price each|price)\b/i
const PRICE_WITHHELD =
  /\b(call for (?:price|pricing)|(?:log ?in|sign ?in|register) (?:to|for) (?:see |view )?(?:price|pricing|prices)|contact us for (?:price|pricing)|price on (?:request|application)|request (?:a )?quote for pricing|pricing available upon request)\b/i

function readPrice(regionText: string, declared: { amount: string | null; currency: string | null }): { price: ProductPageDetails['price']; priceNote: string | null } {
  const label = regionText.match(/\b(list price|msrp|rrp|our price|your price|sale price|unit price|net price)\b/i)?.[1] ?? null
  if (declared.amount) {
    return { price: { amount: declared.amount, currency: declared.currency, label: label ? titleCase(label) : null, source: 'structured data' }, priceNote: null }
  }
  // Only a price the page LABELS as one: a bare currency amount could be a
  // shipping threshold or a competitor comparison.
  const m = regionText.match(/\b(list price|msrp|rrp|our price|your price|sale price|unit price|net price|price each|price)\b\s*[:\-–]?\s*((?:US)?[$£€]\s?\d[\d,]*(?:\.\d{1,2})?)/i)
  if (m && PRICE_LABEL.test(m[1]!)) {
    const symbol = m[2]!.match(/[$£€]/)?.[0]
    return {
      price: { amount: m[2]!.replace(/^(US)?[$£€]\s?/, ''), currency: symbol === '£' ? 'GBP' : symbol === '€' ? 'EUR' : symbol === '$' ? (m[2]!.startsWith('US') ? 'USD' : '$') : null, label: titleCase(m[1]!), source: 'page text' },
      priceNote: null,
    }
  }
  const withheld = regionText.match(PRICE_WITHHELD)?.[0] ?? null
  return { price: null, priceNote: withheld ? titleCase(withheld) : null }
}

function readAvailability(declared: string | null, regionText: string): string | null {
  if (declared) {
    const tail = declared.split('/').pop() ?? declared
    return tail.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase())
  }
  const m = regionText.match(/\b(in stock|out of stock|back[- ]?order(?:ed)?|pre-?order|discontinued|available to ship|ships (?:within|in) [^.\n]{1,25}|lead time:? [^.\n]{1,25})/i)
  return m ? m[1]!.trim().replace(/^\w/, (c) => c.toUpperCase()) : null
}

const ORDERING_KEY =
  /\b(lot size|pack(?:age)? (?:size|qty|quantity)|package type|packaging|min(?:imum)?\.? ?(?:order)? ?(?:qty|quantity)|moq|unit of (?:measure|sale)|uom|sold (?:as|in|by)|case (?:qty|quantity)|(?:qty|quantity) per|order (?:multiple|increment)|standard pack)\b/i

function readOrdering(region: string, specPairs: Array<{ key: string; value: string }>): ProductPageDetails['ordering'] {
  const out: ProductPageDetails['ordering'] = []
  const seen = new Set<string>()
  const push = (label: string, value: string) => {
    const k = label.toLowerCase()
    if (!value || seen.has(k)) return
    seen.add(k)
    out.push({ label, value })
  }
  // A quantity box that enforces a minimum or a step is the page stating one.
  for (const tag of region.match(/<input\b[^>]*>/gi) ?? []) {
    if (!/(qty|quantity)/i.test(tag)) continue
    const min = tag.match(/\sdata-min-?qty\s*=\s*["'](\d+)["']/i)?.[1] ?? tag.match(/\smin\s*=\s*["'](\d+)["']/i)?.[1]
    const step = tag.match(/\sdata-qty-?increment\s*=\s*["'](\d+)["']/i)?.[1] ?? tag.match(/\sstep\s*=\s*["'](\d+)["']/i)?.[1]
    if (min && Number(min) > 1) push('Minimum order quantity', min)
    if (step && Number(step) > 1) push('Order in multiples of', step)
  }
  for (const p of specPairs) {
    const key = p.key.replace(/\s*[:：]\s*$/, '').trim()
    if (ORDERING_KEY.test(key)) push(key, p.value.replace(/\s+/g, ' ').trim())
  }
  return out.slice(0, 8)
}

/** The ISO currency code a price declaration carries in its content attribute ("$" is shown, "USD" declared). */
function declaredCurrencyCode(html: string): string | null {
  const m =
    html.match(/itemprop\s*=\s*["']priceCurrency["'][^>]*\scontent\s*=\s*["']([A-Z]{3})["']/) ??
    html.match(/\scontent\s*=\s*["']([A-Z]{3})["'][^>]*itemprop\s*=\s*["']priceCurrency["']/)
  return m?.[1] ?? null
}

/**
 * The page's own breadcrumb trail ("All Categories > DIN Rail > Item # X"),
 * read from the element the page marks as its breadcrumb. Hidden copies inside
 * it (an SEO list) are cut off, so the trail is what a person sees.
 */
export function readBreadcrumb(html: string): string | null {
  const m = html.match(/<(nav|ol|ul|div|p)\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*bread-?crumb[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i)
  if (!m) return null
  const visible = m[2]!.split(/<(?:div|script|ol|style)\b/i)[0]!
  const text = htmlToText(visible)
    .replace(/\s*(?:>|›|»|\/|\||→)\s*/g, ' > ')
    .replace(/\s+/g, ' ')
    .replace(/^ ?> ?| ?> ?$/g, '')
    .trim()
  const parts = text.split(' > ').filter(Boolean)
  return parts.length >= 2 && text.length <= 250 ? parts.join(' > ') : null
}

function titleCase(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Reads the product page's buyer-facing details. Pure: markup in, facts out.
 *
 * `html` should already be `readableHtml`; the declared values come from the
 * page's own Product/Offer declaration, as the analysis already extracted them.
 */
export function readProductPageDetails(input: {
  html: string
  url: string
  declared: {
    imageUrl: string | null
    price: string | null
    currency: string | null
    availability: string | null
    sku: string | null
    mpn: string | null
    gtin: string | null
    brand: string | null
  }
  specPairs: Array<{ key: string; value: string }>
}): ProductPageDetails {
  const { html, url, declared } = input
  const region = productRegion(html)
  const regionText = htmlToText(region).replace(/[ \t]+/g, ' ')
  const title = extractHeadings(html).find((h) => h.level === 1)?.text.replace(/\s+/g, ' ').trim() ?? null

  const identifiers: ProductPageDetails['identifiers'] = []
  const ident = (label: string, value: string | null) => {
    if (value && !identifiers.some((i) => i.label === label)) identifiers.push({ label, value })
  }
  ident('SKU', declared.sku)
  ident('Part number (MPN)', declared.mpn)
  ident('GTIN / UPC', declared.gtin)
  ident('Brand', declared.brand)

  const currency = declared.currency && /^[A-Z]{3}$/.test(declared.currency) ? declared.currency : (declaredCurrencyCode(html) ?? declared.currency)
  const { price, priceNote } = readPrice(regionText, { amount: declared.price, currency })

  return {
    title,
    images: readImages(region, url, declared.imageUrl, title, declared.sku),
    identifiers,
    price,
    priceNote,
    availability: readAvailability(declared.availability, regionText),
    ordering: readOrdering(region, input.specPairs),
    buyingOptions: readBuyingOptions(region),
    downloads: readDownloads(region, url),
  }
}
