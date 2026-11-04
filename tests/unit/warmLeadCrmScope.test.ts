import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../src/config/env.js'

// SCOPED CRM ACCESS for the permanent Warm Leads module.
//
// CRM_READ_ONLY is global and would break Bulk Email in production, so the Warm Leads worker is
// read-only as a PROCESS (and code can open a read-only scope). The one exception - sending the
// Warm / Early Signal list to NXT Sales - is a narrow 'sync' scope that reaches the Warm Leads
// endpoints only. The global CRM_READ_ONLY=true still beats everything.

const http = await import('../../src/crm/nxtSales/httpClient.js')
const { crmFetch, crmGet, crmPut, crmPost, crmBulkRequest, crmWarmLeadsPut, crmWarmLeadsDelete, setCrmProcessReadOnly, withCrmReadOnly, withCrmWarmLeadsSync, assertSyncScopeAllowed, CrmReadOnlyViolation } = http

const BASE = 'http://crm.example.test:8009'
const ID = 'cmtlgn68v0000elb580hm13qc'
const fetchMock = vi.fn()
const saved = { ...env }

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ companies: [], total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  Object.assign(env, {
    NXT_SALES_BASE_URL: BASE,
    CRM_READ_ONLY: false, // the PRODUCTION setting: the same install sends bulk email through the CRM
    NXT_SALES_STATIC_TOKEN: 'static.test.token',
    NXT_SALES_SERVICE_USER_ID: 'svc-user',
    NXT_SALES_LIVE_SERVICE_USER_ID: 'svc-user',
    NXT_SALES_MAX_CONCURRENCY: 2,
    CRM_WRITE_ENABLED: true,
    CRM_WRITE_ALLOW_LIVE: true,
    BULK_SEND_VIA: 'crm',
    WARM_LEADS_SYNC_ENABLED: true,
    WARM_LEADS_ALLOW_LIVE: true,
  })
})
afterEach(() => {
  setCrmProcessReadOnly(false)
  vi.unstubAllGlobals()
  Object.assign(env, saved)
})

const blocked = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e) => e)
  expect(err, 'should have been refused').toBeInstanceOf(CrmReadOnlyViolation)
}

describe('a process that declared itself read-only (the Warm Leads worker)', () => {
  beforeEach(() => setCrmProcessReadOnly(true))

  it('reads go out as GETs without following redirects', async () => {
    await crmGet('/api/companies', { page: 1, limit: 500 })
    await crmGet(`/api/companies/${ID}`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
  })

  it('every write is refused at the transport - even with every write switch on, including bulk send', async () => {
    await blocked(crmPut(`/api/companies/${ID}`, { customFields: {} }))
    await blocked(crmPost('/api/companies', { name: 'X' }))
    await blocked(crmBulkRequest('POST', '/api/marketing-bulk/send', { idempotencyKey: 'k' }))
    await blocked(crmFetch(`${BASE}/api/companies/${ID}`, { method: 'DELETE' }))
    await blocked(crmFetch(`${BASE}/api/companies/${ID}`, { method: 'PATCH', body: '{}' }))
    await blocked(crmFetch(`${BASE}/api/some-other-endpoint`)) // a GET, but not on the list
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a request without any scope cannot escape it by omitting the method', async () => {
    await blocked(crmFetch(`${BASE}/api/companies/${ID}`, { body: '{}' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the sync scope - the only way anything is written, and only to the Warm Leads endpoints', () => {
  beforeEach(() => setCrmProcessReadOnly(true))

  it('crmWarmLeadsPut reaches PUT /api/marketing-warm-leads/companies/:id, and nothing else', async () => {
    await crmWarmLeadsPut(`/companies/${ID}`, { classification: 'warm' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(`${BASE}/api/marketing-warm-leads/companies/${ID}`)
    expect(init).toMatchObject({ method: 'PUT', redirect: 'error' })
  })

  it('a withdrawal is a DELETE of that one company', async () => {
    await crmWarmLeadsDelete(`/companies/${ID}`)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(`${BASE}/api/marketing-warm-leads/companies/${ID}`)
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
  })

  it('inside the sync scope every other write is still refused', async () => {
    await withCrmWarmLeadsSync(async () => {
      await blocked(crmFetch(`${BASE}/api/companies/${ID}`, { method: 'PUT', body: '{}' })) // a company record
      await blocked(crmFetch(`${BASE}/api/marketing-bulk/send`, { method: 'POST', body: '{}' })) // bulk send
      await blocked(crmFetch(`${BASE}/api/marketing-warm-leads/companies/${ID}`, { method: 'POST', body: '{}' })) // wrong method
      await blocked(crmFetch(`${BASE}/api/marketing-warm-leads/companies/${ID}`, { method: 'PATCH', body: '{}' }))
      await blocked(crmFetch(`${BASE}/api/marketing-warm-leads/companies`, { method: 'PUT', body: '{}' })) // not an item path
      await blocked(crmFetch(`${BASE}/api/marketing-warm-leads/companies/${ID}/extra`, { method: 'PUT', body: '{}' }))
      await blocked(crmFetch(`${BASE}/api/marketing-warm-leads/runs/run1`, { method: 'DELETE' })) // runs may be PUT, never deleted
      await blocked(crmFetch('http://evil.example.test/api/marketing-warm-leads/companies/abc', { method: 'PUT', body: '{}' })) // another origin
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the sync endpoints cannot be reached from a plain read-only scope', async () => {
    await withCrmReadOnly(() => blocked(crmFetch(`${BASE}/api/marketing-warm-leads/companies/${ID}`, { method: 'PUT', body: '{}' })))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the sender still obeys its own switches before any request is built', async () => {
    env.WARM_LEADS_SYNC_ENABLED = false
    await expect(crmWarmLeadsPut(`/companies/${ID}`, {})).rejects.toThrow(/WARM_LEADS_SYNC_ENABLED is off/)
    env.WARM_LEADS_SYNC_ENABLED = true
    env.WARM_LEADS_ALLOW_LIVE = false
    await expect(crmWarmLeadsDelete(`/companies/${ID}`)).rejects.toThrow(/not a local CRM/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the guard is pure and lists exactly three writes', () => {
    const ok = (m: string, p: string) => () => assertSyncScopeAllowed(m, `${BASE}${p}`)
    expect(ok('PUT', `/api/marketing-warm-leads/companies/${ID}`)).not.toThrow()
    expect(ok('DELETE', `/api/marketing-warm-leads/companies/${ID}`)).not.toThrow()
    expect(ok('PUT', '/api/marketing-warm-leads/runs/run-1')).not.toThrow()
    expect(ok('GET', '/api/deals/export')).not.toThrow()
    expect(ok('POST', `/api/marketing-warm-leads/companies/${ID}`)).toThrow(CrmReadOnlyViolation)
    expect(http.WARM_SYNC_WRITE_ENDPOINTS).toHaveLength(3)
  })
})

describe('the global CRM_READ_ONLY=true still beats every scope', () => {
  it('even the sync scope cannot write', async () => {
    env.CRM_READ_ONLY = true
    await blocked(crmWarmLeadsPut(`/companies/${ID}`, { classification: 'warm' }))
    await blocked(crmWarmLeadsDelete(`/companies/${ID}`))
    await blocked(withCrmWarmLeadsSync(() => crmFetch(`${BASE}/api/marketing-warm-leads/companies/${ID}`, { method: 'PUT', body: '{}' })))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('everything else is unchanged (Bulk Email, the API, the main worker)', () => {
  it('a process that is not read-only still passes every request straight through', async () => {
    await crmFetch(`${BASE}/api/marketing-bulk/send`, { method: 'POST', body: '{}' })
    await crmFetch(`${BASE}/api/companies/${ID}`, { method: 'PUT', body: '{}' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
  })

  it('a read-only scope opened in such a process does not leak out of it', async () => {
    await withCrmReadOnly(async () => {
      await blocked(crmFetch(`${BASE}/api/marketing-bulk/send`, { method: 'POST', body: '{}' }))
    })
    await crmFetch(`${BASE}/api/marketing-bulk/send`, { method: 'POST', body: '{}' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
