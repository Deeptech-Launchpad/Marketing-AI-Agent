import { beforeEach, describe, expect, it, vi } from 'vitest'

// THE CRM WRITE PATH — updateCompany, the HTTP PUT, and the guards around them.
//
// This is the only code in the platform that changes anything in NXT Sales.
// Most of what follows checks that it cannot do more than it is supposed to:
// the CRM's own auth middleware performs no role check on write routes, so
// nothing on the far side would catch a mistake made here.

const CONFIRMED_MAP =
  'not_qualified=Not Qualified;qualified=Qualified;qualified_unassigned=Qualified - Unassigned;de_qualified=De-qualified'

const envMock: Record<string, unknown> = {
  CRM_WRITE_ENABLED: false,
  // On for most of this file, so the other guards are what gets exercised.
  // Its own behaviour is tested in its own section.
  CRM_WRITE_ALLOW_LIVE: true,
  CRM_WRITE_FIELD_INTENT_SCORE: 'intentScore',
  CRM_WRITE_FIELD_QUALIFICATION_STATUS: 'qualificationStatus',
  CRM_WRITE_QUALIFICATION_VALUE_MAP: CONFIRMED_MAP,
  NXT_SALES_BASE_URL: 'http://crm.test',
  // crm.test is deliberately NOT a local host, so these tests exercise the
  // identity guard rather than skipping past it.
  NXT_SALES_SERVICE_USER_ID: 'cmt8ljfon00top3t31zkt33wz',
  NXT_SALES_LIVE_SERVICE_USER_ID: 'cmt8ljfon00top3t31zkt33wz',
  NXT_SALES_TIMEOUT_MS: 5000,
  NXT_SALES_MAX_CONCURRENCY: 2,
}
vi.mock('../../src/config/env.js', async (orig) => {
  const actual = (await orig()) as { env: Record<string, unknown> }
  return { env: new Proxy(envMock, { get: (t, k: string) => (k in t ? t[k] : actual.env[k]) }) }
})

const { crmPut } = await import('../../src/crm/nxtSales/httpClient.js')
const { NxtSalesAdapter } = await import('../../src/crm/nxtSales/nxtSalesAdapter.js')

const COMPANY = 'cms7fiyww06pnqj76gap3d9r4'

beforeEach(() => {
  vi.restoreAllMocks()
  envMock.CRM_WRITE_ENABLED = false
  envMock.CRM_WRITE_ALLOW_LIVE = true
  envMock.NXT_SALES_BASE_URL = 'http://crm.test'
  envMock.NXT_SALES_SERVICE_USER_ID = 'cmt8ljfon00top3t31zkt33wz'
  envMock.NXT_SALES_LIVE_SERVICE_USER_ID = 'cmt8ljfon00top3t31zkt33wz'
})

/** Captures the request without letting one leave the process. */
function captureFetch(status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}

// ── 1. THE FLAG IS THE LAST GATE, NOT ONLY THE FIRST ───────────────────────

describe('crmPut refuses while writes are disabled', () => {
  it('throws before any request is made', async () => {
    const calls = captureFetch()
    await expect(crmPut('/api/companies/x', { customFields: {} })).rejects.toThrow(/CRM_WRITE_ENABLED is off/)
    expect(calls).toHaveLength(0)
  })

  it('checks the flag itself rather than trusting its caller', async () => {
    // The write gate checks this too. Both check, because this is the last
    // code before the wire and a guard only at the top protects only the
    // callers that go through the top.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/crm/nxtSales/httpClient.ts', import.meta.url), 'utf8'),
    )
    expect(src).toMatch(/if \(!env\.CRM_WRITE_ENABLED\)/)
  })
})

// ── 2. THE REQUEST ─────────────────────────────────────────────────────────

describe('the HTTP request', () => {
  beforeEach(() => {
    envMock.CRM_WRITE_ENABLED = true
  })

  it('is a PUT to the company, with the exact body', async () => {
    const calls = captureFetch()
    await crmPut(`/api/companies/${COMPANY}`, {
      customFields: { intentScore: 100, qualificationStatus: 'Qualified - Unassigned' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`http://crm.test/api/companies/${COMPANY}`)
    expect(calls[0]!.init.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      customFields: { intentScore: 100, qualificationStatus: 'Qualified - Unassigned' },
    })
  })

  it('sends exactly one request', async () => {
    const calls = captureFetch()
    await crmPut(`/api/companies/${COMPANY}`, { customFields: { intentScore: 1 } })
    expect(calls).toHaveLength(1)
  })

  it('does NOT retry a failed write', async () => {
    // A GET is idempotent and is retried once. A write that may or may not
    // have landed must be reported, not repeated hopefully.
    const calls = captureFetch(500, { error: 'boom' })
    await expect(crmPut('/api/companies/x', { customFields: {} })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('explains a 400 as a probable rejected field value', async () => {
    captureFetch(400, { message: 'not a valid option' })
    await expect(crmPut('/api/companies/x', { customFields: {} })).rejects.toThrow(/dropdown options/)
  })

  it('never marks a write retryable', async () => {
    captureFetch(503)
    await expect(crmPut('/api/companies/x', { customFields: {} })).rejects.toMatchObject({ retryable: false })
  })

  // 2026-09-29: "Add to NXT Sales" needs a create (POST). It is the only
  // addition: still no PATCH and no DELETE, and the POST passes every gate
  // the PUT does — tested below.
  it('offers no PATCH or DELETE, and POST only as crmPost', async () => {
    const client = await import('../../src/crm/nxtSales/httpClient.js')
    expect(Object.keys(client).filter((k) => /patch|delete/i.test(k))).toEqual([])
    expect(Object.keys(client).filter((k) => /post/i.test(k))).toEqual(['crmPost'])
  })
})

describe('crmPost passes the same gates as crmPut', () => {
  it('refuses while writes are disabled, before any request', async () => {
    const { crmPost } = await import('../../src/crm/nxtSales/httpClient.js')
    const calls = captureFetch()
    await expect(crmPost('/api/companies', { name: 'X' })).rejects.toThrow(/CRM_WRITE_ENABLED is off/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a live CRM without CRM_WRITE_ALLOW_LIVE, before any request', async () => {
    const { crmPost } = await import('../../src/crm/nxtSales/httpClient.js')
    envMock.CRM_WRITE_ENABLED = true
    envMock.CRM_WRITE_ALLOW_LIVE = false
    const calls = captureFetch()
    await expect(crmPost('/api/companies', { name: 'X' })).rejects.toThrow(/CRM_WRITE_ALLOW_LIVE is off/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a live CRM signed with an unconfirmed identity', async () => {
    const { crmPost } = await import('../../src/crm/nxtSales/httpClient.js')
    envMock.CRM_WRITE_ENABLED = true
    envMock.NXT_SALES_SERVICE_USER_ID = 'someone-else'
    const calls = captureFetch()
    await expect(crmPost('/api/companies', { name: 'X' })).rejects.toThrow(/not the identity confirmed/)
    expect(calls).toHaveLength(0)
  })

  it('is one POST, never retried', async () => {
    const { crmPost } = await import('../../src/crm/nxtSales/httpClient.js')
    envMock.CRM_WRITE_ENABLED = true
    const calls = captureFetch(503)
    await expect(crmPost('/api/companies', { name: 'X' })).rejects.toMatchObject({ retryable: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.method).toBe('POST')
  })
})

// ── 3. updateCompany ───────────────────────────────────────────────────────

describe('updateCompany', () => {
  beforeEach(() => {
    envMock.CRM_WRITE_ENABLED = true
  })

  it('sends only customFields', async () => {
    const calls = captureFetch()
    await new NxtSalesAdapter().updateCompany(COMPANY, {
      customFields: { intentScore: 100, qualificationStatus: 'Qualified - Unassigned' },
    })
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(Object.keys(body)).toEqual(['customFields'])
  })

  it('rebuilds the body, so a sibling key cannot ride along', async () => {
    const calls = captureFetch()
    // A caller casting past the type and attaching extra keys.
    await new NxtSalesAdapter().updateCompany(COMPANY, {
      customFields: { intentScore: 100 },
      name: 'Renamed Co',
      industry: 'Something else',
    } as never)
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(Object.keys(body)).toEqual(['customFields'])
    expect(JSON.stringify(body)).not.toContain('Renamed Co')
    expect(JSON.stringify(body)).not.toContain('Something else')
  })

  it('refuses a forbidden field before reaching the wire', async () => {
    const calls = captureFetch()
    await expect(
      new NxtSalesAdapter().updateCompany(COMPANY, { ownerId: 'someone' } as never),
    ).rejects.toThrow(/Owner reassignment/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a forbidden field nested in customFields', async () => {
    const calls = captureFetch()
    await expect(
      new NxtSalesAdapter().updateCompany(COMPANY, { customFields: { ownerId: 'x' } } as never),
    ).rejects.toThrow(/customFields.ownerId/)
    expect(calls).toHaveLength(0)
  })
})

// ── 4. THE PORT CONTRACT ───────────────────────────────────────────────────

describe('the port declares one write and no more', () => {
  const port = () =>
    import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/crm/crmPort.ts', import.meta.url), 'utf8'),
    )

  it('declares updateCompany as optional', async () => {
    expect(await port()).toMatch(/updateCompany\?\(/)
  })

  it('declares no create, delete or deal write', async () => {
    const src = await port()
    for (const m of ['createCompany', 'deleteCompany', 'createDeal', 'updateDeal', 'createActivity']) {
      expect(src, m).not.toContain(`${m}(`)
    }
  })

  it('types the patch so only custom fields fit', async () => {
    const src = await port()
    const patch = src.slice(src.indexOf('export interface CompanyCustomFieldPatch'))
    expect(patch).toMatch(/customFields: Record<string, number \| string>/)
    for (const f of ['ownerId', 'leadStatus', 'name', 'stage']) {
      expect(patch.slice(0, 300), f).not.toContain(f)
    }
  })
})

// ── 5. IDENTITY MUST MATCH THE HOST BEING WRITTEN TO ───────────────────────
//
// NXT Sales verifies a token's SIGNATURE ONLY — no user lookup, no role check.
// A write signed with the wrong id is accepted silently and recorded in the CRM
// against whoever that id names. Base URL and service id are separate settings,
// so nothing but this guard keeps them in step.

// ── THE LIVE CRM IS READ-ONLY BY DEFAULT ───────────────────────────────────
//
// The platform is connected to the live CRM to READ leads. Repointing the base
// URL is one setting and enabling writes is another, and neither should be
// able to produce a live write on its own — so a non-local target is refused
// unless somebody says so in a third, separate place.

describe('a live target refuses writes of its own accord', () => {
  beforeEach(() => {
    envMock.CRM_WRITE_ENABLED = true
    envMock.CRM_WRITE_ALLOW_LIVE = false
  })

  it('refuses although writes are enabled and the identity is right', async () => {
    const calls = captureFetch()
    await expect(crmPut('/api/companies/x', { customFields: { intentScore: 1 } })).rejects.toThrow(
      /CRM_WRITE_ALLOW_LIVE is off/,
    )
    expect(calls, 'nothing may reach the wire').toHaveLength(0)
  })

  it('says plainly that nothing was sent', async () => {
    captureFetch()
    await expect(crmPut('/api/companies/x', { customFields: {} })).rejects.toThrow(/Nothing was sent/)
  })

  it('does not stand in the way of a local snapshot', async () => {
    const calls = captureFetch()
    envMock.NXT_SALES_BASE_URL = 'http://localhost:4000'
    await crmPut('/api/companies/x', { customFields: { intentScore: 1 } })
    expect(calls).toHaveLength(1)
  })

  it('lets a live write through once it is deliberately allowed', async () => {
    const calls = captureFetch()
    envMock.CRM_WRITE_ALLOW_LIVE = true
    await crmPut('/api/companies/x', { customFields: { intentScore: 1 } })
    expect(calls).toHaveLength(1)
  })

  it('refuses before the identity check, so reading live needs no service id at all', async () => {
    const calls = captureFetch()
    envMock.NXT_SALES_LIVE_SERVICE_USER_ID = ''
    await expect(crmPut('/api/companies/x', { customFields: {} })).rejects.toThrow(/CRM_WRITE_ALLOW_LIVE is off/)
    expect(calls).toHaveLength(0)
  })
})

describe('service identity must match the target host', () => {
  beforeEach(() => {
    envMock.CRM_WRITE_ENABLED = true
  })

  it('refuses a live write when the id is not the confirmed one', async () => {
    const calls = captureFetch()
    envMock.NXT_SALES_SERVICE_USER_ID = 'cmrbr0txx0000excbbckaah8j' // a colleague's id
    await expect(crmPut('/api/companies/x', { customFields: {} })).rejects.toThrow(
      /not the identity confirmed for this host/,
    )
    expect(calls, 'nothing may reach the wire').toHaveLength(0)
  })

  it('refuses a live write when no identity has been confirmed', async () => {
    const calls = captureFetch()
    envMock.NXT_SALES_LIVE_SERVICE_USER_ID = ''
    await expect(crmPut('/api/companies/x', { customFields: {} })).rejects.toThrow(
      /no confirmed identity/,
    )
    expect(calls).toHaveLength(0)
  })

  it('allows the write when the identity matches', async () => {
    const calls = captureFetch()
    await crmPut('/api/companies/x', { customFields: { intentScore: 1 } })
    expect(calls).toHaveLength(1)
  })

  it('treats an unparseable base URL as live rather than local', async () => {
    const calls = captureFetch()
    envMock.NXT_SALES_BASE_URL = 'not a url'
    envMock.NXT_SALES_LIVE_SERVICE_USER_ID = ''
    await expect(crmPut('/api/companies/x', { customFields: {} })).rejects.toThrow(/no confirmed identity/)
    expect(calls).toHaveLength(0)
  })

  it('exempts local hosts, where there is no audit trail to falsify', async () => {
    const { isLocalTarget } = await import('../../src/crmsync/writeGate.js')
    for (const u of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000']) {
      expect(isLocalTarget(u), u).toBe(true)
    }
    for (const u of ['https://nxtsales.altiusnxt.tech', 'http://crm.test', 'garbage']) {
      expect(isLocalTarget(u), u).toBe(false)
    }
  })
})

// -- 6. THE CONFIGURED IDENTITY IS NOT A COLLEAGUE'S -----------------------

describe('the shipped configuration', () => {
  it('does not name a personal identity that agent writes would be stamped with', async () => {
    const fs = await import('node:fs')
    const url = new URL('../../.env', import.meta.url)
    if (!fs.existsSync(url)) return // .env is not committed; skip where absent

    const read = (key: string): string => {
      const line = fs
        .readFileSync(url, 'utf8')
        .split(/\r?\n/)
        .find((l) => l.startsWith(key + '='))
      return (line ?? '').slice(key.length + 1).trim().replace(/^"|"$/g, '')
    }

    const id = read('NXT_SALES_SERVICE_USER_ID')
    const confirmed = read('NXT_SALES_LIVE_SERVICE_USER_ID')
    expect(id, 'service id must be set').toBeTruthy()
    expect(id, 'service id must be the confirmed live identity').toBe(confirmed)
    expect(fs.readFileSync(url, 'utf8').toLowerCase()).not.toContain('saranya@')
  })

  it('keeps writes switched off', async () => {
    const fs = await import('node:fs')
    const url = new URL('../../.env', import.meta.url)
    if (!fs.existsSync(url)) return
    expect(fs.readFileSync(url, 'utf8')).toContain('CRM_WRITE_ENABLED=false')
  })
})
