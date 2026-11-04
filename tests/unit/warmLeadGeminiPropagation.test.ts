import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../src/config/env.js'
import { withGeminiBudget } from '../../src/llm/gemini/budgetContext.js'
import { geminiCallStats, resetGeminiCallStatsForTests } from '../../src/llm/gemini/callCeiling.js'
import { bucketBudget, newTally } from '../../src/warmleads/budget.js'
import type { UsageStore } from '../../src/warmleads/usageStore.js'

// WHEN GEMINI CANNOT ANSWER, A COMPANY IS NEVER CALLED COLD.
//
// The real computeEvaluation and the real Gemini gateway run here; only the network, the database and the CRM are faked.
// The research step is scripted to behave like the real Intent providers do: it makes Gemini calls and CATCHES whatever
// goes wrong, carrying on with "nothing found". The tests prove that
//   - once the budget's ceiling is reached no further request is sent, and the research is "incomplete", never cold;
//   - a Gemini failure that is NOT the ceiling (rejected key, Google quota, outage, missing dedicated key) is also
//     "could not be completed - retry", never cold;
//   - the same research with every call answered IS allowed to end cold (so the rule is not simply "never cold");
//   - every other feature (a call outside a Warm Leads budget) behaves exactly as before.

const mocks = vi.hoisted(() => ({
  research: { run: async (_gateway: unknown) => undefined as unknown },
  enriched: { hasProductSchema: true },
}))

vi.mock('../../src/platform/db.js', () => ({
  newId: () => 'id',
  prisma: {
    companyEnrichment: {
      findUnique: async () => ({
        status: 'enriched',
        failureReason: null,
        sourceUrl: 'https://acme.example/',
        signals: { finalUrl: 'https://acme.example/', hasProductSchema: mocks.enriched.hasProductSchema, pageTitle: 'Acme Retail', metaDescription: 'Retail' },
        technologies: [],
      }),
    },
    intentDetectionRun: { findUnique: async () => ({ status: 'completed', failureReason: null, costUsd: 0, providerResults: [] }) },
    intentSignal: { findMany: async () => [] },
  },
}))
vi.mock('../../src/crm/index.js', () => ({
  getCrm: () => ({
    getCompany: async () => ({ id: 'c1', name: 'Acme Retail', domain: 'acme.example', country: 'India', industry: 'Retail' }),
    listActivities: async () => [],
  }),
}))
vi.mock('../../src/enrichment/companyEnrichment.js', () => ({
  queueCompanyEnrichment: async () => ({ id: 'enr1' }),
  runCompanyEnrichment: async () => undefined,
}))
vi.mock('../../src/intent/intentDetection.js', () => ({
  queueIntentDetection: async () => ({ id: 'run1' }),
  runIntentDetection: async () => {
    const { GeminiGateway } = await import('../../src/llm/gemini/geminiGateway.js')
    await mocks.research.run(new GeminiGateway())
  },
}))
vi.mock('../../src/intent/providers/crmProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/intent/providers/crmProvider.js')>()),
  CrmSignalProvider: class {
    name = 'crm'
    available() {
      return { ok: true }
    }
    async collect() {
      return { provider: 'crm', ok: true, signals: [], durationMs: 0 }
    }
  },
}))
vi.mock('../../src/llm/promptStore.js', () => ({
  resolvePrompt: async () => ({ key: 'k', version: 1, systemInstruction: 's', userText: 'u', temperature: 0 }),
}))
vi.mock('../../src/llm/tokenLedger.js', () => ({ recordLlmCall: async () => undefined }))

const { computeEvaluation } = await import('../../src/warmleads/service.js')

const saved = { shared: env.GEMINI_API_KEY, own: env.WARM_LEADS_GEMINI_API_KEY }
const SHARED = 'shared-placeholder-key'
const OWN = 'warm-leads-placeholder-key'

/** A budget that grants `ceiling` calls, like the database's conditional UPDATE. */
function budgetOf(ceiling: number) {
  let granted = 0
  const store = {
    reserveGeminiCall: async () => {
      await Promise.resolve()
      if (granted >= ceiling) return false
      granted++
      return true
    },
  } as unknown as UsageStore
  return { budget: bucketBudget(store, 't', 'b', ceiling, newTally()), granted: () => granted }
}

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const okAnswer = () => answer(200, { candidates: [{ content: { parts: [{ text: 'Nothing about this company.' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 } })

/** What the real providers do: ask Gemini several times and, whatever happens, carry on. */
const swallowingResearch = (calls: number) => async (gateway: unknown) => {
  const g = gateway as { generate: (o: unknown) => Promise<unknown> }
  for (let i = 0; i < calls; i++) {
    try {
      await g.generate({ promptKey: 'intent_public_research', variables: {}, feature: 'intent_public_research' })
    } catch {
      // swallowed: "this source found nothing"
    }
  }
}

const evaluate = (budget: ReturnType<typeof budgetOf>['budget']) =>
  withGeminiBudget(budget, () => computeEvaluation({ tenantId: 't', crmCompanyId: 'c1', requestedBy: 'tester', deepGate: async () => ({ allowed: true }) }))

beforeEach(() => {
  env.GEMINI_API_KEY = SHARED
  env.WARM_LEADS_GEMINI_API_KEY = OWN
  mocks.enriched.hasProductSchema = true
  resetGeminiCallStatsForTests()
})
afterEach(() => {
  env.GEMINI_API_KEY = saved.shared
  env.WARM_LEADS_GEMINI_API_KEY = saved.own
  resetGeminiCallStatsForTests()
  vi.unstubAllGlobals()
})

describe('the ceiling is reached in the middle of the research', () => {
  it('no request is sent after the ceiling, and the company is incomplete - never cold', async () => {
    const fetchMock = vi.fn(async () => okAnswer())
    vi.stubGlobal('fetch', fetchMock)
    mocks.research.run = swallowingResearch(10) // asks 10 times; the budget allows 3
    const b = budgetOf(3)
    const r = await evaluate(b.budget)

    expect(fetchMock).toHaveBeenCalledTimes(3) // never more than the ceiling, however often it asked
    expect(b.granted()).toBe(3)
    expect(geminiCallStats().blocked).toBeGreaterThan(0) // every refused attempt was counted
    expect(r.failure).toBeNull()
    expect(r.deep).toBe('skipped_ceiling')
    expect(r.result?.classification).not.toBe('cold')
    expect(r.result?.classification).toBe('insufficient_data')
    expect(r.result?.summary).toMatch(/incomplete/i)
  })

  it('a ceiling of 0 sends nothing at all and the company is still not cold', async () => {
    const fetchMock = vi.fn(async () => okAnswer())
    vi.stubGlobal('fetch', fetchMock)
    mocks.research.run = swallowingResearch(5)
    const r = await evaluate(budgetOf(0).budget)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.result?.classification).toBe('insufficient_data')
  })
})

describe('Gemini fails for a reason that is not the ceiling', () => {
  for (const [name, status, message] of [
    ['a rejected key', 403, 'API key not valid. Please pass a valid API key.'],
    ["Google's own quota", 429, 'Resource has been exhausted (e.g. check quota).'],
    ['an outage', 503, 'The service is currently unavailable.'],
  ] as const) {
    it(`${name}: the research is "could not be completed - retry", never cold, and nothing is classified`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => answer(status, { error: { message } })))
      mocks.research.run = swallowingResearch(4)
      const r = await evaluate(budgetOf(100).budget)
      expect(r.result).toBeNull() // not classified at all
      expect(r.failure?.message).toMatch(/Gemini returned an error/)
      expect(r.failure?.message).toContain(message.slice(0, 20))
      expect(r.deep).toBe('failed')
      expect(JSON.stringify(r)).not.toContain(OWN) // the key never reaches a stored result
    })
  }

  it('the dedicated Warm Leads key missing in the middle of the work is also a retry, not cold', async () => {
    const fetchMock = vi.fn(async () => okAnswer())
    vi.stubGlobal('fetch', fetchMock)
    env.WARM_LEADS_GEMINI_API_KEY = ''
    mocks.research.run = swallowingResearch(3)
    const b = budgetOf(100)
    const r = await evaluate(b.budget)
    expect(fetchMock).not.toHaveBeenCalled() // and the shared key was not used instead
    expect(b.granted()).toBe(0) // no reservation was used up
    expect(r.result).toBeNull()
    expect(r.failure?.message).toMatch(/Gemini returned an error/)
  })
})

describe('research that really finished may end cold (so the rule is not simply "never cold")', () => {
  it('every call answered, nothing found: cold, and the stats show no failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okAnswer()))
    mocks.research.run = swallowingResearch(3)
    const r = await evaluate(budgetOf(100).budget)
    expect(r.failure).toBeNull()
    expect(r.deep).toBe('done')
    expect(r.result?.classification).toBe('cold')
    expect(geminiCallStats()).toMatchObject({ blocked: 0, failed: 0 })
  })

  it('a company the screen does not flag makes no Gemini call at all', async () => {
    const fetchMock = vi.fn(async () => okAnswer())
    vi.stubGlobal('fetch', fetchMock)
    mocks.enriched.hasProductSchema = false
    mocks.research.run = swallowingResearch(3)
    const r = await evaluate(budgetOf(100).budget)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.tier).toBe('screen')
  })
})

describe('everything else is unchanged', () => {
  it('a Gemini failure outside a Warm Leads budget throws the same error as before and uses the shared key', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(new URL(url).searchParams.get('key') ?? '')
      return answer(403, { error: { message: 'API key not valid.' } })
    }))
    const { GeminiGateway } = await import('../../src/llm/gemini/geminiGateway.js')
    await expect(new GeminiGateway().generate({ promptKey: 'k', variables: {}, feature: 'f' } as never)).rejects.toThrow(/API key not valid.*tried \d+ model/)
    expect(new Set(seen)).toEqual(new Set([SHARED]))
  })

  it('the failure counter is bookkeeping only: ceiling refusals are counted as refusals, not as failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okAnswer()))
    mocks.research.run = swallowingResearch(4)
    await evaluate(budgetOf(1).budget)
    expect(geminiCallStats().failed).toBe(0)
    expect(geminiCallStats().blocked).toBeGreaterThan(0)
  })
})
