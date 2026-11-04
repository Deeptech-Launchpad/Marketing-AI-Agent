import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../src/config/env.js'

// THE PAGE READER MUST COPE WITH WHAT REAL SERVERS SEND, exactly as fetch() did.
//
// Found in review of the pinned transport: (1) a status outside 200-599 (LinkedIn answers bots with HTTP 999) made the
// Response constructor throw inside an event handler, which kills the process; (2) strict zlib rejected bodies that
// fetch() accepted (truncated, empty, raw deflate, "br, gzip"); (3) a deadline that fired mid-body was reported as a
// "reset" instead of "too slow"; (4) an address with a user name and password used to be refused and must still be.
// Nothing here touches a network: DNS and sockets are fakes.

vi.mock('../../src/platform/db.js', () => ({ prisma: {}, newId: () => 'id_test' }))
const guard = await import('../../src/research/ssrfGuard.js')
const { fetchPageRaw, pinnedRequest, setTransportForTests, describeFetchFailure } = await import('../../src/research/pageFetch.js')

interface Reply {
  status: number
  headers?: Record<string, string>
  body?: string | Buffer
  /** A body that sends this much and then stalls forever. */
  stallAfter?: string | Buffer
}

let connections = 0
function wire(script: (url: URL) => Reply) {
  connections = 0
  guard.setResolverForTests(async () => [{ address: '93.184.216.34', family: 4 as const }])
  const request = (url: URL, options: Record<string, any>, cb: (res: Readable) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void }
    req.destroy = (e) => {
      if (e) req.emit('error', e)
    }
    req.end = () => {
      setImmediate(() => {
        connections++
        const s = script(url)
        const res = (s.stallAfter !== undefined
          ? new Readable({ read() { if (!(this as any)._sent) { (this as any)._sent = true; this.push(Buffer.from(s.stallAfter as string | Buffer)) } } })
          : Readable.from([Buffer.from(s.body ?? '')])) as Readable & { statusCode: number; headers: Record<string, string> }
        res.statusCode = s.status
        res.headers = s.headers ?? {}
        cb(res)
      })
    }
    return req
  }
  const deps = { http: { request }, https: { request } } as unknown as Parameters<typeof pinnedRequest>[3]
  setTransportForTests((url, headers, opts) => pinnedRequest(url, headers, opts, deps))
}

const savedTimeout = env.RESEARCH_FETCH_TIMEOUT_MS
beforeEach(() => guard.setResolverForTests(null))
afterEach(() => {
  guard.setResolverForTests(null)
  setTransportForTests(null)
  env.RESEARCH_FETCH_TIMEOUT_MS = savedTimeout
})

const PAGE = '<html><head><title>Acme Retail</title></head><body>' + 'We are hiring a sales manager. '.repeat(40) + '</body></html>'
const html = { 'content-type': 'text/html; charset=utf-8' }

describe('any status a server sends is reported, never a crash', () => {
  for (const status of [999, 600, 199, 100, 101, 102, 450, 599, 205, 204, 304]) {
    it(`HTTP ${status}`, async () => {
      wire(() => ({ status, headers: html, body: status === 205 || status === 204 || status === 304 ? '' : PAGE }))
      const r = await fetchPageRaw('https://acme.test/')
      // The reader returned an answer (it did not throw, and the process did not die on an uncaught error).
      expect(r.ok).toBe(false)
      if (status === 204 || status === 205) expect(r.reason).toBe('The site returned an empty response.') // a page with no body, as before
      else expect(r.status).toBe(status)
    })
  }

  it('HTTP 999 (LinkedIn) is the fact "the site returned HTTP 999", as before', async () => {
    wire(() => ({ status: 999, headers: html, body: 'Request denied' }))
    const r = await fetchPageRaw('https://www.linkedin.com/company/acme')
    expect(r).toMatchObject({ ok: false, status: 999, reason: 'The site returned HTTP 999.' })
  })

  it('a 205 that arrives with a body does not throw', async () => {
    wire(() => ({ status: 205, headers: html, body: 'ignored' }))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('The site returned an empty response.')
  })

  it('an ordinary 200 is still read', async () => {
    wire(() => ({ status: 200, headers: html, body: PAGE }))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r).toMatchObject({ ok: true, status: 200 })
    expect(r.html).toContain('Acme Retail')
  })
})

describe('compressed bodies are read as leniently as fetch() read them', () => {
  const enc = (e: string, body: Buffer) => ({ status: 200, headers: { ...html, 'content-encoding': e }, body })
  const text = Buffer.from(PAGE)

  it('gzip, deflate (zlib-wrapped) and brotli', async () => {
    for (const [e, b] of [['gzip', zlib.gzipSync(text)], ['deflate', zlib.deflateSync(text)], ['br', zlib.brotliCompressSync(text)]] as const) {
      wire(() => enc(e, b))
      const r = await fetchPageRaw('https://acme.test/')
      expect(r.ok, e).toBe(true)
      expect(r.html, e).toBe(PAGE)
    }
  })

  it('"deflate" that is really raw deflate (some IIS and older servers)', async () => {
    wire(() => enc('deflate', zlib.deflateRawSync(text)))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r.ok).toBe(true)
    expect(r.html).toBe(PAGE)
  })

  it('stacked encodings are applied in the right order: "br, gzip" means brotli first, then gzip', async () => {
    wire(() => enc('br, gzip', zlib.gzipSync(zlib.brotliCompressSync(text))))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r.html).toBe(PAGE)
  })

  it('a gzip body cut off before its end still yields the part that arrived', async () => {
    const varied = Buffer.from('<html><body>' + Array.from({ length: 400 }, (_, i) => `Item ${i} ${(i * 7919).toString(36)} ${(i * 104729).toString(16)}`).join(' ') + '</body></html>')
    const whole = zlib.gzipSync(varied)
    wire(() => enc('gzip', whole.subarray(0, Math.floor(whole.length * 0.8))))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r.ok).toBe(true)
    expect(r.html.length).toBeGreaterThan(100)
    expect(varied.toString().startsWith(r.html)).toBe(true)
  })

  it('an empty body labelled gzip is an empty page, not a failure to reach the site', async () => {
    wire(() => enc('gzip', Buffer.alloc(0)))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r.reason ?? '').not.toMatch(/reach that site/)
  })

  it('an encoding it does not know is refused with a clear sentence', async () => {
    wire(() => enc('compress', text))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })
})

describe('a deadline that fires while the body is arriving', () => {
  it('is reported as "took too long", not as a reset connection', async () => {
    env.RESEARCH_FETCH_TIMEOUT_MS = 250
    wire(() => ({ status: 200, headers: html, stallAfter: '<html><title>Slow</title>' }))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('The site took too long to respond.')
  })

  it('the same for a compressed body that stalls', async () => {
    env.RESEARCH_FETCH_TIMEOUT_MS = 250
    wire(() => ({ status: 200, headers: { ...html, 'content-encoding': 'gzip' }, stallAfter: zlib.gzipSync(Buffer.from(PAGE)).subarray(0, 12) }))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r.ok).toBe(false)
    expect(['The site took too long to respond.', 'The site returned an empty response.']).toContain(r.reason)
  })

  it('describeFetchFailure maps the timeout error to the same sentence', () => {
    expect(describeFetchFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('The site took too long to respond.')
  })
})

describe('addresses with a user name or password are still refused', () => {
  it('nothing is sent', async () => {
    wire(() => ({ status: 200, headers: html, body: PAGE }))
    const r = await fetchPageRaw('https://admin:secret@acme.test/')
    expect(r.ok).toBe(false)
    expect(r.reason ?? '').toMatch(/user name or password|valid http/i)
    expect(connections).toBe(0)
  })

  it('and a redirect to such an address is refused before anything is sent to it', async () => {
    wire((url) => (url.hostname === 'acme.test' ? { status: 301, headers: { location: 'https://u:p@evil.test/' } } : { status: 200, headers: html, body: PAGE }))
    const r = await fetchPageRaw('https://acme.test/')
    expect(r.ok).toBe(false)
    expect(connections).toBe(1) // only the first hop
  })
})
