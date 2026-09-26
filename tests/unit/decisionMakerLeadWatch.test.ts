import { beforeEach, describe, expect, it, vi } from 'vitest'

// NEW LEAD → DECISION-MAKER DISCOVERY, AND NO DUPLICATE SEARCHES.
//
// What must hold:
//   · a company created inside the lookback window, never searched, gets ONE
//     ordinary discovery run and one job — the same run the button queues;
//   · a company searched before, or created before the window, gets nothing;
//   · the per-check cap defers the rest, oldest first;
//   · the flag off means no CRM read and no search at all;
//   · while a search is in flight, asking again returns THAT run and no new job.

const env = {
  DM_AUTO_DISCOVER_ENABLED: true,
  DM_AUTO_DISCOVER_LOOKBACK_HOURS: 24,
  DM_AUTO_DISCOVER_MAX_PER_CHECK: 5,
  DEFAULT_TENANT_SLUG: 'altiusnxt',
  NXT_SALES_SERVICE_USER_ID: 'svc-user',
  // Read at import time by modules discovery.ts pulls in.
  NXT_SALES_MAX_CONCURRENCY: 4,
  GEMINI_MAX_CONCURRENCY: 2,
}
vi.mock('../../src/config/env.js', () => ({ env }))

const searchCompanies = vi.fn()
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ searchCompanies }) }))

const enqueue = vi.fn()
vi.mock('../../src/platform/queue.js', () => ({ enqueue, QUEUE_DM_DISCOVER: 'decisionmaker.discover' }))

const audit = vi.fn()
vi.mock('../../src/platform/audit.js', () => ({ audit }))

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

// The lock, the in-flight check and the insert, as the transaction sees them.
const tx = {
  $executeRaw: vi.fn(),
  decisionMakerRun: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}
const db = {
  // No DiscoveredCompany in these tests: every id is a CRM company.
  discoveredCompany: { findFirst: async () => null },
  tenant: { findUnique: vi.fn() },
  decisionMakerRun: { findMany: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
}
vi.mock('../../src/platform/db.js', () => ({ prisma: db, newId: () => `run_${Math.random().toString(36).slice(2, 8)}` }))

const { checkForNewLeads } = await import('../../src/decisionmakers/leadWatch.js')
const { queueDecisionMakerDiscovery } = await import('../../src/decisionmakers/discovery.js')

const NOW = new Date('2026-09-15T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const company = (id: string, createdAt: string) => ({ id, name: `Company ${id}`, createdAt })

beforeEach(() => {
  vi.clearAllMocks()
  env.DM_AUTO_DISCOVER_ENABLED = true
  env.DM_AUTO_DISCOVER_MAX_PER_CHECK = 5
  db.tenant.findUnique.mockResolvedValue({ id: 't1' })
  db.decisionMakerRun.findMany.mockResolvedValue([])
  tx.decisionMakerRun.findFirst.mockResolvedValue(null)
  tx.decisionMakerRun.create.mockResolvedValue({})
  tx.decisionMakerRun.updateMany.mockResolvedValue({ count: 0 })
  db.decisionMakerRun.update.mockResolvedValue({})
  enqueue.mockResolvedValue(undefined)
})

describe('the new-lead check', () => {
  it('queues one ordinary search for a new, never-searched lead', async () => {
    searchCompanies.mockResolvedValue({ items: [company('new1', hoursAgo(2))] })
    const result = await checkForNewLeads(NOW)

    expect(result.queued.map((q) => q.crmCompanyId)).toEqual(['new1'])
    expect(tx.decisionMakerRun.create).toHaveBeenCalledTimes(1)
    const created = tx.decisionMakerRun.create.mock.calls[0]![0].data
    expect(created).toMatchObject({ tenantId: 't1', crmCompanyId: 'new1', status: 'queued', requestedByCrmUserId: 'svc-user' })
    expect(enqueue).toHaveBeenCalledWith('decisionmaker.discover', { dmRunId: created.id })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'system', action: 'decision_makers.auto_queued' }))
  })

  it('ignores companies created before the lookback window', async () => {
    searchCompanies.mockResolvedValue({ items: [company('old', hoursAgo(30)), company('bad', 'not a date')] })
    const result = await checkForNewLeads(NOW)
    expect(result.newLeads).toBe(0)
    expect(tx.decisionMakerRun.create).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('never searches a lead that has been searched before', async () => {
    searchCompanies.mockResolvedValue({ items: [company('seen', hoursAgo(1)), company('fresh', hoursAgo(1))] })
    db.decisionMakerRun.findMany.mockResolvedValue([{ crmCompanyId: 'seen' }])
    const result = await checkForNewLeads(NOW)
    expect(result.alreadySearched).toBe(1)
    expect(result.queued.map((q) => q.crmCompanyId)).toEqual(['fresh'])
  })

  it('does not repeat a search that started between the read and the lock', async () => {
    searchCompanies.mockResolvedValue({ items: [company('race', hoursAgo(1))] })
    tx.decisionMakerRun.findFirst.mockResolvedValue({ id: 'manual_run' })
    const result = await checkForNewLeads(NOW)
    expect(result.queued).toEqual([])
    expect(tx.decisionMakerRun.create).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    // The automatic check asks "ever searched", not only "in flight".
    const where = tx.decisionMakerRun.findFirst.mock.calls[0]![0].where
    expect(where).toEqual({ tenantId: 't1', crmCompanyId: 'race' })
  })

  it('caps searches per check, oldest lead first, and defers the rest', async () => {
    env.DM_AUTO_DISCOVER_MAX_PER_CHECK = 2
    searchCompanies.mockResolvedValue({
      items: [company('c', hoursAgo(1)), company('a', hoursAgo(5)), company('b', hoursAgo(3))],
    })
    const result = await checkForNewLeads(NOW)
    expect(result.queued.map((q) => q.crmCompanyId)).toEqual(['a', 'b'])
    expect(result.deferred).toBe(1)
  })

  it('does nothing at all when switched off', async () => {
    env.DM_AUTO_DISCOVER_ENABLED = false
    const result = await checkForNewLeads(NOW)
    expect(result.enabled).toBe(false)
    expect(searchCompanies).not.toHaveBeenCalled()
    expect(tx.decisionMakerRun.create).not.toHaveBeenCalled()
  })
})

describe('duplicate searches for the same company', () => {
  const ask = () =>
    queueDecisionMakerDiscovery({ tenantId: 't1', crmCompanyId: 'co1', requestedByCrmUserId: 'u1' })

  it('returns the search already in flight instead of starting another', async () => {
    tx.decisionMakerRun.findFirst.mockResolvedValue({ id: 'running_run' })
    await expect(ask()).resolves.toEqual({ id: 'running_run', reused: true })
    expect(tx.decisionMakerRun.create).not.toHaveBeenCalled()
  })

  it('starts a new search when none is in flight', async () => {
    const result = await ask()
    expect(result.reused).toBe(false)
    expect(tx.decisionMakerRun.create).toHaveBeenCalledTimes(1)
  })

  it('checks under a per-company lock, and only for queued or running searches that are not stranded', async () => {
    await ask()
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    const where = tx.decisionMakerRun.findFirst.mock.calls[0]![0].where
    expect(where.status).toEqual({ in: ['queued', 'running'] })
    expect(where.createdAt.gte).toBeInstanceOf(Date)
    // A finished search never blocks asking again.
    expect(where.status.in).not.toContain('completed')
  })

  it('closes stranded queued/running runs for the company as failed before checking', async () => {
    await ask()
    expect(tx.decisionMakerRun.updateMany).toHaveBeenCalledTimes(1)
    const arg = tx.decisionMakerRun.updateMany.mock.calls[0]![0]
    expect(arg.where).toMatchObject({ tenantId: 't1', crmCompanyId: 'co1', status: { in: ['queued', 'running'] } })
    expect(arg.where.createdAt.lt).toBeInstanceOf(Date)
    expect(arg.data.status).toBe('failed')
    expect(arg.data.failureReason).toMatch(/in-flight window/)
  })
})

describe('an enqueue failure does not strand a run', () => {
  it('marks the automatically queued run failed when the job cannot be enqueued', async () => {
    searchCompanies.mockResolvedValue({ items: [company('new1', hoursAgo(2))] })
    enqueue.mockRejectedValueOnce(new Error('queue down'))
    const result = await checkForNewLeads(NOW)

    expect(result.queued).toEqual([])
    const created = tx.decisionMakerRun.create.mock.calls[0]![0].data
    expect(db.decisionMakerRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: created.id },
        data: expect.objectContaining({ status: 'failed', failureReason: expect.stringMatching(/could not be queued/) }),
      }),
    )
  })
})

describe('reading more than one CRM page', () => {
  it('reads the next page while the oldest company on a full page is still inside the window', async () => {
    const full = Array.from({ length: 100 }, (_, i) => company(`p1_${i}`, hoursAgo(1)))
    searchCompanies
      .mockResolvedValueOnce({ items: full })
      .mockResolvedValueOnce({ items: [company('p2_new', hoursAgo(3)), company('p2_old', hoursAgo(40))] })
    const result = await checkForNewLeads(NOW)
    expect(searchCompanies).toHaveBeenCalledTimes(2)
    expect(result.newLeads).toBe(101)
  })

  it('stops after one page when that page already reaches past the window', async () => {
    const full = Array.from({ length: 100 }, (_, i) => company(`p1_${i}`, hoursAgo(i === 99 ? 48 : 1)))
    searchCompanies.mockResolvedValue({ items: full })
    await checkForNewLeads(NOW)
    expect(searchCompanies).toHaveBeenCalledTimes(1)
  })
})
