import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// THE API, END TO END: the real Express routes, the real approval module, the real validation - only the database and NXT Sales are stand-ins.
// What it proves, at the HTTP level: an activity whose company id is null or differs from the submitted one is refused (409), another tenant's
// proposal cannot be approved or revealed (404), the body can never carry a tenant, an approver or an address, the exact address leaves the
// server only in the reveal response (admin, no-store) and nowhere else, and nothing is written when anything is refused.

const h = vi.hoisted(() => ({
  /** `${tenant}|${company}` pairs on a Warm Leads list */
  companies: new Set<string>(),
  /** stored evaluations, by tenant */
  rows: new Map<string, Array<Record<string, any>>>(),
  activities: [] as Array<Record<string, any>>,
  crmCalls: [] as Array<Record<string, any>>,
  creates: [] as Array<Record<string, any>>,
  audits: [] as Array<Record<string, any>>,
  logs: [] as unknown[][],
}))
vi.mock('../../src/platform/db.js', () => {
  const prisma = {
    $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
      const tenant = values.find((v) => typeof v === 'string' && h.rows.has(v)) as string | undefined
      return tenant ? h.rows.get(tenant)! : []
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    warmLeadCompany: {
      findUnique: async (a: Record<string, any>) => (h.companies.has(`${a.where.tenantId_crmCompanyId.tenantId}|${a.where.tenantId_crmCompanyId.crmCompanyId}`) ? { id: 'row' } : null),
      findMany: async (a: Record<string, any>) => (a.where.crmCompanyId.in as string[]).map((id) => ({ crmCompanyId: id, classification: 'warm' })),
    },
    auditEvent: { findMany: async () => [], create: async (a: Record<string, any>) => void h.audits.push(a.data) },
    suppressionEntry: {
      findUnique: async () => null,
      createMany: async (a: { data: Array<Record<string, any>> }) => {
        h.creates.push(...a.data)
        return { count: a.data.length }
      },
    },
  }
  return { newId: () => 'id', prisma }
})
vi.mock('../../src/platform/logger.js', () => {
  const l: Record<string, unknown> = {}
  for (const n of ['info', 'warn', 'error', 'debug', 'trace', 'fatal']) l[n] = (...a: unknown[]) => void h.logs.push(a)
  l.child = () => l
  return { logger: l, runLogger: () => l }
})
vi.mock('../../src/crm/index.js', () => ({
  getCrm: () => ({
    listActivities: async (q: Record<string, any>) => {
      h.crmCalls.push(q)
      return h.activities
    },
  }),
}))
vi.mock('../../src/warmleads/companies.js', () => ({ companyDetail: vi.fn(), listCompanies: vi.fn(), retryFailed: vi.fn() }))
vi.mock('../../src/warmleads/pilot.js', () => ({ approvePilot: vi.fn(), pilotResults: vi.fn(), requestPilot: vi.fn() }))
vi.mock('../../src/warmleads/service.js', () => ({ runDetail: vi.fn() }))
vi.mock('../../src/warmleads/settings.js', () => ({ approveScale: vi.fn(), approveSync: vi.fn(), disableSync: vi.fn(), ensureSettings: vi.fn(), requestListRefresh: vi.fn(), setPaused: vi.fn(), updateLimits: vi.fn(), updateWindow: vi.fn() }))
vi.mock('../../src/warmleads/view.js', () => ({ buildOverview: vi.fn() }))

import { env } from '../../src/config/env.js'
import { errorHandler } from '../../src/api/middleware/errorHandler.js'
import { warmLeadsRoutes } from '../../src/api/routes/warmLeads.routes.js'
import { toActivity } from '../../src/crm/nxtSales/mappers.js'
import { optOutSignals, proposeOptOuts, signalsToReasons } from '../../src/warmleads/optOut.js'
import { summariseInbound } from '../../src/warmleads/replies.js'

env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'unit-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
env.WARM_LEADS_OWN_DOMAINS = 'ours.example'

let server: Server
let base = ''
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const role = req.header('x-role')
    const tenantId = req.header('x-tenant') ?? 'tenant-A'
    if (role) req.principal = { tenantId, crmUserId: 'user-7', role: role as never, permissions: role === 'admin' ? ['view', 'admin'] : ['view'] } as never
    next()
  })
  app.use('/api/warm-leads', warmLeadsRoutes)
  app.use(errorHandler)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/warm-leads`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const NOW = new Date()
const dayAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const raw = (over: Record<string, unknown> = {}) => ({ id: 'act_1', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: dayAgo(3), body: 'UNSUBSCRIBE', fromEmail: 'Ravi <ravi@acme.example>', matchedCompanyEmail: 'ravi@acme.example', mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example', user: { email: 'rep@ours.example' }, ...over })
const crmHas = (over: Record<string, unknown> = {}) => void (h.activities = [toActivity(raw(over), true)])

beforeEach(() => {
  env.WARM_LEADS_RECORD_OPT_OUTS = true
  env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'unit-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
  h.companies = new Set(['tenant-A|c1'])
  h.creates.length = 0
  h.audits.length = 0
  h.crmCalls.length = 0
  h.logs.length = 0
  // the proposal as tenant A's earlier evaluation stored it: reasons only - never an address
  const assessed = summariseInbound([toActivity(raw(), true)], NOW, undefined, true).assessed
  const reasons = signalsToReasons(optOutSignals({ assessed, decision: proposeOptOuts(assessed, false), persisted: [], record: false }))
  h.rows = new Map([['tenant-A', [{ id: 'e1', crmCompanyId: 'c1', companyName: 'Acme', evaluatedAt: new Date(), reasons }]]])
  crmHas()
})

const GOOD = { crmCompanyId: 'c1', activityId: 'act_1', confirm: true, independentlyVerified: true, verificationMethod: 'phone_call_known_number' }
const REVEAL = { crmCompanyId: 'c1', activityId: 'act_1' }
const call = (path: string, body: unknown, headers: Record<string, string> = { 'x-role': 'admin' }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const untouched = () => {
  expect(h.creates).toEqual([])
  expect(h.audits).toEqual([])
}

describe('API: approve and reveal need an activity tied to EXACTLY the submitted company', () => {
  it('a NULL company id on the NXT Sales activity: 409, nothing written or audited, for both calls', async () => {
    for (const companyId of [null, '']) {
      crmHas({ companyId })
      for (const [path, body] of [['/opt-outs/approve', GOOD], ['/opt-outs/reveal', REVEAL]] as const) {
        const res = await call(path, body)
        expect(res.status, `${path} ${JSON.stringify(companyId)}`).toBe(409)
        const text = JSON.stringify(await res.json())
        expect(text).toMatch(/does not link that email to any company/)
        expect(text).not.toContain('ravi@acme.example')
      }
    }
    untouched()
  })

  it('a MISMATCHED company id: 409, nothing written or audited, for both calls', async () => {
    crmHas({ companyId: 'c9' })
    for (const [path, body] of [['/opt-outs/approve', GOOD], ['/opt-outs/reveal', REVEAL]] as const) {
      const res = await call(path, body)
      expect(res.status, path).toBe(409)
      expect(JSON.stringify(await res.json())).toMatch(/different company than the one submitted/)
    }
    untouched()
  })

  it('an activity of another company submitted under THIS company\'s id is not accepted either (the id in the request cannot choose the company)', async () => {
    h.companies.add('tenant-A|c2')
    // c2 has no proposal of its own: the activity id of c1's proposal is refused for it
    expect((await call('/opt-outs/approve', { ...GOOD, crmCompanyId: 'c2' })).status).toBe(404)
    expect((await call('/opt-outs/reveal', { ...REVEAL, crmCompanyId: 'c2' })).status).toBe(404)
    untouched()
  })

  it('CROSS-TENANT: tenant B (even with c1 on its own list) gets 404 for tenant A\'s proposal, and tenant C (no such company) gets 404 before any proposal is read', async () => {
    h.companies.add('tenant-B|c1')
    for (const [path, body] of [['/opt-outs/approve', GOOD], ['/opt-outs/reveal', REVEAL]] as const) {
      const b = await call(path, body, { 'x-role': 'admin', 'x-tenant': 'tenant-B' })
      expect(b.status, `${path} B`).toBe(404)
      expect(JSON.stringify(await b.json())).toMatch(/no opt-out proposal/)
      const c = await call(path, body, { 'x-role': 'admin', 'x-tenant': 'tenant-C' })
      expect(c.status, `${path} C`).toBe(404)
      expect(JSON.stringify(await c.json())).toMatch(/not in your Warm Leads list/)
    }
    expect(h.crmCalls).toEqual([]) // NXT Sales was never asked for another tenant
    untouched()
  })

  it('the request cannot name a tenant, an approver, an address or a time: those are 400 and nothing is read', async () => {
    for (const extra of [{ tenantId: 'tenant-A' }, { approverCrmUserId: 'user-1' }, { address: 'victim@example.com' }, { approvedAt: '2020-01-01T00:00:00Z' }]) {
      expect((await call('/opt-outs/approve', { ...GOOD, ...extra })).status).toBe(400)
      expect((await call('/opt-outs/reveal', { ...REVEAL, ...extra })).status).toBe(400)
    }
    expect(h.crmCalls).toEqual([])
    untouched()
  })
})

describe('API: the approval records who, when and how; the reveal shows the address once and only to an administrator', () => {
  it('approve without a verification method is 400; with one, the approval is audited with the admin id, the time and the method', async () => {
    const { verificationMethod: _drop, ...without } = GOOD
    expect((await call('/opt-outs/approve', without)).status).toBe(400)
    expect((await call('/opt-outs/approve', { ...GOOD, verificationMethod: 'I rang them up' })).status).toBe(400)
    untouched()
    const res = await call('/opt-outs/approve', { ...GOOD, verificationMethod: 'account_owner_confirmed' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'recorded', masked: 'r***@acme.example' })
    expect(h.creates).toHaveLength(1)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]).toMatchObject({ tenantId: 'tenant-A', actorCrmUserId: 'user-7', action: 'warmleads.opt_out_approved' })
    expect(h.audits[0]!.metadata).toMatchObject({ approvedByCrmUserId: 'user-7', verification: { method: 'account_owner_confirmed' } })
    expect(Number.isNaN(Date.parse(h.audits[0]!.metadata.approvedAt))).toBe(false)
    expect(JSON.stringify(h.audits)).not.toContain('ravi')
  })

  it('reveal: the admin gets the exact address (no-store), a viewer gets 403, and the audit and the logs never contain it', async () => {
    expect((await call('/opt-outs/reveal', REVEAL, { 'x-role': 'viewer' })).status).toBe(403)
    expect((await call('/opt-outs/reveal', REVEAL, {})).status).toBe(401)
    expect(h.crmCalls).toEqual([])
    const res = await call('/opt-outs/reveal', REVEAL)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ address: 'ravi@acme.example', authenticated: false, masked: 'r***@acme.example' })
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]).toMatchObject({ action: 'warmleads.opt_out_address_revealed', actorCrmUserId: 'user-7', tenantId: 'tenant-A' })
    expect(JSON.stringify(h.audits)).not.toContain('ravi')
    expect(JSON.stringify(h.logs)).not.toContain('ravi@acme.example')
    expect(h.creates).toEqual([]) // viewing never suppresses anyone
  })

  it('with the switch OFF or without the key, the reveal is 409 and the address is not read', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = false
    expect((await call('/opt-outs/reveal', REVEAL)).status).toBe(409)
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = ''
    expect((await call('/opt-outs/reveal', REVEAL)).status).toBe(409)
    expect(h.crmCalls).toEqual([])
    untouched()
  })
})
