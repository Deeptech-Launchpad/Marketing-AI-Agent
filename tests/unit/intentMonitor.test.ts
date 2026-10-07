import { beforeEach, describe, expect, it, vi } from 'vitest'

// LIVE INTENT MONITORING (2026-09-29).
//
// The monitor only QUEUES ordinary Intent Signals runs — every filter stays in
// the run itself. What is under test is which companies it re-checks: only
// ones being worked, only when due, oldest first, capped, never twice at once,
// and nothing at all while it is switched off.

const env = { INTENT_MONITOR_ENABLED: true, INTENT_MONITOR_MIN_DAYS: 7, INTENT_MONITOR_MAX_COMPANIES: 2 }
vi.mock('../../src/config/env.js', () => ({ env }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

type Run = { tenantId: string; crmCompanyId: string; requestedByCrmUserId: string; createdAt: Date; status: string }
let runs: Run[] = []
let campaigns: Array<{ tenantId: string; crmCompanyId: string; isTest: boolean; status: string }> = []
const DAY = 86_400_000
const NOW = new Date('2026-09-29T06:00:00Z')
const ago = (d: number) => new Date(NOW.getTime() - d * DAY)

const prisma = {
  intentDetectionRun: {
    groupBy: vi.fn(async ({ where, _max }: { where: Record<string, any>; _max?: unknown }) => {
      let rows = runs
      if (where.requestedByCrmUserId?.not) rows = rows.filter((r) => r.requestedByCrmUserId !== where.requestedByCrmUserId.not)
      if (where.createdAt?.gte) rows = rows.filter((r) => r.createdAt >= where.createdAt.gte)
      if (where.crmCompanyId?.in) rows = rows.filter((r) => where.crmCompanyId.in.includes(r.crmCompanyId))
      const groups = new Map<string, { tenantId: string; crmCompanyId: string; _max: { createdAt: Date } }>()
      for (const r of rows) {
        const k = `${r.tenantId}|${r.crmCompanyId}`
        const g = groups.get(k)
        if (!g || g._max.createdAt < r.createdAt) groups.set(k, { tenantId: r.tenantId, crmCompanyId: r.crmCompanyId, _max: { createdAt: r.createdAt } })
      }
      return [...groups.values()].map((g) => (_max ? g : { tenantId: g.tenantId, crmCompanyId: g.crmCompanyId }))
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) =>
      runs.find((r) => r.crmCompanyId === where.crmCompanyId && where.status.in.includes(r.status) && r.createdAt >= where.createdAt.gte) ?? null,
    ),
    update: vi.fn(),
  },
  outreachCampaign: {
    findMany: vi.fn(async () => campaigns.filter((c) => !c.isTest && ['active', 'paused'].includes(c.status))),
  },
}
vi.mock('../../src/platform/db.js', () => ({ prisma }))
const queued: string[] = []
vi.mock('../../src/intent/intentDetection.js', () => ({
  RUN_IN_FLIGHT_MS: 30 * 60_000,
  queueIntentDetection: vi.fn(async (i: { crmCompanyId: string; requestedByCrmUserId: string }) => {
    queued.push(`${i.crmCompanyId}:${i.requestedByCrmUserId}`)
    return { id: `run-${i.crmCompanyId}` }
  }),
}))
const enqueue = vi.fn(async () => undefined)
vi.mock('../../src/platform/queue.js', () => ({ enqueue, QUEUE_INTENT_DETECT: 'intent.detect', INTENT_JOB_EXPIRE_SECONDS: 1800 }))

const { monitorIntentSignals, MONITOR_USER } = await import('../../src/intent/intentMonitor.js')

beforeEach(() => {
  vi.clearAllMocks()
  queued.length = 0
  env.INTENT_MONITOR_ENABLED = true
  runs = []
  campaigns = []
})

const manual = (id: string, days: number, status = 'completed'): Run => ({ tenantId: 't1', crmCompanyId: id, requestedByCrmUserId: 'u1', createdAt: ago(days), status })

describe('the intent monitor', () => {
  it('does nothing while switched off', async () => {
    env.INTENT_MONITOR_ENABLED = false
    runs = [manual('a', 30)]
    expect(await monitorIntentSignals(NOW)).toMatchObject({ queued: 0 })
    expect(queued).toEqual([])
  })

  it('re-checks a worked company once it is due, as the monitor, through the ordinary Intent run', async () => {
    runs = [manual('a', 10)]
    expect(await monitorIntentSignals(NOW)).toMatchObject({ queued: 1 })
    expect(queued).toEqual([`a:${MONITOR_USER}`])
    // An intent job may run for up to 30 minutes before it is redelivered (2026-10-07).
    expect(enqueue).toHaveBeenCalledWith('intent.detect', { intentRunId: 'run-a' }, { expireInSeconds: 1800 })
  })

  it('leaves a company checked recently alone', async () => {
    runs = [manual('a', 3)]
    expect(await monitorIntentSignals(NOW)).toMatchObject({ queued: 0 })
  })

  it('ignores companies nobody is working (last manual run long ago, no live sequence)', async () => {
    runs = [manual('old', 200)]
    expect(await monitorIntentSignals(NOW)).toMatchObject({ considered: 0, queued: 0 })
  })

  it('includes companies with a live (not test) outreach sequence, even without a manual run', async () => {
    campaigns = [
      { tenantId: 't1', crmCompanyId: 'live', isTest: false, status: 'active' },
      { tenantId: 't1', crmCompanyId: 'rehearsal', isTest: true, status: 'active' },
      { tenantId: 't1', crmCompanyId: 'done', isTest: false, status: 'completed' },
    ]
    await monitorIntentSignals(NOW)
    expect(queued).toEqual([`live:${MONITOR_USER}`])
  })

  it('takes the longest-unchecked first, up to the cap', async () => {
    runs = [manual('a', 10), manual('b', 40), manual('c', 20)]
    await monitorIntentSignals(NOW)
    expect(queued).toEqual([`b:${MONITOR_USER}`, `c:${MONITOR_USER}`])
  })

  it('never starts a second run while one is in flight', async () => {
    runs = [manual('a', 10), { ...manual('a', 0), createdAt: new Date(NOW.getTime() - 60_000), status: 'running' }]
    // The in-flight run is also the latest, so the company is not due at all.
    expect(await monitorIntentSignals(NOW)).toMatchObject({ queued: 0 })
  })
})
