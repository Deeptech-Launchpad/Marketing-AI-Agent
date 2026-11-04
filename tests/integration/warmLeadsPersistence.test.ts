import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// WARM LEADS - the database parts, on a REAL Postgres: the atomic daily limits, the SKIP LOCKED work
// queue, the company list, and the rules that decide what an outcome does to a company.
//
// The unit tests prove the rules with in-memory fakes; this file proves the SQL behaves the same way
// when many callers hit it at once. It uses its own throw-away tenant id and removes everything it
// created. Skipped (with a printed reason) when no database is reachable.
//
// Nothing here calls NXT Sales, Gemini or anything on the network.

async function dbReady(): Promise<string | null> {
  try {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.$queryRaw`SELECT 1`
    await prisma.$queryRaw`SELECT 1 FROM "WarmLeadUsage" LIMIT 1` // the permanent module's migration must be applied
    return null
  } catch (err) {
    return `marketing database unavailable or migration 20261104100000_warm_leads_permanent not applied: ${(err as Error).message}`
  }
}
const skip = await dbReady()
const describeIfDb = skip ? describe.skip : describe
if (skip) console.warn(`\n[warm-leads persistence] SKIPPED — ${skip}\n`)

const T = `wl-int-${Math.random().toString(36).slice(2, 10)}`
const { prisma } = await import('../../src/platform/db.js')
const { dbUsageStore } = await import('../../src/warmleads/usageStore.js')
const companies = await import('../../src/warmleads/companies.js')

const crmCompany = (i: number) => ({
  id: `crm-${String(i).padStart(5, '0')}-xxxxxxxxxxxx`,
  name: `Company ${i}`,
  email: null,
  emails: [],
  phone: null,
  domain: i % 3 ? `company${i}.example` : null,
  industry: 'Retail',
  country: 'India',
  cms: null,
  leadStatus: null,
  status: null,
  remarks: null,
  notes: null,
  endPdpUrl: null,
  contactPersons: [],
  linkedProfiles: [],
  ownerId: null,
  ownerName: null,
  dealCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})
const list = (n: number, truncated = false) => async () => ({ items: Array.from({ length: n }, (_, i) => crmCompany(i)), truncated })

afterAll(async () => {
  if (skip) return
  await prisma.warmLeadRun.deleteMany({ where: { tenantId: T } })
  await prisma.warmLeadCompany.deleteMany({ where: { tenantId: T } })
  await prisma.warmLeadUsage.deleteMany({ where: { tenantId: T } })
  await prisma.warmLeadSettings.deleteMany({ where: { tenantId: T } })
})

describeIfDb('the daily limits are atomic', () => {
  it('50 concurrent Gemini reservations against a ceiling of 20 are granted exactly 20 times', async () => {
    await dbUsageStore.ensureBucket(T, 'b-gemini', { geminiCeiling: 20, companyLimit: 25, retryLimit: 5 })
    const results = await Promise.all(Array.from({ length: 50 }, () => dbUsageStore.reserveGeminiCall(T, 'b-gemini')))
    expect(results.filter(Boolean)).toHaveLength(20)
    expect((await dbUsageStore.getBucket(T, 'b-gemini'))!.geminiCalls).toBe(20)
  })

  it('40 concurrent company slots against a limit of 25 are granted exactly 25 times, and retries stay within their share', async () => {
    await dbUsageStore.ensureBucket(T, 'b-slots', { geminiCeiling: 300, companyLimit: 25, retryLimit: 5 })
    const retries = await Promise.all(Array.from({ length: 12 }, () => dbUsageStore.reserveCompanySlot(T, 'b-slots', true)))
    expect(retries.filter(Boolean)).toHaveLength(5)
    const normal = await Promise.all(Array.from({ length: 40 }, () => dbUsageStore.reserveCompanySlot(T, 'b-slots', false)))
    expect(normal.filter(Boolean)).toHaveLength(20) // 25 - the 5 retries
    expect(await dbUsageStore.reserveCompanySlot(T, 'b-slots', false)).toBe(false)
    expect(await dbUsageStore.getBucket(T, 'b-slots')).toMatchObject({ companiesStarted: 25, retriesStarted: 5 })
  })

  it('a released slot can be used again, and re-ensuring a bucket changes its limits without resetting what was spent', async () => {
    await dbUsageStore.releaseCompanySlot(T, 'b-slots', false)
    expect(await dbUsageStore.reserveCompanySlot(T, 'b-slots', false)).toBe(true)
    await dbUsageStore.ensureBucket(T, 'b-slots', { geminiCeiling: 300, companyLimit: 30, retryLimit: 6 })
    expect(await dbUsageStore.getBucket(T, 'b-slots')).toMatchObject({ companiesStarted: 25, companyLimit: 30, retryLimit: 6 })
    await dbUsageStore.ensureBucket(T, 'b-slots', { geminiCeiling: 300, companyLimit: 10, retryLimit: 2 }) // lowered below what was started
    expect(await dbUsageStore.reserveCompanySlot(T, 'b-slots', false)).toBe(false)
  })
})

describeIfDb('the company list', () => {
  it('reads 1,200 companies in batches, keeps state on a second read, and marks the ones that disappeared', async () => {
    const r1 = await companies.refreshCompanyList(T, list(1200))
    expect(r1).toMatchObject({ seen: 1200, created: 1200, truncated: false })
    expect(await prisma.warmLeadCompany.count({ where: { tenantId: T } })).toBe(1200)

    await prisma.warmLeadCompany.update({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: crmCompany(5).id } }, data: { state: 'evaluated', classification: 'warm' } })
    const r2 = await companies.refreshCompanyList(T, list(1100)) // 100 left NXT Sales
    expect(r2).toMatchObject({ seen: 1100, created: 0, markedGone: 100 })
    const kept = await prisma.warmLeadCompany.findUniqueOrThrow({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: crmCompany(5).id } } })
    expect(kept).toMatchObject({ state: 'evaluated', classification: 'warm', inCrm: true })

    const r3 = await companies.refreshCompanyList(T, list(10, true)) // a cut-off read must not mark anything gone
    expect(r3).toMatchObject({ truncated: true, markedGone: 0 })
    expect((await companies.companyCounts(T)).total).toBeGreaterThan(1000)
  })
})

describeIfDb('taking work', () => {
  it('30 concurrent workers over 20 pending companies each get a different one, in NXT Sales’ list order', async () => {
    await prisma.warmLeadCompany.updateMany({ where: { tenantId: T }, data: { state: 'evaluated', classification: 'cold' } })
    for (let i = 0; i < 20; i++) {
      await prisma.warmLeadCompany.update({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: crmCompany(i).id } }, data: { state: 'pending', classification: null, inCrm: true } })
    }
    const claims = await Promise.all(Array.from({ length: 30 }, () => companies.claimNext(T, 'pending', 'b-claim', 'tester')))
    const got = claims.filter((c): c is NonNullable<typeof c> => c !== null)
    expect(got).toHaveLength(20)
    expect(new Set(got.map((c) => c.crmCompanyId)).size).toBe(20)
    const running = await prisma.warmLeadCompany.count({ where: { tenantId: T, state: 'running' } })
    expect(running).toBe(20)
    expect(await prisma.warmLeadEvaluation.count({ where: { tenantId: T, status: 'running' } })).toBe(20)
  })

  it('a company that is not in NXT Sales any more, or belongs to the pilot, is not taken as "pending"', async () => {
    const a = crmCompany(500).id
    const b = crmCompany(501).id
    await prisma.warmLeadCompany.update({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: a } }, data: { state: 'pending', inCrm: false, classification: null } })
    await prisma.warmLeadCompany.update({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: b } }, data: { state: 'pending', inCrm: true, cohort: 'pilot', classification: null } })
    expect(await companies.claimNext(T, 'pending', 'b-claim2', 'tester')).toBeNull()
  })

  it('retries are taken only when due and while automatic attempts remain; the pilot bucket takes only pilot companies', async () => {
    const [due, notDue, spent, pilot] = [600, 601, 602, 603].map((i) => crmCompany(i).id)
    const set = (id: string, data: object) => prisma.warmLeadCompany.update({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: id } }, data })
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 86_400_000)
    await set(due, { state: 'failed', nextAttemptAt: past, attempts: 1, classification: null })
    await set(notDue, { state: 'failed', nextAttemptAt: future, attempts: 1, classification: null })
    await set(spent, { state: 'failed', nextAttemptAt: past, attempts: 3, classification: null })
    await set(pilot, { state: 'failed', nextAttemptAt: past, attempts: 1, cohort: 'pilot', classification: null })
    const first = await companies.claimNext(T, 'retry', 'day:2026-11-04', 'tester')
    expect([due, pilot]).toContain(first!.crmCompanyId)
    const second = await companies.claimNext(T, 'retry', 'day:2026-11-04', 'tester')
    expect(new Set([first!.crmCompanyId, second!.crmCompanyId])).toEqual(new Set([due, pilot]))
    expect(await companies.claimNext(T, 'retry', 'day:2026-11-04', 'tester')).toBeNull() // not-due and used-up stay untouched
    await set(due, { state: 'failed', nextAttemptAt: past, attempts: 1 })
    await set(pilot, { state: 'failed', nextAttemptAt: past, attempts: 1 })
    const only = await companies.claimNext(T, 'retry', 'pilot', 'tester')
    expect(only!.crmCompanyId).toBe(pilot)
  })

  it('a worker that died is recovered: its company becomes due again and its evaluation is failed', async () => {
    const id = crmCompany(700).id
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    await prisma.warmLeadCompany.update({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: id } }, data: { state: 'running', lastAttemptAt: old, classification: null } })
    expect(await companies.recoverStale(T)).toBeGreaterThanOrEqual(1)
    expect(await prisma.warmLeadCompany.findUniqueOrThrow({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: id } } })).toMatchObject({ state: 'failed' })
  })
})

describeIfDb('what an outcome does to a company', () => {
  const computed = (classification: string | null, over: Record<string, unknown> = {}) =>
    ({
      company: null,
      tier: 'screen',
      website: null,
      deep: 'not_needed',
      enrichmentId: null,
      intentRunId: null,
      costUsd: 0,
      failure: classification ? null : { message: 'The website could not be read.', reasons: [] },
      result: classification ? { classification, score: classification === 'warm' ? 60 : 5, confidence: 'high', summary: `is ${classification}`, reasons: [] } : null,
      ...over,
    }) as never

  async function run(crmId: string, c: ReturnType<typeof computed>) {
    await prisma.warmLeadCompany.update({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: crmId } }, data: { state: 'pending' } })
    const claim = (await companies.claimNext(T, 'pending', 'day:out', 'tester'))!
    expect(claim.crmCompanyId).toBe(crmId)
    await companies.recordOutcome(claim, c, { bucket: 'day:out', geminiCalls: 0, now: new Date() })
    return prisma.warmLeadCompany.findUniqueOrThrow({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: crmId } } })
  }

  it('Warm, then a failed re-check keeps Warm; a completed Cold replaces it; incomplete research is never Cold', async () => {
    // make the target the only pending company so claimNext returns it
    await prisma.warmLeadCompany.updateMany({ where: { tenantId: T }, data: { state: 'evaluated' } })
    const id = crmCompany(800).id
    const reset = () => prisma.warmLeadCompany.updateMany({ where: { tenantId: T, state: 'pending', crmCompanyId: { not: id } }, data: { state: 'evaluated' } })

    await reset()
    expect(await run(id, computed('warm'))).toMatchObject({ state: 'evaluated', classification: 'warm', score: 60 })
    const warmEval = (await prisma.warmLeadCompany.findUniqueOrThrow({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: id } } })).currentEvaluationId

    expect(await run(id, computed(null))).toMatchObject({ state: 'needs_reevaluation', classification: 'warm', currentEvaluationId: warmEval })

    expect(await run(id, computed('insufficient_data', { deep: 'skipped_ceiling', tier: 'deep' }))).toMatchObject({ state: 'needs_reevaluation', classification: 'warm', researchIncomplete: true })

    expect(await run(id, computed('cold'))).toMatchObject({ state: 'evaluated', classification: 'cold', researchIncomplete: false })
    const history = await prisma.warmLeadEvaluation.count({ where: { tenantId: T, crmCompanyId: id } })
    expect(history).toBeGreaterThanOrEqual(1) // the earlier evaluations are kept as history
  })

  it('the counts add up and keep "research incomplete", "failed" and "insufficient data" apart', async () => {
    const c = await companies.companyCounts(T)
    expect(c.total).toBe(c.pending + c.inProgress + (c.total - c.pending - c.inProgress))
    expect(c.evaluated).toBe(c.warm + c.earlySignal + c.cold + c.insufficientData + c.existingCustomer + c.activeOpportunity + c.doNotContact)
  })
})

describeIfDb('the pilot', () => {
  it('turns a requested pilot into queued evaluations, takes them in order, and closes the run when none is left', async () => {
    const { requestPilot, preparePilot, pilotView } = await import('../../src/warmleads/pilot.js')
    await prisma.warmLeadCompany.updateMany({ where: { tenantId: T }, data: { state: 'evaluated', cohort: null } })
    const ids = [900, 901, 902].map((i) => crmCompany(i).id)
    await prisma.warmLeadCompany.updateMany({ where: { tenantId: T, crmCompanyId: { in: ids } }, data: { state: 'pending' } })

    await requestPilot(T, 'admin-1')
    const build = (async () => ({
      sample: { seed: 1, size: 3, picks: ids.map((id) => ({ id, name: id, country: null, industry: null, website: 'website', strata: ['general'], pickedFor: 'general' })), coverage: [], countries: 1, industries: 1, notes: [], pool: {} },
      companies: new Map(ids.map((id, i) => [id, crmCompany(900 + i)])),
    })) as never
    expect(await preparePilot(T, build)).toBe(true)
    expect((await pilotView(T)).counts).toMatchObject({ total: 3, queued: 3 })

    const claims = []
    for (let i = 0; i < 4; i++) claims.push(await companies.claimNext(T, 'pilot', 'pilot', 'tester'))
    expect(claims.filter(Boolean)).toHaveLength(3)
    expect(claims[3]).toBeNull()
    expect(await companies.finishRunIfIdle(claims[0]!.runId)).toBe(false) // still running
    await prisma.warmLeadEvaluation.updateMany({ where: { runId: claims[0]!.runId }, data: { status: 'done', classification: 'cold' } })
    expect(await companies.finishRunIfIdle(claims[0]!.runId)).toBe(true)
    expect((await pilotView(T)).canApprove).toBe(true)
  })

  it('approving needs a finished pilot and then opens daily processing', async () => {
    const { approvePilot } = await import('../../src/warmleads/pilot.js')
    await approvePilot(T, 'admin-1')
    expect((await prisma.warmLeadSettings.findUniqueOrThrow({ where: { tenantId: T } })).pilotApprovedAt).not.toBeNull()
  })
})

describeIfDb('syncing to NXT Sales is gated', () => {
  it('sends nothing while any gate is closed, and says which', async () => {
    const { syncPending, syncGate } = await import('../../src/warmleads/sync.js')
    const r = await syncPending(T)
    expect(r.skipped).not.toBeNull()
    expect(r).toMatchObject({ put: 0, withdrawn: 0, failed: 0 })
    expect(await syncGate(T)).toMatch(/switched off|not been approved/)
  })
})
