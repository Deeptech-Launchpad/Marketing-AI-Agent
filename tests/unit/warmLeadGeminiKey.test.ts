import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../src/config/env.js'
import { requireGeminiBudget, withGeminiBudget } from '../../src/llm/gemini/budgetContext.js'
import { geminiCallStats, resetGeminiCallStatsForTests } from '../../src/llm/gemini/callCeiling.js'
import { GeminiKeyMissingError, resolveGeminiApiKey, warmLeadsKeyProblem } from '../../src/llm/gemini/apiKey.js'
import { bucketBudget, newTally } from '../../src/warmleads/budget.js'
import type { UsageStore } from '../../src/warmleads/usageStore.js'

// WARM LEADS HAS A GEMINI KEY OF ITS OWN.
//
// Calls inside a Warm Leads budget use WARM_LEADS_GEMINI_API_KEY (a separate Google project); every other call in
// the application keeps using GEMINI_API_KEY. A Warm Leads call without a usable dedicated key is refused BEFORE a
// reservation is made and BEFORE anything is sent. The values below are made-up placeholders, not real keys.

vi.mock('../../src/platform/db.js', () => ({ prisma: {}, newId: () => 'id' }))
const { GeminiGateway } = await import('../../src/llm/gemini/geminiGateway.js')

const SHARED = 'shared-key-placeholder-AAAA'
const DEDICATED = 'warm-leads-key-placeholder-BBBB'

const saved = { shared: env.GEMINI_API_KEY, own: env.WARM_LEADS_GEMINI_API_KEY, driver: env.LLM_DRIVER }

function fakeStore(): { store: UsageStore; reserved: () => number } {
  let n = 0
  return { store: { reserveGeminiCall: async () => { n++; return true } } as unknown as UsageStore, reserved: () => n }
}
const warmLeadsBudget = (store: UsageStore) => bucketBudget(store, 't', 'b', 100, newTally())

/** Records the key= parameter of every request the gateway makes. */
function stubFetch() {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    seen.push(new URL(url).searchParams.get('key') ?? '')
    return new Response('{}', { status: 200 })
  }))
  return seen
}

beforeEach(() => {
  env.GEMINI_API_KEY = SHARED
  env.WARM_LEADS_GEMINI_API_KEY = DEDICATED
  env.LLM_DRIVER = 'real'
  resetGeminiCallStatsForTests()
})
afterEach(() => {
  env.GEMINI_API_KEY = saved.shared
  env.WARM_LEADS_GEMINI_API_KEY = saved.own
  env.LLM_DRIVER = saved.driver
  requireGeminiBudget(false)
  resetGeminiCallStatsForTests()
  vi.unstubAllGlobals()
})

describe('which key a call uses', () => {
  it('a call inside a Warm Leads budget is sent with the dedicated key, and never the shared one', async () => {
    const seen = stubFetch()
    const { store } = fakeStore()
    const r = await withGeminiBudget(warmLeadsBudget(store), () => new GeminiGateway().health())
    expect(r.ok).toBe(true)
    expect(seen).toEqual([DEDICATED])
    expect(seen).not.toContain(SHARED)
  })

  it('a call outside a budget (every other feature) still uses the shared key, exactly as before', async () => {
    const seen = stubFetch()
    expect((await new GeminiGateway().health()).ok).toBe(true)
    expect(seen).toEqual([SHARED])
  })

  it('both at the same time stay separate: concurrent Warm Leads and other calls never swap keys', async () => {
    const seen = stubFetch()
    const { store } = fakeStore()
    const g = new GeminiGateway()
    await Promise.all([
      ...Array.from({ length: 6 }, () => withGeminiBudget(warmLeadsBudget(store), () => g.health())),
      ...Array.from({ length: 6 }, () => g.health()),
    ])
    expect(seen.filter((k) => k === DEDICATED)).toHaveLength(6)
    expect(seen.filter((k) => k === SHARED)).toHaveLength(6)
  })

  it('a budget that is not a Warm Leads one does not switch keys', async () => {
    const plain = { reserve: async () => undefined }
    await expect(withGeminiBudget(plain, async () => resolveGeminiApiKey())).resolves.toBe(SHARED)
  })
})

describe('without a usable dedicated key, Warm Leads fails safely', () => {
  for (const [name, own] of [['empty', ''], ['blank', '   ']] as const) {
    it(`${name}: nothing is sent, nothing is reserved, and the shared key is not used`, async () => {
      env.WARM_LEADS_GEMINI_API_KEY = own
      const seen = stubFetch()
      const { store, reserved } = fakeStore()
      const tally = newTally()
      const budget = bucketBudget(store, 't', 'b', 100, tally)
      const r = await withGeminiBudget(budget, () => new GeminiGateway().health())
      expect(r.ok).toBe(false)
      expect(r.detail).toMatch(/no Gemini key of its own/)
      expect(seen).toEqual([]) // no request at all, with either key
      expect(reserved()).toBe(0) // the daily allowance was not used up
      expect(tally.calls).toBe(0)
      expect(geminiCallStats().attempted).toBe(0)
    })
  }

  it('the error is a GeminiKeyMissingError and its message carries no key', async () => {
    env.WARM_LEADS_GEMINI_API_KEY = ''
    const err = await withGeminiBudget(warmLeadsBudget(fakeStore().store), async () => resolveGeminiApiKey()).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(GeminiKeyMissingError)
    expect(err!.message).not.toContain(SHARED)
    expect(err!.message).not.toContain(DEDICATED)
  })

  it('set to the same value as the shared key is refused too: it would not be a separate project', async () => {
    env.WARM_LEADS_GEMINI_API_KEY = SHARED
    const seen = stubFetch()
    const r = await withGeminiBudget(warmLeadsBudget(fakeStore().store), () => new GeminiGateway().health())
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/same as the shared/)
    expect(seen).toEqual([])
  })

  it('a missing dedicated key does not stop the other features: they keep working on the shared key', async () => {
    env.WARM_LEADS_GEMINI_API_KEY = ''
    const seen = stubFetch()
    expect((await new GeminiGateway().health()).ok).toBe(true)
    expect(seen).toEqual([SHARED])
  })

  it('the Warm Leads worker process, which allows only budgeted calls, cannot reach the shared key by leaving the budget', async () => {
    requireGeminiBudget(true)
    const seen = stubFetch()
    const r = await new GeminiGateway().health() // outside any budget
    expect(r.ok).toBe(false)
    expect(seen).toEqual([])
  })
})

describe('the readiness check the worker and the screen use', () => {
  it('reports the problem in a sentence (no key) when the driver is real, and nothing when it is fine', () => {
    expect(warmLeadsKeyProblem()).toBeNull()
    env.WARM_LEADS_GEMINI_API_KEY = ''
    expect(warmLeadsKeyProblem()).toMatch(/WARM_LEADS_GEMINI_API_KEY is empty/)
    env.WARM_LEADS_GEMINI_API_KEY = SHARED
    expect(warmLeadsKeyProblem()).toMatch(/same as the shared/)
  })

  it('needs no key when no real request can be made (fake driver)', () => {
    env.LLM_DRIVER = 'fake'
    env.WARM_LEADS_GEMINI_API_KEY = ''
    expect(warmLeadsKeyProblem()).toBeNull()
  })

  it('the worker tick returns before reading the list or claiming anything when the key is missing (source order)', () => {
    const src = readFileSync(path.resolve('src/warmleads/workerLoop.ts'), 'utf8')
    const tick = src.slice(src.indexOf('export async function tickTenant'))
    const check = tick.indexOf('warmLeadsKeyProblem()')
    expect(check).toBeGreaterThan(0)
    for (const step of ['handleListRefresh(tenantId)', 'preparePilot(tenantId)', 'runCycle(', 'syncPending(']) {
      expect(check, `the key check must come before ${step}`).toBeLessThan(tick.indexOf(step))
    }
  })

  it('Start is refused while the key is unusable (source)', () => {
    const src = readFileSync(path.resolve('src/warmleads/settings.ts'), 'utf8')
    expect(src).toMatch(/warmLeadsKeyProblem\(\)[\s\S]{0,200}ConflictError/)
  })
})

describe('nothing else can read the shared key around the rule', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('only the key resolver reads GEMINI_API_KEY for requests: the gateway has no direct use of it', () => {
    const gw = strip(readFileSync(path.resolve('src/llm/gemini/geminiGateway.ts'), 'utf8'))
    expect(gw).not.toMatch(/env\.GEMINI_API_KEY/)
    expect(gw).not.toMatch(/env\.WARM_LEADS_GEMINI_API_KEY/)
    expect((gw.match(/resolveGeminiApiKey\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2) // post() and health()
  })

  it('no source file other than the resolver, the config and the usage screen reads either key', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) walk(f)
        else if (f.endsWith('.ts')) files.push(f)
      }
    }
    walk(path.resolve('src'))
    const readers = files
      .filter((f) => /env\.(WARM_LEADS_)?GEMINI_API_KEY/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(process.cwd(), f).split(path.sep).join('/'))
      .sort()
    expect(readers).toEqual(['src/api/routes/usage.routes.ts', 'src/config/env.ts', 'src/llm/gemini/apiKey.ts'])
  })

  it('the Warm Leads budget is the one that selects the dedicated key, and the key name is redacted from logs', () => {
    expect(bucketBudget(fakeStore().store, 't', 'b', 1, newTally()).keyScope).toBe('warm-leads')
    expect(readFileSync(path.resolve('src/platform/logger.ts'), 'utf8')).toContain("'WARM_LEADS_GEMINI_API_KEY'")
  })

  it('no real-looking key is committed in the example config', () => {
    const example = readFileSync(path.resolve('.env.example'), 'utf8')
    expect(example).toMatch(/^WARM_LEADS_GEMINI_API_KEY=""\s*$/m)
    expect(example).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/)
  })
})
