import { z } from 'zod'
import { stripLabel } from '../domain/provenance.js'
import type { LlmPort } from '../llm/index.js'

// Maps a targeting concept the USER asked for ("infrastructure") onto the real
// industry vocabulary the CRM actually stores.
//
// This is deliberately separate from ICP derivation. They answer different
// questions and have different reliability:
//
//   ICP evidence    - what the CRM can PROVE about which customers convert.
//                     Derived from won/lost deals. Often insufficient.
//   Concept mapping - which existing companies match what the user ASKED FOR.
//                     Derived from the user's own words plus the CRM's own
//                     vocabulary. Available even when ICP evidence is not.
//
// Conflating them is how "generate infrastructure leads" ends up returning a
// confident profile built on three won deals. Keeping them apart means the
// audience can be built honestly from user intent while the ICP verdict stays
// "insufficient".
//
// The model never invents a value: it classifies values from a supplied list,
// and anything it returns outside that list is discarded here.

export const ConceptMappingOutput = z.object({
  direct: z.array(
    z.object({
      value: z.string(),
      reason: z.string(),
    }),
  ),
  related: z.array(
    z.object({
      value: z.string(),
      reason: z.string(),
    }),
  ),
  interpretation: z.string(),
})

export type ConceptMappingStatus = 'resolved' | 'ambiguous' | 'unmapped'

export interface ConceptMapping {
  concept: string
  /** Values the model judged to be unambiguously the requested concept. */
  direct: Array<{ value: string; reason: string }>
  /** Adjacent values. Never used without being flagged for human approval. */
  related: Array<{ value: string; reason: string }>
  status: ConceptMappingStatus
  /** Values actually used to build the audience. */
  applied: string[]
  requiresApproval: boolean
  note: string
  interpretation: string
  /** Values the model returned that are not in the CRM vocabulary. */
  rejected: string[]
  vocabularySize: number
}

export interface MapConceptOptions {
  concept: string
  vocabulary: string[]
  llm: LlmPort
  tenantId: string
  runId?: string | null
  stepId?: string | null
}

export async function mapConceptToIndustries(opts: MapConceptOptions): Promise<ConceptMapping> {
  const { concept, vocabulary } = opts

  if (!vocabulary.length) {
    return {
      concept,
      direct: [],
      related: [],
      status: 'unmapped',
      applied: [],
      requiresApproval: true,
      note:
        'The CRM returned no industry vocabulary, so the concept could not be mapped to anything. ' +
        'There is no industry value to filter on — do not run the audience without one.',
      interpretation: '',
      rejected: [],
      vocabularySize: 0,
    }
  }

  const result = await opts.llm.generate({
    promptKey: 'segment.map_concept',
    variables: { concept, vocabulary },
    schema: ConceptMappingOutput,
    feature: 'concept_mapping',
    tenantId: opts.tenantId,
    runId: opts.runId,
    stepId: opts.stepId,
  })

  // Enforce the vocabulary rather than trusting the prompt to have been obeyed.
  // A value outside the list matches nothing in the CRM and would silently
  // produce an empty audience that looks like a real one.
  const allowed = new Set(vocabulary)
  const rejected: string[] = []
  const keep = (rows: Array<{ value: string; reason: string }>) =>
    rows
      .filter((r) => {
        if (allowed.has(r.value)) return true
        rejected.push(r.value)
        return false
      })
      // The safety preamble asks the model to label its claims, so reasons
      // arrive as "[AI inference] ...". These fragments get composed into
      // larger sentences downstream, so the label is removed here at the source
      // rather than at every call site.
      .map((r) => ({ value: r.value, reason: stripLabel(r.reason) }))

  const direct = keep(result.data.direct)
  const related = keep(result.data.related).filter((r) => !direct.some((d) => d.value === r.value))

  // A concept with no direct match is NOT silently widened to its neighbours.
  // The related values are applied so the run can still produce something to
  // look at, but the mapping is marked ambiguous and flagged for approval, so
  // the reviewer decides whether "adjacent" was good enough.
  let status: ConceptMappingStatus
  let applied: string[]
  let note: string

  if (direct.length > 0) {
    status = 'resolved'
    applied = direct.map((d) => d.value)
    note =
      related.length > 0
        ? `Mapped to ${direct.length} industry value(s). ${related.length} adjacent value(s) were identified but NOT applied — approve them explicitly to widen the audience.`
        : `Mapped to ${direct.length} industry value(s).`
  } else if (related.length > 0) {
    status = 'ambiguous'
    applied = related.map((r) => r.value)
    note =
      `"${concept}" does not map cleanly onto any CRM industry value. ` +
      `${related.length} adjacent value(s) were applied provisionally and REQUIRE APPROVAL — ` +
      `the audience below is built on an unconfirmed interpretation.`
  } else {
    status = 'unmapped'
    applied = []
    note =
      `"${concept}" could not be mapped to any of the ${vocabulary.length} industry values in the CRM. ` +
      `There is no industry value to filter on — do not run the audience without one, as that would include every industry. ` +
      `Supply explicit industry values, or confirm a different targeting axis.`
  }

  return {
    concept,
    direct,
    related,
    status,
    applied,
    requiresApproval: status !== 'resolved',
    note,
    interpretation: stripLabel(result.data.interpretation),
    rejected,
    vocabularySize: vocabulary.length,
  }
}
