import { GeminiCallCeilingError } from '../llm/gemini/callCeiling.js'
import type { GeminiBudget } from '../llm/gemini/budgetContext.js'
import type { UsageStore } from './usageStore.js'

// The Gemini budget of one bucket, as the gateway sees it (see llm/gemini/budgetContext.ts).
//
// Each call is reserved in the database BEFORE it is made (usageStore.reserveGeminiCall);
// a refusal throws, so nothing is sent. The tally records what this one evaluation used,
// so the evaluation row can say how many calls it made and whether any was refused.

export interface BudgetTally {
  calls: number
  refused: number
  pricedCostUsd: number
  unpricedCalls: number
}

export const newTally = (): BudgetTally => ({ calls: 0, refused: 0, pricedCostUsd: 0, unpricedCalls: 0 })

export function bucketBudget(store: UsageStore, tenantId: string, bucket: string, ceiling: number, tally: BudgetTally): GeminiBudget {
  return {
    async reserve() {
      const ok = await store.reserveGeminiCall(tenantId, bucket)
      if (!ok) {
        tally.refused++
        throw new GeminiCallCeilingError(ceiling)
      }
      tally.calls++
    },
    onLedger(call) {
      if (call.priced && call.hasUsageData) tally.pricedCostUsd += call.costUsd
      else tally.unpricedCalls++
    },
  }
}
