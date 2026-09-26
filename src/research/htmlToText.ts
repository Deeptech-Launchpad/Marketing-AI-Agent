// HTML -> text and platform fingerprinting, ported from NXT Sales'
// server/src/routes/intelligence.js. The entity-decoding order and the Magento
// lookbehind below are both bug fixes from over there and should be preserved.

/**
 * Decodes one numeric entity, leaving the original text alone if the code point
 * is invalid — String.fromCodePoint throws on out-of-range values, which would
 * otherwise take down the whole extraction for one malformed entity.
 */
function safeCodePoint(n: number, original: string): string {
  if (!Number.isInteger(n) || n < 1 || n > 0x10ffff) return original
  try {
    return String.fromCodePoint(n)
  } catch {
    return original
  }
}

export function htmlToText(html: string): string {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    // Numeric entities are everywhere in real product copy; left raw they reach
    // the model as literal noise, e.g. "HBA &#8211; Vehicle Parts".
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d: string) => safeCodePoint(parseInt(d, 10), m))
    // &amp; is decoded LAST so an already-escaped entity ("&amp;#8211;") is not
    // promoted into a real one by an earlier pass.
    .replace(/&amp;/gi, '&')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

export type TechnologyCategory = 'ecommerce' | 'cms' | 'pim' | 'erp' | 'framework' | 'declared'

export interface TechnologySignature {
  pattern: RegExp
  name: string
  category: TechnologyCategory
}

// Checked against the RAW html: markup and asset paths are the giveaway, and
// they are stripped out of the text version.
//
// Every pattern must key on a token that is DISTINCTIVE to the vendor. A bare
// vendor word matches ordinary prose — "infor" is inside "information",
// "epicor" is not inside anything — so the test is whether the token can plausibly
// appear on a site that does not use the product. Where it can, the pattern is
// anchored to an asset path, CDN host or namespaced identifier instead.
export const PLATFORM_SIGNATURES: TechnologySignature[] = [
  { pattern: /cdn\.shopify\.com|shopify-(?:section|features)|Shopify\.theme/i, name: 'Shopify', category: 'ecommerce' },
  // WordPress and WooCommerce are separate detections. Every WooCommerce shop
  // is a WordPress site, but most WordPress sites are not shops — labelling any
  // wp-content path "WooCommerce / WordPress" claimed a shop that was not there.
  { pattern: /\/wp-content\/|\/wp-includes\/|\/wp-json\//i, name: 'WordPress', category: 'cms' },
  {
    pattern:
      /\/plugins\/woocommerce\/|\bwoocommerce_params\b|\bwc_add_to_cart_params\b|[?&]wc-ajax=|class=["'][^"']*\bwoocommerce(?:-page|-cart|-shop)?\b/i,
    name: 'WooCommerce',
    category: 'ecommerce',
  },
  // The lookbehind on `mage/` is load-bearing: a bare /mage\// also matches
  // "i-mage/" — every "image/jpeg" meta tag and /uploads/image/ path — which
  // falsely tagged plain WordPress sites as Magento.
  {
    pattern: /\/skin\/frontend\/|Magento_|(?<![a-z])mage\/|static\/version\d+\/frontend/i,
    name: 'Magento',
    category: 'ecommerce',
  },
  { pattern: /cdn\d*\.bigcommerce\.com|bigcommerce\.com\/s-/i, name: 'BigCommerce', category: 'ecommerce' },
  { pattern: /cdn\.shopifycloud\.com/i, name: 'Shopify', category: 'ecommerce' },
  // CDN hosts and the page-context global only. A bare "squarespace.com" is a
  // link anyone can publish ("our old site was on squarespace.com").
  {
    pattern: /static1\.squarespace\.com|assets\.squarespace\.com|images\.squarespace-cdn\.com|\bSquarespace\.(?:afterBodyLoad|load)\b|\bSQUARESPACE_CONTEXT\b/i,
    name: 'Squarespace',
    category: 'cms',
  },
  { pattern: /wix(?:static|apps)\.com|_wixCssImports/i, name: 'Wix', category: 'cms' },
  { pattern: /\/sites\/default\/files\/|drupal(?:-settings-json|\.js)/i, name: 'Drupal', category: 'cms' },
  // The vendor words below appear in ordinary prose (a case study, a partner
  // page, a job ad) and in links to the vendor, so none is matched bare. Each is
  // anchored to an asset path, a CDN host or a namespaced identifier that only
  // the running software emits.
  {
    pattern: /\bvar\s+prestashop\s*=|\/modules\/ps_[a-z0-9_]+\/|\bprestashop\.(?:on|emit)\(/i,
    name: 'PrestaShop',
    category: 'ecommerce',
  },
  { pattern: /\/_next\/static\//i, name: 'Next.js (custom build)', category: 'framework' },
  {
    // "salesforce" alone is the CRM, a partner logo or a job ad — never proof
    // of Commerce Cloud. Its storefront assets are served from demandware paths.
    pattern: /demandware\.(?:static|store|net|com)|\/on\/demandware\.|\bdwstatic\b|\/dw\/shop\/v\d/i,
    name: 'Salesforce Commerce Cloud',
    category: 'ecommerce',
  },
  {
    pattern: /\/bundles\/storefront\/|\/themes\/Frontend\/(?:Bare|Responsive)\/|\/engine\/Shopware\//i,
    name: 'Shopware',
    category: 'ecommerce',
  },
  {
    pattern: /\/catalog\/view\/(?:theme|javascript)\/|index\.php\?route=(?:product|common|checkout|account)\//i,
    name: 'OpenCart',
    category: 'ecommerce',
  },
  {
    pattern: /\/js\/public\.(?:common|ajaxcart)\.js|\bAjaxCart\.(?:addproducttocart_catalog|addproducttocart_details|init)\b/i,
    name: 'nopCommerce',
    category: 'ecommerce',
  },

  // ── PIM / ERP (Stage 2) ───────────────────────────────────────────────────
  // Deliberately few. These are the vendors whose presence leaves an
  // unambiguous trace in delivered markup; anything only visible server-side
  // (most ERPs) is NOT guessed at from a homepage.
  { pattern: /akeneo\.com|akeneo-pim|\/akeneo\//i, name: 'Akeneo (PIM)', category: 'pim' },
  { pattern: /\/bundles\/pimcore[a-z]*\/|class=["'][^"']*\bpimcore_(?:area|editable|block)/i, name: 'Pimcore (PIM)', category: 'pim' },
  { pattern: /cdn\.salsify\.com|salsify\.com\/|images\.salsify/i, name: 'Salsify (PIM)', category: 'pim' },
  { pattern: /inriver\.com|inriverapi|productmarketingcloud\.com/i, name: 'inRiver (PIM)', category: 'pim' },
  {
    pattern: /\/_ui\/(?:responsive|desktop|addons)\/|\/yacceleratorstorefront\/|\/medias\/[^"'\s?]+\?context=|\bACC\.config\b/i,
    name: 'SAP Commerce (Hybris)',
    category: 'erp',
  },
  { pattern: /netsuite\.com|nlapi|\/app\/site\/hosting\//i, name: 'NetSuite', category: 'erp' },
  { pattern: /[a-z0-9-]+\.epicorsaas\.com|\/epicor(?:commerce|ecc)\/|\bEpicor(?:Commerce|ECC)\.[A-Za-z]/i, name: 'Epicor', category: 'erp' },
]

/** One detected technology, with the literal page text that proved it. */
export interface DetectedTechnology {
  name: string
  category: TechnologyCategory
  /** The exact substring matched in the page source. Real evidence, not a label. */
  evidence: string
}

export interface PageSignals {
  /** Names only. Kept for callers that predate evidence capture. */
  platforms: string[]
  /** Same detections, each carrying the markup that proved it. */
  technologies: DetectedTechnology[]
  /** The FIRST generator declaration, verbatim. Kept for older callers. */
  generator: string | null
  /**
   * Every generator declaration on the page, verbatim and in order. Optional
   * because signals cached before it existed do not carry it.
   */
  generators?: string[]
  title: string | null
  metaDescription: string | null
  hasStructuredData: boolean
  productSchema: boolean
  imageCount: number
  tableCount: number
  pdfLinks: number
}

const MAX_EVIDENCE_CHARS = 160

/**
 * Widens a regex hit to a little surrounding context, so the stored evidence is
 * inspectable ("cdn.shopify.com/s/files/..." rather than just "cdn.shopify.com")
 * and a false positive is obvious on sight rather than needing a re-fetch.
 */
function evidenceFor(html: string, match: RegExpMatchArray): string {
  const at = match.index ?? 0
  const start = Math.max(0, at - 40)
  const end = Math.min(html.length, at + match[0].length + 60)
  return html
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EVIDENCE_CHARS)
}

function evidenceAt(html: string, index: number, length: number): string {
  const start = Math.max(0, index - 40)
  const end = Math.min(html.length, index + length + 60)
  return html.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, MAX_EVIDENCE_CHARS)
}

interface MetaHit {
  value: string
  index: number
  length: number
}

/**
 * Every `<meta name="…" content="…">` with the given name, in document order.
 *
 * Attributes are read individually, so `content` before `name` is found as
 * readily as the conventional order, and a page declaring several generators
 * (a platform plus its plugins) yields all of them rather than the first.
 */
export function metaTags(html: string, name: string): MetaHit[] {
  const hits: MetaHit[] = []
  const wanted = name.toLowerCase()
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>()
    for (const a of tag[0].matchAll(/([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(a[1]!.toLowerCase(), (a[2] ?? a[3] ?? a[4] ?? '').trim())
    }
    if ((attrs.get('name') ?? '').toLowerCase() !== wanted) continue
    const content = attrs.get('content')
    if (content === undefined) continue
    hits.push({ value: content, index: tag.index ?? 0, length: tag[0].length })
  }
  return hits.filter((h, i) => name !== 'generator' || (h.value && hits.findIndex((o) => o.value === h.value) === i))
}

/** "WordPress 6.4.2" -> "WordPress"; "Drupal 10 (https://www.drupal.org)" -> "Drupal". */
export function stripVersion(raw: string): string {
  return raw
    .replace(/\s*\(https?:\/\/[^)]*\)\s*/gi, ' ')
    .replace(/[\s,;:-]+v?\d+(?:\.[\dx]+)*(?:[-+.][\w.]+)?(?=$|[\s;,(-]).*$/i, '')
    .replace(/[\s,;:-]+$/, '')
    .trim()
}

/** The vendor a product name belongs to: "Wix.com Website Builder" -> "wix". */
export function vendorToken(name: string): string {
  return (name.toLowerCase().replace(/^powered by\s+/, '').match(/[a-z0-9]+/)?.[0] ?? '')
}

/**
 * Plugins, themes and page builders announce themselves in generator tags too.
 * They name an add-on, not the platform, so they are not technologies here.
 *
 * Two generic rules: the declaration reads like an add-on (builder, plugin,
 * slider, "by <vendor>", SEO/analytics kits), or the page already runs
 * WordPress — whose plugins routinely emit their own generator tag — and the
 * declaration matched no platform.
 */
function isPluginGenerator(declared: string, detected: DetectedTechnology[]): boolean {
  if (/\b(?:plugin|page builder|builder for|slider|theme|by google|seo|analytics|site kit|wpbakery|visual composer|elementor|yoast|jetpack|wpml|redux|revolution|divi|gutenberg|all in one)\b/i.test(declared)) {
    return !/website builder|site builder/i.test(declared)
  }
  return detected.some((t) => t.name === 'WordPress' || t.name === 'WooCommerce')
}

export function detectSignals(html: string): PageSignals {
  const platforms: string[] = []
  const technologies: DetectedTechnology[] = []

  for (const sig of PLATFORM_SIGNATURES) {
    const match = html.match(sig.pattern)
    if (!match) continue
    // De-duplicated by NAME, not by pattern: Shopify has two signatures, and a
    // site hitting both is one detection, not two.
    if (technologies.some((t) => t.name === sig.name)) continue
    technologies.push({ name: sig.name, category: sig.category, evidence: evidenceFor(html, match) })
    platforms.push(sig.name)
  }
  const generators = metaTags(html, 'generator')
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const descr = metaTags(html, 'description')[0]

  // A <meta name="generator"> tag is the site DECLARING its own platform. That
  // is stronger evidence than any asset-path heuristic, and it is the only way
  // to catch platforms absent from the table above — real prospect sites turned
  // up nopCommerce and "The IPG Member Platform", neither of which any
  // fingerprint would ever have matched.
  //
  // Three rules keep one platform from being counted twice:
  //   1. A declaration naming the same vendor as a fingerprint is FOLDED into
  //      that fingerprint ("Wix.com Website Builder" is Wix, "WordPress 6.4"
  //      is WordPress), never listed beside it.
  //   2. Versions are stripped — "WordPress 6.4.2" and "WordPress 6.5" are one
  //      platform, and a version is not a technology.
  //   3. A generator written by a plugin or page builder names an add-on, not
  //      the platform, so it is not reported as a technology.
  //
  // Anything left is categorised 'declared' rather than guessed at: the tag
  // says WHAT is running, not whether it is a CMS, a shop or a site builder.
  // Platform declarations are settled before add-on ones, so a plugin tag that
  // happens to precede "WordPress 6.4" in the markup is still seen as a plugin.
  const isPlatformDeclaration = (value: string): boolean =>
    PLATFORM_SIGNATURES.some((sig) => vendorToken(sig.name) === vendorToken(stripVersion(value)))
  const ordered = [...generators].sort(
    (a, b) => Number(!isPlatformDeclaration(a.value)) - Number(!isPlatformDeclaration(b.value)),
  )
  for (const gen of ordered) {
    const declared = stripVersion(gen.value)
    if (!declared) continue
    const token = vendorToken(declared)

    const known = PLATFORM_SIGNATURES.find((sig) => vendorToken(sig.name) === token)
    if (known) {
      if (!technologies.some((t) => t.name === known.name)) {
        technologies.push({ name: known.name, category: known.category, evidence: evidenceAt(html, gen.index, gen.length) })
        platforms.push(known.name)
      }
      continue
    }
    if (technologies.some((t) => vendorToken(t.name) === token)) continue
    if (isPluginGenerator(declared, technologies)) continue

    const name = declared.slice(0, 80)
    technologies.push({ name, category: 'declared', evidence: evidenceAt(html, gen.index, gen.length) })
    platforms.push(name)
  }

  return {
    platforms,
    technologies,
    generator: generators[0]?.value ?? null,
    generators: generators.map((g) => g.value),
    title: title?.[1] ? htmlToText(title[1]).slice(0, 200) : null,
    metaDescription: descr ? descr.value.slice(0, 300) : null,
    hasStructuredData: /application\/ld\+json/i.test(html),
    productSchema: /"@type"\s*:\s*"Product"/i.test(html),
    imageCount: (html.match(/<img\b/gi) ?? []).length,
    tableCount: (html.match(/<table\b/gi) ?? []).length,
    pdfLinks: (html.match(/href=["'][^"']+\.pdf/gi) ?? []).length,
  }
}
