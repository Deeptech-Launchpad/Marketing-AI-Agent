import type { IntentSignalDraft } from './types.js'

// BUSINESS INTENT SIGNALS — marketplace expansion, RFP/tender activity,
// international expansion and catalogue size.
//
// BUSINESS SOURCE: Team Answer, Section D.6 and Section 8 of the brief:
//
//   "Marketplace expansion — company newly selling on Amazon, eBay, Walmart
//    Marketplace... increase in SKU/product count on their own site.
//    RFP/tender activity & International expansion — publicly posted
//    RFPs/tenders for eCommerce, PIM, or catalog systems; new country domains
//    or multi-language site versions."
//
// The governing constraint, from the same brief: "Every signal must be
// evidence-backed. Never create intent from speculation."
//
// So every detector here works the same way: it is handed page content that
// was actually fetched, and it returns a signal ONLY when it can quote the
// fragment that caused it. A detector that cannot point at text returns
// nothing. No path in this file produces a signal from an absence, an
// inference, or a model's opinion.

export interface PageEvidence {
  url: string
  /** Visible text, already extracted. */
  text: string
  /** Raw HTML, where the markup itself is the evidence (hreflang, say). */
  html?: string
  observedAt: Date
}

export interface DetectorContext {
  crmCompanyId: string
  /** Which collector fetched the page, recorded on every signal. */
  provider: string
  /** The company's own domain, so its own links are not read as expansion. */
  homeDomain: string | null
}

/** Trims a match to a readable quote with a little context either side. */
function quote(text: string, index: number, length: number, pad = 60): string {
  const start = Math.max(0, index - pad)
  const end = Math.min(text.length, index + length + pad)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}

// ── 1. MARKETPLACE EXPANSION ───────────────────────────────────────────────

const MARKETPLACES: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'Amazon',
    pattern: /\b(amazon\.[a-z.]{2,6}\/(?:s|stores|shops|sp)\b|sold\s+on\s+amazon|our\s+amazon\s+store|amazon\s+storefront|shop\s+(?:us\s+)?on\s+amazon)/i,
  },
  {
    name: 'eBay',
    pattern: /\b(ebay\.[a-z.]{2,6}\/(?:str|usr|sch)\b|our\s+ebay\s+(?:store|shop)|sold\s+on\s+ebay|ebay\s+storefront)/i,
  },
  {
    name: 'Walmart Marketplace',
    pattern: /\b(walmart\.com\/(?:seller|browse|ip)\b|walmart\s+marketplace|sold\s+on\s+walmart)/i,
  },
]

/**
 * Detects that a company sells through a marketplace.
 *
 * "Newly selling" is deliberately not decided here. This reports what the site
 * says today; whether that is NEW is a comparison against the previous
 * observation, and the engine that stores signals owns that history. Claiming
 * novelty from a single page read would be the speculation the rule forbids.
 */
export function detectMarketplace(page: PageEvidence, ctx: DetectorContext): IntentSignalDraft[] {
  const out: IntentSignalDraft[] = []
  for (const m of MARKETPLACES) {
    const inText = m.pattern.exec(page.text)
    const inHtml = inText ? null : page.html ? m.pattern.exec(page.html) : null
    const match = inText ?? inHtml
    if (!match) continue
    const haystack = inText ? page.text : page.html!

    out.push({
      crmCompanyId: ctx.crmCompanyId,
      signalCategory: 'business',
      signalType: 'marketplace_presence',
      summary: `Sells through ${m.name}.`,
      interpretation:
        `A distributor selling on ${m.name} has to meet that marketplace's product-data requirements — ` +
        `complete attributes, images and identifiers per listing. That is the same catalogue work this platform ` +
        `addresses. It indicates relevance; it does not establish that they are looking for help.`,
      polarity: 'positive',
      sourceType: 'company_website',
      sourceUrl: page.url,
      evidence: quote(haystack, match.index, match[0].length),
      observedAt: page.observedAt,
      provider: ctx.provider,
      metadata: { marketplace: m.name, matched: match[0] },
    })
  }
  return out
}

// ── 2. RFP / TENDER ACTIVITY ───────────────────────────────────────────────

/**
 * Two conditions, both required.
 *
 * A page must look like a procurement document AND name a system in scope.
 * Either alone is noise: distributors publish tender pages for warehouse
 * racking, and they use the word "catalogue" on every page of the site. The
 * conjunction is what makes it a buying signal rather than a word count.
 */
const PROCUREMENT =
  /\b(request for proposal|request for information|request for quotation|rfp|rfi|rfq|invitation to tender|tender notice|call for tenders|procurement notice)\b/i
const SYSTEM_IN_SCOPE =
  /\b(e-?commerce platform|product information management|pim|product data|catalog(?:ue)?\s+(?:system|management|platform)|master data management|mdm|digital commerce platform|web ?shop)\b/i

export function detectRfp(page: PageEvidence, ctx: DetectorContext): IntentSignalDraft[] {
  const proc = PROCUREMENT.exec(page.text)
  if (!proc) return []
  const sys = SYSTEM_IN_SCOPE.exec(page.text)
  if (!sys) return []

  return [
    {
      crmCompanyId: ctx.crmCompanyId,
      signalCategory: 'business',
      signalType: 'rfp_tender',
      summary: `Published procurement activity mentioning ${sys[0]}.`,
      interpretation:
        `The page carries both procurement language ("${proc[0]}") and a system this platform serves ("${sys[0]}"). ` +
        `Both were required: procurement language alone is routine for a distributor, and the system name alone ` +
        `appears on ordinary marketing pages.`,
      polarity: 'positive',
      sourceType: 'third_party',
      sourceUrl: page.url,
      evidence: `${quote(page.text, proc.index, proc[0].length)} || ${quote(page.text, sys.index, sys[0].length)}`,
      observedAt: page.observedAt,
      provider: ctx.provider,
      metadata: { procurementTerm: proc[0], system: sys[0] },
    },
  ]
}

// ── 3. INTERNATIONAL EXPANSION ─────────────────────────────────────────────

const COUNTRY_HINT = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:co\.uk|co\.za|com\.au|co\.nz|com\.sg|ae|ie|mt|ca)\b/gi
const LOCALE_PATH = /\/([a-z]{2}-[a-z]{2})\//gi

/**
 * Detects that a company operates in more than one country or language.
 *
 * `hreflang` is checked first and treated as the strongest evidence, because
 * it is the site's own machine-readable declaration of which locales it
 * serves — a statement by the company rather than an inference about it. One
 * locale is not expansion; two or more distinct ones is.
 */
export function detectInternational(page: PageEvidence, ctx: DetectorContext): IntentSignalDraft[] {
  const locales = new Set<string>()
  const shown: string[] = []

  if (page.html) {
    const re = /<link[^>]+rel=["']?alternate["']?[^>]*hreflang=["']([a-z-]{2,10})["'][^>]*>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(page.html)) !== null) {
      const tag = m[1]!.toLowerCase()
      if (tag === 'x-default') continue
      locales.add(tag)
      if (shown.length < 4) shown.push(m[0].trim().slice(0, 180))
    }
  }

  if (locales.size >= 2) {
    return [
      {
        crmCompanyId: ctx.crmCompanyId,
        signalCategory: 'business',
        signalType: 'international_expansion',
        summary: `Serves ${locales.size} locales: ${[...locales].sort().join(', ')}.`,
        interpretation:
          `The site declares ${locales.size} alternate locales via hreflang. Serving several countries or ` +
          `languages multiplies the product-data work: every attribute, description and unit of measure has to ` +
          `exist correctly in each one.`,
        polarity: 'positive',
        sourceType: 'company_website',
        sourceUrl: page.url,
        evidence: shown.join(' || '),
        observedAt: page.observedAt,
        provider: ctx.provider,
        metadata: { locales: [...locales].sort(), strength: 'hreflang_declared' },
      },
    ]
  }

  // Weaker fallback: country domains or locale paths linked from the page,
  // excluding the site's own domain.
  const haystack = page.html ?? page.text
  const domains = new Set<string>()
  const home = ctx.homeDomain?.toLowerCase() ?? ''
  for (const m of haystack.matchAll(COUNTRY_HINT)) {
    const full = m[0].toLowerCase().replace(/^https?:\/\//, '')
    if (home && (full === home || full.endsWith(`.${home}`))) continue
    domains.add(full)
  }
  const localePaths = new Set([...haystack.matchAll(LOCALE_PATH)].map((m) => m[1]!.toLowerCase()))
  const total = domains.size + localePaths.size

  if (total >= 2) {
    return [
      {
        crmCompanyId: ctx.crmCompanyId,
        signalCategory: 'business',
        signalType: 'international_expansion',
        summary: `References ${total} country-specific sites or locale paths.`,
        interpretation:
          'The page links to country-specific domains or locale paths beyond its own. This is weaker evidence ' +
          'than an hreflang declaration — a link is not proof of operating there — and is recorded as such.',
        polarity: 'positive',
        sourceType: 'company_website',
        sourceUrl: page.url,
        evidence: [...domains, ...localePaths].slice(0, 6).join(' || '),
        observedAt: page.observedAt,
        provider: ctx.provider,
        metadata: {
          domains: [...domains],
          localePaths: [...localePaths],
          strength: 'weaker_than_hreflang',
        },
      },
    ]
  }

  return []
}

// ── 4. CATALOGUE SIZE ──────────────────────────────────────────────────────

/**
 * Reports an observed product count so the engine can compare it with the
 * previous observation.
 *
 * This returns a MEASUREMENT, not a growth signal, and its polarity is
 * neutral for that reason. "SKU count increased" is a claim about two points
 * in time, and a detector holding one page cannot make it.
 */
export function detectProductCount(page: PageEvidence, ctx: DetectorContext): IntentSignalDraft[] {
  const patterns = [
    /\b(?:over|more than|upwards of)\s+([\d][\d,.]{2,})\s+(?:products|items|skus|parts|lines)\b/i,
    /\b([\d][\d,.]{2,})\+?\s+(?:products|items|skus|parts|lines)\b/i,
  ]
  for (const p of patterns) {
    const m = p.exec(page.text)
    if (!m) continue
    const count = Number(m[1]!.replace(/[,.]/g, ''))
    if (!Number.isFinite(count) || count < 100) continue
    return [
      {
        crmCompanyId: ctx.crmCompanyId,
        signalCategory: 'catalog',
        signalType: 'product_count_observed',
        summary: `States a catalogue of about ${count.toLocaleString()} products.`,
        interpretation:
          'A product count quoted from the company\'s own page. Whether it represents growth depends on the ' +
          'previous observation and is decided when the signal is stored, not here.',
        polarity: 'neutral',
        sourceType: 'company_website',
        sourceUrl: page.url,
        evidence: quote(page.text, m.index, m[0].length),
        observedAt: page.observedAt,
        provider: ctx.provider,
        metadata: { productCount: count, stated: m[0].trim() },
      },
    ]
  }
  return []
}

/** Every business detector, run over one page. */
export function detectBusinessSignals(page: PageEvidence, ctx: DetectorContext): IntentSignalDraft[] {
  return [
    ...detectMarketplace(page, ctx),
    ...detectRfp(page, ctx),
    ...detectInternational(page, ctx),
    ...detectProductCount(page, ctx),
  ]
}
