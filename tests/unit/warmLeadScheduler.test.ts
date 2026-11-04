import { describe, expect, it } from 'vitest'
import type { Claim, StoredOutcome, WorkKind } from '../../src/warmleads/companies.js'
import { runCycle, retryTurn, type CycleDeps, type CycleSettings, type EvaluatedClaim } from '../../src/warmleads/scheduler.js'
import type { ComputedEvaluation } from '../../src/warmleads/service.js'
import type { BucketLimits, BucketUsage, ProgressDelta, UsageStore } from '../../src/warmleads/usageStore.js'
import { deepResearchAllowed } from '../../src/warmleads/scheduler.js'

// The processing cycle, against an in-memory store that behaves like the database's
// conditional UPDATEs (a unit is granted only while the counter is below its limit).

const IN_WINDOW = new Date('2026-11-04T20:00:00Z') // 01:30 IST on 5 Nov = the night of 4 Nov
const BUCKET = 'day:2026-11-04'

const baseSettings = (over: Partial<CycleSettings> = {}): CycleSettings => ({
  paused: false,
  dailyCompanyLimit: 25,
  dailyGeminiCeiling: 300,
  pilotSize: 100,
  pilotGeminiCeiling: 1200,
  retryShare: 20,
  windowStart: '23:00',
  windowEnd: '06:00',
  timezone: 'Asia/Kolkata',
  pilotApprovedAt: new Date('2026-11-01T00:00:00Z'),
  ...over,
})

class MemoryUsage implements UsageStore {
  rows = new Map<string, BucketUsage>()
  async ensureBucket(_t: string, bucket: string, l: BucketLimits) {
    const r = this.rows.get(bucket) ?? { bucket, geminiCalls: 0, companiesStarted: 0, retriesStarted: 0, screened: 0, deepResearched: 0, completed: 0, failed: 0, incomplete: 0, pricedCostUsd: 0, unpricedCalls: 0, stoppedReason: null, ...l }
    Object.assign(r, l)
    this.rows.set(bucket, r)
  }
  async reserveGeminiCall(_t: string, bucket: string) {
    const r = this.rows.get(bucket)!
    if (r.geminiCalls >= r.geminiCeiling) return false
    r.geminiCalls++
    return true
  }
  async reserveCompanySlot(_t: string, bucket: string, retry: boolean) {
    const r = this.rows.get(bucket)!
    if (r.companiesStarted >= r.companyLimit || (retry && r.retriesStarted >= r.retryLimit)) return false
    r.companiesStarted++
    if (retry) r.retriesStarted++
    return true
  }
  async releaseCompanySlot(_t: string, bucket: string, retry: boolean) {
    const r = this.rows.get(bucket)!
    r.companiesStarted = Math.max(0, r.companiesStarted - 1)
    if (retry) r.retriesStarted = Math.max(0, r.retriesStarted - 1)
  }
  async getBucket(_t: string, bucket: string) {
    const r = this.rows.get(bucket)
    return r ? { ...r } : null
  }
  async addProgress(_t: string, bucket: string, d: ProgressDelta) {
    const r = this.rows.get(bucket)!
    r.screened += d.screened ?? 0
    r.deepResearched += d.deepResearched ?? 0
    r.completed += d.completed ?? 0
    r.failed += d.failed ?? 0
    r.incomplete += d.incomplete ?? 0
    r.pricedCostUsd += d.pricedCostUsd ?? 0
    r.unpricedCalls += d.unpricedCalls ?? 0
  }
  async setStopped(_t: string, bucket: string, reason: string | null) {
    const r = this.rows.get(bucket)
    if (r) r.stoppedReason = reason
  }
}

interface World {
  pending: string[]
  retry: string[]
  pilot: string[]
  processed: string[]
  claims: Claim[]
}

const computed = (over: Partial<ComputedEvaluation> = {}): ComputedEvaluation => ({
  company: null,
  tier: 'screen',
  website: null,
  deep: 'not_needed',
  enrichmentId: null,
  intentRunId: null,
  costUsd: 0,
  failure: null,
  result: null,
  ...over,
})

function setup(opts: {
  settings?: () => CycleSettings
  world?: Partial<World>
  deps?: Partial<CycleDeps>
  /** Companies (by id) whose evaluation needs the paid research, and how many calls it takes. */
  deep?: Map<string, number>
  usage?: MemoryUsage
  now?: () => Date
} = {}) {
  const usage = opts.usage ?? new MemoryUsage()
  const world: World = { pending: Array.from({ length: 100 }, (_, i) => `p${i}`), retry: [], pilot: [], processed: [], claims: [], ...opts.world }
  const settings = opts.settings ?? (() => baseSettings())
  let seq = 0
  const deps: CycleDeps = {
    tenantId: 't1',
    now: opts.now ?? (() => IN_WINDOW),
    workerEnabled: () => true,
    availableMb: () => 8000,
    stopBelowMb: 3072,
    startMarginMb: 1024,
    loadSettings: async () => settings(),
    usage,
    recoverStale: async () => 0,
    claim: async (kind: WorkKind) => {
      await Promise.resolve() // yield, so two workers really interleave
      const list = kind === 'pilot' ? world.pilot : kind === 'retry' ? world.retry : world.pending
      const id = list.shift()
      if (!id) return null
      const c: Claim = { companyRowId: `row-${id}`, crmCompanyId: id, evaluationId: `ev-${++seq}`, runId: 'run', kind, attempts: 1 }
      world.claims.push(c)
      return c
    },
    evaluate: async (claim, ctx): Promise<EvaluatedClaim> => {
      const need = opts.deep?.get(claim.crmCompanyId)
      if (need === undefined) return { computed: computed(), geminiCalls: 0, pricedCostUsd: 0, unpricedCalls: 0 }
      // The paid research: only started when a whole research fits in what is left; each call is reserved first.
      const used = (await usage.getBucket('t1', ctx.bucket))!
      if (!deepResearchAllowed(used)) return { computed: computed({ tier: 'deep', deep: 'skipped_ceiling' }), geminiCalls: 0, pricedCostUsd: 0, unpricedCalls: 0 }
      let calls = 0
      for (let i = 0; i < need; i++) {
        if (!(await usage.reserveGeminiCall('t1', ctx.bucket))) return { computed: computed({ tier: 'deep', deep: 'skipped_ceiling' }), geminiCalls: calls, pricedCostUsd: 0, unpricedCalls: 0 }
        calls++
      }
      return { computed: computed({ tier: 'deep', deep: 'done' }), geminiCalls: calls, pricedCostUsd: calls * 0.01, unpricedCalls: 0 }
    },
    record: async (claim, e): Promise<StoredOutcome> => {
      world.processed.push(claim.crmCompanyId)
      const incomplete = e.computed.deep === 'skipped_ceiling'
      return { state: incomplete ? 'needs_reevaluation' : 'evaluated', classification: incomplete ? null : 'cold', researchIncomplete: incomplete, failed: false }
    },
    afterPilotEvaluation: async () => undefined,
    log: () => undefined,
    ...opts.deps,
  }
  return { deps, usage, world }
}

describe('when the cycle does nothing', () => {
  it('worker off, paused, outside the window - and it claims nothing', async () => {
    for (const [why, over] of [
      ['worker_disabled', { deps: { workerEnabled: () => false } }],
      ['paused', { settings: () => baseSettings({ paused: true }) }],
      ['outside_window', { now: () => new Date('2026-11-04T06:00:00Z') }], // 11:30 IST
    ] as const) {
      const s = setup(over as never)
      const r = await runCycle(s.deps)
      expect(r.stoppedBecause).toBe(why)
      expect(s.world.claims).toHaveLength(0)
    }
  })

  it('does not start without 4 GB available, and a night in progress stops below 3 GB', async () => {
    const low = setup({ deps: { availableMb: () => 4095 } })
    expect((await runCycle(low.deps)).stoppedBecause).toBe('low_memory')
    expect(low.world.claims).toHaveLength(0)

    let mb = 8000
    const s = setup({ deps: { availableMb: () => mb } })
    const original = s.deps.record
    s.deps.record = async (c, e, x) => {
      const r = await original(c, e, x)
      if (s.world.processed.length === 3) mb = 3071 // memory drops after the third company
      return r
    }
    const r = await runCycle(s.deps)
    expect(r.stoppedBecause).toBe('low_memory')
    expect(r.processed).toBe(3)
  })
})

describe('the daily company limit', () => {
  it('stops after exactly 25 companies, sequentially', async () => {
    const s = setup()
    const r = await runCycle(s.deps)
    expect(r).toMatchObject({ stoppedBecause: 'company_limit', processed: 25, bucket: BUCKET })
    expect(s.world.processed).toHaveLength(25)
    expect(s.usage.rows.get(BUCKET)).toMatchObject({ companiesStarted: 25, screened: 25, completed: 25, stoppedReason: 'company_limit' })
  })

  it('a restart in the middle of the night continues with the remainder, never more than 25', async () => {
    const usage = new MemoryUsage()
    const world: Partial<World> = { pending: Array.from({ length: 100 }, (_, i) => `p${i}`), processed: [], claims: [] }
    let n = 0
    const first = setup({ usage, world, deps: { workerEnabled: () => n++ < 10 } }) // "crashes" after 10 companies
    await runCycle(first.deps)
    expect(first.world.processed.length).toBeLessThan(25)
    const done = first.world.processed.length
    const second = setup({ usage, world: first.world }) // a new process, same database and same pending list
    const r = await runCycle(second.deps)
    expect(r.stoppedBecause).toBe('company_limit')
    expect(second.world.processed.length).toBe(25)
    expect(new Set(second.world.processed).size).toBe(25)
    expect(done + r.processed).toBe(25)
  })

  it('two workers at once never start more than the limit, and never take the same company', async () => {
    const usage = new MemoryUsage()
    const world: World = { pending: Array.from({ length: 100 }, (_, i) => `p${i}`), retry: [], pilot: [], processed: [], claims: [] }
    const a = setup({ usage, world })
    const b = setup({ usage, world })
    const [ra, rb] = await Promise.all([runCycle(a.deps), runCycle(b.deps)])
    expect(ra.processed + rb.processed).toBe(25)
    expect(world.processed).toHaveLength(25)
    expect(new Set(world.processed).size).toBe(25)
    expect(usage.rows.get(BUCKET)!.companiesStarted).toBe(25)
  })

  it('an admin lowering the limit during the night takes effect before the next company', async () => {
    let limit = 25
    const s = setup({ settings: () => baseSettings({ dailyCompanyLimit: limit }) })
    const original = s.deps.record
    s.deps.record = async (c, e, x) => {
      const r = await original(c, e, x)
      if (s.world.processed.length === 5) limit = 8
      return r
    }
    const r = await runCycle(s.deps)
    expect(r.processed).toBe(8)
    expect(r.stoppedBecause).toBe('company_limit')
  })

  it('pausing during the night stops before the next company', async () => {
    let paused = false
    const s = setup({ settings: () => baseSettings({ paused }) })
    const original = s.deps.record
    s.deps.record = async (c, e, x) => {
      const r = await original(c, e, x)
      if (s.world.processed.length === 4) paused = true
      return r
    }
    const r = await runCycle(s.deps)
    expect(r).toMatchObject({ stoppedBecause: 'paused', processed: 4 })
  })

  it('when nothing is left it stops and gives the unused slot back', async () => {
    const s = setup({ world: { pending: ['a', 'b'] } })
    const r = await runCycle(s.deps)
    expect(r).toMatchObject({ stoppedBecause: 'nothing_to_do', processed: 2 })
    expect(s.usage.rows.get(BUCKET)!.companiesStarted).toBe(2)
  })

  it('the night ends at 06:00 and the next night has a fresh allowance', async () => {
    const usage = new MemoryUsage()
    const night1 = setup({ usage })
    await runCycle(night1.deps)
    const night2 = setup({ usage, now: () => new Date('2026-11-05T20:00:00Z'), world: { pending: Array.from({ length: 100 }, (_, i) => `q${i}`) } })
    const r = await runCycle(night2.deps)
    expect(r).toMatchObject({ bucket: 'day:2026-11-05', processed: 25 })
  })
})

describe('the Gemini ceiling', () => {
  it('stops safely when a research cannot finish, and that company is "research incomplete" - never classified', async () => {
    // Ceiling 30 and 12 calls per research: two researches fit (24); the third cannot start.
    const deep = new Map([['p0', 12], ['p1', 12], ['p2', 12], ['p3', 12]])
    const s = setup({ settings: () => baseSettings({ dailyGeminiCeiling: 30 }), deep })
    const r = await runCycle(s.deps)
    expect(r.stoppedBecause).toBe('gemini_ceiling')
    expect(r.incomplete).toBe(1)
    const u = s.usage.rows.get(BUCKET)!
    expect(u.geminiCalls).toBe(24)
    expect(u.geminiCalls).toBeLessThanOrEqual(u.geminiCeiling)
    expect(u).toMatchObject({ deepResearched: 3, completed: 2, incomplete: 1, stoppedReason: 'gemini_ceiling' })
    expect(s.world.processed).toEqual(['p0', 'p1', 'p2']) // p3 was never started
  })

  it('never goes past the ceiling, whatever the research needs', async () => {
    const deep = new Map(Array.from({ length: 50 }, (_, i) => [`p${i}`, 7] as [string, number]))
    const s = setup({ settings: () => baseSettings({ dailyGeminiCeiling: 40 }), deep })
    await runCycle(s.deps)
    expect(s.usage.rows.get(BUCKET)!.geminiCalls).toBeLessThanOrEqual(40)
  })

  it('a ceiling of 0 means no Gemini research: the first company that needs it is incomplete and the night stops', async () => {
    const s = setup({ settings: () => baseSettings({ dailyGeminiCeiling: 0 }), deep: new Map([['p1', 12]]) })
    const r = await runCycle(s.deps)
    expect(r.stoppedBecause).toBe('gemini_ceiling')
    expect(s.usage.rows.get(BUCKET)!.geminiCalls).toBe(0)
  })

  it('companies that need no research are screened without spending a single call', async () => {
    const s = setup()
    await runCycle(s.deps)
    expect(s.usage.rows.get(BUCKET)!.geminiCalls).toBe(0)
  })

  it('the ceiling is shared by two workers: together they never exceed it', async () => {
    const usage = new MemoryUsage()
    const world: World = { pending: Array.from({ length: 100 }, (_, i) => `p${i}`), retry: [], pilot: [], processed: [], claims: [] }
    const deep = new Map(world.pending.map((id) => [id, 12] as [string, number]))
    const mk = () => setup({ usage, world, deep, settings: () => baseSettings({ dailyGeminiCeiling: 100 }) })
    await Promise.all([runCycle(mk().deps), runCycle(mk().deps)])
    expect(usage.rows.get(BUCKET)!.geminiCalls).toBeLessThanOrEqual(100)
  })
})

describe('retries', () => {
  it('every fifth company is a retry while the retry share lasts (20% of 25 = 5)', async () => {
    const s = setup({ world: { retry: Array.from({ length: 20 }, (_, i) => `r${i}`) } })
    await runCycle(s.deps)
    const retries = s.world.claims.filter((c) => c.kind === 'retry')
    expect(retries).toHaveLength(5)
    expect(s.world.claims.filter((c) => c.kind === 'pending')).toHaveLength(20)
    expect(s.usage.rows.get(BUCKET)!.retriesStarted).toBe(5)
    expect([retryTurn(0, 20), retryTurn(3, 20), retryTurn(4, 20), retryTurn(9, 20), retryTurn(4, 0)]).toEqual([false, false, true, true, false])
  })

  it('a night with nothing new still retries, up to the share', async () => {
    const s = setup({ world: { pending: [], retry: Array.from({ length: 20 }, (_, i) => `r${i}`) } })
    const r = await runCycle(s.deps)
    expect(r.processed).toBe(5)
  })
})

describe('the pilot (before it is approved)', () => {
  const pilotSettings = () => baseSettings({ pilotApprovedAt: null })
  it('uses the pilot bucket, its 100-company size and 1,200-call ceiling, and takes only pilot companies', async () => {
    const s = setup({ settings: pilotSettings, world: { pilot: Array.from({ length: 100 }, (_, i) => `pilot${i}`), pending: ['must-not-be-touched'] } })
    const r = await runCycle(s.deps)
    expect(r).toMatchObject({ bucket: 'pilot', processed: 100, stoppedBecause: 'company_limit' })
    expect(s.world.processed.every((id) => id.startsWith('pilot'))).toBe(true)
    expect(s.world.pending).toEqual(['must-not-be-touched'])
    expect(s.usage.rows.get('pilot')).toMatchObject({ geminiCeiling: 1200, companyLimit: 100 })
  })
  it('stops when the pilot is done, and daily companies are never started', async () => {
    const s = setup({ settings: pilotSettings, world: { pilot: ['a', 'b'] } })
    const r = await runCycle(s.deps)
    expect(r).toMatchObject({ stoppedBecause: 'nothing_to_do', processed: 2 })
  })
})

describe('errors', () => {
  it('a broken store stops the cycle instead of looping', async () => {
    let calls = 0
    const s = setup({
      deps: {
        record: async () => {
          calls++
          throw new Error('database unavailable')
        },
      },
    })
    const r = await runCycle(s.deps)
    expect(r.stoppedBecause).toBe('error')
    expect(calls).toBe(1)
  })
})
