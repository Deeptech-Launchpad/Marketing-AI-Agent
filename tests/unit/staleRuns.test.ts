import { beforeEach, describe, expect, it, vi } from 'vitest'

// RUNS STRANDED BY A WORKER RESTART ARE CLOSED, NOT LEFT "RUNNING" (2026-10-06).
//
// Every deploy restarts the worker. An intent run or a Prospects search that
// was in progress at that moment used to stay queued/running for good — the
// screen polled forever, Detect stayed disabled, and the search could never be
// deleted. Decision Makers and Enrichment already closed theirs; these two did
// not.

type Row = Record<string, any>
const rows: Record<string, Row[]> = { intentDetectionRun: [], companyDiscoverySearch: [] }

const matches = (r: Row, where: Row) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(r[k])
    if (v && typeof v === 'object' && 'lt' in v) return r[k] < (v.lt as Date)
    return r[k] === v
  })
const model = (name: string) => ({
  updateMany: vi.fn(async ({ where, data }: Row) => {
    const hit = rows[name]!.filter((r) => matches(r, where))
    hit.forEach((r) => Object.assign(r, data))
    return { count: hit.length }
  }),
})
const prisma = { intentDetectionRun: model('intentDetectionRun'), companyDiscoverySearch: model('companyDiscoverySearch') }
vi.mock('../../src/platform/db.js', () => ({ prisma, newId: () => 'id' }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

const { failStaleIntentRuns, STALE_INTENT_RUN_REASON } = await import('../../src/intent/intentDetection.js')
const { failStaleDiscoverySearches, STALE_SEARCH_REASON } = await import('../../src/prospects/companyWebDiscovery.js')

const NOW = new Date('2026-10-06T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

beforeEach(() => {
  rows.intentDetectionRun = [
    { id: 'dead-running', tenantId: 't1', status: 'running', createdAt: minutesAgo(45) },
    { id: 'dead-queued', tenantId: 't1', status: 'queued', createdAt: minutesAgo(31) },
    { id: 'live', tenantId: 't1', status: 'running', createdAt: minutesAgo(5) },
    { id: 'finished', tenantId: 't1', status: 'completed', createdAt: minutesAgo(600) },
    { id: 'other-tenant', tenantId: 't2', status: 'running', createdAt: minutesAgo(600) },
  ]
  rows.companyDiscoverySearch = [
    { id: 'dead', tenantId: 't1', status: 'running', createdAt: minutesAgo(60) },
    { id: 'still-going', tenantId: 't1', status: 'running', createdAt: minutesAgo(20) },
    { id: 'done', tenantId: 't1', status: 'completed', createdAt: minutesAgo(600) },
  ]
})

const status = (name: string) => Object.fromEntries(rows[name]!.map((r) => [r.id, r.status]))

describe('intent runs', () => {
  it('fails runs stranded past 30 minutes, with a reason that says what to do', async () => {
    expect(await failStaleIntentRuns('t1', NOW)).toBe(2)
    expect(status('intentDetectionRun')).toEqual({
      'dead-running': 'failed',
      'dead-queued': 'failed',
      live: 'running',
      finished: 'completed',
      'other-tenant': 'running',
    })
    const closed = rows.intentDetectionRun!.find((r) => r.id === 'dead-running')!
    expect(closed.failureReason).toBe(STALE_INTENT_RUN_REASON)
    expect(closed.failureReason).toMatch(/detect again/)
    expect(closed.completedAt).toEqual(NOW)
  })
})

describe('Prospects searches', () => {
  it('fails searches stranded past 45 minutes and leaves a search still in its budget alone', async () => {
    expect(await failStaleDiscoverySearches('t1', NOW)).toBe(1)
    expect(status('companyDiscoverySearch')).toEqual({ dead: 'failed', 'still-going': 'running', done: 'completed' })
    const closed = rows.companyDiscoverySearch!.find((r) => r.id === 'dead')!
    expect(closed.failureReason).toBe(STALE_SEARCH_REASON)
    expect(closed.finishedAt).toEqual(NOW)
  })
})
