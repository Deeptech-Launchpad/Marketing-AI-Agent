import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../src/config/env.js'
import { currentGeminiBudget, GeminiBudgetRequiredError, requireGeminiBudget, withGeminiBudget } from '../../src/llm/gemini/budgetContext.js'
import { GeminiCallCeilingError, geminiCallStats, reserveGeminiCallAsync, resetGeminiCallStatsForTests } from '../../src/llm/gemini/callCeiling.js'
import { bucketBudget, newTally } from '../../src/warmleads/budget.js'
import type { UsageStore } from '../../src/warmleads/usageStore.js'

// The Gemini budget of a night: reserved in the database BEFORE every call, so a refused call never
// reaches the network, and the limit holds however many calls run at once.

vi.mock('../../src/platform/db.js', () => ({ prisma: {}, newId: () => 'id' }))
const { GeminiGateway } = await import('../../src/llm/gemini/geminiGateway.js')

/** A bucket that grants a call only while below its ceiling - the same rule as the database's conditional UPDATE. */
function fakeStore(ceiling: number): { store: UsageStore; calls: () => number } {
  let calls = 0
  const store = {
    reserveGeminiCall: async () => {
      await Promise.resolve()
      if (calls >= ceiling) return false
      calls++
      return true
    },
  } as unknown as UsageStore
  return { store, calls: () => calls }
}

// A Warm Leads budget only calls Gemini with its own key (apiKey.ts); a placeholder lets these tests exercise the budget itself.
const savedOwnKey = env.WARM_LEADS_GEMINI_API_KEY
beforeEach(() => {
  env.WARM_LEADS_GEMINI_API_KEY = 'warm-leads-placeholder-key'
  resetGeminiCallStatsForTests()
})
afterEach(() => {
  env.WARM_LEADS_GEMINI_API_KEY = savedOwnKey
  requireGeminiBudget(false)
  env.GEMINI_CALL_CEILING = 0
  resetGeminiCallStatsForTests()
  vi.unstubAllGlobals()
})

describe('the bucket budget', () => {
  it('grants exactly the ceiling, counts what one evaluation used, and refuses the rest', async () => {
    const { store, calls } = fakeStore(3)
    const tally = newTally()
    const budget = bucketBudget(store, 't', 'day:2026-11-04', 3, tally)
    await withGeminiBudget(budget, async () => {
      for (let i = 0; i < 3; i++) await reserveGeminiCallAsync('generateContent')
      await expect(reserveGeminiCallAsync('generateContent')).rejects.toBeInstanceOf(GeminiCallCeilingError)
    })
    expect(calls()).toBe(3)
    expect(tally).toMatchObject({ calls: 3, refused: 1 })
    expect(geminiCallStats()).toMatchObject({ attempted: 3, blocked: 1 }) // research can tell it was cut short
  })

  it('50 concurrent calls against a ceiling of 20 are granted exactly 20 times', async () => {
    const { store, calls } = fakeStore(20)
    const tally = newTally()
    const budget = bucketBudget(store, 't', 'b', 20, tally)
    const results = await withGeminiBudget(budget, () => Promise.allSettled(Array.from({ length: 50 }, () => reserveGeminiCallAsync('generateContent'))))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(30)
    expect(calls()).toBe(20)
  })

  it('records what the ledger reports: priced calls add up, unpriced ones are counted and never estimated', () => {
    const tally = newTally()
    const budget = bucketBudget(fakeStore(5).store, 't', 'b', 5, tally)
    budget.onLedger!({ costUsd: 0.004, priced: true, hasUsageData: true })
    budget.onLedger!({ costUsd: 0.006, priced: true, hasUsageData: true })
    budget.onLedger!({ costUsd: 0, priced: false, hasUsageData: true })
    budget.onLedger!({ costUsd: 0.5, priced: true, hasUsageData: false }) // no usage data from the provider: not trusted
    expect(tally.pricedCostUsd).toBeCloseTo(0.01, 6)
    expect(tally.unpricedCalls).toBe(2)
  })

  it('does not leak: outside withGeminiBudget there is no budget', async () => {
    const { store } = fakeStore(1)
    await withGeminiBudget(bucketBudget(store, 't', 'b', 1, newTally()), async () => {
      expect(currentGeminiBudget()).toBeDefined()
    })
    expect(currentGeminiBudget()).toBeUndefined()
  })
})

describe('a process that requires a budget (the Warm Leads worker)', () => {
  it('refuses a call made outside a budget, and counts it as refused', async () => {
    requireGeminiBudget(true)
    await expect(reserveGeminiCallAsync('generateContent')).rejects.toBeInstanceOf(GeminiBudgetRequiredError)
    expect(geminiCallStats()).toMatchObject({ attempted: 0, blocked: 1 })
  })

  it('every other process is unchanged: no budget, no requirement, the old ceiling rules apply', async () => {
    env.GEMINI_CALL_CEILING = 2
    await reserveGeminiCallAsync('x')
    await reserveGeminiCallAsync('x')
    await expect(reserveGeminiCallAsync('x')).rejects.toBeInstanceOf(GeminiCallCeilingError)
    env.GEMINI_CALL_CEILING = 0
    for (let i = 0; i < 10; i++) await reserveGeminiCallAsync('x') // 0 = unlimited, as before
  })

  it('inside a budget the database decides - the process-local ceiling is not consulted', async () => {
    env.GEMINI_CALL_CEILING = 1
    const { store, calls } = fakeStore(5)
    await withGeminiBudget(bucketBudget(store, 't', 'b', 5, newTally()), async () => {
      for (let i = 0; i < 5; i++) await reserveGeminiCallAsync('x')
    })
    expect(calls()).toBe(5)
  })
})

describe('through the gateway: a call over the budget never reaches the network', () => {
  it('the 4th request of a 3-call budget is not sent, whatever the caller does', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { store, calls } = fakeStore(3)
    const g = new GeminiGateway()
    const out = await withGeminiBudget(bucketBudget(store, 't', 'b', 3, newTally()), async () => {
      const r = []
      for (let i = 0; i < 5; i++) r.push((await g.health()).ok)
      return r
    })
    expect(out).toEqual([true, true, true, false, false])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(calls()).toBe(3)
  })

  it('without a budget, a worker that requires one sends nothing', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    requireGeminiBudget(true)
    expect((await new GeminiGateway().health()).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
