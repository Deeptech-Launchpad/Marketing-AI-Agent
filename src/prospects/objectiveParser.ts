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
 * Common alternative names for the same country. Each group is one country;
 * every spelling in a group is interchangeable. Generic reference data, not a
 * per-customer list: it only lets "UK" find "UNITED KINGDOM".
 *
 * Deliberately NO substring matching. Substrings made "US" match AUSTRALIA,
 * RUSSIA and CYPRUS, "Oman" match ROMANIA, and "India" match BRITISH INDIAN
 * OCEAN TERRITORY — each one silently widening the audience to other countries.
 */
const COUNTRY_ALIASES: string[][] = [
  ['united states', 'united states of america', 'us', 'usa', 'the states'],
  ['united kingdom', 'uk', 'great britain', 'britain', 'gb', 'united kingdom of great britain and northern ireland'],
  ['united arab emirates', 'uae', 'emirates'],
  ['netherlands', 'holland', 'the netherlands'],
  ['south korea', 'korea republic of', 'republic of korea', 'korea south'],
  ['north korea', 'korea democratic peoples republic of', 'democratic peoples republic of korea'],
  ['russia', 'russian federation'],
  ['czech republic', 'czechia'],
  ['turkey', 'turkiye'],
  ['vietnam', 'viet nam'],
  ['iran', 'iran islamic republic of'],
  ['syria', 'syrian arab republic'],
  ['laos', 'lao peoples democratic republic'],
  ['bolivia', 'bolivia plurinational state of'],
  ['venezuela', 'venezuela bolivarian republic of'],
  ['tanzania', 'tanzania united republic of'],
  ['moldova', 'moldova republic of'],
  ['saudi arabia', 'ksa', 'kingdom of saudi arabia'],
  ['ivory coast', 'cote divoire'],
  ['cape verde', 'cabo verde'],
  ['eswatini', 'swaziland'],
  ['north macedonia', 'macedonia'],
  ['myanmar', 'burma'],
  ['hong kong', 'hong kong sar', 'hong kong sar china'],
  ['taiwan', 'taiwan province of china', 'republic of china'],
  ['democratic republic of the congo', 'dr congo', 'drc', 'congo democratic republic of the'],
]

/** Case, accents, punctuation and a leading "the" never distinguish two countries. */
export function normaliseCountry(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '')
}

const ALIAS_INDEX: Map<string, Set<string>> = (() => {
  const index = new Map<string, Set<string>>()
  for (const group of COUNTRY_ALIASES) {
    const names = new Set(group.map(normaliseCountry))
    for (const n of names) {
      const existing = index.get(n)
      index.set(n, existing ? new Set([...existing, ...names]) : names)
    }
  }
  return index
})()

/**
 * Resolves the user's geography terms against the CRM's own country values.
 *
 * Exact match after normalisation (case, accents, punctuation), plus the
 * generic alias table above, because the CRM stores "UNITED STATES" while a
 * user writes "US". A term that resolves to nothing is reported rather than
 * dropped — an unmatched geography silently ignored would widen the audience
 * without anyone noticing.
 */
export function resolveGeography(
  terms: string[],
  vocabulary: string[],
): { matched: string[]; unmatched: string[] } {
  const matched = new Set<string>()
  const unmatched: string[] = []

  for (const term of terms) {
    const t = normaliseCountry(term)
    if (!t) continue
    const accepted = ALIAS_INDEX.get(t) ?? new Set([t])
    const hits = vocabulary.filter((v) => accepted.has(normaliseCountry(v)))
    if (hits.length) hits.forEach((h) => matched.add(h))
    else unmatched.push(term)
  }

  return { matched: [...matched], unmatched }
}
