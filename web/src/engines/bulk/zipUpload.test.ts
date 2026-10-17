import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadZipInPieces } from './zipUpload'

// Uploading a ZIP in pieces (2026-10-18): only the piece that failed is sent again, and after any doubt
// the upload carries on from where the SERVER says its copy ends.

interface Call {
  method: string
  url: string
  size?: number
}

/** A fake server holding one upload; `script` can make a request misbehave. */
function fakeServer(total: number, chunkBytes: number, script: (call: Call, state: { got: number }) => Response | 'lose-answer' | null = () => null) {
  const state = { got: 0, started: false, finished: 0 }
  const calls: Call[] = []
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url).replace('/api/v1', '')
    const method = (init.method ?? 'GET').toUpperCase()
    const call: Call = { method, url: u, size: init.body instanceof Blob ? init.body.size : undefined }
    calls.push(call)
    const scripted = script(call, state)
    if (scripted === 'lose-answer') {
      if (u.includes('/chunk')) state.got += call.size ?? 0 // the server received it; only the answer was lost
      throw new TypeError('network')
    }
    if (scripted) return scripted
    if (u.endsWith('/zip/start')) return json({ id: 'up1', fileName: 'x.zip', sizeBytes: total, chunkBytes }, 201)
    if (u.includes('/zip/up1/chunk')) {
      const offset = Number(new URL(u, 'http://x').searchParams.get('offset'))
      if (offset !== state.got) return json({ error: { code: 'conflict', message: `The server has ${state.got} bytes`, details: { receivedBytes: state.got } } }, 409)
      state.got += call.size ?? 0
      return json({ receivedBytes: state.got })
    }
    if (u.endsWith('/zip/up1/finish')) {
      state.finished++
      return state.got === total ? json({ id: 'up1', fileName: 'x.zip', sizeBytes: total }, 201) : json({ error: { code: 'conflict', message: 'incomplete', details: { receivedBytes: state.got } } }, 409)
    }
    if (method === 'DELETE') return json({ id: 'up1', removed: true })
    return json({ error: { code: 'not_found', message: 'none' } }, 404)
  })
  return { calls, state }
}

const file = (size: number) => new File([new Uint8Array(size)], 'x.zip')
const chunks = (calls: Call[]) => calls.filter((c) => c.url.includes('/chunk')).map((c) => [Number(new URL(c.url, 'http://x').searchParams.get('offset')), c.size])
const removed = (calls: Call[]) => calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/attachments/up1'))

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.unstubAllGlobals())

describe('uploading a ZIP in pieces', () => {
  it('sends the file piece by piece, each at the offset where the server\'s copy ends, then finishes; progress follows the bytes the server has', async () => {
    const { calls } = fakeServer(2500, 1000)
    const seen: number[] = []
    const result = await uploadZipInPieces(file(2500), (n) => seen.push(n), { pauseMs: 0 })
    expect(result).toEqual({ id: 'up1', fileName: 'x.zip', sizeBytes: 2500 })
    expect(chunks(calls)).toEqual([[0, 1000], [1000, 1000], [2000, 500]])
    expect(seen).toEqual([0, 1000, 2000, 2500])
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/outreach/bulk/attachments/zip/start' })
    expect(calls[calls.length - 1]).toMatchObject({ method: 'POST', url: '/outreach/bulk/attachments/zip/up1/finish' })
    expect(removed(calls)).toBe(false)
  })

  it('a ZIP of exactly one piece, and one that ends exactly on a piece boundary, are sent whole', async () => {
    let s = fakeServer(1000, 1000)
    await uploadZipInPieces(file(1000), () => undefined, { pauseMs: 0 })
    expect(chunks(s.calls)).toEqual([[0, 1000]])
    s = fakeServer(2000, 1000)
    await uploadZipInPieces(file(2000), () => undefined, { pauseMs: 0 })
    expect(chunks(s.calls)).toEqual([[0, 1000], [1000, 1000]])
  })

  it('an answer that was lost does not send the piece twice: the server\'s 409 says where it is, and the upload carries on from there', async () => {
    let lost = false
    const { calls, state } = fakeServer(3000, 1000, (c) => {
      if (!lost && c.url.includes('offset=1000')) {
        lost = true
        return 'lose-answer'
      }
      return null
    })
    const result = await uploadZipInPieces(file(3000), () => undefined, { pauseMs: 0 })
    expect(result.sizeBytes).toBe(3000)
    expect(state.got).toBe(3000)
    // offset 1000 was sent, its answer lost; it is sent again, the server answers 409 "I have 2000"; the next piece goes at 2000.
    expect(chunks(calls)).toEqual([[0, 1000], [1000, 1000], [1000, 1000], [2000, 1000]])
  })

  it('a dropped connection or a server hiccup is tried again for that piece only, with the whole upload unharmed', async () => {
    let failures = 0
    const { calls } = fakeServer(2000, 1000, (c) => {
      if (c.url.includes('offset=1000') && failures < 2) {
        failures++
        return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Something went wrong.' } }), { status: failures === 1 ? 502 : 503 })
      }
      return null
    })
    await uploadZipInPieces(file(2000), () => undefined, { pauseMs: 0 })
    expect(chunks(calls)).toEqual([[0, 1000], [1000, 1000], [1000, 1000], [1000, 1000]])
  })

  it('gives up after repeated failures with the server\'s own words, and removes what it started', async () => {
    const { calls } = fakeServer(2000, 1000, (c) => (c.url.includes('offset=1000') ? new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Something went wrong.' } }), { status: 500 }) : null))
    await expect(uploadZipInPieces(file(2000), () => undefined, { pauseMs: 0 })).rejects.toThrow(/Something went wrong/)
    expect(chunks(calls).filter(([o]) => o === 1000)).toHaveLength(9) // the first try and eight more (about two minutes of trouble in real life)
    expect(removed(calls)).toBe(true)
  })

  it('a refusal (not a connection problem) is not retried: it stops at once and the upload is removed', async () => {
    const { calls } = fakeServer(2000, 1000, (c) => (c.url.includes('offset=1000') ? new Response(JSON.stringify({ error: { code: 'bad_request', message: 'More data arrived than the size of the ZIP.' } }), { status: 400 }) : null))
    await expect(uploadZipInPieces(file(2000), () => undefined, { pauseMs: 0 })).rejects.toThrow(/More data arrived/)
    expect(chunks(calls).filter(([o]) => o === 1000)).toHaveLength(1)
    expect(removed(calls)).toBe(true)
  })

  it('a server that keeps answering 409 with the same position cannot keep the screen in a loop', async () => {
    const { calls } = fakeServer(2000, 1000, (c) => (c.url.includes('/chunk') ? new Response(JSON.stringify({ error: { code: 'conflict', message: 'stuck', details: { receivedBytes: 0 } } }), { status: 409 }) : null))
    await expect(uploadZipInPieces(file(2000), () => undefined, { pauseMs: 0 })).rejects.toThrow(/stuck/)
    expect(chunks(calls).length).toBeLessThanOrEqual(5)
    expect(removed(calls)).toBe(true)
  })

  it('a slow end (the gateway timed out while the server was still checking the ZIP) is asked again and gets the same answer', async () => {
    let timedOut = false
    const { calls, state } = fakeServer(1500, 1000, (c) => {
      if (c.url.endsWith('/finish') && !timedOut) {
        timedOut = true
        return new Response('<html>504 Gateway Time-out</html>', { status: 504 })
      }
      return null
    })
    const result = await uploadZipInPieces(file(1500), () => undefined, { pauseMs: 0 })
    expect(result.sizeBytes).toBe(1500)
    expect(state.finished).toBe(1) // the first, timed-out request never reached the fake server's counter; the second did
    expect(calls.filter((c) => c.url.endsWith('/finish'))).toHaveLength(2)
  })

  it('a ZIP the server will not take at the start (too large, no space) fails with its words and leaves nothing to clean up', async () => {
    const { calls } = fakeServer(500, 1000, (c) =>
      c.url.endsWith('/zip/start') ? new Response(JSON.stringify({ error: { code: 'conflict', message: 'The server does not have enough free disk space for this ZIP. Ask an administrator.' } }), { status: 409 }) : null,
    )
    await expect(uploadZipInPieces(file(500), () => undefined, { pauseMs: 0 })).rejects.toThrow(/enough free disk space/)
    expect(calls).toHaveLength(1)
  })

  it('a file that cannot be read stops the upload instead of looping', async () => {
    fakeServer(2000, 1000)
    const broken = file(2000)
    Object.defineProperty(broken, 'slice', { value: () => new Blob([]) })
    await expect(uploadZipInPieces(broken, () => undefined, { pauseMs: 0 })).rejects.toThrow(/could not be read/)
  })
})
