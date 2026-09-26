import type { EnrichedRecord } from './enrichedRecord.js'

// THE 15-POINT AI DISCOVERABILITY SCORECARD.
//
// Three pillars — can an engine FIND this product, UNDERSTAND it, and
// RECOMMEND it — five checks each, weighted 30 / 30 / 40.
//
// EVERY CHECK IS DECIDED BY A RULE OVER SOMETHING THE CRAWLER ACTUALLY
// OBSERVED. No model is asked for an opinion, nothing is estimated, and the
// same page scores the same twice. That is the only reason a number like
// "34 / 100" is allowed to appear on a customer's desk at all: they can ask
// what produced it and be given a fact about their own page.
//
// TWO OF THE FIFTEEN CANNOT BE RUN HERE, and the honest handling of that is
// most of this file:
//
//   A5  Off-Domain Citation Surface — needs a backlink/citation index
//   C5  Live Answer Engine Outcome — needs buyer-intent prompts executed
//       against ChatGPT, Claude, Gemini, Grok and Perplexity, with the results
//       captured
//
// This platform has neither. So both are reported as NOT ASSESSED, they are
// excluded from the denominator, and the score states what it was computed
// from. A "0" for a check nobody ran would be a fabricated failure, and an
// invented citation count would be worse.

export type CheckStatus = 'pass' | 'partial' | 'fail' | 'critical_fail' | 'not_assessed'

export interface ScorecardCheck {
  /** A1, B3, C5 — the reference the template prints and the roadmap cites. */
  ref: string
  /** The metric's name, as the template words it. */
  metric: string
  /** What was found on THIS page, in one or two sentences of plain fact. */
  finding: string
  status: CheckStatus
  /**
   * What the finding was read from, so a disagreement is settleable.
   * Empty only for a check that was not assessed.
   */
  basis: string[]
  /**
   * Why this check could not be run, in one sentence for the customer.
   *
   * Set on, and only on, a check whose status is `not_assessed`. It lives on
   * the check so the not-assessed ledger can be READ OFF the checks instead of
   * written out a second time beside them — see `notAssessedLedger`.
   */
  notAssessedReason?: string
}

export interface Pillar {
  key: 'find' | 'understand' | 'recommend'
  /** "Can AI Find You?" */
  title: string
  /** "Crawlability & Schema" */
  subtitle: string
  /** 30, 30, 40. */
  weightPct: number
  checks: ScorecardCheck[]
  /** 0-100 over the checks that were actually assessed in this pillar. */
  score: number
  assessedCount: number
  notAssessedCount: number
}

export interface Scorecard {
  pillars: Pillar[]
  /** 0-100, weighted across pillars, over assessed checks only. */
  overall: number
  /** "FINDABLE, NOT RECOMMENDED" and its siblings. */
  verdict: string
  /** How many of the fifteen were actually run. */
  assessedCount: number
  /** Named, so the report can say which ones and why. */
  notAssessed: Array<{ ref: string; metric: string; reason: string }>
  /**
   * The sentence that must appear wherever the overall number appears.
   * Not optional: a score printed without its denominator is a claim about
   * fifteen checks when it is a measurement of thirteen.
   */
  denominatorNote: string
}

/** What a check scores when it passes, partially passes, or fails. */
const POINTS: Record<Exclude<CheckStatus, 'not_assessed'>, number> = {
  pass: 100,
  partial: 50,
  fail: 0,
  critical_fail: 0,
}

/** Five checks in each of three pillars. The name the denominator is measured against. */
const TOTAL_CHECKS = 15

/**
 * The not-assessed ledger, READ OFF the checks rather than written beside them.
 *
 * This is now the only way any scorecard's `notAssessed` is produced, and that
 * is the whole point of it existing.
 *
 * It used to be derived here for a live audit and hand-written for a run with
 * no auditable product page — where it was written as `[]` even though all
 * fifteen of that scorecard's checks carried `status: 'not_assessed'`. The two
 * fields disagreed, and page 2 of the report branches on the ARRAY to decide
 * whether to print its "all fifteen checks were run against the live page"
 * reassurance. So the one report that had assessed nothing at all told the
 * customer everything had been assessed, in a green panel, printed directly
 * beneath a table reading 0 of 5, 0 of 5, 0 of 5.
 *
 * Deriving it makes that state unreachable rather than merely fixed: fifteen
 * unassessed checks and an empty ledger can no longer coexist, because nobody
 * writes the ledger any more.
 */
function notAssessedLedger(pillars: Pillar[]): Scorecard['notAssessed'] {
  return pillars
    .flatMap((p) => p.checks)
    .filter((c) => c.status === 'not_assessed')
    .map((c) => ({
      ref: c.ref,
      metric: c.metric,
      // A check that declares itself unassessed without saying why is a bug,
      // but it is not a reason to print nothing in the customer's "why" column.
      reason: c.notAssessedReason ?? 'This check was not run in this audit.',
    }))
}

/** What the auditor observed about one product page. */
export interface ScorecardInput {
  /** The audited page's own transport facts. */
  page: {
    httpStatus: number | null
    finalUrl: string | null
    canonicalUrl: string | null
    wordCount: number
    outcome: string
  }
  /** The `@type` values found in JSON-LD or microdata, if any. */
  structuredDataTypes: string[]
  /** Breadcrumb trail exactly as the page published it. */
  breadcrumbs: string | null
  /** The enriched record for this page: the fields, their state, their method. */
  record: EnrichedRecord
  /** Product pages inspected in the run, for the variant/relation check. */
  productPagesInspected: number
  /** Links from this page to other product pages on the same site. */
  siblingProductLinks: number
}

const has = (record: EnrichedRecord, field: string): boolean =>
  record.fields.some((f) => f.field === field && f.state !== 'absent' && f.before !== null)

const valueOf = (record: EnrichedRecord, field: string): string | null =>
  record.fields.find((f) => f.field === field)?.before ?? null

const methodOf = (record: EnrichedRecord, field: string): string | null =>
  record.fields.find((f) => f.field === field)?.method ?? null

/**
 * Builds the scorecard for one audited product page.
 *
 * Pure: given the same observations it returns the same fifteen rows, which is
 * what makes the number defensible when a customer asks about it.
 */
export function buildScorecard(input: ScorecardInput): Scorecard {
  const { page, record } = input
  const observedFields = record.fields.filter((f) => f.state !== 'absent' && f.before !== null)
  const schemaTypes = input.structuredDataTypes
  const hasProductSchema = schemaTypes.some((t) => /product|offer|itemlist/i.test(t))

  // ── PILLAR 1 — can an engine find it? ─────────────────────────────────
  const a1: ScorecardCheck = page.outcome === 'fetched' && (page.httpStatus ?? 0) < 400
    ? {
        ref: 'A1',
        metric: 'Crawler Access & Rendering',
        finding: `The page answered HTTP ${page.httpStatus} to an ordinary crawler and its content was readable without executing scripts (${page.wordCount} words of text recovered).`,
        status: 'pass',
        basis: [`HTTP ${page.httpStatus}`, `${page.wordCount} words extracted`],
      }
    : {
        ref: 'A1',
        metric: 'Crawler Access & Rendering',
        finding: `The page did not return readable content to a crawler — outcome "${page.outcome}"${page.httpStatus ? `, HTTP ${page.httpStatus}` : ''}. An engine that cannot fetch a page cannot index it.`,
        status: 'critical_fail',
        basis: [`outcome=${page.outcome}`, page.httpStatus ? `HTTP ${page.httpStatus}` : 'no response'],
      }

  const canonical = page.canonicalUrl
  const a2: ScorecardCheck = canonical
    ? {
        ref: 'A2',
        metric: 'URL & Indexation Integrity',
        finding: `The page declares a canonical URL (${canonical}), so an engine can tell which address is the one to index.`,
        status: 'pass',
        basis: [`canonical: ${canonical}`],
      }
    : {
        ref: 'A2',
        metric: 'URL & Indexation Integrity',
        finding:
          'No canonical URL is declared. Where the same product is reachable at more than one address, nothing tells an engine which one to treat as the product.',
        status: 'fail',
        basis: ['no <link rel="canonical"> observed'],
      }

  const a3: ScorecardCheck = hasProductSchema
    ? {
        ref: 'A3',
        metric: 'Structured Data (Schema.org)',
        finding: `Product structured data is present: ${schemaTypes.join(', ')}. A machine reading this page is given entities rather than paragraphs.`,
        status: 'pass',
        basis: [`@type: ${schemaTypes.join(', ')}`],
      }
    : schemaTypes.length > 0
      ? {
          ref: 'A3',
          metric: 'Structured Data (Schema.org)',
          finding: `Structured data is present (${schemaTypes.join(', ')}) but none of it describes the product. The attributes on this page are readable by a person and not by a machine.`,
          status: 'partial',
          basis: [`@type: ${schemaTypes.join(', ')}`, 'no Product/Offer type'],
        }
      : {
          ref: 'A3',
          metric: 'Structured Data (Schema.org)',
          finding:
            'CRITICAL: no JSON-LD or microdata was found on this page. Every attribute below exists only as visual HTML, so an engine has no entity to attach them to.',
          status: 'critical_fail',
          basis: ['no JSON-LD block', 'no microdata itemprop'],
        }

  const mpn = valueOf(record, 'product.mpn')
  const gtin = valueOf(record, 'product.gtin')
  const idMethod = methodOf(record, 'product.mpn')
  const a4: ScorecardCheck =
    mpn && gtin
      ? {
          ref: 'A4',
          metric: 'Identifier Resolution',
          finding: `Both a manufacturer part number (${mpn}) and a GTIN (${gtin}) are published, so this product can be matched to the same product elsewhere.`,
          status: 'pass',
          basis: [`MPN: ${mpn}`, `GTIN: ${gtin}`],
        }
      : mpn
        ? {
            ref: 'A4',
            metric: 'Identifier Resolution',
            finding: `A manufacturer part number (${mpn}) is published${idMethod === 'json_ld' ? ' as structured data' : ' as flat text'}, but no GTIN or barcode is. Cross-catalogue matching is partial.`,
            status: 'partial',
            basis: [`MPN: ${mpn}`, 'GTIN not published', `method: ${idMethod ?? 'dom'}`],
          }
        : {
            ref: 'A4',
            metric: 'Identifier Resolution',
            finding:
              'Neither a manufacturer part number nor a GTIN is published. There is no identifier on this page that ties the product to the same product in any other catalogue.',
            status: 'fail',
            basis: ['MPN not published', 'GTIN not published'],
          }

  const a5: ScorecardCheck = {
    ref: 'A5',
    metric: 'Off-Domain Citation Surface',
    finding:
      'NOT ASSESSED. Measuring who cites this SKU off-domain requires a backlink and citation index, which this audit does not query. No figure has been estimated in its place.',
    status: 'not_assessed',
    basis: [],
    notAssessedReason: 'No backlink or citation index is configured for this audit.',
  }

  // ── PILLAR 2 — can an engine understand it? ───────────────────────────
  const attributeCount = observedFields.length + record.derivedAttributeCount
  const b1: ScorecardCheck =
    attributeCount >= 8
      ? {
          ref: 'B1',
          metric: 'Attribute Completeness',
          finding: `${observedFields.length} attribute(s) are published as fields and ${record.derivedAttributeCount} more are stated inside the description text — a usable engineering baseline.`,
          status: 'pass',
          basis: [`${observedFields.length} published fields`, `${record.derivedAttributeCount} in prose`],
        }
      : attributeCount >= 4
        ? {
            ref: 'B1',
            metric: 'Attribute Completeness',
            finding: `Only ${attributeCount} attribute(s) are stated anywhere on the page. A buyer filtering on anything beyond name and price has nothing to filter on.`,
            status: 'partial',
            basis: [`${observedFields.length} published fields`, `${record.derivedAttributeCount} in prose`],
          }
        : {
            ref: 'B1',
            metric: 'Attribute Completeness',
            finding: `The page states ${attributeCount} attribute(s). There is not enough here for an engine to distinguish this product from any other in its category.`,
            status: 'fail',
            basis: [`${observedFields.length} published fields`],
          }

  const unitsStated = has(record, 'product.units') || has(record, 'product.dimensions') || has(record, 'product.weight')
  const b2: ScorecardCheck = unitsStated
    ? {
        ref: 'B2',
        metric: 'Units & Normalization',
        finding:
          'Dimensional or unit information is published, so a size or weight on this page can be compared with the same measurement elsewhere.',
        status: 'pass',
        basis: ['dimensions, weight or units published'],
      }
    : {
        ref: 'B2',
        metric: 'Units & Normalization',
        finding:
          'No dimension, weight or unit of measure is published. Nothing on this page can be sorted, filtered or compared numerically.',
        status: 'fail',
        basis: ['no dimensions', 'no weight', 'no units of measure'],
      }

  // Decoded here too: a breadcrumb stored as "SAFETY &amp; PPE" is three
  // levels deep either way, but the finding quotes it back to the customer.
  const crumbs = (input.breadcrumbs ?? valueOf(record, 'product.category'))
    ?.replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
  const crumbDepth = crumbs ? crumbs.split(/\s*[>›/|]\s*/).filter(Boolean).length : 0
  const b3: ScorecardCheck =
    crumbDepth >= 3
      ? {
          ref: 'B3',
          metric: 'Taxonomy Placement',
          finding: `The page publishes a ${crumbDepth}-level category path (${crumbs}), so its place in the catalogue is explicit.`,
          status: 'pass',
          basis: [`breadcrumb: ${crumbs}`],
        }
      : crumbDepth > 0
        ? {
            ref: 'B3',
            metric: 'Taxonomy Placement',
            finding: `A category path is published but only ${crumbDepth} level(s) deep (${crumbs}). An engine can place the product broadly and not precisely.`,
            status: 'partial',
            basis: [`breadcrumb: ${crumbs}`],
          }
        : {
            ref: 'B3',
            metric: 'Taxonomy Placement',
            finding:
              'No breadcrumb or category is published on this page, so nothing states which part of the catalogue this product belongs to.',
            status: 'fail',
            basis: ['no breadcrumb', 'no category field'],
          }

  const description = valueOf(record, 'product.description') ?? ''
  const plainDescription = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const sentences = plainDescription.split(/[.!?]\s/).filter((s) => s.trim().length > 20).length
  const looksLikeSpecString = plainDescription.length > 0 && sentences <= 1 && (plainDescription.match(/,/g) ?? []).length >= 4
  const b4: ScorecardCheck = !plainDescription
    ? {
        ref: 'B4',
        metric: 'Semantic Depth of Copy',
        finding: 'No product description is published, so there is no prose for a conversational engine to quote.',
        status: 'fail',
        basis: ['no description published'],
      }
    : looksLikeSpecString
      ? {
          ref: 'B4',
          metric: 'Semantic Depth of Copy',
          finding:
            'The description is a comma-delimited specification string rather than prose. Engines avoid quoting these, because reading one back to a buyer produces an unusable answer.',
          status: 'fail',
          basis: [`${plainDescription.length} characters`, `${sentences} sentence(s)`, 'comma-delimited'],
        }
      : sentences >= 3
        ? {
            ref: 'B4',
            metric: 'Semantic Depth of Copy',
            finding: `The description runs to ${sentences} sentences of prose, which gives an engine something it can quote in an answer.`,
            status: 'pass',
            basis: [`${sentences} sentences`, `${plainDescription.length} characters`],
          }
        : {
            ref: 'B4',
            metric: 'Semantic Depth of Copy',
            finding: `The description is ${sentences} sentence(s) long. It names the product without describing what it is for, which is what a buyer's question actually asks.`,
            status: 'partial',
            basis: [`${sentences} sentence(s)`, `${plainDescription.length} characters`],
          }

  const b5: ScorecardCheck =
    input.siblingProductLinks >= 3
      ? {
          ref: 'B5',
          metric: 'Variant & Assembly Clarity',
          finding: `The page links to ${input.siblingProductLinks} related product page(s), so an engine can follow the range rather than seeing one isolated item.`,
          status: 'pass',
          basis: [`${input.siblingProductLinks} product links`],
        }
      : input.siblingProductLinks > 0
        ? {
            ref: 'B5',
            metric: 'Variant & Assembly Clarity',
            finding: `Only ${input.siblingProductLinks} link(s) to related products were found. Adjacent sizes, variants and mating parts are largely unconnected.`,
            status: 'partial',
            basis: [`${input.siblingProductLinks} product links`],
          }
        : {
            ref: 'B5',
            metric: 'Variant & Assembly Clarity',
            finding:
              'No links to variants or related products were found on this page, so nothing connects this item to the rest of its range.',
            status: 'fail',
            basis: ['no sibling product links'],
          }

  // ── PILLAR 3 — will an engine recommend it? ───────────────────────────
  const c1: ScorecardCheck = looksLikeSpecString || !plainDescription
    ? {
        ref: 'C1',
        metric: 'Differentiation vs. Sameness',
        finding:
          'The page carries no distinguishing copy of its own. A description that is absent, or that repeats the manufacturer feed verbatim, gives an engine no reason to name this seller over any other carrying the same item.',
        status: 'fail',
        basis: [plainDescription ? 'manufacturer-style spec string' : 'no description published'],
      }
    : {
        ref: 'C1',
        metric: 'Differentiation vs. Sameness',
        finding: `The page carries ${sentences} sentence(s) of its own copy, which is what separates a listing from every other listing of the same item.`,
        status: sentences >= 3 ? 'pass' : 'partial',
        basis: [`${sentences} sentences of description`],
      }

  const documents = valueOf(record, 'product.documents')
  const c2: ScorecardCheck = documents
    ? {
        ref: 'C2',
        metric: 'Authority & Trust Signals',
        finding: `Supporting documentation is linked from the page (${documents}), which is the evidence an engine needs before recommending a technical product.`,
        status: 'pass',
        basis: [`documents: ${documents}`],
      }
    : {
        ref: 'C2',
        metric: 'Authority & Trust Signals',
        finding:
          'No datasheet, drawing, certificate or compliance document is linked. There is nothing on the page an engine can cite as authority for a technical claim.',
        status: 'fail',
        basis: ['no document links found'],
      }

  const price = valueOf(record, 'product.price')
  const availability = valueOf(record, 'product.availability')
  const priceIsReal = Boolean(price && price.trim() !== '' && price.trim() !== '0')
  const c3: ScorecardCheck =
    priceIsReal && availability
      ? {
          ref: 'C3',
          metric: 'Buying-Decision Content',
          finding: 'Both a price and an availability status are published without a login, so a recommendation engine can confirm the product is actually buyable.',
          status: 'pass',
          basis: [`price: ${price}`, `availability: ${availability}`],
        }
      : priceIsReal || availability
        ? {
            ref: 'C3',
            metric: 'Buying-Decision Content',
            finding: `Only ${priceIsReal ? 'a price' : 'an availability status'} is published. Commercial feasibility is partly visible, and engines weigh a listing they cannot fully price.`,
            status: 'partial',
            basis: [priceIsReal ? `price: ${price}` : `availability: ${availability}`],
          }
        : {
            ref: 'C3',
            metric: 'Buying-Decision Content',
            finding:
              'CRITICAL: neither a price nor an availability status is publicly visible. A listing with no commercial signal is treated as non-transactional and is not recommended.',
            status: 'critical_fail',
            basis: ['no public price', 'no availability status'],
          }

  const c4: ScorecardCheck =
    record.derivedAttributeCount >= 2 && sentences >= 2
      ? {
          ref: 'C4',
          metric: 'Buyer-Question Coverage',
          finding: `The copy answers questions beyond identity: ${record.derivedAttributeCount} filterable attribute(s) are stated within it, in the page's own words.`,
          status: 'pass',
          basis: [`${record.derivedAttributeCount} attributes stated in prose`],
        }
      : {
          ref: 'C4',
          metric: 'Buyer-Question Coverage',
          finding: `The page answers "what is this called" and little else. ${record.absentCount} field(s) a buyer would ask about are not published anywhere on it.`,
          status: 'fail',
          basis: [`${record.absentCount} fields not published`, `${record.derivedAttributeCount} attributes in prose`],
        }

  const c5: ScorecardCheck = {
    ref: 'C5',
    metric: 'Live Answer Engine Outcome',
    finding:
      'NOT ASSESSED. Testing whether this product surfaces in generative buyer prompts requires those prompts to be run against live answer engines and the results captured. This audit does not run them, and no outcome has been assumed.',
    status: 'not_assessed',
    basis: [],
    notAssessedReason: 'No answer-engine query harness is configured for this audit.',
  }

  const pillar = (
    key: Pillar['key'],
    title: string,
    subtitle: string,
    weightPct: number,
    checks: ScorecardCheck[],
  ): Pillar => {
    const assessed = checks.filter((c) => c.status !== 'not_assessed')
    const score =
      assessed.length === 0
        ? 0
        : Math.round(
            assessed.reduce((n, c) => n + POINTS[c.status as Exclude<CheckStatus, 'not_assessed'>], 0) / assessed.length,
          )
    return {
      key,
      title,
      subtitle,
      weightPct,
      checks,
      score,
      assessedCount: assessed.length,
      notAssessedCount: checks.length - assessed.length,
    }
  }

  const pillars: Pillar[] = [
    pillar('find', 'Can AI Find You?', 'Crawlability & Schema', 30, [a1, a2, a3, a4, a5]),
    pillar('understand', 'Can AI Understand You?', 'Taxonomy & Specs', 30, [b1, b2, b3, b4, b5]),
    pillar('recommend', 'Will AI Recommend You?', 'Authority & Signals', 40, [c1, c2, c3, c4, c5]),
  ]

  const overall = Math.round(pillars.reduce((n, p) => n + (p.score * p.weightPct) / 100, 0))

  const notAssessed = notAssessedLedger(pillars)
  const assessedCount = TOTAL_CHECKS - notAssessed.length

  return {
    pillars,
    overall,
    verdict: verdictFor(pillars),
    assessedCount,
    notAssessed,
    denominatorNote:
      notAssessed.length === 0
        ? 'Computed from all 15 checks.'
        : `Computed from the ${assessedCount} checks this audit can run against the live page. ` +
          `${notAssessed.map((n) => n.ref).join(' and ')} are not included in the score because they were not assessed — they are shown as NOT ASSESSED rather than scored as zero.`,
  }
}

/**
 * The verdict line beside the number.
 *
 * Says which pillar failed, because "34/100" alone tells a customer they are
 * bad at something without telling them at what.
 */
function verdictFor(pillars: Pillar[]): string {
  const find = pillars.find((p) => p.key === 'find')!.score
  const understand = pillars.find((p) => p.key === 'understand')!.score
  const recommend = pillars.find((p) => p.key === 'recommend')!.score

  if (find < 40) return 'NOT RELIABLY FINDABLE'
  if (recommend < 40 && find >= 40) return 'FINDABLE, NOT RECOMMENDED'
  if (understand < 40) return 'FINDABLE, POORLY UNDERSTOOD'
  if (recommend >= 70 && understand >= 70 && find >= 70) return 'FINDABLE, UNDERSTOOD AND RECOMMENDABLE'
  return 'PARTIALLY DISCOVERABLE'
}

/**
 * The three highest-leverage fixes, drawn from the checks that actually failed.
 *
 * Ordered by pillar weight then severity, so the roadmap on the last page is a
 * consequence of the scorecard rather than a separate opinion about it. A page
 * that passes everything gets an empty list and the report says so.
 */
export interface RemediationFix {
  title: string
  /**
   * WHAT IS ON THEIR PAGE TODAY, in the terms the check read it.
   *
   * The roadmap used to open on the problem, which reads as an assertion
   * about a customer's website before they have been shown what it was read
   * from. A recommendation lands differently when the line above it is their
   * own page quoted back: "MPN not published, GTIN not published" is not an
   * opinion, and nobody argues with it.
   *
   * This is the check's own `basis` — the literal things the audit observed —
   * so it introduces no new claim and cannot drift from the score. Empty only
   * for a check that recorded no basis, and the report then omits the line
   * rather than inventing one.
   */
  observedBefore: string[]
  currentGap: string
  remediation: string
  impact: string
  addresses: string[]
  effort: 'Low' | 'Medium' | 'High'
  owner: string
}

/**
 * The fixes themselves — our advice, identical for every company.
 *
 * `currentGap` and `observedBefore` are BOTH omitted because both come from
 * the customer's own check result rather than from this library. That split is
 * the file's whole point: what we recommend is standard, what we say about
 * THEIR page is read off their page.
 */
const FIX_LIBRARY: Record<string, Omit<RemediationFix, 'currentGap' | 'observedBefore'>> = {
  A3: {
    title: 'Expose spec fields as structured product schema (JSON-LD)',
    remediation:
      'Emit Schema.org Product JSON-LD with explicit PropertyValue pairs for every attribute already shown in the page’s visual table, plus Brand, MPN and Offers.',
    impact: 'Lets an engine match this product against a specification query instead of guessing from prose.',
    addresses: ['A3', 'A4', 'B1'],
    effort: 'Medium',
    owner: 'eCommerce engineering',
  },
  C3: {
    title: 'Surface pricing and stock signals without a mandatory login',
    remediation:
      'Publish list pricing, tiered brackets, or a clear inventory status badge that a logged-out crawler can read.',
    impact: 'Recommendation engines confirm commercial feasibility before naming a supplier in an answer.',
    addresses: ['C3'],
    effort: 'Medium',
    owner: 'eCommerce / sales operations',
  },
  B4: {
    title: 'Rewrite the product description as buyer-facing prose',
    remediation:
      'Turn the specification string into sentences that state what the product is for, what it fits, and where it should not be used.',
    impact: 'Gives an engine quotable sentences that answer a buyer’s question directly.',
    addresses: ['B4', 'C1', 'C4'],
    effort: 'Low',
    owner: 'Product content',
  },
  C2: {
    title: 'Link the datasheets and certificates you already hold',
    remediation:
      'Attach the manufacturer datasheet, drawing or compliance certificate to the product page as a crawlable link.',
    impact: 'Supplies the authority an engine needs before it will repeat a technical claim.',
    addresses: ['C2'],
    effort: 'Low',
    owner: 'Product content',
  },
  A2: {
    title: 'Declare a canonical URL for every product',
    remediation: 'Emit <link rel="canonical"> naming the single address that should be indexed for each product.',
    impact: 'Stops the same product competing with itself across several addresses.',
    addresses: ['A2'],
    effort: 'Low',
    owner: 'eCommerce engineering',
  },
  B3: {
    title: 'Publish the full category path on the product page',
    remediation: 'Render the breadcrumb trail as markup, and mirror it in BreadcrumbList structured data.',
    impact: 'Tells an engine which part of the catalogue the product belongs to, precisely rather than broadly.',
    addresses: ['B3'],
    effort: 'Low',
    owner: 'eCommerce engineering',
  },
  B2: {
    title: 'Publish dimensions, weight and units as their own fields',
    remediation: 'Move measurements out of the description into named numeric fields with explicit units.',
    impact: 'Makes the product sortable and filterable on the values buyers actually search by.',
    addresses: ['B2', 'B1'],
    effort: 'Medium',
    owner: 'Product content',
  },
  B5: {
    title: 'Link variants and related products to one another',
    remediation: 'Add links between adjacent sizes, grades and mating parts, in both directions.',
    impact: 'Lets an engine follow a range instead of finding one isolated item.',
    addresses: ['B5'],
    effort: 'Medium',
    owner: 'eCommerce engineering',
  },
  A4: {
    title: 'Publish manufacturer part numbers and GTINs',
    remediation: 'Render MPN and GTIN as their own fields and repeat them in structured data.',
    impact: 'Allows this product to be matched to the same product in any other catalogue.',
    addresses: ['A4'],
    effort: 'Low',
    owner: 'Product data / PIM',
  },
  C4: {
    title: 'Answer the questions a buyer asks before ordering',
    remediation: 'State load ratings, compatibility, torque or coverage figures where the data exists.',
    impact: 'Turns a listing into something an engine can use to answer a specific question.',
    addresses: ['C4'],
    effort: 'Medium',
    owner: 'Product content',
  },
}

/** Failed checks, worst first, mapped to the fix that addresses them. */
export function buildRemediation(scorecard: Scorecard, max = 3): RemediationFix[] {
  const severity: Record<CheckStatus, number> = {
    critical_fail: 0,
    fail: 1,
    partial: 2,
    pass: 3,
    not_assessed: 4,
  }

  const failing = scorecard.pillars
    .flatMap((p) => p.checks.map((c) => ({ check: c, weight: p.weightPct })))
    .filter((x) => x.check.status === 'critical_fail' || x.check.status === 'fail' || x.check.status === 'partial')
    .sort(
      (a, b) =>
        severity[a.check.status] - severity[b.check.status] ||
        b.weight - a.weight ||
        a.check.ref.localeCompare(b.check.ref),
    )

  const out: RemediationFix[] = []
  const used = new Set<string>()
  for (const { check } of failing) {
    if (out.length >= max) break
    const fix = FIX_LIBRARY[check.ref]
    if (!fix || used.has(fix.title)) continue
    used.add(fix.title)
    // The check's own basis, carried through untouched. Every recommendation
    // in the roadmap therefore opens on something the audit actually read off
    // the page, and a reader can trace the whole chain back to one observation.
    out.push({ ...fix, observedBefore: check.basis, currentGap: check.finding })
  }
  return out
}

/**
 * Why none of the fifteen could be run when no product page was found.
 *
 * One sentence, used as each check's reason, so the report's "why it is not in
 * the score" column says the same thing fifteen times — which is the truth.
 */
const NO_SUBJECT_REASON =
  'No inspected page published a product record, so there was nothing for this check to read.'

/**
 * The checks as they stand when there is no subject to run them against.
 *
 * They carry their REAL metric names rather than the word "Not assessed",
 * because the customer is owed the list of what would have been measured. The
 * status column is what says it was not measured, on both page 2 and page 3.
 */
const NO_SUBJECT_PILLARS: Pillar[] = (
  [
    [
      'find',
      'Can AI Find You?',
      'Crawlability & Schema',
      30,
      [
        ['A1', 'Crawler Access & Rendering'],
        ['A2', 'URL & Indexation Integrity'],
        ['A3', 'Structured Data (Schema.org)'],
        ['A4', 'Identifier Resolution'],
        ['A5', 'Off-Domain Citation Surface'],
      ],
    ],
    [
      'understand',
      'Can AI Understand You?',
      'Taxonomy & Specs',
      30,
      [
        ['B1', 'Attribute Completeness'],
        ['B2', 'Units & Normalization'],
        ['B3', 'Taxonomy Placement'],
        ['B4', 'Semantic Depth of Copy'],
        ['B5', 'Variant & Assembly Clarity'],
      ],
    ],
    [
      'recommend',
      'Will AI Recommend You?',
      'Authority & Signals',
      40,
      [
        ['C1', 'Differentiation vs. Sameness'],
        ['C2', 'Authority & Trust Signals'],
        ['C3', 'Buying-Decision Content'],
        ['C4', 'Buyer-Question Coverage'],
        ['C5', 'Live Answer Engine Outcome'],
      ],
    ],
  ] as const
).map(([key, title, subtitle, weightPct, checks]) => ({
  key,
  title,
  subtitle,
  weightPct,
  checks: checks.map(([ref, metric]) => ({
    ref,
    metric,
    finding: `NOT ASSESSED. ${NO_SUBJECT_REASON} Nothing has been scored or estimated in its place.`,
    status: 'not_assessed' as const,
    basis: [],
    notAssessedReason: NO_SUBJECT_REASON,
  })),
  score: 0,
  assessedCount: 0,
  notAssessedCount: checks.length,
}))

/** Derived by the same function a live audit's ledger is derived by. */
const NO_SUBJECT_NOT_ASSESSED = notAssessedLedger(NO_SUBJECT_PILLARS)

/**
 * The scorecard for a run that found no auditable product page.
 *
 * Every check is NOT ASSESSED and the overall index is zero over zero, which
 * the verdict says in words. The alternative — scoring fifteen failures for a
 * page that was never found — would report a bad catalogue where the truth is
 * an unreached one.
 *
 * The ledger and the denominator are COMPUTED from those checks rather than
 * stated alongside them, so this constant cannot contradict itself again. Its
 * denominator note is worded to sit inside the same sentence frame the live
 * one does — page 2 prints it as "The overall index above is …" — because a
 * note that only reads correctly in one of the two places it appears is how a
 * document ends up ungrammatical in front of a customer.
 */
export const NO_SUBJECT_SCORECARD: Scorecard = {
  pillars: NO_SUBJECT_PILLARS,
  overall: 0,
  verdict: 'NO AUDITABLE PRODUCT PAGE FOUND',
  assessedCount: TOTAL_CHECKS - NO_SUBJECT_NOT_ASSESSED.length,
  notAssessed: NO_SUBJECT_NOT_ASSESSED,
  denominatorNote:
    'Not a measurement of this catalogue: no inspected page published a product record, so none of the ' +
    `${TOTAL_CHECKS} checks could be run.`,
}
