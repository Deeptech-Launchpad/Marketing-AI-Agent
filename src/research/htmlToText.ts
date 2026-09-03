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
  { pattern: /wp-content|wp-includes|woocommerce/i, name: 'WooCommerce / WordPress', category: 'cms' },
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
  { pattern: /squarespace\.com|static1\.squarespace/i, name: 'Squarespace', category: 'cms' },
  { pattern: /wix(?:static|apps)\.com|_wixCssImports/i, name: 'Wix', category: 'cms' },
  { pattern: /\/sites\/default\/files\/|drupal(?:-settings-json|\.js)/i, name: 'Drupal', category: 'cms' },
  { pattern: /prestashop/i, name: 'PrestaShop', category: 'ecommerce' },
  { pattern: /\/_next\/static\//i, name: 'Next.js (custom build)', category: 'framework' },
  { pattern: /salesforce|demandware|dwstatic/i, name: 'Salesforce Commerce Cloud', category: 'ecommerce' },
  { pattern: /shopware/i, name: 'Shopware', category: 'ecommerce' },
  { pattern: /opencart/i, name: 'OpenCart', category: 'ecommerce' },
  { pattern: /nopcommerce/i, name: 'nopCommerce', category: 'ecommerce' },

  // ── PIM / ERP (Stage 2) ───────────────────────────────────────────────────
  // Deliberately few. These are the vendors whose presence leaves an
  // unambiguous trace in delivered markup; anything only visible server-side
  // (most ERPs) is NOT guessed at from a homepage.
  { pattern: /akeneo\.com|akeneo-pim|\/akeneo\//i, name: 'Akeneo (PIM)', category: 'pim' },
  { pattern: /pimcore/i, name: 'Pimcore (PIM)', category: 'pim' },
  { pattern: /cdn\.salsify\.com|salsify\.com\/|images\.salsify/i, name: 'Salsify (PIM)', category: 'pim' },
  { pattern: /inriver\.com|inriverapi|productmarketingcloud\.com/i, name: 'inRiver (PIM)', category: 'pim' },
  { pattern: /hybris|\/_ui\/responsive\/|sap-commerce|sapcommerce/i, name: 'SAP Commerce (Hybris)', category: 'erp' },
  { pattern: /netsuite\.com|nlapi|\/app\/site\/hosting\//i, name: 'NetSuite', category: 'erp' },
  { pattern: /epicor/i, name: 'Epicor', category: 'erp' },
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
  generator: string | null
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
  const generator = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const descr = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)

  // A <meta name="generator"> tag is the site DECLARING its own platform. That
  // is stronger evidence than any asset-path heuristic, and it is the only way
  // to catch platforms absent from the table above — real prospect sites turned
  // up nopCommerce and "The IPG Member Platform", neither of which any
  // fingerprint would ever have matched.
  //
  // Categorised 'declared' rather than guessed at: the tag says WHAT is running,
  // not whether it is a CMS, a shop or a site builder.
  const declared = generator?.[1]?.trim()
  if (declared && !technologies.some((t) => t.name.toLowerCase() === declared.toLowerCase())) {
    technologies.push({
      name: declared.slice(0, 80),
      category: 'declared',
      evidence: evidenceFor(html, generator!),
    })
    platforms.push(declared.slice(0, 80))
  }

  return {
    platforms,
    technologies,
    generator: generator?.[1]?.trim() ?? null,
    title: title?.[1] ? htmlToText(title[1]).slice(0, 200) : null,
    metaDescription: descr?.[1]?.trim().slice(0, 300) ?? null,
    hasStructuredData: /application\/ld\+json/i.test(html),
    productSchema: /"@type"\s*:\s*"Product"/i.test(html),
    imageCount: (html.match(/<img\b/gi) ?? []).length,
    tableCount: (html.match(/<table\b/gi) ?? []).length,
    pdfLinks: (html.match(/href=["'][^"']+\.pdf/gi) ?? []).length,
  }
}
