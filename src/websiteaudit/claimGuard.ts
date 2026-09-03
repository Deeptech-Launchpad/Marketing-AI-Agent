// TASK #979 — the guard against unsupported claims.
//
// This exists because the failure mode of an automated audit report is not a
// crash, it is a confident sentence nobody can defend. "87% of your catalogue
// is missing specifications" reads as a measurement and is actually an
// extrapolation from twelve pages. "This is costing you £40,000 a year" is an
// invention with a currency symbol attached.
//
// So generated PROSE is checked before it is stored, and text that fails is
// refused rather than softened. The check runs at generation time, not only in
// tests, because a rule that only fires in CI is a rule that ships broken.
//
// It applies to prose the system writes. It deliberately does NOT apply to
// evidence quoted from a prospect's own page — a product page may legitimately
// display "£12.50" or "20% glass fibre", and redacting the evidence to satisfy
// a guard on our own writing would corrupt the record.

export interface ClaimViolation {
  pattern: string
  match: string
  why: string
}

interface Rule {
  name: string
  re: RegExp
  why: string
  /**
   * A narrow exemption, checked against the surrounding text.
   *
   * Needed because a phrase can appear in an ASSERTION or in a DISCLAIMER of
   * that same assertion, and those are opposites. "Your whole catalogue lacks
   * dimensions" is the claim this guard exists to stop; "this should not be
   * read as a measure of the whole catalogue" is the sentence that makes the
   * report honest. A rule that blocked both would push the writer toward
   * vaguer language, which is the opposite of the intent.
   */
  unless?: RegExp
}

const RULES: Rule[] = [
  {
    name: 'percentage',
    re: /\b\d{1,3}(?:\.\d+)?\s?%/,
    why: 'A percentage generalises beyond the inspected sample. State "3 of 12 inspected product pages" instead.',
  },
  {
    name: 'money',
    re: /[£$€]\s?\d|\b\d+\s?(?:k|m|bn)\b(?=[^a-z]|$)|\b(?:usd|gbp|eur)\b/i,
    why: 'A monetary figure is not supported by anything this audit observed.',
  },
  {
    name: 'financial-outcome',
    re: /\b(roi|revenue|profit|turnover|sales uplift|lost sales|cost savings?|payback|bottom line)\b/i,
    why: 'Financial impact was not measured by this audit.',
  },
  {
    name: 'improvement-promise',
    re: /\b(increase|boost|improve|grow|reduce|cut|double|triple)\s+(?:your\s+)?\w+\s+by\b|\bup to\s+\d/i,
    why: 'A quantified improvement promise is not supported by evidence.',
  },
  {
    name: 'guarantee',
    re: /\b(guarantee[ds]?|guaranteed|will result in|is costing you|you are losing|proven to)\b/i,
    why: 'A guaranteed outcome cannot follow from a page sample.',
  },
  {
    name: 'whole-catalogue-generalisation',
    re: /\b(?:your|the)\s+(?:entire|whole|full)\s+(?:catalogue|catalog|website|product range)\b|\ball (?:of your )?products\b|\bevery product\b/i,
    // Deliberately strict. It also catches prescriptive phrasing like "publish
    // X on every product page", which is harmless — that text is reworded to
    // "each product page" rather than the rule being loosened, because the cost
    // of the false positive is one word and the cost of a false negative is a
    // claim nobody can defend.
    why: 'Only the inspected pages were seen. Do not generalise to the whole catalogue.',
    // Allows the scope disclaimer, which negates the very claim being guarded
    // against: "...should NOT be read as a measure of the whole catalogue".
    unless: /\bnot\b[^.]{0,80}\b(?:entire|whole|full)\s+(?:catalogue|catalog|website|product range)\b/i,
  },
  {
    // Phase 6, Section 11. The report may observe factors that MAY influence
    // discoverability; it may never state a ranking, a visibility position or
    // an AI-answer placement, because the audit reads pages and has never
    // seen a search result.
    name: 'ranking-claim',
    re: /\b(?:search|google|bing|seo|aeo|geo|ai)?\s*rank(?:ing|ed|s)?\b|\b(?:first|top)\s+(?:page|result|position)\b|\bserp\b|\bvisibility\s+(?:score|index)\b|\b(?:out)?ranks?\s+(?:your|their|the)\b/i,
    why:
      'This audit inspected pages, not search results. State "may affect discoverability" or "potential ' +
      'discoverability consideration" instead of a ranking claim.',
    // The disclaimer that denies the claim has to be sayable. "not a ranking",
    // "no ranking was measured" are the sentences that keep the report honest.
    unless: /\b(?:not|never|no|without)\b[^.]{0,60}\brank(?:ing|ed|s)?\b/i,
  },
  {
    name: 'marketing-filler',
    re: /\b(world[- ]class|best[- ]in[- ]class|cutting[- ]edge|game[- ]changing|revolutionise|unlock the power|seamlessly|leverage synergies)\b/i,
    why: 'Generic marketing language was explicitly excluded from this deliverable.',
  },
]

/** Finds every unsupported-claim violation in generated prose. */
export function findUnsupportedClaims(text: string): ClaimViolation[] {
  const violations: ClaimViolation[] = []
  for (const rule of RULES) {
    const m = text.match(rule.re)
    if (!m) continue
    // An exemption applies only where the rule explicitly declares one, and is
    // checked against the whole text so a negation elsewhere in the sentence
    // can license the phrase.
    if (rule.unless?.test(text)) continue
    violations.push({ pattern: rule.name, match: m[0], why: rule.why })
  }
  return violations
}

export class UnsupportedClaimError extends Error {
  constructor(
    readonly field: string,
    readonly violations: ClaimViolation[],
    readonly text: string,
  ) {
    super(
      `Refusing to store unsupported claim in "${field}": ` +
        violations.map((v) => `[${v.pattern}] matched "${v.match}" — ${v.why}`).join(' '),
    )
    this.name = 'UnsupportedClaimError'
  }
}

/**
 * Returns the text, or throws.
 *
 * Throwing rather than sanitising is deliberate: silently stripping a "%" from
 * a sentence leaves a claim that reads as though a number was intended and
 * lost. A generator that produces an indefensible sentence has a bug, and the
 * bug should surface.
 */
export function assertSupported(field: string, text: string): string {
  const violations = findUnsupportedClaims(text)
  if (violations.length) throw new UnsupportedClaimError(field, violations, text)
  return text
}

/**
 * Phrases a count against the sample it came from.
 *
 * Every metric in this task goes through here, so no metric can be written
 * without naming its denominator. That is the whole difference between
 * "observed on 3 of 12 inspected product pages" and "87% missing".
 */
export function sampleMetric(
  subject: string,
  count: number,
  sampleSize: number,
  unit: string,
  verb = 'were observed on',
): string {
  return `${subject} ${verb} ${count} of ${sampleSize} inspected ${unit}.`
}
