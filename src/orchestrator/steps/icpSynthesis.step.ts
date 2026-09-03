import { z } from 'zod'
import {
  deriveIcpEvidence,
  formatEvidence,
  INSUFFICIENT_ICP_STATEMENT,
} from '../../campaign/icpDeriver.js'
import { getCrm } from '../../crm/index.js'
import { claim, type Claim } from '../../domain/provenance.js'
import { formatForPrompt, type RetrievedChunk } from '../../knowledge/retriever.js'
import { getLlm } from '../../llm/index.js'
import { prisma, newId } from '../../platform/db.js'
import type { IntakeOutput } from './intake.step.js'
import type { StepHandler } from './types.js'

// Derives ICP EVIDENCE from real won/lost deal data — and stops when there
// isn't enough of it.
//
// This step used to always produce a confident profile. Against real NXT Sales
// data (87 deals, 3 won, 14 lost, 26 unlinked) it returned an ICP with
// confidence "high" built on zero surviving industry facets. That output was
// indistinguishable in form from a well-evidenced one, which made it worse than
// no output at all.
//
// Now the deriver returns a sufficiency verdict and this step honours it: when
// the CRM cannot support an ICP, no model call is made and the required
// statement is returned instead. Audience selection does not depend on this —
// it runs from USER INTENT via the concept mapper — so an insufficient verdict
// stops a false claim without stopping the run.

export const IcpOutput = z.object({
  name: z.string(),
  definition: z.object({
    industries: z.array(z.string()),
    countries: z.array(z.string()),
    cmsValues: z.array(z.string()),
    signals: z.array(z.string()),
  }),
  reasoning: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
})
export type IcpOutput = z.infer<typeof IcpOutput>

export const icpSynthesisStep: StepHandler = async (ctx) => {
  const crm = getCrm()
  const llm = getLlm()

  const intake = await ctx.prior<IntakeOutput>('INTAKE')

  await ctx.tool('crm.getDealStats', {})
  const evidence = await deriveIcpEvidence(crm)
  const s = evidence.sufficiency

  const baseClaims: Claim[] = [
    claim(
      'crm_data',
      `${evidence.totalDeals} deals analysed: ${evidence.wonDeals} won, ${evidence.lostDeals} lost, ` +
        `${evidence.dealsWithoutCompany} linked to no company.`,
    ),
    claim(
      'crm_data',
      `${s.linkedDecidedDeals} decided deals join to a company; surviving facets — ` +
        `industry ${s.survivingIndustryFacets}, country ${s.survivingCountryFacets}, CMS ${s.survivingCmsFacets}.`,
    ),
  ]

  // ── Insufficient: return the verdict, make no ICP claim ──────────────────
  if (!s.sufficient) {
    const icpId = newId()
    await prisma.icpProfile.create({
      data: {
        id: icpId,
        tenantId: ctx.run.tenantId,
        name: 'No reliable ICP (insufficient CRM evidence)',
        // Empty on purpose. A downstream step reading this must find nothing to
        // target on, rather than a plausible-looking guess.
        definition: { industries: [], countries: [], cmsValues: [], signals: [] } as never,
        evidence: evidence as never,
        confidence: 'low',
        sourceDealCount: evidence.totalDeals,
      },
    })

    return {
      output: {
        icpProfileId: icpId,
        sufficient: false,
        statement: INSUFFICIENT_ICP_STATEMENT,
        reasons: s.reasons,
        name: 'No reliable ICP (insufficient CRM evidence)',
        definition: { industries: [], countries: [], cmsValues: [], signals: [] },
        confidence: 'low',
        reasoning: INSUFFICIENT_ICP_STATEMENT,
        evidenceSummary: {
          totalDeals: evidence.totalDeals,
          wonDeals: evidence.wonDeals,
          lostDeals: evidence.lostDeals,
          dealsWithoutCompany: evidence.dealsWithoutCompany,
          linkedDecidedDeals: s.linkedDecidedDeals,
          survivingIndustryFacets: s.survivingIndustryFacets,
          topIndustries: [],
        },
        citations: [],
        provenance: [
          ...baseClaims,
          claim('crm_data', INSUFFICIENT_ICP_STATEMENT),
          ...s.reasons.map((r) => claim('crm_data', r)),
          claim(
            'ai_inference',
            'No ideal customer profile was inferred. Audience selection proceeds from the user-stated targeting concept instead.',
          ),
        ],
      },
    }
  }

  // ── Sufficient: interpret the evidence ───────────────────────────────────
  const personaChunks = (await ctx
    .tool('rag.search', {
      query: `${intake?.targetConcept ?? intake?.verticalHint ?? ctx.run.objective} buyer persona, pains, triggers`,
      corpusTypes: ['persona', 'case_study'],
      topN: 6,
    })
    .catch(() => [])) as RetrievedChunk[]

  const result = await llm.generate({
    promptKey: 'icp.synthesize',
    variables: {
      objective: ctx.run.objective,
      verticalHint: intake?.targetConcept ?? intake?.verticalHint ?? 'not specified',
      evidence: formatEvidence(evidence),
      knowledge: formatForPrompt(personaChunks),
    },
    schema: IcpOutput,
    feature: 'icp_synthesis',
    tenantId: ctx.run.tenantId,
    runId: ctx.run.id,
    stepId: ctx.stepId,
  })

  const icpId = newId()
  await prisma.icpProfile.create({
    data: {
      id: icpId,
      tenantId: ctx.run.tenantId,
      name: result.data.name,
      definition: result.data.definition as never,
      evidence: evidence as never,
      confidence: result.data.confidence,
      sourceDealCount: evidence.totalDeals,
    },
  })

  return {
    output: {
      icpProfileId: icpId,
      sufficient: true,
      statement: s.statement,
      reasons: [],
      ...result.data,
      evidenceSummary: {
        totalDeals: evidence.totalDeals,
        wonDeals: evidence.wonDeals,
        lostDeals: evidence.lostDeals,
        dealsWithoutCompany: evidence.dealsWithoutCompany,
        linkedDecidedDeals: s.linkedDecidedDeals,
        survivingIndustryFacets: s.survivingIndustryFacets,
        topIndustries: evidence.byIndustry.slice(0, 5),
      },
      citations: personaChunks.map((c) => ({
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        chunkId: c.chunkId,
      })),
      provenance: [
        ...baseClaims,
        claim('crm_data', s.statement),
        ...evidence.byIndustry
          .slice(0, 3)
          .map((f) =>
            claim('crm_data', `${f.value}: ${f.won} won / ${f.lost} lost (${(f.winRate * 100).toFixed(0)}% win rate).`),
          ),
        ...(personaChunks.length ? [claim('knowledge', `${personaChunks.length} persona/case-study chunk(s) retrieved.`)] : []),
        claim('ai_inference', `Profile "${result.data.name}" at ${result.data.confidence} confidence.`),
      ],
    },
  }
}
