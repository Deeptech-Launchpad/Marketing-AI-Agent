import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import { BudgetExceededError, ForbiddenError } from '../platform/errors.js'

// Ceilings are checked BEFORE a step is dispatched, never after.
//
// Checking afterwards would mean the spend has already happened, which makes
// the limit a report rather than a control. An autonomous LLM loop with no
// pre-dispatch ceiling is an open financial exposure.

export interface BudgetSnapshot {
  tokensUsed: number
  costUsd: number
  stepCount: number
  budgetTokens: number
  budgetUsd: number
}

export async function assertWithinBudget(runId: string): Promise<BudgetSnapshot> {
  if (env.KILL_SWITCH_ENABLED) {
    throw new ForbiddenError('KILL_SWITCH_ENABLED is set — no agent work will be dispatched.')
  }

  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: {
      tokensUsed: true,
      costUsd: true,
      stepCount: true,
      budgetTokens: true,
      budgetUsd: true,
    },
  })
  if (!run) throw new BudgetExceededError('Run not found for budget check.')

  const costUsd = Number(run.costUsd)
  const budgetUsd = Number(run.budgetUsd)

  if (run.stepCount >= env.MAX_STEPS_PER_RUN) {
    throw new BudgetExceededError(
      `Run exceeded MAX_STEPS_PER_RUN (${env.MAX_STEPS_PER_RUN}). This usually means a regeneration loop is not converging.`,
    )
  }
  if (run.tokensUsed >= run.budgetTokens) {
    throw new BudgetExceededError(
      `Run exceeded its token budget (${run.tokensUsed}/${run.budgetTokens}).`,
    )
  }
  if (costUsd >= budgetUsd) {
    throw new BudgetExceededError(
      `Run exceeded its cost budget (${costUsd.toFixed(4)}/${budgetUsd.toFixed(2)} USD).`,
    )
  }

  return {
    tokensUsed: run.tokensUsed,
    costUsd,
    stepCount: run.stepCount,
    budgetTokens: run.budgetTokens,
    budgetUsd,
  }
}
