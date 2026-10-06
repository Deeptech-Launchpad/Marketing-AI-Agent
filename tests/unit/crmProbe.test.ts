import { afterEach, describe, expect, it, vi } from 'vitest'

// THE READINESS CHECK ASKS NXT SALES A REAL QUESTION (2026-10-06).
//
// /health/ready used to ask NXT Sales for /health, with no token. NXT Sales has
// no such page behind its website, which answered with its HTML, so readiness
// reported the CRM down every single time on live. It now asks /api/auth/me —
// one read of the service user — with the same address and token as every
// real call. No request in this file leaves the machine: fetch is replaced.

const { env } = await import('../../src/config/env.js')
const { probeCrm } = await import('../../src/crm/nxtSales/httpClient.js')

const seen: Array<{ url: string; headers: Record<string, string> }> = []
const answer = (status: number, body: string, type = 'application/json') =>
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    seen.push({ url: String(url), headers: init.headers as Record<string, string> })
    return new Response(body, { status, headers: { 'content-type': type } })
  })

afterEach(() => {
  vi.unstubAllGlobals()
  seen.length = 0
})

describe('the NXT Sales readiness probe', () => {
  it('asks /api/auth/me with this platform’s token, as the real calls do', async () => {
    answer(200, JSON.stringify({ id: env.NXT_SALES_SERVICE_USER_ID, name: 'Marketing Agent' }))
    expect(await probeCrm()).toEqual({ ok: true })
    expect(seen[0]!.url).toBe(`${env.NXT_SALES_BASE_URL}/api/auth/me`)
    expect(seen[0]!.headers.Authorization).toMatch(/^Bearer \S+\.\S+\.\S+$/)
  })

  it('is not fooled by the website answering 200 with a page — the live bug', async () => {
    answer(200, '<!DOCTYPE html><html>…</html>', 'text/html')
    const r = await probeCrm()
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/web page instead of data/)
  })

  it('reports a refused credential plainly', async () => {
    answer(401, JSON.stringify({ error: 'Unauthorized' }))
    expect(await probeCrm()).toEqual({ ok: false, detail: 'NXT Sales answered HTTP 401.' })
  })

  it('fails when NXT Sales does not know the service user', async () => {
    answer(200, 'null')
    expect((await probeCrm()).detail).toMatch(/service user/)
  })

  it('reports an unreachable CRM rather than throwing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    expect(await probeCrm()).toEqual({ ok: false, detail: 'fetch failed' })
  })
})
