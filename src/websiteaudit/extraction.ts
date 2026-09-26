import {
  countImages,
  decode,
  extractCanonical,
  extractDocumentLinks,
  extractHeadings,
  extractJsonLd,
  extractLinks,
  extractMeta,
  extractMicrodata,
  extractSpecPairs,
  extractTitle,
  hasType,
  jsonLdNodes,
  ldValue,
  structuredDataTypes,
  wordCount,
  type SpecPair,
} from './htmlStructure.js'
import {
  CATEGORY_FIELDS,
  PAGE_FIELDS,
  PRODUCT_FIELDS,
  couldNotDetermine,
  notObserved,
  observed,
  type Observation,
} from './types.js'

// STAGE 5 — turning a page into observations.
//
// Two rules run through every function here.
//
// 1. Every expected field produces a row. A page with no dimensions yields
//    `product.dimensions = not_observed`, never silence. Stage 6 reads the
//    absences, and an omitted row would be indistinguishable from a field
//    nobody looked for.
//
// 2. Nothing is judged, and nothing is normalised into a verdict. The value
//    stored is what the page said: "12 x 8 x 4 in" stays that, and whether
//    that is adequate dimensional data is not a question this file asks.
//
// Extraction is deterministic. No model is involved — Gemini is not called from
// this stage at all, because "what does the brand field say" has a correct
// answer that regex can reach and a model can only approximate more expensively.

/** Merges rows so every expected field appears exactly once, best evidence won. */
function completeFields(found: Observation[], expected: readonly string[]): Observation[] {
  const byField = new Map<string, Observation>()
  for (const o of found) {
    const existing = byField.get(o.field)
    // First writer wins: callers push strongest-source-first.
    if (!existing) byField.set(o.field, o)
  }
  return expected.map((f) => byField.get(f) ?? notObserved(f))
}

// ── Page-level ─────────────────────────────────────────────────────────────

export function extractPageObservations(html: string, url: string): Observation[] {
  const found: Observation[] = []

  const title = extractTitle(html)
  if (title) found.push(observed('page.title', title.value, 'dom_heuristic', '<title>', title.fragment))

  const desc = extractMeta(html, 'description') ?? extractMeta(html, 'og:description')
  if (desc) {
    found.push(observed('page.metaDescription', desc.value, 'meta_tag', `meta[${desc.attr}="description"]`, desc.fragment))
  }

  const canonical = extractCanonical(html)
  if (canonical) {
    found.push(observed('page.canonical', canonical.value, 'meta_tag', 'link[rel="canonical"]', canonical.fragment))
  }

  const crumbs = extractBreadcrumbs(html)
  if (crumbs) found.push(crumbs.observation)

  const headings = extractHeadings(html)
  if (headings.length) {
    found.push(
      observed(
        'page.headings',
        headings.map((h) => `h${h.level}: ${h.text}`).join(' | '),
        'dom_heuristic',
        '<h1>-<h6>',
        headings.slice(0, 3).map((h) => h.text).join(' | '),
      ),
    )
  }

  const words = wordCount(html)
  found.push(observed('page.wordCount', String(words), 'dom_heuristic', 'visible text', `${words} words of visible text`))

  const types = structuredDataTypes(html)
  if (types.length) {
    found.push(observed('page.structuredDataTypes', types.join(', '), 'json_ld', 'JSON-LD/microdata @type', types.join(', ')))
  }

  void url
  return completeFields(found, PAGE_FIELDS)
}

/** Breadcrumbs from JSON-LD first, then from the usual markup conventions. */
function extractBreadcrumbs(html: string): { observation: Observation } | null {
  for (const { node, path } of jsonLdNodes(extractJsonLd(html))) {
    if (!hasType(node, 'BreadcrumbList')) continue
    const items = node.itemListElement
    if (!Array.isArray(items)) continue
    const names = items
      .map((i) => (i && typeof i === 'object' ? ldValue((i as Record<string, unknown>).name ?? (i as Record<string, unknown>).item) : null))
      .filter(Boolean)
    if (names.length) {
      return {
        observation: observed(
          'page.breadcrumbs',
          names.join(' > '),
          'json_ld',
          `${path}.itemListElement[].name`,
          names.join(' > '),
        ),
      }
    }
  }

  const nav = html.match(
    /<(nav|ol|ul|div)\b[^>]*(?:aria-label\s*=\s*["'][^"']*breadcrumb|class\s*=\s*["'][^"']*\bbreadcrumbs?\b)[^>]*>([\s\S]{0,2000}?)<\/\1>/i,
  )
  if (!nav) return null
  const parts = [...(nav[2] ?? '').matchAll(/<(?:a|span|li)\b[^>]*>([\s\S]{0,120}?)<\/(?:a|span|li)>/gi)]
    // decode(), not a raw tag strip: this path previously left HTML entities
    // intact, so a real stored breadcrumb read "RAGS, WIPERS &amp; PAPER".
    // Every other extractor in this file already decodes, and breadcrumbs are
    // the only source of product category, so the corruption propagated.
    .map((m) => decode(m[1] ?? ''))
    // A separator rendered as its own element ("/", "›", "»") is punctuation,
    // not a crumb.
    .filter((t) => t.length > 0 && t.length < 100 && !/^[/>»›|·—–-]+$/.test(t))
  if (!parts.length) return null

  return {
    observation: observed(
      'page.breadcrumbs',
      [...new Set(parts)].join(' > '),
      'dom_heuristic',
      'breadcrumb container',
      nav[0].slice(0, 300),
    ),
  }
}

// ── Product-level ──────────────────────────────────────────────────────────

const DIMENSION_KEY = /\b(dimension|size|width|height|length|depth|diameter|bore|thickness|od|id)\b/i
const WEIGHT_KEY = /\b(weight|mass|nett?\s*weight|gross\s*weight)\b/i
const UNIT_TOKEN = /\b(mm|cm|m|km|in(ch(es)?)?|ft|yd|kg|g|lb|lbs|oz|t|tonnes?|ml|l|litres?|liters?|bar|psi|°?[cf])\b/i

/**
 * The primary product image, as an absolute URL on the company's own site.
 *
 * Tried in order of how much the page is ASSERTING the image is the product:
 * a schema.org `image` is a declaration, `og:image` is what the site tells
 * social platforms to show, and only then a plain `<img>`. Data URIs, SVG
 * icons, spacers and obvious logo/sprite assets are skipped — a customer report
 * showing a company's own logo where their product should be is worse than
 * showing nothing.
 *
 * Returns null rather than a guess. "No image published" is a real finding.
 */
function extractProductImage(html: string, pageUrl: string, ld: Record<string, unknown> | null): Observation | null {
  const absolute = (raw: string): string | null => {
    const v = decode(raw).trim()
    if (!v || v.startsWith('data:')) return null
    try {
      return new URL(v, pageUrl).toString()
    } catch {
      return null
    }
  }

  const usable = (u: string): boolean => {
    const low = u.toLowerCase()
    if (low.endsWith('.svg')) return false
    return !/(logo|sprite|icon|placeholder|blank|spacer|pixel|favicon)/.test(low)
  }

  // 1. schema.org image — a declaration by the page itself.
  if (ld) {
    const raw = ld.image
    const first = Array.isArray(raw) ? raw[0] : raw
    const candidate =
      typeof first === 'string'
        ? first
        : first && typeof first === 'object'
          ? ((first as Record<string, unknown>).url as string | undefined) ?? null
          : null
    if (candidate) {
      const abs = absolute(candidate)
      if (abs) return observed('product.image', abs, 'json_ld', 'Product.image', abs.slice(0, 300))
    }
  }

  // 2. og:image — what the site nominates as its own representative picture.
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
  if (og?.[1]) {
    const abs = absolute(og[1])
    // Filtered like any other candidate. A homepage's og:image is very often
    // the company logo, and a "product image" that is really a logo is worse
    // than an honest blank: it looks like evidence and is not.
    if (abs && usable(abs)) return observed('product.image', abs, 'meta_tag', 'meta[property=og:image]', abs.slice(0, 300))
  }

  // 3. The first <img> that is not obviously furniture.
  //
  // Lazy-loading is the norm on catalogue pages, so the real URL frequently
  // lives in data-src / data-lazy-src / srcset rather than src. Reading src
  // alone found nothing on a page that plainly had product photographs.
  const ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-srcset', 'srcset']
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    for (const attr of ATTRS) {
      const m = tag.match(new RegExp(attr + '=["' + "'" + ']([^"' + "'" + ']+)["' + "'" + ']', 'i'))
      if (!m?.[1]) continue
      // srcset is a comma-separated candidate list; the first URL is enough.
      const raw = m[1].split(',')[0]!.trim().split(/\s+/)[0]!
      const abs = absolute(raw)
      if (abs && usable(abs)) {
        return observed('product.image', abs, 'dom_heuristic', `product <img> [${attr}]`, abs.slice(0, 300))
      }
    }
  }

  return null
}

export function extractProductObservations(html: string, url: string): Observation[] {
  const found: Observation[] = []
  const nodes = jsonLdNodes(extractJsonLd(html))
  const product = nodes.find(({ node }) => hasType(node, 'Product', 'IndividualProduct', 'ProductModel'))

  // ── Strongest source: the page's own Product declaration. ───────────────
  if (product) {
    const n = product.node
    const p = product.path
    const push = (field: string, key: string, value: unknown) => {
      const v = ldValue(value)
      if (v) found.push(observed(field, v, 'json_ld', `${p}.${key}`, `${key}: ${v}`.slice(0, 300)))
    }

    push('product.name', 'name', n.name)
    push('product.sku', 'sku', n.sku)
    push('product.mpn', 'mpn', n.mpn)
    push('product.gtin', 'gtin', n.gtin ?? n.gtin13 ?? n.gtin12 ?? n.gtin8 ?? n.gtin14)
    push('product.brand', 'brand.name', n.brand)
    push('product.category', 'category', n.category)
    push('product.description', 'description', n.description)
    push('product.weight', 'weight', n.weight)

    const dims = ['width', 'height', 'depth', 'length']
      .map((k) => ({ k, v: ldValue(n[k]) }))
      .filter((x) => x.v)
    if (dims.length) {
      found.push(
        observed(
          'product.dimensions',
          dims.map((d) => `${d.k}=${d.v}`).join(', '),
          'json_ld',
          `${p}.{${dims.map((d) => d.k).join(',')}}`,
          dims.map((d) => `${d.k}: ${d.v}`).join(' | '),
        ),
      )
    }

    // Offers carry price and availability, and may be an array.
    const offerNode = nodes.find(({ path }) => path.startsWith(`${p}.offers`))
    if (offerNode) {
      const o = offerNode.node
      const price = ldValue(o.price ?? o.lowPrice)
      if (price) found.push(observed('product.price', price, 'json_ld', `${offerNode.path}.price`, `price: ${price}`))
      const cur = ldValue(o.priceCurrency)
      if (cur) found.push(observed('product.currency', cur, 'json_ld', `${offerNode.path}.priceCurrency`, `priceCurrency: ${cur}`))
      const avail = ldValue(o.availability)
      if (avail) {
        found.push(observed('product.availability', avail, 'json_ld', `${offerNode.path}.availability`, `availability: ${avail}`))
      }
    }

    // additionalProperty is where schema.org puts arbitrary spec attributes.
    if (Array.isArray(n.additionalProperty)) {
      const props = n.additionalProperty
        .map((x) => {
          const o = x as Record<string, unknown>
          const k = ldValue(o.name)
          const v = ldValue(o.value)
          return k && v ? `${k}: ${v}` : null
        })
        .filter(Boolean)
      if (props.length) {
        found.push(
          observed(
            'product.attributes',
            props.join(' | '),
            'json_ld',
            `${p}.additionalProperty[]`,
            props.slice(0, 5).join(' | '),
          ),
        )
      }
    }
  }

  // ── Microdata, for catalogues that predate JSON-LD. ─────────────────────
  const micro: Array<[string, string]> = [
    ['product.name', 'name'],
    ['product.sku', 'sku'],
    ['product.mpn', 'mpn'],
    ['product.brand', 'brand'],
    ['product.description', 'description'],
    ['product.price', 'price'],
    ['product.currency', 'priceCurrency'],
    ['product.availability', 'availability'],
    ['product.weight', 'weight'],
  ]
  for (const [field, prop] of micro) {
    const m = extractMicrodata(html, prop)
    if (m) found.push(observed(field, m.value, 'microdata', `itemprop="${prop}"`, m.fragment))
  }

  // ── Specification blocks: tables, definition lists, "Label: value". ─────
  const pairs = extractSpecPairs(html)
  if (pairs.length) {
    found.push(
      observed(
        'product.specifications',
        pairs.map((p) => `${p.key}: ${p.value}`).join(' | '),
        'dom_heuristic',
        'specification table / definition list',
        pairs.slice(0, 4).map((p) => `${p.key}: ${p.value}`).join(' | '),
      ),
    )
    found.push(
      observed(
        'product.attributes',
        pairs.map((p) => `${p.key}: ${p.value}`).join(' | '),
        'dom_heuristic',
        'specification table / definition list',
        pairs.slice(0, 4).map((p) => `${p.key}: ${p.value}`).join(' | '),
      ),
    )

    const dim = pairs.find((p) => DIMENSION_KEY.test(p.key))
    if (dim) {
      found.push(observed('product.dimensions', `${dim.key}: ${dim.value}`, 'dom_heuristic', `spec row "${dim.key}"`, dim.fragment))
    }
    const wt = pairs.find((p) => WEIGHT_KEY.test(p.key))
    if (wt) {
      found.push(observed('product.weight', `${wt.key}: ${wt.value}`, 'dom_heuristic', `spec row "${wt.key}"`, wt.fragment))
    }

    const unitEvidence = unitsFrom(pairs)
    if (unitEvidence) found.push(unitEvidence)
  }

  // ── Fallbacks that stay honest about what they are. ────────────────────
  if (!found.some((o) => o.field === 'product.name')) {
    const h1 = extractHeadings(html).find((h) => h.level === 1)
    if (h1) found.push(observed('product.name', h1.text, 'dom_heuristic', 'first <h1>', h1.text))
  }

  // Non-capturing groups throughout. With nested captures the value's index
  // shifts whenever an alternative is added, and an off-by-one here records an
  // EMPTY sku as though it had been observed — which is worse than not looking.
  const skuText = html.match(
    /\b(?:sku|part\s*(?:no|number|#)|item\s*(?:no|number|code)|mpn|model)\b\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9._/-]{2,40})/i,
  )
  const skuValue = skuText?.[1]?.trim()
  if (skuValue && !found.some((o) => o.field === 'product.sku')) {
    found.push(observed('product.sku', skuValue, 'dom_heuristic', 'SKU label in page text', skuText![0]))
  }

  const images = countImages(html)
  found.push(observed('product.imageCount', String(images), 'dom_heuristic', '<img> elements', `${images} <img> elements`))

  // The image ITSELF, not just how many there are. Absent is left absent.
  const image = extractProductImage(html, url, product ? (product.node as Record<string, unknown>) : null)
  if (image) found.push(image)

  const docs = extractDocumentLinks(extractLinks(html))
  if (docs.length) {
    found.push(
      observed(
        'product.documents',
        docs.map((d) => d.href).join(' | '),
        'link_analysis',
        'links to document file types',
        docs.slice(0, 3).map((d) => `${d.text || '(no text)'} -> ${d.href}`).join(' | '),
      ),
    )
  }

  // A price-shaped string with no declaration is genuinely ambiguous: it could
  // be a delivery charge or a competitor comparison. Recorded as
  // `could_not_determine` rather than guessed, which is the third status.
  if (!found.some((o) => o.field === 'product.price')) {
    const priceish = html.match(/[£$€]\s?\d[\d,]*(?:\.\d{2})?/)
    if (priceish) {
      found.push(
        couldNotDetermine(
          'product.price',
          'currency-shaped text with no price declaration',
          `Found "${priceish[0]}" in the page but no JSON-LD offer or itemprop="price" to confirm it is this product's price.`,
        ),
      )
    }
  }

  void url
  return completeFields(found, PRODUCT_FIELDS)
}

/** Records which measurement units the page actually used, if any. */
function unitsFrom(pairs: SpecPair[]): Observation | null {
  const units = new Set<string>()
  let fragment = ''
  for (const p of pairs) {
    const m = p.value.match(UNIT_TOKEN)
    if (m) {
      units.add(m[0].toLowerCase())
      if (!fragment) fragment = `${p.key}: ${p.value}`
    }
  }
  if (!units.size) return null
  return observed('product.units', [...units].sort().join(', '), 'dom_heuristic', 'unit tokens in specification values', fragment)
}

// ── Category / listing level ───────────────────────────────────────────────

export function extractCategoryObservations(html: string, url: string): Observation[] {
  const found: Observation[] = []
  const nodes = jsonLdNodes(extractJsonLd(html))

  const list = nodes.find(({ node }) => hasType(node, 'ItemList', 'CollectionPage', 'OfferCatalog'))
  if (list) {
    const name = ldValue(list.node.name)
    if (name) found.push(observed('category.name', name, 'json_ld', `${list.path}.name`, `name: ${name}`))
    const total = ldValue(list.node.numberOfItems)
    if (total) {
      found.push(observed('category.productCount', total, 'json_ld', `${list.path}.numberOfItems`, `numberOfItems: ${total}`))
    }
  }

  if (!found.some((o) => o.field === 'category.name')) {
    const h1 = extractHeadings(html).find((h) => h.level === 1)
    if (h1) found.push(observed('category.name', h1.text, 'dom_heuristic', 'first <h1>', h1.text))
  }

  // "Showing 1-24 of 512 products" — the count the site states publicly.
  if (!found.some((o) => o.field === 'category.productCount')) {
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    const stated = text.match(/\b(?:of|found|showing)\s+([\d,]{1,9})\s+(?:products?|items?|results?)\b/i)
    if (stated?.[1]) {
      // The fragment is widened to the surrounding phrase. "of 512 products" is
      // a correct match but poor evidence; "Showing 1-24 of 512 products" lets a
      // reader see that 512 is the total rather than the page size.
      const at = stated.index ?? 0
      const fragment = text.slice(Math.max(0, at - 40), at + stated[0].length + 20).trim()
      found.push(observed('category.productCount', stated[1], 'dom_heuristic', 'result-count text', fragment))
    }
  }

  const pagination = extractPagination(html)
  if (pagination) found.push(pagination)

  const filters = extractNamedControls(
    html,
    /class\s*=\s*["'][^"']*\b(filter|filters|refine|refinement)\b[^"']*["']/gi,
    'category.filters',
    'filter container class',
  )
  if (filters) found.push(filters)

  const facets = extractNamedControls(
    html,
    /(?:class|id|data-[a-z-]*)\s*=\s*["'][^"']*\bfacet[^"']*["']/gi,
    'category.facets',
    'facet container attribute',
  )
  if (facets) found.push(facets)

  const sorts = html.match(/<select\b[^>]*(?:name|id|class)\s*=\s*["'][^"']*\b(sort|order|orderby)\b[^"']*["'][^>]*>[\s\S]{0,1500}?<\/select>/i)
  if (sorts) {
    const options = [...sorts[0].matchAll(/<option\b[^>]*>([\s\S]{0,120}?)<\/option>/gi)]
      .map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    if (options.length) {
      found.push(
        observed('category.sortOptions', options.join(' | '), 'dom_heuristic', 'sort <select>', options.slice(0, 6).join(' | ')),
      )
    }
  }

  const crumbs = extractBreadcrumbs(html)
  if (crumbs) {
    found.push({ ...crumbs.observation, field: 'category.breadcrumbs' })
  }

  void url
  return completeFields(found, CATEGORY_FIELDS)
}

function extractPagination(html: string): Observation | null {
  const relNext = html.match(/<link\b[^>]*rel\s*=\s*["']next["'][^>]*>/i)
  if (relNext) {
    const href = relNext[0].match(/href\s*=\s*["']([^"']+)["']/i)
    return observed(
      'category.pagination',
      href?.[1] ?? 'rel=next present',
      'meta_tag',
      'link[rel="next"]',
      relNext[0].slice(0, 300),
    )
  }

  const block = html.match(
    /<(nav|ul|div)\b[^>]*class\s*=\s*["'][^"']*\b(pagination|pager|page-numbers)\b[^"']*["'][^>]*>([\s\S]{0,1500}?)<\/\1>/i,
  )
  if (block) {
    const pages = [...(block[3] ?? '').matchAll(/>\s*(\d{1,4})\s*</g)].map((m) => m[1]!)
    return observed(
      'category.pagination',
      pages.length ? `page links: ${[...new Set(pages)].join(', ')}` : 'pagination container present',
      'dom_heuristic',
      'pagination container',
      block[0].slice(0, 300),
    )
  }

  const param = html.match(/href\s*=\s*["'][^"']*[?&](page|p)=(\d+)[^"']*["']/i)
  if (param) {
    return observed('category.pagination', param[0], 'link_analysis', 'link with a page parameter', param[0].slice(0, 300))
  }
  return null
}

/** Records the distinct control labels found, or nothing at all. */
function extractNamedControls(
  html: string,
  re: RegExp,
  field: string,
  sourcePath: string,
): Observation | null {
  const hits = [...html.matchAll(re)].map((m) => m[0])
  if (!hits.length) return null
  const distinct = [...new Set(hits)].slice(0, 12)
  return observed(field, `${hits.length} matching container(s)`, 'dom_heuristic', sourcePath, distinct.join(' | '))
}
