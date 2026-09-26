import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Two properties of the shared page fetcher that Stage 2 depends on:
//
//  1. The request deadline covers the BODY, not just the headers. A server that
//     answers promptly and then drips its body forever must not hang a job.
//  2. A page served from the ResearchArtifact cache says so, with the time it
//     was really fetched, and a caller can ask to bypass the cache.

const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
vi.mock('node:dns/promises', () => ({ default: { lookup: (...a: unknown[]) => lookup(...(a as [])) } }))

const db = {
  researchArtifact: { findFirst: vi.fn(), create: vi.fn(async () => ({})) },
}
vi.mock('../../src/platform/db.js', () => ({ prisma: db, newId: () => 'id_test' }))

const { fetchPageRaw, fetchPage } = await import('../../src/research/pageFetch.js')
const { env } = await import('../../src/config/env.js')

function htmlResponse(read: (signal: AbortSignal) => Promise<{ done: boolean; value?: Uint8Array }>, signal: AbortSignal) {
  return {
    status: 200,
    ok: true,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
    body: {
      getReader: () => ({ read: () => read(signal), cancel: async () => undefined }),
      cancel: async () => undefined,
    },
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  db.researchArtifact.findFirst.mockReset()
  db.researchArtifact.create.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('body download deadline', () => {
  it('aborts a slow-drip body once the request budget is spent', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      let sent = false
      return htmlResponse(
        (signal) =>
          new Promise((resolve, reject) => {
            if (!sent) {
              sent = true
              resolve({ done: false, value: new TextEncoder().encode('<html><body>') })
              return
            }
            // Never finishes on its own; only the deadline can end it.
            const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          }),
        init.signal,
      )
    })

    const pending = fetchPageRaw('https://slow.example.test/')
    await vi.advanceTimersByTimeAsync(env.RESEARCH_FETCH_TIMEOUT_MS + 50)
    const out = await pending

    expect(out.ok).toBe(false)
    expect(out.reason).toBe('The site took too long to respond.')
  })

  it('still reads a body that arrives within the budget', async () => {
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      const chunks = [new TextEncoder().encode('<html><title>Ok</title></html>')]
      return htmlResponse(async () => {
        const value = chunks.shift()
        return value ? { done: false, value } : { done: true }
      }, init.signal)
    })
    const out = await fetchPageRaw('https://fast.example.test/')
    expect(out.ok).toBe(true)
    expect(out.html).toContain('<title>Ok</title>')
  })
})

describe('cache honesty', () => {
  const okFetch = async (_url: string, init: { signal: AbortSignal }) => {
    const chunks = [new TextEncoder().encode('<html><title>Live</title></html>')]
    return htmlResponse(async () => {
      const value = chunks.shift()
      return value ? { done: false, value } : { done: true }
    }, init.signal)
  }

  it('marks a cached page as cached and carries the original fetch time', async () => {
    const original = new Date('2026-01-02T03:04:05Z')
    db.researchArtifact.findFirst.mockResolvedValue({
      ok: true,
      finalUrl: 'https://acme.example.test/',
      extractedText: 'cached text',
      signals: null,
      failureReason: null,
      fetchedAt: original,
    })
    const out = await fetchPage('https://acme.example.test/', { tenantId: 't1' })
    expect(out.cached).toBe(true)
    expect(out.fetchedAt).toBe(original.toISOString())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fresh: true bypasses the cache read and reports a live fetch', async () => {
    fetchMock.mockImplementation(okFetch)
    const out = await fetchPage('https://acme.example.test/', { tenantId: 't1', fresh: true })
    expect(db.researchArtifact.findFirst).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.ok).toBe(true)
    expect(out.cached).toBe(false)
    expect(out.fetchedAt).toBeTruthy()
    // Still written to the cache for everyone else.
    expect(db.researchArtifact.create).toHaveBeenCalledTimes(1)
  })

  it('default callers still use the cache', async () => {
    db.researchArtifact.findFirst.mockResolvedValue(null)
    fetchMock.mockImplementation(okFetch)
    const out = await fetchPage('https://acme.example.test/', { tenantId: 't1' })
    expect(db.researchArtifact.findFirst).toHaveBeenCalledTimes(1)
    expect(out.cached).toBe(false)
  })
})
