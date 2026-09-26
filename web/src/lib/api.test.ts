import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, Resource, api } from './api'

// ─────────────────────────────────────────────────────────────────────────
// A missing route must never become an empty result.
//
// THE DEFECT: nullOn404 collapsed every 404 to null. A route that was not
// mounted, a dev proxy answering in the API's place and a resource the engines
// have genuinely not built yet all arrived at the screens as the same value —
// null — which the screens then drew as "0 products", "0 findings", "no
// workbench". An operator reading that has no way to know whether the audit
// found nothing or the request never reached the audit.
//
// The engines' error handler stamps every application answer with
// { error: { code, message } }. That envelope is the only evidence that the
// application, rather than the network, said no.
// ─────────────────────────────────────────────────────────────────────────

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** What the engines answer when a resource exists but has not been built. */
const NOT_BUILT = {
  error: { code: 'not_found', message: 'No Workbench has been built for that audit run yet.' },
}

afterEach(() => vi.unstubAllGlobals())

describe('nullOn404 answers only for a 404 the application authored', () => {
  it('returns null when the envelope says the resource is not built yet', async () => {
    vi.stubGlobal('fetch', async () => json(NOT_BUILT, 404))
    await expect(api.get('/website-audit/runs/r1/workbench', { nullOn404: true })).resolves.toBeNull()
  })

  it('throws for a 404 carrying an HTML body — a proxy answered, not the API', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('<!doctype html><title>404</title>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    const err = await api
      .get('/website-audit/runs/r1/workbench', { nullOn404: true })
      .catch((e: unknown) => e)

    expect(err, 'this is the value that used to be silently null').toBeInstanceOf(ApiError)
    expect((err as ApiError).isApplicationError).toBe(false)
    expect((err as ApiError).isMissingRoute).toBe(true)
  })

  it('throws for a 404 with an empty body', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    await expect(api.get('/x', { nullOn404: true })).rejects.toBeInstanceOf(ApiError)
  })

  it('throws for a 404 whose JSON carries no error envelope', async () => {
    vi.stubGlobal('fetch', async () => json({}, 404))
    await expect(api.get('/x', { nullOn404: true })).rejects.toBeInstanceOf(ApiError)
  })

  it("throws for the router's own catch-all, which wears the envelope but means the route is gone", async () => {
    // Express's terminal handler emits our envelope for a path no router
    // claimed, so the envelope alone cannot be trusted; the sentence can.
    vi.stubGlobal('fetch', async () =>
      json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404),
    )
    const err = (await api.get('/nope', { nullOn404: true }).catch((e: unknown) => e)) as ApiError

    expect(err).toBeInstanceOf(ApiError)
    expect(err.isMissingRoute).toBe(true)
    // The sentence still reaches the screen: it is the clearest thing anyone
    // will say about a route that is not mounted.
    expect(err.message).toBe('No such endpoint.')
  })
})

describe('api.resource separates absent from broken', () => {
  it('reports absent, quoting the backend rather than inventing copy', async () => {
    vi.stubGlobal('fetch', async () => json(NOT_BUILT, 404))
    const state = await api.resource('/website-audit/runs/r1/workbench')

    expect(state.kind).toBe('absent')
    expect(state).toEqual({
      kind: 'absent',
      reason: 'No Workbench has been built for that audit run yet.',
      code: 'not_found',
    })
  })

  it('reports error — not absent — when the route is missing', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>nginx</html>', { status: 404 }))
    const state = await api.resource('/website-audit/runs/r1/workbench')

    expect(state.kind, 'a missing route is never an empty audit').toBe('error')
  })

  it('reports error when the API cannot be reached at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const state = await api.resource('/anything')

    expect(state.kind).toBe('error')
    expect(state.kind === 'error' && state.error.status).toBe(0)
  })

  it('reports error for a 500, which says nothing about what exists', async () => {
    vi.stubGlobal('fetch', async () =>
      json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500),
    )
    expect((await api.resource('/x')).kind).toBe('error')
  })

  it('reports ready with the body untouched', async () => {
    vi.stubGlobal('fetch', async () => json({ total: 0, candidates: [] }, 200))
    const state = await api.resource<{ total: number }>('/decision-makers/companies/c1/candidates')

    // Zero findings from a completed run is a RESULT, and stays one.
    expect(state).toEqual({ kind: 'ready', data: { total: 0, candidates: [] } })
  })

  it('still rejects an aborted request, so a stale response cannot land', async () => {
    vi.stubGlobal('fetch', async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    })
    await expect(api.resource('/x')).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('Resource.absent lets a screen name an absence it already knows about', () => {
  it('carries the screen’s own sentence', () => {
    // The real case: a run queued and never crawled has a zero-valued report
    // row beside it. That is not a report, and must not be rendered as one.
    const state = Resource.absent<{ total: number }>('No completed website audit for this company.')

    expect(state).toEqual({
      kind: 'absent',
      reason: 'No completed website audit for this company.',
      code: 'not_built',
    })
  })
})
