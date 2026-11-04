import { env } from '../../config/env.js'
import { currentGeminiBudget, GeminiBudgetRequiredError, geminiBudgetRequired } from './budgetContext.js'

// A HARD CEILING ON GEMINI API CALLS (GEMINI_CALL_CEILING, 0 = none).
//
// Every HTTP request to the Gemini API is counted before it is made — retries
// and model fall-backs included — and the call AFTER the ceiling is never sent:
// reserveGeminiCall throws, so nothing leaves the machine. The count lives in
// this process; the isolated warm-lead test reads it to report the real number
// of calls and to know when research was cut short.

export class GeminiCallCeilingError extends Error {
  constructor(ceiling: number) {
    super(`The Gemini call ceiling (${ceiling}) was reached; this call was not sent.`)
    this.name = 'GeminiCallCeilingError'
  }
}

const state = { attempted: 0, blocked: 0, byKind: {} as Record<string, number> }

/** Counts one call, or throws (and counts a refusal) when the ceiling is used up. Call it immediately before the request. */
export function reserveGeminiCall(kind: string): void {
  const ceiling = env.GEMINI_CALL_CEILING
  if (ceiling > 0 && state.attempted >= ceiling) {
    state.blocked++
    throw new GeminiCallCeilingError(ceiling)
  }
  state.attempted++
  state.byKind[kind] = (state.byKind[kind] ?? 0) + 1
}

/**
 * The reservation the gateway makes before every request.
 *
 * Inside a budget (Warm Leads) the DATABASE decides - daily, atomic, shared by
 * every worker and surviving restarts. Outside one the process-local ceiling
 * above applies, exactly as before - unless the process declared that every call
 * needs a budget, in which case an unbudgeted call is refused.
 */
export async function reserveGeminiCallAsync(kind: string): Promise<void> {
  const budget = currentGeminiBudget()
  if (budget) {
    try {
      await budget.reserve(kind)
    } catch (err) {
      if (err instanceof GeminiCallCeilingError) state.blocked++
      throw err
    }
    state.attempted++
    state.byKind[kind] = (state.byKind[kind] ?? 0) + 1
    return
  }
  if (geminiBudgetRequired()) {
    state.blocked++
    throw new GeminiBudgetRequiredError()
  }
  reserveGeminiCall(kind)
}

/** True when no further call can be made. */
export const geminiCeilingExhausted = (): boolean => env.GEMINI_CALL_CEILING > 0 && state.attempted >= env.GEMINI_CALL_CEILING

export function geminiCallStats() {
  return { ceiling: env.GEMINI_CALL_CEILING, attempted: state.attempted, blocked: state.blocked, exhausted: geminiCeilingExhausted(), byKind: { ...state.byKind } }
}

/** Tests only. */
export function resetGeminiCallStatsForTests(): void {
  state.attempted = 0
  state.blocked = 0
  state.byKind = {}
}
