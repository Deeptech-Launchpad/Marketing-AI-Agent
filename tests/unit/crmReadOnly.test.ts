import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../src/config/env.js'

// CRM READ-ONLY MODE (CRM_READ_ONLY=true), enforced in the HTTP transport.
//
// The isolated warm-lead test reads the LIVE CRM. Its guarantee is not that
// nothing in the code wants to write — it is that a write cannot leave the
// machine: crmFetch refuses every method but GET, every endpoint not on the
// list, every other origin and every redirect, BELOW the feature switches. So
// these tests open EVERY higher switch and show the transport still blocks.

const http = await import('../../src/crm/nxtSales/httpClient.js')
const { NxtSalesAdapter } = await import('../../src/crm/nxtSales/nxtSalesAdapter.js')
const { crmFetch, assertReadOnlyAllowed, crmGet, crmPut, crmPost, crmBulkRequest, crmWarmLeadsPut, probeCrm, crmRequestStats, CrmReadOnlyViolation, READ_ONLY_ENDPOINTS } = http

const BASE = 'http://crm.example.test:8009'
const fetchMock = vi.fn()
const saved = { ...env }

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ companies: [], total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  Object.assign(env, {
    NXT_SALES_BASE_URL: BASE,
    CRM_READ_ONLY: true,
    NXT_SALES_STATIC_TOKEN: 'static.test.token',
    NXT_SALES_SERVICE_USER_ID: 'svc-user',
    NXT_SALES_LIVE_SERVICE_USER_ID: 'svc-user',
    NXT_SALES_MAX_CONCURRENCY: 2,
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(env, saved)
})

const blocked = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e) => e)
  expect(err, 'should have been refused').toBeInstanceOf(CrmReadOnlyViolation)
  return err as Error
}

describe('what read-only mode lets through', () => {
  const allowed = [
    '/api/companies?page=1&limit=500',
    '/api/companies?lastActivity=last_90&page=2&limit=500&sort=recent',
    '/api/companies/cmtlgn68v0000elb580hm13qc',
    '/api/companies/cms7fkjp70jdtqj76ixyk5omp',
    '/api/deals?companyId=cmtlgn68v0000elb580hm13qc',
    '/api/deals/export',
    '/api/activities?companyId=cmtlgn68v0000elb580hm13qc&type=email',
  ]
  it('GET to the listed read endpoints goes out — with a GET method and redirects turned into errors', async () => {
    for (const p of allowed) {
      await crmFetch(`${BASE}${p}`, { method: 'GET', headers: { Authorization: 'Bearer x' } })
    }
    expect(fetchMock).toHaveBeenCalledTimes(allowed.length)
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('error')
    }
  })

  it('the normal read helpers work, and send the pre-made token as it is (nothing is signed, so JWT_SECRET is not needed)', async () => {
    env.JWT_SECRET = 'this-secret-must-never-be-used-for-signing'
    await crmGet('/api/deals', { companyId: 'cmtlgn68v0000elb580hm13qc' })
    const init = fetchMock.mock.calls[0]![1]
    expect(init.headers.Authorization).toBe('Bearer static.test.token')
    const adapter = new NxtSalesAdapter()
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ companies: [], total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await adapter.searchCompanies({ page: 1, limit: 1 })
    expect(fetchMock.mock.calls.at(-1)![0]).toContain('/api/companies?')
  })

  it('a request without a method is a GET (as fetch itself treats it)', async () => {
    await crmFetch(`${BASE}/api/deals/export`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('what read-only mode refuses — before any request is made', () => {
  it('every method but exactly "GET"', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'get', 'Get', 'post', '', 'PROPFIND', 'GET ']) {
      await blocked(crmFetch(`${BASE}/api/companies`, { method }))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a GET that carries a body', async () => {
    await blocked(crmFetch(`${BASE}/api/companies`, { method: 'GET', body: '{"x":1}' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('every endpoint that is not on the list, including every write route and the heavy "export everything" route', async () => {
    const paths = [
      '/api/users', '/api/auth/me', '/api/auth/login', '/api/companies/export', '/api/companies/import-fields', '/api/companies/recycle-bin', '/api/companies/summary', '/api/companies/email-conflicts',
      '/api/companies/short', '/api/companies/cmtlgn68v0000elb580hm13qc/pin', '/api/companies/cmtlgn68v0000elb580hm13qc/neighbors', '/api/companies/', '/api/companies/cmtlgn68v0000elb580hm13qc/',
      '/api/dashboard/deal-stats', '/api/dropdowns/fields', '/api/custom-fields/Company', '/api/intelligence/email-summaries/cmtlgn68v0000elb580hm13qc', '/api/email/send', '/api/email/accounts',
      '/api/marketing-bulk/send', '/api/marketing-bulk/sender', '/api/marketing-bulk/status', '/api/marketing-warm-leads/summary', '/api/marketing-warm-leads/companies/cmtlgn68v0000elb580hm13qc',
      '/api/deals/cmtlgn68v0000elb580hm13qc', '/api/activities/cmtlgn68v0000elb580hm13qc', '/api/data/export', '/api/chat/unread', '/', '/health', '/uploads/x',
      // spellings that try to slip past a prefix check
      '/API/companies', '/api//companies', '//api/companies', '/api/companies;x=1', '/api/companies/%2e%2e/users', '/api/companies/../users', '/api/companies/cmtlgn68v0000elb580hm13qc/../../users', '/api/companies%2Fexport',
    ]
    for (const p of paths) {
      await blocked(crmFetch(`${BASE}${p}`, { method: 'GET' }))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('another origin, another scheme, another port, and credentials inside the URL', async () => {
    for (const u of ['http://evil.test/api/companies', 'https://crm.example.test:8009/api/companies', 'http://crm.example.test/api/companies', 'http://crm.example.test:8010/api/companies', `http://user:pw@crm.example.test:8009/api/companies`, 'http://localhost:8009/api/companies', 'not a url']) {
      await blocked(crmFetch(u, { method: 'GET' }))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('counts what it let through and what it refused', async () => {
    const before = crmRequestStats()
    await crmFetch(`${BASE}/api/deals/export`, { method: 'GET' })
    await blocked(crmFetch(`${BASE}/api/users`, { method: 'GET' }))
    await blocked(crmFetch(`${BASE}/api/companies`, { method: 'POST' }))
    const after = crmRequestStats()
    expect(after.allowed - before.allowed).toBe(1)
    expect(after.blocked - before.blocked).toBe(2)
  })

  it('the guard itself is pure: assertReadOnlyAllowed throws without touching the network', () => {
    expect(() => assertReadOnlyAllowed('PUT', `${BASE}/api/companies/cmtlgn68v0000elb580hm13qc`)).toThrow(CrmReadOnlyViolation)
    expect(() => assertReadOnlyAllowed('GET', `${BASE}/api/deals/export`)).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('every CRM write function is blocked — even with every higher-level switch turned ON', () => {
  beforeEach(() => {
    Object.assign(env, { CRM_WRITE_ENABLED: true, CRM_WRITE_ALLOW_LIVE: true, WARM_LEADS_SYNC_ENABLED: true, WARM_LEADS_ALLOW_LIVE: true, BULK_SEND_VIA: 'crm' })
  })

  it('crmPut, crmPost, the bulk-send API, the warm-lead sync and the company updater all stop at the transport', async () => {
    await blocked(crmPut('/api/companies/cmtlgn68v0000elb580hm13qc', { customFields: {} }))
    await blocked(crmPost('/api/companies', { name: 'X' }))
    await blocked(crmPost('/api/companies/email-conflicts', { emails: [] }))
    await blocked(crmBulkRequest('POST', '/api/marketing-bulk/send', { idempotencyKey: 'k' }))
    await blocked(crmBulkRequest('GET', '/api/marketing-bulk/status?keys=a')) // a GET, but not on the list
    await blocked(crmBulkRequest('GET', '/api/marketing-bulk/sender'))
    await blocked(crmWarmLeadsPut('/companies/cmtlgn68v0000elb580hm13qc', { classification: 'warm' }))
    await blocked(crmWarmLeadsPut('/runs/run1', { kind: 'test' }))
    await expect(new NxtSalesAdapter().updateCompany!('cmtlgn68v0000elb580hm13qc', { customFields: {} })).rejects.toBeInstanceOf(CrmReadOnlyViolation)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the readiness probe (which is not on the list) is refused too, and says so instead of reaching the CRM', async () => {
    const r = await probeCrm()
    expect(r.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('and with read-only OFF the normal behaviour is unchanged: the same call passes through to fetch (regression)', async () => {
    env.CRM_READ_ONLY = false
    await crmFetch(`${BASE}/api/companies`, { method: 'POST', body: '{}' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST')
    expect(fetchMock.mock.calls[0]![1].redirect).toBeUndefined() // not altered when the mode is off
  })
})

describe('no way around the one door (source scans)', () => {
  const root = path.resolve('src')
  const read = (p: string) => readFileSync(path.join(root, p), 'utf8')
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : n.endsWith('.ts') ? [path.join(dir, n)] : []))

  it('httpClient.ts calls fetch() only inside crmFetch', () => {
    const src = read('crm/nxtSales/httpClient.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const start = src.indexOf('export async function crmFetch')
    const end = src.indexOf('\n}\n', start)
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, end)
    const all = [...src.matchAll(/(^|[^A-Za-z_.])fetch\(/g)].length
    const inside = [...body.matchAll(/(^|[^A-Za-z_.])fetch\(/g)].length
    expect(inside).toBeGreaterThan(0)
    expect(all).toBe(inside)
  })

  it('no other module builds a CRM URL or sends a request to it', () => {
    const users = files(root)
      .filter((f) => readFileSync(f, 'utf8').includes('NXT_SALES_BASE_URL'))
      .map((f) => path.relative(root, f).replace(/\\/g, '/'))
      .sort()
    // env: the setting; httpClient: the door; writeGate/leadWrite: only ask "is the target local?", they send nothing.
    expect(users).toEqual(['config/env.ts', 'crm/leads/leadWrite.ts', 'crm/nxtSales/httpClient.ts', 'crmsync/writeGate.ts'])
    for (const f of ['crm/leads/leadWrite.ts', 'crmsync/writeGate.ts']) {
      expect(read(f).replace(/\/\/.*$/gm, '')).not.toMatch(/(^|[^A-Za-z_.])fetch\(/)
    }
  })

  it('the allow-list is exactly the five approved read endpoints', () => {
    expect(READ_ONLY_ENDPOINTS).toHaveLength(5)
  })
})
