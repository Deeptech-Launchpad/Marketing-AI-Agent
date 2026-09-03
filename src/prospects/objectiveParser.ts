import { z } from 'zod'
import type { LlmPort } from '../llm/index.js'

// Parses a PROSPECTING objective into constraints.
//
// Distinct from intake.parse_objective, which parses a CAMPAIGN objective.
// The outputs a prospecting request needs are different: a requested count, a
// geography, and — most importantly — a clean separation between what the user
// asked to FILTER on and what they asked to HYPOTHESISE about.
//
// "Find 100 manufacturing companies that may need product-data improvement"
// contains both. "manufacturing" and "100" are constraints the CRM can act on.
// "may need product-data improvement" is a HYPOTHESIS about companies nobody
// has looked at yet. Treating it as a filter would be inventing a fact; stating
// it as a finding would be asserting a problem before any evidence exists.
// It is captured, labelled, and applied to nothing.

export const ProspectObjectiveOutput = z.object({
  /** The targeting concept in the user's own words: "infrastructure". */
  targetConcept: z.string().nullable(),
  /** Geography as the user said it. Resolved against CRM values separately. */
  geography: z.array(z.string()),
  /** An explicit number of prospects, when the user gave one. */
  requestedCount: z.number().int().positive().nullable(),
  /**
   * A problem or need the user SPECULATES the prospects have. Never a filter,
   * never asserted about any company. Recorded so a later stage can go and
   * actually test it.
   */
  statedNeedHypothesis: z.string().nullable(),
  /**
   * Other stated characteristics (size, platform, maturity). Recorded even
   * when no CRM field can express them, so the gap is visible rather than
   * silently dropped.
   */
  companyCharacteristics: z.array(z.string()),
  /** Whether to include companies that already have an open opportunity. */
  includeExistingOpportunities: z.boolean(),
  ambiguities: z.array(z.string()),
})
export type ProspectObjectiveOutput = z.infer<typeof ProspectObjectiveOutput>

export async function parseProspectObjective(opts: {
  objective: string
  llm: LlmPort
  tenantId: string
  searchId?: string | null
}): Promise<ProspectObjectiveOutput> {
  const result = await opts.llm.generate({
    promptKey: 'prospect.parse_objective',
    variables: { objective: opts.objective },
    schema: ProspectObjectiveOutput,
    feature: 'prospect_parse_objective',
    tenantId: opts.tenantId,
  })

  // Validated again here, deliberately. The Gemini gateway already validates
  // against this schema, but that is an implementation detail of one LlmPort —
  // the contract does not require it, and this function must not depend on it.
  // A requestedCount of "one hundred" reaching resolveAudience as a limit would
  // silently produce a NaN cap rather than an error anyone could see.
  return ProspectObjectiveOutput.parse(result.data)
}

/**
 * Resolves the user's geography terms against the CRM's own country values.
 *
 * Substring matching in both directions, because the CRM stores values like
 * "UNITED STATES" while a user writes "US" or "the States". A term that
 * resolves to nothing is reported rather than dropped — an unmatched geography
 * silently ignored would widen the audience without anyone noticing.
 */
export function resolveGeography(
  terms: string[],
  vocabulary: string[],
): { matched: string[]; unmatched: string[] } {
  const matched = new Set<string>()
  const unmatched: string[] = []

  for (const term of terms) {
    const t = term.trim().toLowerCase()
    if (!t) continue
    const hits = vocabulary.filter((v) => {
      const lv = v.toLowerCase()
      return lv === t || lv.includes(t) || t.includes(lv)
    })
    if (hits.length) hits.forEach((h) => matched.add(h))
    else unmatched.push(term)
  }

  return { matched: [...matched], unmatched }
}
