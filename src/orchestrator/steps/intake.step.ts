import { z } from 'zod'
import { claim } from '../../domain/provenance.js'
import { getLlm } from '../../llm/index.js'
import type { StepHandler } from './types.js'

// Turns a free-text objective into a structured goal.
//
// The `ambiguities` field is the important one: rather than silently guessing a
// geography or a company size the user never specified, the step names what it
// had to leave open, and those gaps are shown to the reviewer at the strategy
// gate. "Generate infrastructure leads" says nothing about geography — pretending
// otherwise is how a campaign ends up targeting the wrong market.

export const IntakeOutput = z.object({
  intent: z.string(),
  /**
   * The targeting concept the user actually named, in their own words —
   * "infrastructure" from "Generate infrastructure leads". This is USER INTENT,
   * not a CRM fact and not an inference, and it is what drives audience
   * selection when the CRM cannot support an ICP. Kept verbatim so the mapping
   * step resolves the user's word against the CRM vocabulary rather than
   * against a paraphrase of it.
   */
  targetConcept: z.string().nullable(),
  verticalHint: z.string().nullable(),
  geoHint: z.string().nullable(),
  volumeHint: z.string().nullable(),
  channelHint: z.string().nullable(),
  ambiguities: z.array(z.string()),
})
export type IntakeOutput = z.infer<typeof IntakeOutput>

export const intakeStep: StepHandler = async (ctx) => {
  const llm = getLlm()

  const result = await llm.generate({
    promptKey: 'intake.parse_objective',
    variables: { objective: ctx.run.objective },
    schema: IntakeOutput,
    feature: 'intake',
    tenantId: ctx.run.tenantId,
    runId: ctx.run.id,
    stepId: ctx.stepId,
  })

  return {
    output: {
      ...result.data,
      provenance: [
        claim('user_intent', `Objective as stated: "${ctx.run.objective}"`),
        claim(
          'user_intent',
          result.data.targetConcept
            ? `Targeting concept named by the user: "${result.data.targetConcept}"`
            : 'The user named no explicit targeting concept.',
        ),
        claim('ai_inference', `Parsed intent: ${result.data.intent}`),
        ...result.data.ambiguities.map((a) => claim('ai_inference', `Unspecified by the user: ${a}`)),
      ],
    },
  }
}
