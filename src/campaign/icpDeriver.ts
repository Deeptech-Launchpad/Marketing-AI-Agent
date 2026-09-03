import type { CrmPort } from '../crm/index.js'
import type { CrmCompany, CrmDeal } from '../crm/types.js'

// Derives evidence for an ICP from real won/lost deal data.
//
// This is plain computation, deliberately not an LLM call: counting which
// firmographic profile actually converts is arithmetic, and doing it in code
// means the numbers are reproducible and arguable. The model's job (in the
// ICP_SYNTHESIS step) is to interpret this evidence, not to invent it.

export interface FacetStat {
  value: string
  won: number
  lost: number
  open: number
  total: number
  winRate: number
  wonValue: number
}

/**
 * Whether the CRM can actually support an ICP claim.
 *
 * This exists because it turned out not to. Against the real NXT Sales data —
 * 87 deals, 3 Won, 14 Lost, 26 of them linked to no company — ZERO industry
 * facets clear the sample floor. Without an explicit verdict the ICP step still
 * runs, still returns a confidently-worded profile, and nothing downstream can
 * tell that it rests on nothing. An unreliable ICP that looks reliable is worse
 * than no ICP, so the verdict is computed here and carried forward.
 */
export interface IcpSufficiency {
  sufficient: boolean
  /** Exact wording surfaced to the user when the CRM cannot support an ICP. */
  statement: string
  decidedDeals: number
  /** Decided deals that actually join to a company — the real usable base. */
  linkedDecidedDeals: number
  survivingIndustryFacets: number
  survivingCountryFacets: number
  survivingCmsFacets: number
  reasons: string[]
}

export interface IcpEvidence {
  totalDeals: number
  wonDeals: number
  lostDeals: number
  /**
   * Deal.companyId is nullable in NXT Sales and its own dashboard surfaces the
   * gap explicitly. These deals cannot be attributed to any firmographic
   * profile, so they are reported rather than silently dropped from the base.
   */
  dealsWithoutCompany: number
  companiesAnalysed: number
  byIndustry: FacetStat[]
  byCountry: FacetStat[]
  byCms: FacetStat[]
  medianWonValue: number
  sufficiency: IcpSufficiency
}

export const INSUFFICIENT_ICP_STATEMENT = 'Insufficient CRM evidence to infer a reliable ICP.'

const MIN_SAMPLE = 3

// An ICP is a claim about which firmographic profile converts. Industry is the
// axis campaigns are actually built on, so at least one industry facet must
// clear the sample floor — a verdict resting only on country would say nothing
// about what to sell or to whom.
const MIN_SURVIVING_INDUSTRY_FACETS = 1

// A floor on the overall base as well. One industry with exactly 3 decided
// deals out of a total of 4 is a coincidence, not a pattern.
const MIN_LINKED_DECIDED_DEALS = 10

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
}

function tally(
  deals: CrmDeal[],
  companyById: Map<string, CrmCompany>,
  pick: (c: CrmCompany) => string | null,
): FacetStat[] {
  const buckets = new Map<string, FacetStat>()

  for (const deal of deals) {
    if (!deal.companyId) continue
    const company = companyById.get(deal.companyId)
    if (!company) continue
    const value = pick(company)
    if (!value) continue

    const bucket =
      buckets.get(value) ??
      { value, won: 0, lost: 0, open: 0, total: 0, winRate: 0, wonValue: 0 }

    if (deal.stage === 'Won') {
      bucket.won++
      bucket.wonValue += deal.value
    } else if (deal.stage === 'Lost') {
      bucket.lost++
    } else {
      bucket.open++
    }
    bucket.total++
    buckets.set(value, bucket)
  }

  return [...buckets.values()]
    .map((b) => {
      const decided = b.won + b.lost
      // Win rate over DECIDED deals only. Including open deals would make an
      // active pipeline look like a losing one.
      return { ...b, winRate: decided ? b.won / decided : 0 }
    })
    // A single won deal is not a pattern. Facets below the sample floor are
    // dropped rather than presented as a signal.
    .filter((b) => b.won + b.lost >= MIN_SAMPLE)
    .sort((a, b) => b.winRate - a.winRate || b.won - a.won)
}

function assessSufficiency(params: {
  decidedDeals: number
  linkedDecidedDeals: number
  byIndustry: FacetStat[]
  byCountry: FacetStat[]
  byCms: FacetStat[]
}): IcpSufficiency {
  const reasons: string[] = []

  if (params.byIndustry.length < MIN_SURVIVING_INDUSTRY_FACETS) {
    reasons.push(
      `No industry has at least ${MIN_SAMPLE} decided (won or lost) deals, so no industry-level pattern can be measured.`,
    )
  }
  if (params.linkedDecidedDeals < MIN_LINKED_DECIDED_DEALS) {
    reasons.push(
      `Only ${params.linkedDecidedDeals} decided deals are linked to a company (minimum ${MIN_LINKED_DECIDED_DEALS}).`,
    )
  }

  const sufficient = reasons.length === 0
  return {
    sufficient,
    statement: sufficient
      ? `Derived from ${params.linkedDecidedDeals} decided deals across ${params.byIndustry.length} industry facet(s).`
      : INSUFFICIENT_ICP_STATEMENT,
    decidedDeals: params.decidedDeals,
    linkedDecidedDeals: params.linkedDecidedDeals,
    survivingIndustryFacets: params.byIndustry.length,
    survivingCountryFacets: params.byCountry.length,
    survivingCmsFacets: params.byCms.length,
    reasons,
  }
}

export async function deriveIcpEvidence(crm: CrmPort): Promise<IcpEvidence> {
  const [deals, companiesWithDeals] = await Promise.all([
    crm.exportDeals(),
    crm.exportCompanies({ hasDeal: true }),
  ])

  const companyById = new Map(companiesWithDeals.items.map((c) => [c.id, c]))
  const wonValues = deals.filter((d) => d.stage === 'Won').map((d) => d.value)

  const decided = deals.filter((d) => d.stage === 'Won' || d.stage === 'Lost')
  // Decided AND joinable. A decided deal with no companyId contributes to no
  // facet, so counting it towards sufficiency would overstate the evidence.
  const linkedDecided = decided.filter((d) => d.companyId && companyById.has(d.companyId))

  const byIndustry = tally(deals, companyById, (c) => c.industry)
  const byCountry = tally(deals, companyById, (c) => c.country)
  const byCms = tally(deals, companyById, (c) => c.cms)

  return {
    totalDeals: deals.length,
    wonDeals: deals.filter((d) => d.stage === 'Won').length,
    lostDeals: deals.filter((d) => d.stage === 'Lost').length,
    dealsWithoutCompany: deals.filter((d) => !d.companyId).length,
    companiesAnalysed: companyById.size,
    byIndustry,
    byCountry,
    byCms,
    medianWonValue: median(wonValues),
    sufficiency: assessSufficiency({
      decidedDeals: decided.length,
      linkedDecidedDeals: linkedDecided.length,
      byIndustry,
      byCountry,
      byCms,
    }),
  }
}

/** Compact rendering for a prompt — top facets only, with their real counts. */
export function formatEvidence(e: IcpEvidence): string {
  const facet = (label: string, stats: FacetStat[]) => {
    if (!stats.length) return `${label}: (no facet met the ${MIN_SAMPLE}-decided-deal minimum)`
    const rows = stats
      .slice(0, 8)
      .map(
        (s) =>
          `  - ${s.value}: ${s.won} won / ${s.lost} lost (win rate ${(s.winRate * 100).toFixed(0)}%), won value ${s.wonValue.toFixed(0)}`,
      )
      .join('\n')
    return `${label}:\n${rows}`
  }

  const head = [
    `SUFFICIENCY VERDICT: ${e.sufficiency.sufficient ? 'SUFFICIENT' : 'INSUFFICIENT'}`,
    e.sufficiency.statement,
    ...e.sufficiency.reasons.map((r) => `  - ${r}`),
    '',
    `Deals analysed: ${e.totalDeals} (won ${e.wonDeals}, lost ${e.lostDeals})`,
    `Decided deals linked to a company: ${e.sufficiency.linkedDecidedDeals}`,
    `Deals with no linked company (excluded from all facets): ${e.dealsWithoutCompany}`,
    `Companies analysed: ${e.companiesAnalysed}`,
    `Median won deal value: ${e.medianWonValue.toFixed(0)}`,
  ]

  // When the verdict is INSUFFICIENT the facet tables are deliberately not
  // rendered. Showing "Janitorial: 1W/1L" invites the model to reason from it
  // regardless of the warning above, and a single-deal facet is noise.
  if (!e.sufficiency.sufficient) {
    return [
      ...head,
      '',
      'Facet tables are withheld because no facet met the sample floor.',
      'Do NOT infer an ideal customer profile from this data.',
    ].join('\n')
  }

  return [
    ...head,
    '',
    facet('By industry', e.byIndustry),
    '',
    facet('By country', e.byCountry),
    '',
    facet('By CMS/platform', e.byCms),
  ].join('\n')
}
