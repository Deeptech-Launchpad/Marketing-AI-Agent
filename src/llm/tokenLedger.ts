import { Prisma } from '@prisma/client'
import { prisma, newId } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import type { LlmUsage } from './llmPort.js'

// Records one row per LLM request and rolls the cost onto the run.
//
// The counting discipline is inherited verbatim from NXT Sales' AiUsage: write
// only what the provider itself reported, never estimate, and mark
// hasUsageData=false when the provider returned nothing rather than guessing a
// number that would quietly understate the bill.
//
// The one thing this changes is trust: AiUsage rows are POSTed by the browser
// and are therefore telemetry. These rows are written server-side by the only
// component that can make the call, so they are an auditable ledger.

export interface LedgerInput {
  tenantId: string
  runId?: string | null
  stepId?: string | null
  feature: string
  provider: string
  modelRequested: string
  model: string
  fellBack: boolean
  usage: LlmUsage
  costUsd: number
  priced: boolean
  latencyMs: number
  promptKey?: string | null
  promptVersion?: number | null
}

/** Coerce defensively — these numbers arrive from an external API. */
function toCount(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0
  return Math.min(Math.floor(v), 100_000_000)
}

export async function recordLlmCall(input: LedgerInput): Promise<void> {
  const promptTokens = toCount(input.usage.promptTokens)
  const outputTokens = toCount(input.usage.outputTokens)
  const totalTokens = toCount(input.usage.totalTokens) || promptTokens + outputTokens

  try {
    await prisma.$transaction(async (tx) => {
      await tx.llmCall.create({
        data: {
          id: newId(),
          tenantId: input.tenantId,
          runId: input.runId ?? null,
          stepId: input.stepId ?? null,
          feature: input.feature,
          provider: input.provider,
          modelRequested: input.modelRequested,
          model: input.model,
          fellBack: input.fellBack,
          promptTokens,
          outputTokens,
          totalTokens,
          hasUsageData: input.usage.hasUsageData,
          costUsd: new Prisma.Decimal(input.costUsd),
          priced: input.priced,
          latencyMs: input.latencyMs,
          promptKey: input.promptKey ?? null,
          promptVersion: input.promptVersion ?? null,
        },
      })

      // Roll onto the run so budgetGuard can read a single authoritative total
      // instead of re-aggregating the ledger before every dispatch.
      if (input.runId) {
        await tx.agentRun.update({
          where: { id: input.runId },
          data: {
            tokensUsed: { increment: totalTokens },
            costUsd: { increment: new Prisma.Decimal(input.costUsd) },
          },
        })
      }
      if (input.stepId) {
        await tx.agentStep.update({
          where: { id: input.stepId },
          data: {
            tokensUsed: { increment: totalTokens },
            costUsd: { increment: new Prisma.Decimal(input.costUsd) },
          },
        })
      }
    })
  } catch (err) {
    // Ledger failure must not kill the generation that already succeeded, but
    // it is loud: an unrecorded call is an unbudgeted call.
    logger.error({ err, feature: input.feature }, 'LLM ledger write failed')
  }
}
