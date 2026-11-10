import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/warm-leads/opt-outs/approve: administrators only, a strict body that carries IDS ONLY (never an address), and the tenant and the
// approver come from the login - never from the request. A real Express app with a stub login; the module behind it is a stand-in.

const m = vi.hoisted(() => ({ approve: vi.fn(), review: vi.fn() }))
vi.mock('../../src/warmleads/optOutApproval.js', () => ({ approveOptOut: m.approve }))
vi.mock('../../src/warmleads/optOutReview.js', () => ({ optOutReview: m.review }))
vi.mock('../../src/warmleads/companies.js', () => ({ companyDetail: vi.fn(), listCompanies: vi.fn(), retryFailed: vi.fn() }))
vi.mock('../../src/warmleads/pilot.js', () => ({ approvePilot: vi.fn(), pilotResults: vi.fn(), requestPilot: vi.fn() }))
vi.mock('../../src/warmleads/service.js', () => ({ runDetail: vi.fn() }))
vi.mock('../../src/warmleads/settings.js', () => ({ approveScale: vi.fn(), approveSync: vi.fn(), disableSync: vi.fn(), ensureSettings: vi.fn(), requestListRefresh: vi.fn(), setPaused: vi.fn(), updateLimits: vi.fn(), updateWindow: vi.fn() }))
vi.mock('../../src/warmleads/view.js', () => ({ buildOverview: vi.fn() }))

import { env } from '../../src/config/env.js'
import { errorHandler } from '../../src/api/middleware/errorHandler.js'
import { warmLeadsRoutes } from '../../src/api/routes/warmLeads.routes.js'

let server: Server
let base = ''

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const role = req.header('x-role')
    if (role) req.principal = { tenantId: 'tenant-A', crmUserId: 'user-7', role: role as never, permissions: role === 'admin' ? ['view', 'admin'] : ['view'] } as never
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
beforeEach(() => {
  m.approve.mockReset()
  m.review.mockReset()
  env.WARM_LEADS_RECORD_OPT_OUTS = false
})

const post = (body: unknown, role?: string) => fetch(`${base}/opt-outs/approve`, { method: 'POST', headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: JSON.stringify(body) })
const GOOD = { crmCompanyId: 'c1', activityId: 'act_1', confirm: true, independentlyVerified: true }

describe('POST /opt-outs/approve', () => {
  it('needs a login (401) and the admin permission (403): a viewer cannot approve', async () => {
    expect((await post(GOOD)).status).toBe(401)
    expect((await post(GOOD, 'viewer')).status).toBe(403)
    expect(m.approve).not.toHaveBeenCalled()
  })

  it('the body is strict: an address, any extra field, a missing id or a missing confirmation is refused (400) and nothing is approved', async () => {
    for (const bad of [
      { ...GOOD, address: 'victim@example.com' },
      { ...GOOD, email: 'victim@example.com' },
      { ...GOOD, tenantId: 'tenant-B' },
      { ...GOOD, approverCrmUserId: 'someone-else' },
      { crmCompanyId: 'c1', confirm: true, independentlyVerified: true },
      { activityId: 'act_1', confirm: true, independentlyVerified: true },
      { ...GOOD, confirm: false },
      { ...GOOD, independentlyVerified: false },
      { crmCompanyId: 'c1', activityId: 'act_1', confirm: true }, // no confirmation of an independent check
      { ...GOOD, independentlyVerified: 'true' },
      { crmCompanyId: 'c1', activityId: 'act_1' },
      { ...GOOD, activityId: '' },
      {},
    ]) {
      expect((await post(bad, 'admin')).status, JSON.stringify(bad)).toBe(400)
    }
    expect(m.approve).not.toHaveBeenCalled()
  })

  it('an administrator\'s request reaches the module with the tenant and approver from the LOGIN and the two ids from the body - nothing else', async () => {
    m.approve.mockResolvedValue({ status: 'recorded', masked: 'r***@acme.example', activityId: 'act_1', message: 'r***@acme.example was added to the suppression list.' })
    const res = await post(GOOD, 'admin')
    expect(res.status).toBe(200)
    expect(m.approve).toHaveBeenCalledTimes(1)
    expect(m.approve).toHaveBeenCalledWith({ tenantId: 'tenant-A', approverCrmUserId: 'user-7', crmCompanyId: 'c1', activityId: 'act_1', independentlyVerified: true })
    expect(((await res.json()) as { message: string }).message).toMatch(/added to the suppression list/)
  })

  it('a refusal from the module reaches the caller as a clear status, never as a success', async () => {
    const { ConflictError, NotFoundError } = await import('../../src/platform/errors.js')
    m.approve.mockRejectedValueOnce(new ConflictError('Recording opt-outs is switched off'))
    expect((await post(GOOD, 'admin')).status).toBe(409)
    m.approve.mockRejectedValueOnce(new NotFoundError('There is no opt-out proposal for that email.'))
    expect((await post(GOOD, 'admin')).status).toBe(404)
  })
})

describe('GET /pilot/opt-outs', () => {
  it('is readable by a viewer, tells whether recording is on, and is scoped to the login\'s tenant', async () => {
    m.review.mockResolvedValue({ items: [], pendingCount: 0, complete: true })
    const off = await fetch(`${base}/pilot/opt-outs`, { headers: { 'x-role': 'viewer' } })
    expect(await off.json()).toEqual({ items: [], pendingCount: 0, complete: true, recordingEnabled: false })
    expect(m.review).toHaveBeenCalledWith('tenant-A')
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    expect(((await (await fetch(`${base}/pilot/opt-outs`, { headers: { 'x-role': 'viewer' } })).json()) as { recordingEnabled: boolean }).recordingEnabled).toBe(true)
    expect((await fetch(`${base}/pilot/opt-outs`)).status).toBe(401)
  })
})
