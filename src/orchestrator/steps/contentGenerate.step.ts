import { z } from 'zod'
import { ASSET_TYPES, CHANNELS } from '../../domain/enums.js'
import { formatForPrompt, toCitations, type RetrievedChunk } from '../../knowledge/retriever.js'
import { getLlm } from '../../llm/index.js'
import { prisma, newId } from '../../platform/db.js'
import { BadRequestError } from '../../platform/errors.js'
import type { IcpOutput } from './icpSynthesis.step.js'
import type { StrategyOutput } from './strategy.step.js'
import type { StepHandler } from './types.js'

// Generates channel-ready copy for the approved strategy.
//
// Content is generated for LinkedIn and Meta as well as email — that is
// campaign planning, and it is in scope. What is NOT in scope is publishing:
// there is no channel adapter anywhere in this codebase, and no tool that could
// reach one.
//
// Every regeneration appends a version. Nothing is edited in place, so an asset
// that was approved can always be shown exactly as it was approved.

const Variant = z.object({
  label: z.string(),
  headline: z.string(),
  body: z.string(),
  callToAction: z.string(),
})

export const ContentOutput = z.object({
  assets: z.array(
    z.object({
      channel: z.enum(CHANNELS),
      assetType: z.enum(ASSET_TYPES),
      name: z.string(),
      variants: z.array(Variant).min(1),
    }),
  ),
})
export type ContentOutput = z.infer<typeof ContentOutput>

export const contentGenerateStep: StepHandler = async (ctx) => {
  const llm = getLlm()
  if (!ctx.run.campaignId) throw new BadRequestError('Run has no campaign to attach assets to.')

  const [strategy, icp] = await Promise.all([
    ctx.prior<StrategyOutput>('STRATEGY'),
    ctx.prior<IcpOutput>('ICP_SYNTHESIS'),
  ])
  if (!strategy) throw new BadRequestError('No approved strategy is available to generate content from.')

  const knowledge = (await ctx
    .tool('rag.search', {
      query: `brand tone of voice, product and service descriptions, proof points`,
      corpusTypes: ['brand_guidelines', 'product_service', 'case_study'],
      topN: 8,
    })
    .catch(() => [])) as RetrievedChunk[]

  const result = await llm.generate({
    promptKey: 'content.generate',
    variables: {
      objective: ctx.run.objective,
      icp: icp ? JSON.stringify(icp.definition, null, 2) : 'not available',
      channelMix: JSON.stringify(strategy.channelMix, null, 2),
      messagingPillars: JSON.stringify(strategy.messagingPillars, null, 2),
      knowledge: formatForPrompt(knowledge),
      feedback: ctx.run.feedback ?? '(none — first attempt)',
    },
    schema: ContentOutput,
    feature: 'content_generate',
    tenantId: ctx.run.tenantId,
    runId: ctx.run.id,
    stepId: ctx.stepId,
  })

  const citations = toCitations(knowledge)
  const created: Array<{ assetId: string; channel: string; name: string; variants: number }> = []

  for (const asset of result.data.assets) {
    // Same (campaign, run, channel, name) means a regeneration of the same
    // asset, so it gains a version rather than becoming a duplicate.
    const existing = await prisma.asset.findFirst({
      where: {
        campaignId: ctx.run.campaignId,
        runId: ctx.run.id,
        channel: asset.channel,
        name: asset.name,
      },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    })

    const assetId = existing?.id ?? newId()
    if (!existing) {
      await prisma.asset.create({
        data: {
          id: assetId,
          tenantId: ctx.run.tenantId,
          campaignId: ctx.run.campaignId,
          runId: ctx.run.id,
          channel: asset.channel,
          assetType: asset.assetType,
          name: asset.name,
        },
      })
    }

    const nextVersion = (existing?.versions[0]?.version ?? 0) + 1
    let lastVersionId: string | null = null

    for (const variant of asset.variants) {
      const versionId = newId()
      await prisma.assetVersion.create({
        data: {
          id: versionId,
          tenantId: ctx.run.tenantId,
          assetId,
          version: nextVersion,
          variantLabel: variant.label,
          content: variant as never,
          renderedText: `${variant.headline}\n\n${variant.body}\n\n${variant.callToAction}`,
          model: result.model,
          promptKey: 'content.generate',
          citations: citations as never,
        },
      })
      lastVersionId = versionId
    }

    await prisma.asset.update({ where: { id: assetId }, data: { currentVersionId: lastVersionId } })
    created.push({
      assetId,
      channel: asset.channel,
      name: asset.name,
      variants: asset.variants.length,
    })
  }

  return {
    output: {
      assets: created,
      totalAssets: created.length,
      totalVariants: created.reduce((s, a) => s + a.variants, 0),
      citations,
      knowledgeChunksUsed: knowledge.length,
      // Made visible so a green validation result is not mistaken for one that
      // actually had brand rules to check against.
      brandCorpusAvailable: knowledge.some((c) => c.corpusType === 'brand_guidelines'),
    },
  }
}
