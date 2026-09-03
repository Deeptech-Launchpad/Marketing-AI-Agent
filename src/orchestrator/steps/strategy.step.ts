import { z } from 'zod'
import { CHANNELS } from '../../domain/enums.js'
import { formatForPrompt, toCitations, type RetrievedChunk } from '../../knowledge/retriever.js'
import { getLlm } from '../../llm/index.js'
import { prisma, newId } from '../../platform/db.js'
import { BadRequestError } from '../../platform/errors.js'
import type { IcpOutput } from './icpSynthesis.step.js'
import type { ResearchOutput } from './research.step.js'
import type { StepHandler } from './types.js'

// Campaign strategy: channel mix, messaging pillars, sequence, KPIs.
//
// Re-enters here when a reviewer requests changes, with their comment carried
// on the run. The rejected strategy is never edited — a new version is written,
// so what was rejected and why stays visible.

export const StrategyOutput = z.object({
  channelMix: z.array(
    z.object({
      channel: z.enum(CHANNELS),
      rationale: z.string(),
      weight: z.number().min(0).max(1),
    }),
  ),
  messagingPillars: z.array(z.object({ name: z.string(), angle: z.string() })),
  sequence: z.array(
    z.object({ step: z.number().int(), channel: z.enum(CHANNELS), description: z.string() }),
  ),
  kpis: z.array(z.object({ name: z.string(), target: z.string() })),
  rationale: z.string(),
})
export type StrategyOutput = z.infer<typeof StrategyOutput>

export const strategyStep: StepHandler = async (ctx) => {
  const llm = getLlm()
  if (!ctx.run.campaignId) throw new BadRequestError('Run has no campaign to attach a strategy to.')

  const [icp, research, audience] = await Promise.all([
    ctx.prior<IcpOutput>('ICP_SYNTHESIS'),
    ctx.prior<ResearchOutput & { coverage: unknown }>('RESEARCH'),
    ctx.prior<{ totalIncluded: number; totalSuppressed: number; truncated: boolean }>('SEGMENT_RESOLVE'),
  ])

  const knowledge = (await ctx
    .tool('rag.search', {
      query: `${ctx.run.objective} positioning, services, differentiators, past campaign results`,
      corpusTypes: ['product_service', 'company_info', 'past_campaign', 'case_study'],
      topN: 8,
    })
    .catch(() => [])) as RetrievedChunk[]

  const result = await llm.generate({
    promptKey: 'strategy.generate',
    variables: {
      objective: ctx.run.objective,
      icp: icp ? JSON.stringify(icp.definition, null, 2) : 'not available',
      audienceSize: audience?.totalIncluded ?? 0,
      audienceTruncated: audience?.truncated ? 'yes' : 'no',
      research: research?.summary ?? 'no research available',
      knowledge: formatForPrompt(knowledge),
      // Empty on the first pass; carries the reviewer's words on a rerun.
      feedback: ctx.run.feedback ?? '(none — first attempt)',
    },
    schema: StrategyOutput,
    feature: 'strategy',
    tenantId: ctx.run.tenantId,
    runId: ctx.run.id,
    stepId: ctx.stepId,
  })

  const previous = await prisma.campaignStrategy.findFirst({
    where: { campaignId: ctx.run.campaignId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  const version = (previous?.version ?? 0) + 1

  const strategyId = newId()
  await prisma.campaignStrategy.create({
    data: {
      id: strategyId,
      tenantId: ctx.run.tenantId,
      campaignId: ctx.run.campaignId,
      runId: ctx.run.id,
      version,
      channelMix: result.data.channelMix as never,
      messagingPillars: result.data.messagingPillars as never,
      sequence: result.data.sequence as never,
      kpis: result.data.kpis as never,
      rationale: result.data.rationale,
      citations: toCitations(knowledge) as never,
    },
  })

  return {
    output: {
      strategyId,
      version,
      ...result.data,
      citations: toCitations(knowledge),
      knowledgeChunksUsed: knowledge.length,
    },
  }
}
