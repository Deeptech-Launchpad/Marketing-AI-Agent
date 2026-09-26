import { decode, extractJsonLd, extractMeta, extractTitle, hasType, jsonLdNodes, ldValue } from './htmlStructure.js'
import { observed, type ExtractionMethod, type Observation } from './types.js'

// STAGE 5 — WHAT DOES THIS COMPANY SELL, ACCORDING TO ITS OWN PAGES?
//
// The crawler already answers "is this a product detail page". That question is
// the wrong one to stop at, and a real customer proved it: unicaremalta.com
// publishes a full catalogue of grab rails, shower seats and mobility aids, and
// the audit reported ZERO PRODUCTS. Not because the crawl failed — fifteen
// pages were fetched, every one of them a real category page — but because the
// product grid is rendered by JavaScript. The server HTML says "No results
// found", so there was no product page to find, and the run said so.
//
// It was wrong. The evidence was in the markup the whole time:
//
//   <img alt="GRAB RAIL" src="/…/RS972XX.jpg">
//   <img alt="GRAB RAIL LOOPED" src="/…/H3301.jpg">
//
// That is the company naming its own products, on its own page, in text a
// search engine and an answer engine can both read. "No products" was a
// statement about our crawler, printed as a statement about their business.
//
// So this module collects CATALOGUE EVIDENCE: every place a page names
// something it sells, ranked by how much the page is asserting it.
//
//   linked      a named entry with its own detail-page link (a real listing)
//   named       a named entry with no link (a grid, a JSON-LD ItemList)
//   image_alt   a product name carried only in image alt text
//
// WHAT THIS IS NOT
//
// It is not a product record, and it never becomes one by accident. An entry
// carries a NAME the page published and, at most, an image and that image's
// FILE NAME. A file name is a file name: it is labelled as one everywhere it
// is shown, and never written into product.sku, product.mpn or any other field
// that would assert the company publishes a code it does not publish. No
// price, specification or attribute is ever derived here.

/** Entries taken from any one page. A grid of 200 does not need all 200. */
const MAX_ENTRIES_PER_PAGE = 24

/** Alt text and file names that are furniture rather than merchandise. */
const FURNITURE =
  /^(logo|logotype|icon|banner|bg|background|hero|placeholder|default|thumb(nail)?|spacer|pixel|blank|image|img|photo|picture|avatar|cart|basket|search|menu|close|arrow|next|prev(ious)?|play|pause|star|rating|share|facebook|instagram|linkedin|twitter|whatsapp|youtube|tiktok|pinterest|visa|mastercard|paypal|loading|spinner|slide\d*|slider|carousel|map|flag)\b/i

/**
 * Alt text that is a control, a heading or an empty state rather than a name.
 *
 * The empty states matter as much as the calls to action: a JavaScript grid
 * that has not run yet renders "No results found", and a catalogue that
 * collected THAT as a product would report the absence as merchandise.
 */
const NOT_A_NAME =
  /^(read more|learn more|view (more|all|product|details?)|shop now|click here|home|about( us)?|contact( us)?|products?|all products|our products|services?|news|blog|gallery|enquire|enquiry|quote|buy now|add to cart|previous|next|submit|search|sign in|login|register|menu|close|no results found|no products found|no items found|nothing found|coming soon|sold out|out of stock|load more|show more|filter|sort by)$/i

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp)(\?|#|$)/i

export type CatalogEntryStrength = 'linked' | 'named' | 'image_alt'

export interface CatalogEntry {
  /** Exactly as the page stated it. Never title-cased, expanded or cleaned up. */
  name: string
  /** The detail page the listing linked to, absolute. Null when it linked none. */
  detailUrl: string | null
  /** An image published alongside the name, absolute. */
  imageUrl: string | null
  /**
   * The image's own file name, when it reads like a product code.
   *
   * Recorded because on a site with no published SKU it is frequently the only
   * identifier that exists — and it is presented as what it is: a file name
   * observed on their page, not a code the company publishes.
   */
  imageFileName: string | null
  strength: CatalogEntryStrength
  method: ExtractionMethod
  sourcePath: string
  fragment: string
}

/** The site naming itself, so its own name is not collected as merchandise. */
function siteNames(html: string): string[] {
  const names = new Set<string>()
  const og = extractMeta(html, 'og:site_name')?.value
  if (og) names.add(og.trim().toLowerCase())
  const title = extractTitle(html)?.value
  if (title) {
    for (const part of title.split(/[|\u2013\u2014-]/)) {
      const t = part.trim().toLowerCase()
      if (t.length >= 3) names.add(t)
    }
  }
  return [...names]
}

/**
 * Reads one attribute off a single tag, in any of the three HTML5 forms.
 *
 * Unquoted values are legal and real stores emit them; a quoted-only reader
 * silently returns nothing rather than failing, which is the worst way for
 * this to be wrong.
 */
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+))', 'i'))
  if (!m) return null
  const raw = m[1] ?? m[2] ?? m[3]
  return raw === undefined ? null : decode(raw).trim()
}

function absolute(raw: string | null, pageUrl: string): string | null {
  if (!raw) return null
  const v = raw.trim()
  if (!v || v.startsWith('data:')) return null
  try {
    const u = new URL(v, pageUrl)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** The last path segment of an image URL, extension included. */
export function imageFileNameOf(url: string | null): string | null {
  if (!url) return null
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    return last && IMAGE_EXT.test(last) ? decodeURIComponent(last) : null
  } catch {
    return null
  }
}

/**
 * Does this file name read like a product code?
 *
 * "RS972XX.jpg", "H3301.jpg", "GRS.jpeg" and "170XX.jpeg" do. "grab-rail.jpg",
 * "hero-banner.png" and "logo.svg" do not. The test is deliberately narrow: a
 * short token that is either all upper case or carries digits, and is not one
 * of the words every site names its furniture after.
 *
 * A true result means "this looks like a code", never "this IS the SKU".
 */
export function looksLikeProductCode(fileName: string | null): boolean {
  if (!fileName) return false
  const stem = fileName.replace(IMAGE_EXT, '').trim()
  if (stem.length < 2 || stem.length > 24) return false
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem)) return false
  if (FURNITURE.test(stem)) return false
  // Words joined by hyphens are a slug, which is a name, not a code.
  if (/[-_]/.test(stem) && !/\d/.test(stem)) return false
  // A slug WITH digits in it is still a slug: "ark-silver3_1_9-800x600" is a
  // product name and an image size, not a manufacturer's code. Two or more
  // runs of three-plus letters is what a phrase looks like, and no real part
  // number reads that way — RS972XX, H3301, DTSF450C001 and MSDEA8166 all
  // carry at most one such run.
  const words = (stem.match(/[A-Za-z]{3,}/g) ?? []).length
  if (words >= 2) return false
  // A trailing pixel dimension is a CMS-generated thumbnail — WordPress writes
  // "render1_114_2-800x600.jpg" and "Avangard1-800x527.png". A manufacturer
  // does not put its image's width and height in the part number.
  if (/[-_]\d{2,4}x\d{2,4}$/i.test(stem)) return false
  const hasDigit = /\d/.test(stem)
  const allCaps = /^[A-Z0-9._-]+$/.test(stem) && /[A-Z]/.test(stem)
  return hasDigit || allCaps
}

/** Could this alt text be a product name the company published? */
function altIsProductName(alt: string, siteNameList: string[]): boolean {
  const t = alt.trim()
  if (t.length < 3 || t.length > 90) return false
  if (IMAGE_EXT.test(t)) return false
  if (FURNITURE.test(t)) return false
  if (NOT_A_NAME.test(t)) return false
  const low = t.toLowerCase()
  if (siteNameList.some((n) => n === low || (n.length >= 5 && low.includes(n)))) return false
  // A bare short word ("New", "Sale") says nothing; a multi-word phrase or a
  // deliberate all-caps label is the shape a product name actually takes.
  const words = t.split(/\s+/).filter(Boolean)
  return words.length >= 2 || (t === t.toUpperCase() && t.length >= 4)
}

function pushUnique(into: CatalogEntry[], entry: CatalogEntry): void {
  const key = entry.name.trim().toLowerCase()
  const existing = into.find((e) => e.name.trim().toLowerCase() === key)
  if (existing) {
    // A later, weaker sighting can still supply a missing image or link.
    existing.detailUrl ??= entry.detailUrl
    existing.imageUrl ??= entry.imageUrl
    existing.imageFileName ??= entry.imageFileName
    return
  }
  if (into.length < MAX_ENTRIES_PER_PAGE) into.push(entry)
}

// ── 1. The site declaring its own list ────────────────────────────────────

function fromJsonLd(html: string, pageUrl: string, out: CatalogEntry[]): void {
  for (const { node, path } of jsonLdNodes(extractJsonLd(html))) {
    if (!hasType(node, 'ItemList', 'OfferCatalog', 'CollectionPage')) continue
    const elements = node.itemListElement
    if (!Array.isArray(elements)) continue

    elements.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return
      const el = raw as Record<string, unknown>
      const item = (el.item && typeof el.item === 'object' ? (el.item as Record<string, unknown>) : el) as Record<
        string,
        unknown
      >
      const name = ldValue(item.name) ?? ldValue(el.name)
      if (!name?.trim()) return
      const url = absolute(ldValue(item.url) ?? ldValue(el.url), pageUrl)
      const imageRaw = Array.isArray(item.image) ? item.image[0] : item.image
      const image = absolute(
        typeof imageRaw === 'string' ? imageRaw : ldValue((imageRaw as Record<string, unknown> | undefined)?.url),
        pageUrl,
      )
      const file = imageFileNameOf(image)
      pushUnique(out, {
        name: name.trim(),
        detailUrl: url,
        imageUrl: image,
        imageFileName: looksLikeProductCode(file) ? file : null,
        strength: url ? 'linked' : 'named',
        method: 'json_ld',
        sourcePath: `${path}.itemListElement[${i}]`,
        fragment: JSON.stringify(item).slice(0, 400),
      })
    })
  }
}

// ── 2. OpenGraph, where a page nominates itself as one product ────────────

function fromOpenGraph(html: string, pageUrl: string, out: CatalogEntry[]): void {
  const type = extractMeta(html, 'og:type')?.value?.toLowerCase() ?? ''
  if (!type.includes('product')) return
  const title = extractMeta(html, 'og:title')?.value?.trim()
  if (!title) return
  const image = absolute(extractMeta(html, 'og:image')?.value ?? null, pageUrl)
  const file = imageFileNameOf(image)
  pushUnique(out, {
    name: title,
    detailUrl: absolute(extractMeta(html, 'og:url')?.value ?? null, pageUrl) ?? pageUrl,
    imageUrl: image,
    imageFileName: looksLikeProductCode(file) ? file : null,
    strength: 'linked',
    method: 'meta_tag',
    sourcePath: 'meta[property=og:title]',
    fragment: `og:type="${type}" og:title="${title}"`,
  })
}

// ── 3. Repeated product cards ─────────────────────────────────────────────

/**
 * Class names that mark ONE product's card, matched as WHOLE class tokens.
 *
 * Whole tokens, not substrings, and this is not a detail. A `\bproduct\b`
 * pattern matches inside `product-list-nav`, `product-list-filters` and
 * `product-list-category-select-container`, because a hyphen is a word
 * boundary — so a Squarespace catalogue page yielded its category navigation
 * as six "products" named "All Products", "Therapy Equipment" and so on. Names
 * lifted off a filter control are not merchandise, and a report listing them
 * as the customer's products is worse than one listing none.
 */
const CARD_CLASSES = new Set([
  'product',
  'product-item',
  'product-list-item',
  'productitem',
  'product-card',
  'card-product',
  'product-tile',
  'product-block',
  'product-grid-item',
  'item-box',
  'grid-item',
])

const OPEN_TAG = /<(?:div|li|article|section)\b[^>]*>/gi

/** True when any whole class token on this tag names a product card. */
function isCardTag(tag: string): boolean {
  const cls = attr(tag, 'class')
  if (!cls) return false
  return cls.split(/\s+/).some((token) => CARD_CLASSES.has(token.toLowerCase()))
}

function fromProductCards(html: string, pageUrl: string, siteNameList: string[], out: CatalogEntry[]): void {
  const re = new RegExp(OPEN_TAG.source, 'gi')
  let m: RegExpExecArray | null
  let seen = 0
  while ((m = re.exec(html)) !== null && seen < MAX_ENTRIES_PER_PAGE * 8) {
    if (!isCardTag(m[0])) continue
    seen++
    // A window rather than a parsed subtree: a card is small, and a bounded
    // slice cannot be led astray by unbalanced markup the way a hand-rolled
    // tag matcher can.
    const card = html.slice(m.index, m.index + 1600)

    // The anchor's OPENING TAG only.
    //
    // Matching through to </a> looked tidier and was wrong: a product card
    // wraps its whole image block in the link, so the closing tag is hundreds
    // of characters away and frequently past the end of this window. Requiring
    // it meant every real Squarespace card failed to match and fell through to
    // the alt-text path, losing the detail-page link the card was carrying.
    //
    // Unquoted attribute values are accepted for the reason given on
    // extractLinks: they are legal HTML and real stores emit them.
    const anchorTag = card.match(/<a\b[^>]*>/i)?.[0] ?? null
    const href = anchorTag ? attr(anchorTag, 'href') : null
    const detailUrl =
      href && !href.startsWith('#') && !/^(javascript|mailto|tel|data):/i.test(href)
        ? absolute(href, pageUrl)
        : null
    // The accessible name of the link. On a card whose only visible content is
    // an image, this is the company stating the product's name in so many words.
    const ariaLabel = anchorTag ? attr(anchorTag, 'aria-label') : null
    // Whatever text the anchor does carry, up to its close or the window's end.
    const anchorText = anchorTag
      ? card.slice(card.indexOf(anchorTag) + anchorTag.length).split(/<\/a>/i)[0]?.slice(0, 300)
      : undefined

    const imgTag = card.match(/<img\b[^>]*>/i)?.[0] ?? null
    const imageUrl = imgTag
      ? absolute(
          attr(imgTag, 'src') ??
            attr(imgTag, 'data-src') ??
            attr(imgTag, 'data-lazy-src') ??
            attr(imgTag, 'data-original'),
          pageUrl,
        )
      : null

    // The name, in the order the card is most likely to be asserting it.
    const heading = card.match(/<h[1-6]\b[^>]*>([\s\S]{0,200}?)<\/h[1-6]>/i)?.[1]
    const titled = card.match(
      /class\s*=\s*["'][^"']*\b(?:product-title|product-name|card-title)\b[^"']*["'][^>]*>([\s\S]{0,200}?)</i,
    )?.[1]
    const alt = imgTag ? attr(imgTag, 'alt') : null

    const candidates = [titled, heading, anchorText, ariaLabel, alt]
      .map((c) => (c ? decode(c.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : ''))
      .filter(Boolean)
    const name = candidates.find((c) => altIsProductName(c, siteNameList))
    if (!name) continue

    const file = imageFileNameOf(imageUrl)
    pushUnique(out, {
      name,
      detailUrl,
      imageUrl,
      imageFileName: looksLikeProductCode(file) ? file : null,
      strength: detailUrl ? 'linked' : 'named',
      method: detailUrl ? 'link_analysis' : 'dom_heuristic',
      sourcePath: 'product card container',
      fragment: card.slice(0, 400),
    })
  }
}

// ── 4. Image alt text, the last honest resort ─────────────────────────────

function fromImageAlts(html: string, pageUrl: string, siteNameList: string[], out: CatalogEntry[]): void {
  const tags = html.match(/<img\b[^>]*>/gi) ?? []

  // A file name used AS alt text belongs to the entry beside it — this is how
  // unicaremalta.com's grid is written, alternating a product name and a code
  // image. Collected in one pass so the pairing is positional rather than a
  // guess about which image a name refers to.
  const read = tags.map((tag) => {
    const alt = attr(tag, 'alt') ?? ''
    const src = absolute(
      attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'data-lazy-src') ?? attr(tag, 'data-original'),
      pageUrl,
    )
    return { tag, alt, src, file: imageFileNameOf(src) }
  })

  read.forEach((img, i) => {
    if (!altIsProductName(img.alt, siteNameList)) return

    // This image's own file name first; failing that, a neighbouring image
    // whose alt IS a file name, which is the same code stated twice.
    let file = looksLikeProductCode(img.file) ? img.file : null
    if (!file) {
      const neighbour = read[i + 1]
      if (neighbour && IMAGE_EXT.test(neighbour.alt) && looksLikeProductCode(neighbour.alt)) {
        file = neighbour.alt
      } else if (neighbour && looksLikeProductCode(neighbour.file) && !altIsProductName(neighbour.alt, siteNameList)) {
        file = neighbour.file
      }
    }

    pushUnique(out, {
      name: img.alt.trim(),
      detailUrl: null,
      imageUrl: img.src,
      imageFileName: file,
      strength: 'image_alt',
      method: 'dom_heuristic',
      sourcePath: 'img[alt]',
      fragment: img.tag.slice(0, 400),
    })
  })
}

/**
 * Every product this page names, from the strongest evidence to the weakest.
 *
 * Runs on EVERY fetched page, not only on pages already classified as a
 * catalogue: the classification is what was wrong in the case that forced this,
 * so nothing here is gated on it.
 */
export function extractCatalogEntries(html: string, pageUrl: string): CatalogEntry[] {
  const out: CatalogEntry[] = []
  const names = siteNames(html)
  fromJsonLd(html, pageUrl, out)
  fromOpenGraph(html, pageUrl, out)
  fromProductCards(html, pageUrl, names, out)
  fromImageAlts(html, pageUrl, names, out)

  // Strongest first, so a truncated list keeps the best evidence.
  const rank: Record<CatalogEntryStrength, number> = { linked: 0, named: 1, image_alt: 2 }
  return out.sort((a, b) => rank[a.strength] - rank[b.strength]).slice(0, MAX_ENTRIES_PER_PAGE)
}

/**
 * Catalogue entries as observation rows, so they persist and are auditable
 * through exactly the same table as every other thing a page said.
 *
 * The field names are indexed — `catalog.entry.0.name` — so an entry can be
 * reassembled without inventing a join, and each row keeps its own true
 * method, source path and source fragment.
 */
export function catalogObservations(entries: CatalogEntry[]): Observation[] {
  const rows: Observation[] = []
  entries.forEach((e, i) => {
    rows.push(observed(`catalog.entry.${i}.name`, e.name, e.method, e.sourcePath, e.fragment))
    rows.push(
      observed(`catalog.entry.${i}.strength`, e.strength, e.method, e.sourcePath, `Evidence strength for "${e.name}"`),
    )
    if (e.detailUrl) {
      rows.push(
        observed(`catalog.entry.${i}.url`, e.detailUrl, 'link_analysis', e.sourcePath, e.detailUrl.slice(0, 300)),
      )
    }
    if (e.imageUrl) {
      rows.push(observed(`catalog.entry.${i}.image`, e.imageUrl, 'dom_heuristic', e.sourcePath, e.imageUrl.slice(0, 300)))
    }
    if (e.imageFileName) {
      // Named for what it is. Never written to product.sku or product.mpn: the
      // company has not published a code, and a file name is not one.
      rows.push(
        observed(
          `catalog.entry.${i}.imageFileName`,
          e.imageFileName,
          'dom_heuristic',
          e.sourcePath,
          'Image file name observed on the page — not a published product code.',
        ),
      )
    }
  })
  return rows
}
