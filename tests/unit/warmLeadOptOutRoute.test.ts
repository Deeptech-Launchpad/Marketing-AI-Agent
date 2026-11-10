import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/warm-leads/opt-outs/approve: administrators only, a strict body that carries IDS ONLY (never an address), and the tenant and the
// approver come from the login - never from the request. A real Express app with a stub login; the module behind it is a stand-in.

const m = vi.hoisted(() => ({ approve: vi.fn(), review: vi.fn(), reveal: vi.fn() }))
vi.mock('../../src/warmleads/optOutApproval.js', async (orig) => ({ ...(await orig<object>()), approveOptOut: m.approve, revealOptOutAddress: m.reveal }))
vi.mock('../../src/warmleads/optOutReview.js', async (orig) => ({ ...(await orig<object>()), optOutReview: m.review }))
vi.mock('../../src/warmleads/companies.js', () => ({ companyDetail: vi.fn(), listCompanies: vi.fn(), retryFailed: vi.fn() }))
vi.mock('../../src/warmleads/pilot.js', () => ({ approvePilot: vi.fn(), pilotResults: vi.fn(), requestPilot: vi.fn() }))
vi.mock('../../src/warmleads/service.js', () => ({ runDetail: vi.fn() }))
vi.mock('../../src/warmleads/settings.js', () => ({ approveScale: vi.fn(), approveSync: vi.fn(), disableSync: vi.fn(), ensureSettings: vi.fn(), requestListRefresh: vi.fn(), setPaused: vi.fn(), updateLimits: vi.fn(), updateWindow: vi.fn() }))
vi.mock('../../src/warmleads/view.js', () => ({ buildOverview: vi.fn() }))

import { env } from '../../src/config/env.js'
import { errorHandler } from '../../src/api/middleware/errorHandler.js'
import { warmLeadsRoutes } from '../../src/api/routes/warmLeads.routes.js'

// Server-side settings the opt-out code needs (test values only): the dedicated fingerprint key, and which domains are OURS.
env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'unit-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
env.WARM_LEADS_OWN_DOMAINS = 'ours.example'

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
  m.reveal.mockReset()
  env.WARM_LEADS_RECORD_OPT_OUTS = false
})

const post = (body: unknown, role?: string) => fetch(`${base}/opt-outs/approve`, { method: 'POST', headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: JSON.stringify(body) })
const GOOD = { crmCompanyId: 'c1', activityId: 'act_1', confirm: true, independentlyVerified: true, verificationMethod: 'phone_call_known_number' }

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
      { crmCompanyId: 'c1', activityId: 'act_1', confirm: true, independentlyVerified: true }, // no verification method
      { ...GOOD, verificationMethod: 'I rang them up' }, // free text is not a method
      { ...GOOD, verificationMethod: '' },
      { ...GOOD, verificationMethod: 7 },
      { ...GOOD, verificationMethod: ['phone_call_known_number'] },
      { ...GOOD, verifiedBy: 'someone-else' },
      { ...GOOD, approvedAt: '2020-01-01T00:00:00Z' },
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
    expect(m.approve).toHaveBeenCalledWith({ tenantId: 'tenant-A', approverCrmUserId: 'user-7', crmCompanyId: 'c1', activityId: 'act_1', independentlyVerified: true, verificationMethod: 'phone_call_known_number' })
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

describe('POST /opt-outs/approve - the verification method', () => {
  it('every method in the fixed list is accepted and passed on; nothing else is', async () => {
    const { VERIFICATION_METHODS } = await import('../../src/warmleads/optOutApproval.js')
    m.approve.mockResolvedValue({ status: 'recorded', masked: 'r***@acme.example', activityId: 'act_1', message: 'ok' })
    for (const verificationMethod of VERIFICATION_METHODS) {
      expect((await post({ ...GOOD, verificationMethod }, 'admin')).status, verificationMethod).toBe(200)
      expect(m.approve).toHaveBeenLastCalledWith(expect.objectContaining({ verificationMethod }))
    }
    expect(m.approve).toHaveBeenCalledTimes(VERIFICATION_METHODS.length)
  })
})

describe('POST /opt-outs/reveal', () => {
  const REVEAL = { crmCompanyId: 'c1', activityId: 'act_1' }
  const postReveal = (body: unknown, role?: string) => fetch(`${base}/opt-outs/reveal`, { method: 'POST', headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: JSON.stringify(body) })
  const SHOWN = { address: 'ravi@acme.example', masked: 'r***@acme.example', crmCompanyId: 'c1', companyName: 'Acme', companyClassification: 'warm', activityId: 'act_1', receivedOn: '2026-11-03', phrase: 'UNSUBSCRIBE', authenticated: false, notice: 'not verified' }

  it('is for administrators only: no login is 401, a viewer is 403, and nothing is read', async () => {
    expect((await postReveal(REVEAL)).status).toBe(401)
    expect((await postReveal(REVEAL, 'viewer')).status).toBe(403)
    expect(m.reveal).not.toHaveBeenCalled()
  })

  it('the body is strict: ids only - no address, no tenant, no admin, nothing extra, nothing missing', async () => {
    for (const bad of [{ ...REVEAL, address: 'victim@example.com' }, { ...REVEAL, tenantId: 'tenant-B' }, { ...REVEAL, adminCrmUserId: 'someone-else' }, { ...REVEAL, confirm: true }, { crmCompanyId: 'c1' }, { activityId: 'act_1' }, { ...REVEAL, activityId: '' }, { ...REVEAL, crmCompanyId: 7 }, {}]) {
      expect((await postReveal(bad, 'admin')).status, JSON.stringify(bad)).toBe(400)
    }
    expect(m.reveal).not.toHaveBeenCalled()
  })

  it('an administrator gets the address; the tenant and the admin come from the LOGIN, the two ids from the body; the response is never cached', async () => {
    m.reveal.mockResolvedValue(SHOWN)
    const res = await postReveal(REVEAL, 'admin')
    expect(res.status).toBe(200)
    expect(m.reveal).toHaveBeenCalledWith({ tenantId: 'tenant-A', adminCrmUserId: 'user-7', crmCompanyId: 'c1', activityId: 'act_1' })
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    expect(res.headers.get('cache-control')).toMatch(/private/)
    expect(res.headers.get('pragma')).toBe('no-cache')
    expect(await res.json()).toEqual(SHOWN)
  })

  it('a refusal reaches the caller as a clear status, without an address: 409 and 404', async () => {
    const { ConflictError, NotFoundError } = await import('../../src/platform/errors.js')
    m.reveal.mockRejectedValueOnce(new ConflictError('NXT Sales does not link that email to any company'))
    const a = await postReveal(REVEAL, 'admin')
    expect(a.status).toBe(409)
    expect(a.headers.get('cache-control') ?? '').not.toMatch(/public/)
    expect(JSON.stringify(await a.json())).not.toContain('@')
    m.reveal.mockRejectedValueOnce(new NotFoundError('There is no opt-out proposal for that email.'))
    expect((await postReveal(REVEAL, 'admin')).status).toBe(404)
  })

  it('the exact address appears NOWHERE else: the review list stays masked even after a reveal', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    m.reveal.mockResolvedValue(SHOWN)
    await postReveal(REVEAL, 'admin')
    const { fingerprintKeyId } = await import('../../src/warmleads/optOut.js')
    m.review.mockResolvedValue({
      items: [{ kind: 'proposal', crmCompanyId: 'c1', companyName: 'Acme', companyClassification: 'warm', evaluationId: 'e1', evaluatedAt: null, status: 'awaiting_approval', masked: 'r***@acme.example', receivedOn: '2026-11-03', activityId: 'act_1', fingerprint: 'abcdef0123456789', keyId: fingerprintKeyId(), phrase: 'UNSUBSCRIBE', reason: 'why', omittedProposals: 0, omittedNotRecorded: 0, summary: 's', approvedBy: null }],
      pendingCount: 1,
      omitted: { proposals: 0, notRecorded: 0 },
      complete: true,
    })
    const text = await (await fetch(`${base}/pilot/opt-outs`, { headers: { 'x-role': 'admin' } })).text()
    expect(text).not.toContain('ravi@acme.example')
    expect(text).toContain('r***@acme.example')
  })
})

describe('GET /pilot/opt-outs', () => {
  const KEY = 'unit-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
  const FP = 'abcdef0123456789'
  const raw = (over: Record<string, unknown> = {}) => ({
    kind: 'proposal', crmCompanyId: 'c1', companyName: 'Acme', companyClassification: 'warm', evaluationId: 'e1', evaluatedAt: null, status: 'awaiting_approval', masked: 'r***@acme.example',
    receivedOn: '2026-11-03', activityId: 'act_1', fingerprint: FP, keyId: null as string | null, phrase: 'UNSUBSCRIBE', reason: 'why', omittedProposals: 0, omittedNotRecorded: 0, summary: 's', approvedBy: null, ...over,
  })
  const get = async (query = '', role = 'viewer') => (await fetch(`${base}/pilot/opt-outs${query}`, { headers: { 'x-role': role } })).json() as Promise<Record<string, any>>
  const result = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, pendingCount: items.length, omitted: { proposals: 0, notRecorded: 0 }, complete: true, ...extra })
  let currentKeyId = ''
  beforeAll(async () => {
    const { fingerprintKeyId } = await import('../../src/warmleads/optOut.js')
    currentKeyId = fingerprintKeyId()!
  })
  beforeEach(() => {
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = KEY
  })

  it('is readable by a viewer, tells whether recording is on, and is scoped to the login\'s tenant', async () => {
    m.review.mockResolvedValue(result([]))
    const off = await get()
    expect(off).toEqual({ items: [], total: 0, shown: 0, pendingCount: 0, omitted: { proposals: 0, notRecorded: 0 }, complete: true, recordingEnabled: false, keyConfigured: true })
    expect(m.review).toHaveBeenCalledWith('tenant-A')
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    expect((await get()).recordingEnabled).toBe(true)
    expect((await fetch(`${base}/pilot/opt-outs`)).status).toBe(401)
  })

  it('NEVER returns the fingerprint or the key id - only whether the proposal can be approved (and, if not, why)', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    m.review.mockResolvedValue(result([raw({ keyId: currentKeyId })]))
    const res = await fetch(`${base}/pilot/opt-outs`, { headers: { 'x-role': 'admin' } })
    const text = await res.text()
    expect(text).not.toContain(FP)
    expect(text).not.toContain(currentKeyId)
    expect(text).not.toMatch(/fingerprint|keyId/i)
    const body = JSON.parse(text) as { items: Array<Record<string, any>> }
    expect(body.items[0]).toMatchObject({ approvable: true, approvalBlockedReason: null })
    expect(Object.keys(body.items[0]!)).not.toContain('fingerprint')
    expect(Object.keys(body.items[0]!)).not.toContain('keyId')
  })

  it('approvable is false - with a reason - when recording is off, the key is missing, the key was changed, or the proposal has no fingerprint', async () => {
    const one = async (over: Record<string, unknown>) => {
      m.review.mockResolvedValue(result([raw(over)]))
      return (await get('', 'admin')).items[0] as { approvable: boolean; approvalBlockedReason: string | null }
    }
    env.WARM_LEADS_RECORD_OPT_OUTS = false
    expect(await one({ keyId: currentKeyId })).toMatchObject({ approvable: false, approvalBlockedReason: 'switch_off' })
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    expect(await one({ keyId: currentKeyId })).toMatchObject({ approvable: true, approvalBlockedReason: null })
    expect(await one({ keyId: '00000000' })).toMatchObject({ approvable: false, approvalBlockedReason: 'key_changed' })
    expect(await one({ fingerprint: null, keyId: null })).toMatchObject({ approvable: false, approvalBlockedReason: 'no_fingerprint' })
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = ''
    expect(await one({ keyId: currentKeyId })).toMatchObject({ approvable: false, approvalBlockedReason: 'key_not_configured' })
    // a line that is not a pending proposal has nothing to approve and nothing to explain
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = KEY
    expect(await one({ status: 'recorded', keyId: currentKeyId })).toMatchObject({ approvable: false, approvalBlockedReason: null })
    expect(await one({ kind: 'not_recorded', keyId: null, fingerprint: null })).toMatchObject({ approvable: false, approvalBlockedReason: null })
  })

  it('is paginated: `limit` bounds the response (default 50, never above 500), pending proposals come first, and the TOTAL and the pending count are reported', async () => {
    const many = Array.from({ length: 120 }, (_, i) => raw({ activityId: `act_${i}`, crmCompanyId: `c${i}`, keyId: currentKeyId, status: i % 2 ? 'recorded' : 'awaiting_approval', receivedOn: `2026-10-${String((i % 28) + 1).padStart(2, '0')}` }))
    m.review.mockResolvedValue(result(many, { pendingCount: 60 + 7, omitted: { proposals: 7, notRecorded: 2 } }))
    const def = await get()
    expect(def).toMatchObject({ total: 120, shown: 50, pendingCount: 67, omitted: { proposals: 7, notRecorded: 2 } })
    expect(def.items).toHaveLength(50)
    expect(def.items.every((i: any) => i.status !== 'recorded')).toBe(true) // 60 pending proposals exist: the first page holds only those
    expect((await get('?limit=3')).items).toHaveLength(3)
    expect((await get('?limit=100000')).items).toHaveLength(120) // capped at 500, so all 120 here
    expect((await get('?limit=abc')).items).toHaveLength(50)
    expect((await get('?limit=0')).items).toHaveLength(50)
    expect((await get('?limit=-5')).items).toHaveLength(1)
  })
})
