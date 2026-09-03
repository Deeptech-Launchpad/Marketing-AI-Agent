import { createApproval } from '../../approval/approvalService.js'
import type { ApprovalKind } from '../../domain/enums.js'
import { prisma } from '../../platform/db.js'
import { BadRequestError } from '../../platform/errors.js'
import type { IntakeOutput } from './intake.step.js'
import type { StepHandler } from './types.js'

// The two human gates. Both use the same handler; only the payload differs.
//
// The step does NOT block a worker. It writes the Approval row, returns an
// awaitingApproval marker, and the executor parks the run — the pg-boss job
// completes and the worker moves on. The run resumes when a decision arrives.

function buildStrategyPayload(
  intake: IntakeOutput | null,
  icp: unknown,
  audience: unknown,
  research: unknown,
  strategy: unknown,
) {
  return {
    kind: 'strategy',
    // Unresolved ambiguities from INTAKE are surfaced HERE, at the moment
    // someone is deciding — not buried in an early step log nobody reads.
    openQuestions: intake?.ambiguities ?? [],
    icp,
    audience,
    research,
    strategy,
  }
}

export function approvalStep(kind: ApprovalKind): StepHandler {
  return async (ctx) => {
    if (!ctx.run.campaignId) throw new BadRequestError('Run has no campaign to approve against.')

    let payload: Record<string, unknown>

    if (kind === 'strategy') {
      const [intake, icp, audience, research, strategy] = await Promise.all([
        ctx.prior<IntakeOutput>('INTAKE'),
        ctx.prior<Record<string, unknown>>('ICP_SYNTHESIS'),
        ctx.prior<Record<string, unknown>>('SEGMENT_RESOLVE'),
        ctx.prior<Record<string, unknown>>('RESEARCH'),
        ctx.prior<Record<string, unknown>>('STRATEGY'),
      ])
      payload = buildStrategyPayload(intake, icp, audience, research, strategy)
    } else {
      const [generated, validation] = await Promise.all([
        ctx.prior<Record<string, unknown>>('CONTENT_GENERATE'),
        ctx.prior<Record<string, unknown>>('CONTENT_VALIDATE'),
      ])

      // The reviewer sees the actual stored asset versions, not a paraphrase of
      // what the generation step reported.
      const assets = await prisma.asset.findMany({
        where: { campaignId: ctx.run.campaignId, runId: ctx.run.id },
        include: { versions: { orderBy: { version: 'desc' } } },
      })

      payload = {
        kind: 'content',
        assets: assets.map((a) => ({
          id: a.id,
          channel: a.channel,
          assetType: a.assetType,
          name: a.name,
          versions: a.versions.map((v) => ({
            id: v.id,
            version: v.version,
            variantLabel: v.variantLabel,
            content: v.content,
            renderedText: v.renderedText,
            citations: v.citations,
            validationResults: v.validationResults,
          })),
        })),
        generationSummary: generated,
        validation,
      }
    }

    const { id, payloadHash } = await createApproval({
      tenantId: ctx.run.tenantId,
      runId: ctx.run.id,
      stepId: ctx.stepId,
      campaignId: ctx.run.campaignId,
      kind,
      payload,
    })

    return {
      output: { approvalId: id, payloadHash, kind },
      awaitingApproval: { approvalId: id, payloadHash },
    }
  }
}
