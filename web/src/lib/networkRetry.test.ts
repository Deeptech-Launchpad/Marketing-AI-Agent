import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

// A DROPPED CONNECTION IS NOT A DEAD SERVICE (2026-10-07).
//
// A laptop switching Wi-Fi, a hotspot or a VPN drops requests in flight
// (net::ERR_NETWORK_CHANGED). One dropped poll on the Intent screen turned the
// whole panel into "the service could not be reached — start the API". Reads
// are now tried again; writes never are.

afterEach(() => vi.unstubAllGlobals())

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('a read that fails at the network level', () => {
  it('is tried again, and the screen gets its data', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok({ runs: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.get('/intent/runs')).resolves.toEqual({ runs: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('says the connection was lost — not that a service must be started — when it keeps failing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const err = await api.get('/intent/runs').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toMatch(/connection to the Marketing AI service was lost/)
    expect((err as ApiError).message).not.toMatch(/port 4100/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  }, 10_000)
})

describe('a write that fails at the network level', () => {
  it('is never sent twice', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.post('/intent/runs', { crmCompanyIds: ['c1'] })).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
