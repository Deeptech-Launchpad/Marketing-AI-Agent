import { z } from 'zod'
import {
  checkBrandCorpusPresent,
  checkChannelConstraints,
  checkClaims,
  type CheckableAsset,
  type ValidationIssue,
} from '../../campaign/validators.js'
import { formatForPrompt, type RetrievedChunk } from '../../knowledge/retriever.js'
import { getLlm } from '../../llm/index.js'
import { prisma } from '../../platform/db.js'
import { BadRequestError } from '../../platform/errors.js'
import type { StepHandler } from './types.js'

// Two-layer validation.
//
// Deterministic checks run first and for free: channel length limits, empty
// bodies, unsubstantiated-claim patterns. Only then does the model review tone
// against the brand corpus — and if there is no brand corpus, that is reported
// as a gap rather than passing silently.

export const BrandReviewOutput = z.object({
  passed: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(['error', 'warning']),
      message: z.string(),
      assetName: z.string().optional(),
    }),
  ),
})

export const contentValidateStep: StepHandler = async (ctx) => {
  const llm = getLlm()
  if (!ctx.run.campaignId) throw new BadRequestError('Run has no campaign to validate.')

  const assets = await prisma.asset.findMany({
    where: { campaignId: ctx.run.campaignId, runId: ctx.run.id },
    include: { versions: { orderBy: { version: 'desc' } } },
  })
  if (!assets.length) throw new BadRequestError('No assets were generated to validate.')

  // Latest version of each asset, all variants of it.
  const checkable: CheckableAsset[] = assets.map((a) => {
    const latest = a.versions[0]?.version ?? 1
    return {
      channel: a.channel,
      name: a.name,
      variants: a.versions
        .filter((v) => v.version === latest)
        .map((v) => {
          const c = v.content as { headline?: string; body?: string; callToAction?: string }
          return {
            label: v.variantLabel,
            headline: c.headline ?? '',
            body: c.body ?? '',
            callToAction: c.callToAction ?? '',
          }
        }),
    }
  })

  const brandChunks = (await ctx
    .tool('rag.search', {
      query: 'brand tone of voice, banned phrasing, claim substantiation rules',
      corpusTypes: ['brand_guidelines'],
      topN: 6,
    })
    .catch(() => [])) as RetrievedChunk[]

  const issues: ValidationIssue[] = [
    ...checkChannelConstraints(checkable),
    ...checkClaims(checkable, brandChunks.length > 0),
    ...checkBrandCorpusPresent(brandChunks.length),
  ]

  // The model review only runs when there is something to review against.
  if (brandChunks.length) {
    const review = await llm.generate({
      promptKey: 'content.validate',
      variables: {
        guidelines: formatForPrompt(brandChunks),
        assets: JSON.stringify(checkable, null, 2),
      },
      schema: BrandReviewOutput,
      feature: 'content_validate',
      tenantId: ctx.run.tenantId,
      runId: ctx.run.id,
      stepId: ctx.stepId,
    })
    for (const i of review.data.issues) {
      issues.push({ severity: i.severity, code: 'brand', message: i.message, assetName: i.assetName })
    }
  }

  const errors = issues.filter((i) => i.severity === 'error')

  // Errors are recorded on the version rows so the reviewer sees them attached
  // to the asset rather than only in a step log.
  for (const asset of assets) {
    const latest = asset.versions[0]?.version ?? 1
    const forAsset = issues.filter((i) => i.assetName === asset.name)
    await prisma.assetVersion.updateMany({
      where: { assetId: asset.id, version: latest },
      data: { validationResults: { issues: forAsset } as never },
    })
  }

  return {
    output: {
      passed: errors.length === 0,
      errorCount: errors.length,
      warningCount: issues.length - errors.length,
      issues,
      brandCorpusChunks: brandChunks.length,
      brandRulesEnforced: brandChunks.length > 0,
    },
  }
}
