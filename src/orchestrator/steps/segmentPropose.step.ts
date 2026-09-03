import { mapConceptToIndustries } from '../../campaign/conceptMapper.js'
import type { CrmDropdownOption } from '../../crm/types.js'
import { claim, type Claim } from '../../domain/provenance.js'
import { getLlm } from '../../llm/index.js'
import type { IcpOutput } from './icpSynthesis.step.js'
import type { IntakeOutput } from './intake.step.js'
import type { StepHandler } from './types.js'

// Builds the CRM filter set for the audience.
//
// The ordering of authority here is the whole point of this step:
//
//   1. USER INTENT is primary. "Generate infrastructure leads" names a
//      targeting concept, and that concept is resolved against the CRM's own
//      industry vocabulary. This works whether or not the CRM can support an
//      ICP.
//   2. CRM-PROVEN ICP evidence NARROWS the result, and only when the deriver
//      judged it sufficient. An insufficient ICP contributes nothing — it does
//      not widen, narrow, or override the user's stated concept.
//
// The previous version inverted this: it fed the ICP to the model and asked for
// filters. With an empty ICP the model had nothing to anchor on and returned
// every industry and every country in the vocabulary — a 15,000-company
// "audience" that matched the objective only by accident.

interface IcpStepOutput extends Partial<IcpOutput> {
  sufficient?: boolean
  statement?: string
}

export const segmentProposeStep: StepHandler = async (ctx) => {
  const llm = getLlm()
  const [intake, icp] = await Promise.all([
    ctx.prior<IntakeOutput>('INTAKE'),
    ctx.prior<IcpStepOutput>('ICP_SYNTHESIS'),
  ])

  // The CRM's own vocabulary. Every value used below comes from here.
  const industryOptions = (await ctx
    .tool('crm.getDropdownOptions', { fieldKey: 'company.industry' })
    .catch(() => [])) as CrmDropdownOption[]
  const countryOptions = (await ctx
    .tool('crm.getDropdownOptions', { fieldKey: 'company.country' })
    .catch(() => [])) as CrmDropdownOption[]

  const industryVocab = industryOptions.map((o) => o.value).filter(Boolean)
  const countryVocab = countryOptions.map((o) => o.value).filter(Boolean)

  const concept = intake?.targetConcept ?? intake?.verticalHint ?? null
  const provenance: Claim[] = [
    claim('crm_data', `CRM industry vocabulary contains ${industryVocab.length} values.`),
  ]

  // ── Resolve the user's concept against the CRM vocabulary ────────────────
  let mapping = null
  if (concept) {
    provenance.push(claim('user_intent', `Targeting concept to resolve: "${concept}".`))
    mapping = await mapConceptToIndustries({
      concept,
      vocabulary: industryVocab,
      llm,
      tenantId: ctx.run.tenantId,
      runId: ctx.run.id,
      stepId: ctx.stepId,
    })

    provenance.push(claim('ai_inference', `Interpretation: ${mapping.interpretation}`))
    provenance.push(claim('ai_inference', mapping.note))
    mapping.direct.forEach((d) =>
      provenance.push(claim('ai_inference', `Direct match "${d.value}" — ${d.reason}`)),
    )
    mapping.related.forEach((r) =>
      provenance.push(claim('ai_inference', `Adjacent candidate "${r.value}" — ${r.reason}`)),
    )
    if (mapping.rejected.length) {
      provenance.push(
        claim(
          'crm_data',
          `Discarded ${mapping.rejected.length} proposed value(s) not present in the CRM vocabulary: ${mapping.rejected.join(', ')}.`,
        ),
      )
    }
  } else {
    provenance.push(
      claim('user_intent', 'The objective named no targeting concept, so no industry filter was derived from it.'),
    )
  }

  const industries = mapping?.applied ?? []

  // ── ICP narrowing, only when the CRM actually proved something ───────────
  const icpSufficient = icp?.sufficient === true
  let narrowedByIcp = false
  let finalIndustries = industries

  if (icpSufficient && icp?.definition?.industries?.length && industries.length) {
    const proven = new Set(icp.definition.industries)
    const intersection = industries.filter((i) => proven.has(i))
    if (intersection.length) {
      finalIndustries = intersection
      narrowedByIcp = true
      provenance.push(
        claim(
          'crm_data',
          `Narrowed to ${intersection.length} industry value(s) that are BOTH what the user asked for and proven by won/lost deals.`,
        ),
      )
    } else {
      provenance.push(
        claim(
          'crm_data',
          'No overlap between the requested concept and the industries the CRM can prove. Proceeding on user intent alone.',
        ),
      )
    }
  } else if (!icpSufficient) {
    provenance.push(
      claim('crm_data', icp?.statement ?? 'No ICP evidence available.'),
    )
    provenance.push(
      claim(
        'ai_inference',
        'Audience is built from the user-stated concept only. It reflects what was ASKED FOR, not what the CRM has proven converts.',
      ),
    )
  }

  // Geography: only applied when the user actually named one.
  const geo = intake?.geoHint
  const countries =
    geo && countryVocab.length
      ? countryVocab.filter((c) => c.toLowerCase().includes(geo.toLowerCase()))
      : []
  if (geo) {
    provenance.push(
      countries.length
        ? claim('user_intent', `Geography "${geo}" matched ${countries.length} CRM country value(s).`)
        : claim('user_intent', `Geography "${geo}" matched no CRM country value; no country filter applied.`),
    )
  }

  const query = {
    industries: finalIndustries,
    countries,
    cmsValues: [] as string[],
    leadStatuses: [] as string[],
    // Companies with an existing opportunity belong to sales, not cold outreach.
    hasDeal: false,
  }

  return {
    output: {
      query,
      concept,
      conceptMapping: mapping,
      // Surfaced at the approval gate. When true the audience rests on an
      // interpretation nobody has confirmed yet.
      requiresApproval: mapping?.requiresApproval ?? Boolean(concept),
      mappingStatus: mapping?.status ?? 'no_concept',
      icpSufficient,
      narrowedByIcp,
      rationale: mapping?.note ?? 'No targeting concept was supplied by the user.',
      provenance,
    },
  }
}
