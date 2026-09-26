import { htmlToText } from '../research/htmlToText.js'

// STAGE 5 — reading structure out of HTML.
//
// Regex-based, like the rest of this codebase's HTML handling. That is a real
// limitation and is stated in the report rather than hidden: it cannot resolve
// nesting, so it reads declarations (JSON-LD, microdata attributes, meta tags,
// tables) rather than trying to understand layout. Those are exactly the
// sources worth trusting anyway — a shop that declares Product JSON-LD is
// telling us what it sells; a div class name is a guess about a stylesheet.
//
// TRUST MODEL: everything passed in here is UNTRUSTED third-party markup. It is
// pattern-matched and never evaluated, never reaches a model, and never selects
// a tool. JSON-LD is parsed with JSON.parse, which cannot execute anything.

const MAX_JSONLD_BYTES = 200_000

export interface JsonLdBlock {
  /** Index of the <script> block, used to build a citable path. */
  index: number
  data: unknown
  /** The raw text of the block, truncated, for evidence. */
  raw: string
}

/**
 * Pulls and parses every JSON-LD island.
 *
 * A block that fails to parse is DROPPED rather than repaired. Half-parsing
 * broken markup invents structure that the page never declared, which is the
 * one thing this stage must not do.
 */
export function extractJsonLd(html: string): JsonLdBlock[] {
  const blocks: JsonLdBlock[] = []
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

  let m: RegExpExecArray | null
  let index = 0
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] ?? '').trim()
    index++
    if (!raw || raw.length > MAX_JSONLD_BYTES) continue
    try {
      // Some CMSs emit JSON-LD wrapped in HTML comments or CDATA.
      const cleaned = raw
        .replace(/^\s*<!--/, '')
        .replace(/-->\s*$/, '')
        .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, '')
        .replace(/\/\*\s*\]\]>\s*\*\/\s*$/, '')
      blocks.push({ index, data: JSON.parse(cleaned), raw: raw.slice(0, 4000) })
    } catch {
      // Unparseable JSON-LD is not evidence of anything.
    }
  }
  return blocks
}

/** Flattens @graph wrappers and arrays into individual typed nodes. */
export function jsonLdNodes(blocks: JsonLdBlock[]): Array<{ node: Record<string, unknown>; path: string; raw: string }> {
  const out: Array<{ node: Record<string, unknown>; path: string; raw: string }> = []

  const walk = (value: unknown, path: string, raw: string, depth: number) => {
    if (depth > 6 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, raw, depth + 1))
      return
    }
    const node = value as Record<string, unknown>
    if ('@type' in node) out.push({ node, path, raw })
    if ('@graph' in node) walk(node['@graph'], `${path}.@graph`, raw, depth + 1)
    // Nested typed nodes (an Offer inside a Product) are reachable too.
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('@')) continue
      if (v && typeof v === 'object') walk(v, `${path}.${k}`, raw, depth + 1)
    }
  }

  blocks.forEach((b) => walk(b.data, `JSON-LD[${b.index}]`, b.raw, 0))
  return out
}

/** True when a JSON-LD node declares (or includes) the given @type. */
export function hasType(node: Record<string, unknown>, ...types: string[]): boolean {
  const raw = node['@type']
  const list = Array.isArray(raw) ? raw : [raw]
  return list.some((t) => typeof t === 'string' && types.some((want) => t.toLowerCase() === want.toLowerCase()))
}

/** Reads a JSON-LD value that may be a string, a number, or a nested node. */
export function ldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map(ldValue).filter(Boolean)
    return parts.length ? parts.join(', ') : null
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    return ldValue(o.name ?? o['@id'] ?? o.value ?? null)
  }
  return null
}

// ── Plain HTML declarations ────────────────────────────────────────────────

/** Tags stripped AND entities decoded. Exported so no caller re-implements it. */
export function decode(s: string): string {
  return htmlToText(s).replace(/\s+/g, ' ').trim()
}

export function extractTitle(html: string): { value: string; fragment: string } | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return null
  const value = decode(m[1] ?? '')
  return value ? { value, fragment: m[0].slice(0, 300) } : null
}

/** Reads a <meta> value by name or property, whichever the page used. */
export function extractMeta(html: string, key: string): { value: string; fragment: string; attr: string } | null {
  for (const attr of ['name', 'property']) {
    const re = new RegExp(
      `<meta\\b[^>]*${attr}\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
      'i',
    )
    const tag = html.match(re)
    if (!tag) continue
    const content = tag[0].match(/content\s*=\s*["']([^"']*)["']/i)
    const value = decode(content?.[1] ?? '')
    if (value) return { value, fragment: tag[0].slice(0, 300), attr }
  }
  return null
}

export function extractCanonical(html: string): { value: string; fragment: string } | null {
  const m = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i)
  if (!m) return null
  const href = m[0].match(/href\s*=\s*["']([^"']+)["']/i)
  const value = href?.[1]?.trim()
  return value ? { value, fragment: m[0].slice(0, 300) } : null
}

export interface Heading {
  level: number
  text: string
}

export function extractHeadings(html: string, limit = 25): Heading[] {
  const out: Heading[] = []
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const text = decode(m[2] ?? '')
    if (text) out.push({ level: Number(m[1]), text: text.slice(0, 200) })
  }
  return out
}

export interface ExtractedLink {
  href: string
  text: string
}

/**
 * Every <a href>, decoded, with its anchor text. Resolution happens later.
 *
 * UNQUOTED ATTRIBUTE VALUES ARE LEGAL HTML, and this used to require quotes.
 * unicaremalta.com is a Squarespace store that emits
 *
 *   <a class="product-list-item-link" href=/products/p/bath-board-steel>
 *
 * for every product on every catalogue page. Requiring quotes meant the
 * crawler never saw a single product link on that site: it read fifteen
 * category pages, found nothing to descend into, and the audit reported that a
 * company with a full catalogue publishes no products. The diagnosis at the
 * time was "the product grid is rendered by JavaScript" — it was not. The
 * markup was there, and this regex could not read it.
 *
 * All three HTML5 forms are accepted now: double-quoted, single-quoted, and
 * unquoted up to the first whitespace or tag delimiter.
 */
export function extractLinks(html: string, limit = 800): ExtractedLink[] {
  const out: ExtractedLink[] = []
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    // A bare fragment is a jump within this page, not another page.
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue
    out.push({ href, text: decode(m[4] ?? '').slice(0, 200) })
  }
  return out
}

export function countImages(html: string): number {
  return (html.match(/<img\b[^>]*>/gi) ?? []).length
}

/** Microdata itemprop values, which many older catalogues still emit. */
export function extractMicrodata(html: string, prop: string): { value: string; fragment: string } | null {
  const re = new RegExp(`<([a-z0-9]+)\\b[^>]*itemprop\\s*=\\s*["']${prop}["'][^>]*>([\\s\\S]{0,400}?)<\\/\\1>`, 'i')
  const m = html.match(re)
  if (m) {
    const text = decode(m[2] ?? '')
    if (text) return { value: text, fragment: m[0].slice(0, 300) }
  }
  // Self-closing / attribute-carried form: <meta itemprop="price" content="9.99">
  const attrRe = new RegExp(`<[a-z0-9]+\\b[^>]*itemprop\\s*=\\s*["']${prop}["'][^>]*>`, 'i')
  const tag = html.match(attrRe)
  if (!tag) return null
  const content = tag[0].match(/(?:content|value)\s*=\s*["']([^"']*)["']/i)
  const value = decode(content?.[1] ?? '')
  return value ? { value, fragment: tag[0].slice(0, 300) } : null
}

export interface SpecPair {
  key: string
  value: string
  fragment: string
}

/**
 * Key/value pairs from the three shapes specification blocks actually take:
 * two-column table rows, definition lists, and "Label: value" list items.
 *
 * These are where dimensions, weights and materials live on industrial
 * catalogues, and they are declarations rather than layout guesses.
 */
export function extractSpecPairs(html: string, limit = 120): SpecPair[] {
  const pairs: SpecPair[] = []
  const push = (key: string, value: string, fragment: string) => {
    const k = decode(key)
    const v = decode(value)
    if (!k || !v || k.length > 80 || pairs.length >= limit) return
    pairs.push({ key: k, value: v.slice(0, 300), fragment: fragment.replace(/\s+/g, ' ').slice(0, 300) })
  }

  // <tr><th>Key</th><td>Value</td></tr> and <tr><td>Key</td><td>Value</td></tr>
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let row: RegExpExecArray | null
  while ((row = rowRe.exec(html)) !== null && pairs.length < limit) {
    const cells = [...(row[1] ?? '').matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    if (cells.length === 2) push(cells[0]![2] ?? '', cells[1]![2] ?? '', row[0] ?? '')
  }

  // <dt>Key</dt><dd>Value</dd>
  const dlRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi
  let dl: RegExpExecArray | null
  while ((dl = dlRe.exec(html)) !== null && pairs.length < limit) {
    push(dl[1] ?? '', dl[2] ?? '', dl[0] ?? '')
  }

  // <li>Key: Value</li>
  const liRe = /<li\b[^>]*>([\s\S]{0,300}?)<\/li>/gi
  let li: RegExpExecArray | null
  while ((li = liRe.exec(html)) !== null && pairs.length < limit) {
    const text = decode(li[1] ?? '')
    const split = text.match(/^([^:]{2,60}):\s*(.+)$/)
    if (split) push(split[1] ?? '', split[2] ?? '', li[0] ?? '')
  }

  return pairs
}

/**
 * Class names that repeat once per product on a listing page.
 *
 * These are the conventions the common storefront platforms actually emit
 * (nopCommerce `item-box`/`product-item`, WooCommerce `product`, Shopify
 * `product-card`, Magento `product-item`). Counting them is a STRUCTURAL
 * signal: it works on a site whose product URLs are bare slugs, which is
 * exactly where URL-pattern matching fails.
 */
const PRODUCT_TILE_CLASS = /class\s*=\s*["'][^"']*\b(product-item|item-box|product-card|product-tile|product-block|product-grid-item|product-title|product-name)\b[^"']*["']/gi

export function countProductTiles(html: string): number {
  return (html.match(PRODUCT_TILE_CLASS) ?? []).length
}

/** Controls that only appear on a page listing many products. */
export function listingControlSignals(html: string): string[] {
  const found: string[] = []
  const checks: Array<[RegExp, string]> = [
    [/class\s*=\s*["'][^"']*\bproduct-sorting\b/i, 'a product-sorting control'],
    [/class\s*=\s*["'][^"']*\bproduct-filters?\b/i, 'a product-filters control'],
    [/class\s*=\s*["'][^"']*\bproduct-page-size\b/i, 'a page-size control'],
    [/class\s*=\s*["'][^"']*\bproduct-viewmode\b/i, 'a grid/list view-mode control'],
    [/class\s*=\s*["'][^"']*\b(product-grid|item-grid|products-grid)\b/i, 'a product grid container'],
  ]
  checks.forEach(([re, label]) => {
    if (re.test(html)) found.push(label)
  })
  return found
}

/** Containers that appear once, on a single product's own page. */
export function productDetailSignals(html: string): string[] {
  const found: string[] = []
  const checks: Array<[RegExp, string]> = [
    [/class\s*=\s*["'][^"']*\bproduct-details-page\b/i, 'a product-details-page container'],
    [/class\s*=\s*["'][^"']*\bproduct-essential\b/i, 'a product-essential container'],
    [/class\s*=\s*["'][^"']*\bproduct-specs?-box\b/i, 'a product-specs container'],
    [/class\s*=\s*["'][^"']*\bproduct-collateral\b/i, 'a product-collateral container'],
    [/class\s*=\s*["'][^"']*\b(single-product|product-detail|pdp)\b/i, 'a single-product container'],
  ]
  checks.forEach(([re, label]) => {
    if (re.test(html)) found.push(label)
  })
  return found
}

/**
 * Product links taken from the LISTING'S OWN STRUCTURE rather than from URL
 * shape.
 *
 * This is what lets the crawler reach products on a site whose product URLs
 * look like /foaming-carpet-cleaner-deodorizer-24x18-ozcs — indistinguishable
 * from any other page by pattern, but unambiguous once you notice it is the
 * link inside a product tile.
 */
export function extractProductTileLinks(html: string, limit = 60): string[] {
  const out: string[] = []
  const re = new RegExp(PRODUCT_TILE_CLASS.source, 'gi')

  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < limit) {
    // The tile's own anchor is the first href shortly after the class attribute.
    const window = html.slice(m.index, m.index + 500)
    // Unquoted values accepted for the reason given on extractLinks.
    const href = window.match(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i)
    const value = (href?.[1] ?? href?.[2] ?? href?.[3])?.trim()
    if (
      value &&
      !value.startsWith('#') &&
      !/^(javascript|mailto|tel|data):/i.test(value) &&
      !out.includes(value)
    ) {
      out.push(value)
    }
  }
  return out
}

/** Counts links that point at a document rather than another page. */
export function extractDocumentLinks(links: ExtractedLink[]): ExtractedLink[] {
  return links.filter((l) => /\.(pdf|docx?|xlsx?|csv|dwg|dxf|stp|step|igs|iges|zip)(\?|#|$)/i.test(l.href))
}

/** Words of visible text — a cheap, honest measure of how much page there is. */
export function wordCount(html: string): number {
  const text = htmlToText(html)
  return text ? text.split(/\s+/).filter(Boolean).length : 0
}

/** Every declared JSON-LD @type on the page, deduplicated. */
export function structuredDataTypes(html: string): string[] {
  const types = new Set<string>()
  jsonLdNodes(extractJsonLd(html)).forEach(({ node }) => {
    const raw = node['@type']
    const list = Array.isArray(raw) ? raw : [raw]
    list.forEach((t) => typeof t === 'string' && types.add(t))
  })
  // Microdata itemtype URLs carry the same information in an older form.
  const re = /itemtype\s*=\s*["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) types.add(m[1]!)
  return [...types].sort()
}
