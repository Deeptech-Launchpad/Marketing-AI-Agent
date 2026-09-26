// STAGE 4 — role matching.
//
// The rule that shapes this file: a title is relevant because of its FUNCTION,
// never because of its seniority word. "Director" alone says nothing — a
// Director of Facilities is not a decision maker for product data. So a match
// requires a function token, and seniority only ranks what has already matched.
//
// Deterministic and inspectable. No model is asked to judge relevance, because
// a model asked "is this person relevant?" will find a way to say yes.
//
// ─────────────────────────────────────────────────────────────────────────
// BUSINESS SOURCE: Team Answer, Section E.1/E.3 and the approved buyer policy.
//
//   P1 — direct buyer:      Ecommerce, Catalog, Product Data, Digital
//                           Commerce, Merchandising, Category
//   P2 — strong influencer: IT, Business Systems, Product, Digital Product,
//                           Marketing Operations, Data Analytics
//   P3 — fallback persona:  Owner, Founder, GM, Managing Director,
//                           VP Sales / Marketing
//
// P3 is a FALLBACK, not a third-best buyer. The team's rule is "fall back to
// Owner/GM at smaller companies when no specialist role exists", so a P3 match
// is only promoted for a company where no P1 or P2 was found. That gate lives
// in `applyFallbackPolicy` below, because it is a decision about a COMPANY's
// candidate set and cannot be made while looking at one title.
// ─────────────────────────────────────────────────────────────────────────

export type RolePriority = 1 | 2 | 3

export interface RoleMatch {
  priority: RolePriority
  roleGroup: string
  /** The function token that actually matched — the reason it is relevant. */
  matchedFunction: string
  seniority: Seniority
  normalizedTitle: string
  reasons: string[]
  /**
   * True when the only thing that matched is the executive-sponsor fallback.
   * Such a candidate is relevant ONLY where no specialist exists.
   */
  isFallback: boolean
}

export const SENIORITIES = ['c_level', 'vp', 'director', 'head', 'manager', 'lead', 'individual'] as const
export type Seniority = (typeof SENIORITIES)[number]

/**
 * Collapses the spelling variants these titles actually appear in.
 *
 * "VP E-Commerce", "V.P. eCommerce", "Vice President, E Commerce" and
 * "VP of Ecommerce" are one title written four ways, and matching them
 * separately would mean maintaining four patterns per role forever.
 */
export function normalizeTitle(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    // Strip anything after a separator that introduces a second role or company.
    .replace(/\s+(at|@)\s+.*$/i, '')
    .replace(/[|·•]/g, ' ')
    // e-commerce / e commerce / ecomm -> ecommerce, before word splitting.
    .replace(/\be[\s._-]*commerce\b/g, 'ecommerce')
    .replace(/\becomm?\b/g, 'ecommerce')
    .replace(/\bdigital commerce\b/g, 'ecommerce')
    .replace(/\bonline (sales|retail|store)\b/g, 'ecommerce')
    // Seniority abbreviations.
    .replace(/\bs?vp\b\.?/g, 'vice president')
    .replace(/\bv\.p\.?\b/g, 'vice president')
    .replace(/\bevp\b/g, 'vice president')
    .replace(/\bsnr\b|\bsr\b\.?/g, 'senior')
    .replace(/\bdir\b\.?/g, 'director')
    .replace(/\bmgr\b\.?/g, 'manager')
    .replace(/\bchief ([a-z]+) officer\b/g, 'chief $1 officer')
    .replace(/\bc([a-z])o\b/g, (m) => m) // CTO/CIO kept as-is for seniority detection
    // Product-data variants.
    .replace(/\bproduct information management\b/g, 'pim')
    .replace(/\bproduct info(rmation)?\b/g, 'product information')
    .replace(/\bmaster data management\b/g, 'mdm')
    .replace(/\bcatalogue\b/g, 'catalog')
    // Fallback-persona variants, normalised before punctuation is stripped so
    // "MD" and "GM" survive as words rather than becoming noise.
    .replace(/\bmanaging director\b/g, 'managing director')
    .replace(/\bgeneral manager\b/g, 'general manager')
    .replace(/\bg\.?m\.?\b/g, 'general manager')
    .replace(/\bceo\b/g, 'chief executive officer')
    // "Founding entrepreneur", "founding director" and "co-founder" are how
    // company About pages actually write Founder. Only the founding-PERSON
    // forms are collapsed: a "founding engineer" or "founding member" of a team
    // is not the company's founder, and stays unmatched.
    .replace(/\bco[\s-]?founder\b/g, 'founder')
    .replace(/\bfounding (entrepreneur|director|partner|owner|chair(man|woman|person)?|president|chief executive officer|principal)\b/g, 'founder')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Seniority is used for RANKING only — never to establish relevance. */
export function detectSeniority(normalized: string): Seniority {
  // The lookbehind matters: "vice president" contains "president", and without
  // it every VP in the set would be promoted to C-level.
  if (/\bchief\s+\w+\s+officer\b|\bc[teiofmr]o\b|\bchief\b|(?<!vice )\bpresident\b|\bfounder\b|\bowner\b/.test(normalized)) {
    return 'c_level'
  }
  if (/\bvice president\b/.test(normalized)) return 'vp'
  if (/\bdirector\b/.test(normalized)) return 'director'
  if (/\bhead of\b|\bhead\b/.test(normalized)) return 'head'
  if (/\bmanager\b/.test(normalized)) return 'manager'
  if (/\blead\b|\bsupervisor\b/.test(normalized)) return 'lead'
  return 'individual'
}

interface FunctionPattern {
  pattern: RegExp
  fn: string
  group: string
  priority: RolePriority
  /** Executive sponsor rather than a specialist — see applyFallbackPolicy. */
  fallback?: true
}

// Function tokens, not job titles. Each says WHAT the person owns.
const FUNCTIONS: FunctionPattern[] = [
  // ── Priority 1: owns product/catalog data or ecommerce outright ──────────
  { pattern: /\bproduct data\b/, fn: 'product data', group: 'Product Data', priority: 1 },
  { pattern: /\bproduct information\b|\bpim\b/, fn: 'product information / PIM', group: 'Product Information', priority: 1 },
  { pattern: /\bcatalog\b/, fn: 'catalog', group: 'Catalog', priority: 1 },
  { pattern: /\becommerce\b/, fn: 'ecommerce', group: 'Ecommerce', priority: 1 },
  { pattern: /\bmerchandis(ing|er)\b/, fn: 'merchandising', group: 'Merchandising', priority: 1 },
  // Confirmed P1 by the Team Answer. A Category Manager owns what is in the
  // catalogue and how it is described, which is the same conversation.
  { pattern: /\bcategory\b/, fn: 'category management', group: 'Category', priority: 1 },

  // ── Priority 2: strong influencers over the same data ───────────────────
  { pattern: /\bmaster data\b|\bmdm\b/, fn: 'master data', group: 'Master Data', priority: 2 },
  { pattern: /\bdata (operations|ops|governance|quality|steward)/, fn: 'data operations', group: 'Data Operations', priority: 2 },
  // Confirmed P2. Covers "Data Analytics Manager", "VP of BI and Analytics",
  // "Data Analyst", "Ecommerce Price Analyst" from the approved title list.
  { pattern: /\b(analytics|business intelligence|\bbi\b)\b|\b(data|revenue|pricing|price|business) analyst\b/, fn: 'data analytics / BI', group: 'Analytics', priority: 2 },
  { pattern: /\bdigital (operations|ops)\b/, fn: 'digital operations', group: 'Digital Operations', priority: 2 },
  // "&" is stripped during normalisation, so "Digital & Data" arrives as
  // "digital data" and is matched in that form.
  { pattern: /\bdigital (experience|channel|content|strategy|data)\b/, fn: 'digital experience', group: 'Digital', priority: 2 },
  // "Manager, CX Applications" and "Director, New Customer Experience
  // Ecosystems" both appear in the approved list: they own the storefront
  // experience the catalogue is rendered into.
  { pattern: /\bcustomer experience\b|\bcx\b/, fn: 'customer experience', group: 'Customer Experience', priority: 2 },
  // Confirmed P2. Previously Priority 3; the Team Answer names IT Manager as a
  // strong influencer, and "Business Systems" is called out by name.
  { pattern: /\b(information technology|technology|it)\b/, fn: 'IT / technology', group: 'IT', priority: 2 },
  { pattern: /\bbusiness systems\b|\bsystems\b/, fn: 'business systems', group: 'Business Systems', priority: 2 },
  // Confirmed P2. "Product Manager" / "Digital Product Manager" / "Product
  // Owner" own the roadmap the catalogue sits in. Deliberately AFTER the P1
  // product-data patterns so a Product Data Manager still ranks P1.
  { pattern: /\bproduct (manager|owner|management|specialist|marketing)\b|\bproduct\b(?=.*\b(manager|owner|director|vice president|head|lead|specialist)\b)/, fn: 'product management', group: 'Product', priority: 2 },
  // Confirmed P2. Marketing Operations is named explicitly.
  { pattern: /\bmarketing (operations|ops)\b/, fn: 'marketing operations', group: 'Marketing Operations', priority: 2 },
  // Section E.1 names "Marketing/Digital Marketing Manager" in the primary
  // buyer list. An earlier engineering decision excluded it because it matched
  // a Digital Marketing Executive during validation; the business has since
  // asked for it, so it is included at P2 rather than P1 — relevant, but never
  // outranking someone who owns the catalogue outright.
  // The negative lookahead keeps VP/chief-level marketing OUT of this tier so
  // it lands on the fallback rule below, which is where the Team Answer puts
  // "VP Sales / Marketing". A Digital Marketing Manager stays P2.
  { pattern: /^(?!.*\bvice president\b)(?!.*\bchief\b).*\b(digital )?marketing\b/, fn: 'marketing', group: 'Marketing', priority: 2 },
  { pattern: /\bsupply chain\b|\bprocurement\b|\bpurchasing\b/, fn: 'supply chain / procurement', group: 'Supply Chain', priority: 2 },
  { pattern: /\bdigital transformation\b|\btransformation\b/, fn: 'transformation', group: 'Transformation', priority: 2 },
  { pattern: /\b(integration|solution architect|architect)\b/, fn: 'integration / architecture', group: 'Integration', priority: 2 },

  // ── Priority 3: FALLBACK executive sponsor ──────────────────────────────
  // Only usable where the company has no specialist. See applyFallbackPolicy.
  { pattern: /\bowner\b/, fn: 'owner', group: 'Executive Sponsor', priority: 3, fallback: true },
  { pattern: /\bfounder\b/, fn: 'founder', group: 'Executive Sponsor', priority: 3, fallback: true },
  { pattern: /\bgeneral manager\b/, fn: 'general manager', group: 'Executive Sponsor', priority: 3, fallback: true },
  { pattern: /\bmanaging director\b/, fn: 'managing director', group: 'Executive Sponsor', priority: 3, fallback: true },
  { pattern: /(?<!vice )\bpresident\b/, fn: 'president', group: 'Executive Sponsor', priority: 3, fallback: true },
  { pattern: /\bchief executive officer\b/, fn: 'chief executive', group: 'Executive Sponsor', priority: 3, fallback: true },
  { pattern: /\bvice president\b.*\b(sales|marketing)\b|\b(sales|marketing)\b.*\bvice president\b/, fn: 'VP sales / marketing', group: 'Executive Sponsor', priority: 3, fallback: true },
  // General commercial roles. They appear throughout the approved title list
  // because they are who the team actually meets, but a Regional Sales Manager
  // does not own product data. They sit in the fallback tier for the same
  // reason VP Sales does: a commercial contact is worth having when there is
  // no specialist, and worth nothing ahead of one.
  { pattern: /\b(sales|accounts?|channel|go to market|commercial)\b/, fn: 'commercial contact', group: 'Commercial Contact', priority: 3, fallback: true },
]

/**
 * Seniority words that must NOT by themselves make a title relevant. Kept
 * explicit so the intent is visible: a match needs a FUNCTION, and these are
 * the words most likely to be mistaken for one.
 */
const GENERIC_ONLY = /^(senior |junior |global |group |regional |national )*(vice president|director|head of|head|manager|lead|chief|officer|executive|supervisor|coordinator|specialist|analyst|associate|assistant)( of)?$/

export function matchRole(rawTitle: string): RoleMatch | null {
  const normalized = normalizeTitle(rawTitle)
  if (!normalized) return null

  // A title that is nothing but seniority is explicitly rejected. "Director"
  // could be Director of Facilities.
  if (GENERIC_ONLY.test(normalized)) return null

  const hits = FUNCTIONS.filter((f) => f.pattern.test(normalized))
  if (!hits.length) return null

  // Best (lowest) priority wins when several functions appear.
  hits.sort((a, b) => a.priority - b.priority)
  const best = hits[0]!
  const seniority = detectSeniority(normalized)
  const isFallback = best.fallback === true

  const reasons = [
    `Title normalises to "${normalized}".`,
    `Matched the "${best.fn}" function, which is a Priority ${best.priority} role group (${best.group}).`,
    `Seniority read as "${seniority}" — used for ranking only, never to establish relevance.`,
  ]
  if (isFallback) {
    reasons.push(
      'This is the executive-sponsor fallback. It counts only where the company has no specialist role, per the approved buyer policy.',
    )
  }
  if (hits.length > 1) {
    reasons.push(`Also matched: ${hits.slice(1).map((h) => h.fn).join(', ')}.`)
  }

  return {
    priority: best.priority,
    roleGroup: best.group,
    matchedFunction: best.fn,
    seniority,
    normalizedTitle: normalized,
    reasons,
    isFallback,
  }
}

/** Rank weight for seniority. Only applied to titles that already matched. */
export const SENIORITY_WEIGHT: Record<Seniority, number> = {
  c_level: 6,
  vp: 5,
  director: 4,
  head: 4,
  manager: 3,
  lead: 2,
  individual: 1,
}

export interface FallbackDecision<T> {
  /** Candidates that may be used, in the order given. */
  eligible: T[]
  /** Fallback candidates held back because a specialist exists. */
  suppressed: T[]
  /** Whether the fallback persona was actually needed for this company. */
  fallbackUsed: boolean
  reason: string
}

/**
 * Applies the approved fallback rule to ONE company's candidate set.
 *
 * "Fall back to Owner / Founder / GM / Managing Director when no specialist
 * role exists" is a statement about a company, not about a person: the same
 * Managing Director is the right approach at a ten-person distributor and the
 * wrong one at a company that employs a Product Data Manager. So the decision
 * is made once the whole set is known, and the suppressed candidates are
 * returned rather than dropped, so the reason stays inspectable.
 */
export function applyFallbackPolicy<T>(
  candidates: T[],
  roleOf: (c: T) => { priority: RolePriority; isFallback: boolean } | null,
): FallbackDecision<T> {
  const specialists = candidates.filter((c) => {
    const r = roleOf(c)
    return r !== null && !r.isFallback
  })
  const fallbacks = candidates.filter((c) => roleOf(c)?.isFallback === true)
  const unmatched = candidates.filter((c) => roleOf(c) === null)

  if (specialists.length > 0) {
    return {
      eligible: [...specialists, ...unmatched],
      suppressed: fallbacks,
      fallbackUsed: false,
      reason:
        `${specialists.length} specialist role(s) were found for this company, so the ` +
        `executive-sponsor fallback was not used. ${fallbacks.length} fallback candidate(s) held back.`,
    }
  }

  return {
    eligible: [...fallbacks, ...unmatched],
    suppressed: [],
    fallbackUsed: fallbacks.length > 0,
    reason: fallbacks.length
      ? `No specialist role was found for this company, so the executive-sponsor fallback applies (${fallbacks.length} candidate(s)).`
      : 'No specialist role and no executive-sponsor fallback was found for this company.',
  }
}
