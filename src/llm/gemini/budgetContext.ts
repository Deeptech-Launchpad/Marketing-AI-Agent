import { AsyncLocalStorage } from 'node:async_hooks'

// A SPENDING CONTEXT FOR GEMINI CALLS.
//
// Warm Leads must never spend more Gemini calls than its daily ceiling, across
// restarts and across several workers. The ceiling therefore lives in the
// database, and every call is reserved there BEFORE the request is made.
//
// The gateway does not know about Warm Leads. It asks `reserveGeminiCallAsync`
// for permission before each HTTP request; when a budget is active for the
// current async call chain, the budget decides (and refuses by throwing).
// Everything outside a budget keeps the previous behaviour, so no other
// feature changes.
//
// A process can declare that it may NOT call Gemini without a budget
// (`requireGeminiBudget`) - the Warm Leads worker does, so a code path that
// forgets to open a budget is refused instead of spending unmetered.

export interface GeminiBudget {
  /** Reserves one call. Throws GeminiCallCeilingError when the ceiling is used up. */
  reserve(kind: string): Promise<void>
  /** Called with what a finished call cost, when the ledger knows it. Must not throw. */
  onLedger?(call: { costUsd: number; priced: boolean; hasUsageData: boolean }): void
}

export class GeminiBudgetRequiredError extends Error {
  constructor() {
    super('This process may only call Gemini inside a budget (it was not sent).')
    this.name = 'GeminiBudgetRequiredError'
  }
}

const store = new AsyncLocalStorage<GeminiBudget>()
let budgetRequired = false

/** Runs `fn` with every Gemini call in its async chain reserved against `budget`. */
export const withGeminiBudget = <T>(budget: GeminiBudget, fn: () => Promise<T>): Promise<T> => store.run(budget, fn)

export const currentGeminiBudget = (): GeminiBudget | undefined => store.getStore()

/** For a dedicated worker process: a call made outside a budget is refused. */
export function requireGeminiBudget(on = true): void {
  budgetRequired = on
}

export const geminiBudgetRequired = (): boolean => budgetRequired
