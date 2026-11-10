import { beforeEach, describe, expect, it, vi } from 'vitest'

// human_review (and any status NXT Sales does not accept) must never reach NXT Sales - through ANY of the three code paths that write a
// company result there. Each guard below has a test that FAILS if the guard is removed. The database and the transport are stand-ins.

const h = vi.hoisted(() => ({
  puts: [] as Array<{ path: string; body: Record<string, any> }>,
  deletes: [] as string[],
  evaluations: new Map<string, Record<string, any>>(),
  updates: [] as Array<Record<string, any>>,
  findManyArgs: [] as Array<Record<string, any>>,
  companies: new Map<string, Record<string, any>>(),
  companyUpdates: [] as Array<Record<string, any>>,
  queue: [] as Array<{ id: string }>,
  settings: null as Record<string, any> | null,
}))

vi.mock('../../src/platform/db.js', () => ({
  newId: () => 'id',
  prisma: {
    $queryRaw: async () => h.queue,
    warmLeadEvaluation: {
      findUnique: async (a: Record<string, any>) => h.evaluations.get(a.where.id) ?? null,
      update: async (a: Record<string, any>) => void h.updates.push(a),
      findMany: async (a: Record<string, any>) => {
        h.findManyArgs.push(a)
        return [...h.evaluations.values()].filter((e) => e.crmSyncedAt === null && (a.where.OR ? e.classification === null || e.classification !== 'human_review' : true)).map((e) => ({ id: e.id }))
      },
      count: async () => 0,
    },
    warmLeadRun: { findMany: async () => [], findUnique: async () => null },
    warmLeadCompany: {
      findUnique: async (a: Record<string, any>) => h.companies.get(a.where.id) ?? null,
      update: async (a: Record<string, any>) => void h.companyUpdates.push(a),
    },
    warmLeadSettings: { findUnique: async () => h.settings },
  },
}))
vi.mock('../../src/crm/nxtSales/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/crm/nxtSales/httpClient.js')>()
  return {
    ...actual,
    crmWarmLeadsPut: async (path: string, body: Record<string, any>) => void h.puts.push({ path, body }),
    crmWarmLeadsDelete: async (path: string) => void h.deletes.push(path),
  }
})

import { env } from '../../src/config/env.js'
import { resyncPending, syncEvaluation } from '../../src/warmleads/service.js'
import { syncPending } from '../../src/warmleads/sync.js'

const ev = (id: string, over: Record<string, any> = {}) => ({
  id,
  runId: 'r1',
  tenantId: 't1',
  crmCompanyId: 'c-' + id,
  status: 'done',
  classification: 'warm',
  score: 60,
  confidence: 'high',
  summary: 's',
  reasons: [],
  deepCheck: 'done',
  error: null,
  evaluatedAt: new Date('2026-11-04T01:00:00Z'),
  crmSyncedAt: null,
  ...over,
})

beforeEach(() => {
  h.puts.length = 0
  h.deletes.length = 0
  h.evaluations.clear()
  h.updates.length = 0
  h.findManyArgs.length = 0
  h.companies.clear()
  h.companyUpdates.length = 0
  h.queue = []
  h.settings = null
  env.WARM_LEADS_SYNC_ENABLED = false
})

describe('legacy per-evaluation sync (service.ts syncEvaluation)', () => {
  it('a finished evaluation held for human review is NEVER sent', async () => {
    h.evaluations.set('e1', ev('e1', { classification: 'human_review' }))
    await syncEvaluation('e1')
    expect(h.puts).toEqual([])
    expect(h.updates).toEqual([]) // and it is not stamped as sent
  })
  it('a warm one is sent with exactly its classification; a failed one is sent with a null classification', async () => {
    h.evaluations.set('e2', ev('e2'))
    h.evaluations.set('e3', ev('e3', { status: 'failed', classification: null, error: 'site down' }))
    await syncEvaluation('e2')
    await syncEvaluation('e3')
    expect(h.puts.map((p) => p.body.classification)).toEqual(['warm', null])
    expect(h.updates).toHaveLength(2)
  })
  it('a classification NXT does not accept is refused by the last-line guard, not sent, and the failure is recorded', async () => {
    h.evaluations.set('e4', ev('e4', { classification: 'something_new' }))
    await syncEvaluation('e4')
    expect(h.puts).toEqual([])
    expect(h.updates[0]!.data.crmSyncError).toMatch(/not one NXT Sales accepts/)
  })
})

describe('re-sending what NXT Sales has not acknowledged (service.ts resyncPending)', () => {
  it('never even selects a human_review evaluation, so it is never retried', async () => {
    h.evaluations.set('held', ev('held', { classification: 'human_review' }))
    h.evaluations.set('warm', ev('warm'))
    h.evaluations.set('failed', ev('failed', { status: 'failed', classification: null }))
    const r = await resyncPending('t1')
    const where = h.findManyArgs[0]!.where
    expect(where.OR).toEqual([{ classification: null }, { classification: { not: 'human_review' } }]) // a plain "not" would also drop the NULL rows (failed evaluations)
    expect(r.attempted).toBe(2)
    expect(h.puts.map((p) => p.path).sort()).toEqual(['/companies/c-failed', '/companies/c-warm'])
    expect(h.puts.some((p) => p.body.classification === 'human_review')).toBe(false)
  })
})

describe('the company sync (sync.ts syncPending): defence in depth', () => {
  const open = () => {
    env.WARM_LEADS_SYNC_ENABLED = true
    h.settings = { pilotApprovedAt: new Date(), syncEnabled: true, syncApprovedAt: new Date() }
  }
  const company = (id: string, over: Record<string, any> = {}) => ({ id, crmCompanyId: 'c-' + id, classification: 'warm', currentEvaluationId: 'e-' + id, syncedEvaluationId: null, ...over })
  it('a Warm company whose evaluation row is (impossibly) human_review is NOT sent: the guard refuses it, and the error is recorded', async () => {
    open()
    h.queue = [{ id: 'k1' }]
    h.companies.set('k1', company('k1'))
    h.evaluations.set('e-k1', ev('e-k1', { classification: 'human_review' }))
    const r = await syncPending('t1')
    expect(h.puts).toEqual([])
    expect(r.failed).toBe(1)
    expect(h.companyUpdates[0]!.data.syncError).toMatch(/not one NXT Sales accepts/)
  })
  it('a normal Warm company is sent', async () => {
    open()
    h.queue = [{ id: 'k2' }]
    h.companies.set('k2', company('k2'))
    h.evaluations.set('e-k2', ev('e-k2'))
    const r = await syncPending('t1')
    expect(r.put).toBe(1)
    expect(h.puts[0]!.body.classification).toBe('warm')
  })
  it('with sending switched off nothing is attempted at all', async () => {
    h.queue = [{ id: 'k3' }]
    h.companies.set('k3', company('k3'))
    h.evaluations.set('e-k3', ev('e-k3'))
    expect((await syncPending('t1')).skipped).toMatch(/WARM_LEADS_SYNC_ENABLED/)
    expect(h.puts).toEqual([])
  })
})

describe('the server-only fingerprint never reaches NXT Sales', () => {
  const LINE = { signal: 'opt_out_proposal', summary: 'r***@acme.example is PROPOSED', evidence: 'status: dry_run · NXT activity act_1 · received 2026-11-03 · fp 0123456789abcdef · key 89abcdef · phrase: UNSUBSCRIBE · one address only' }
  it('syncEvaluation sends the reasons without the fingerprint and the key id (everything else is unchanged)', async () => {
    h.evaluations.set('e9', ev('e9', { classification: 'cold', reasons: [LINE] }))
    await syncEvaluation('e9')
    const sent = h.puts[0]!.body.reasons as Array<{ evidence: string; summary: string }>
    expect(JSON.stringify(sent)).not.toMatch(/0123456789abcdef|89abcdef| fp | key /)
    expect(sent[0]!.evidence).toBe('status: dry_run · NXT activity act_1 · received 2026-11-03 · phrase: UNSUBSCRIBE · one address only')
    expect(sent[0]!.summary).toBe('r***@acme.example is PROPOSED')
  })
  it('the company sync (syncPending) sends them redacted too', async () => {
    env.WARM_LEADS_SYNC_ENABLED = true
    h.settings = { pilotApprovedAt: new Date(), syncEnabled: true, syncApprovedAt: new Date() }
    h.queue = [{ id: 'k9' }]
    h.companies.set('k9', { id: 'k9', crmCompanyId: 'c-k9', classification: 'warm', currentEvaluationId: 'e-k9', syncedEvaluationId: null })
    h.evaluations.set('e-k9', ev('e-k9', { reasons: [LINE] }))
    await syncPending('t1')
    expect(JSON.stringify(h.puts[0]!.body.reasons)).not.toMatch(/0123456789abcdef|89abcdef| fp | key /)
  })
})
