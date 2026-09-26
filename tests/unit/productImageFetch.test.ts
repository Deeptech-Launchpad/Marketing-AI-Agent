import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// FETCHING THE CUSTOMER'S PRODUCT IMAGE.
//
// `product.image` is read verbatim off the audited page, so whoever controls
// that website controls the URL this code is asked to request. It is the only
// outbound call in src/ pointed at an address a stranger chose — everything
// else goes to an operator-configured API base.
//
// It used to call `fetch(url)` directly: protocol checked on the URL it was
// GIVEN, then up to twenty redirects followed with no further check. An image
// URL that 302s to http://169.254.169.254/ or to a service on the report
// host's own loopback was a request that left the building. The content-type
// test stopped the BYTES being embedded in the PDF; it never stopped the
// REQUEST.
//
// The size cap had the matching hole. `content-length` is absent on a chunked
// response, `Number(null ?? '0')` is 0, so the pre-check passed at zero and
// arrayBuffer() buffered the entire body before anything measured it.
//
// These tests had no predecessors — fetchProductImages was untested, which is
// how both holes survived. They are written against the boundary that matters:
// what leaves the machine, and what it is allowed to spend doing it.

const lookup = vi.fn()
vi.mock('node:dns/promises', () => ({ default: { lookup: (...a: unknown[]) => lookup(...a) } }))

const { fetchProductImages } = await import('../../src/websiteaudit/productImages.js')

/** One response, shaped the way fetchAsset actually reads a response. */
function response(opts: {
  status?: number
  headers?: Record<string, string>
  chunks?: Uint8Array[]
  /** Yields forever, so a consumer that does not stop is caught by the test timing out. */
  endless?: boolean
}): unknown {
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const chunks = [...(opts.chunks ?? [])]
  let cancelled = false
  const reader = {
    read: async () => {
      if (cancelled) return { done: true, value: undefined }
      if (opts.endless) {
        pulled += 1
        return { done: false, value: new Uint8Array(64 * 1024) }
      }
      const value = chunks.shift()
      if (!value) return { done: true, value: undefined }
      pulled += 1
      return { done: false, value }
    },
    cancel: async () => {
      cancelled = true
    },
  }
  const status = opts.status ?? 200
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: { getReader: () => reader, cancel: async () => void (cancelled = true) },
  }
}

/** How many chunks the transport actually pulled — the streaming evidence. */
let pulled = 0
let requested: string[] = []
const fetchMock = vi.fn()

const PUBLIC_IMAGE = 'https://cdn.example-supplier.test/widget.jpg'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const MB = (n: number) => new Uint8Array(n * 1024 * 1024)

beforeEach(() => {
  pulled = 0
  requested = []
  lookup.mockReset()
  // Every hostname resolves to one ordinary public address unless a test says
  // otherwise. A bare literal IP never reaches DNS at all — but a BRACKETED
  // IPv6 literal does, because `new URL('https://[::1]/x').hostname` keeps its
  // brackets and `net.isIP('[::1]')` is therefore 0. Node's own resolver
  // answers that with the address itself, so the mock does too: a mock that
  // handed back a public address for a loopback literal would be testing a
  // world that does not exist, and would hide the resolved-address check that
  // is what actually blocks it.
  lookup.mockImplementation(async (host: string) => {
    const v6 = /^\[(.+)\]$/.exec(host)
    return v6 ? [{ address: v6[1]!, family: 6 }] : [{ address: '93.184.216.34', family: 4 }]
  })
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => {
    requested.push(url)
    return response({ headers: { 'content-type': 'image/jpeg' }, chunks: [PNG] })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('1. a public image still loads', () => {
  it('returns the bytes, keyed by the URL as the audit observed it', async () => {
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(1)
    expect(out.get(PUBLIC_IMAGE)).toEqual(Buffer.from(PNG))
    expect(requested).toEqual([PUBLIC_IMAGE])
  })

  it('fetches each distinct URL once and ignores empties', async () => {
    const out = await fetchProductImages([PUBLIC_IMAGE, PUBLIC_IMAGE, null, undefined, ''])
    expect(out.size).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts png as well as jpeg', async () => {
    fetchMock.mockImplementation(async () => response({ headers: { 'content-type': 'image/png' }, chunks: [PNG] }))
    const out = await fetchProductImages(['https://cdn.test/a.png'])
    expect(out.size).toBe(1)
  })
})

describe('2. an image URL pointing straight at an internal address is refused', () => {
  // Literal IPs and the reserved names never reach DNS: assertPublicHost
  // classifies them itself, so this holds with no network of any kind.
  const INTERNAL = [
    'https://127.0.0.1/widget.jpg',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/widget.jpg',
    'https://192.168.1.20/widget.jpg',
    'https://172.16.4.4/widget.jpg',
    'https://[::1]/widget.jpg',
    'https://localhost/widget.jpg',
    'https://api.internal/widget.jpg',
  ]

  it('makes no request at all for any of them', async () => {
    const out = await fetchProductImages(INTERNAL)
    expect(out.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // A name that resolves to a private address is the version a URL filter
  // cannot see, and it is why the check is on the RESOLVED address.
  it('refuses a public-looking hostname that resolves to a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.1.2.3' }])
    const out = await fetchProductImages(['https://images.example-supplier.test/widget.jpg'])
    expect(out.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // One public and one private answer for the same name must not slip through.
  it('refuses when ANY resolved address is private', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34' }, { address: '127.0.0.1' }])
    const out = await fetchProductImages(['https://images.example-supplier.test/widget.jpg'])
    expect(out.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a scheme that is not http(s) without touching the network', async () => {
    const out = await fetchProductImages(['file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://h/x.png'])
    expect(out.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('3. a public URL that redirects to an internal address is refused', () => {
  // A mocked fetch cannot follow redirects the way the runtime's own does, so
  // this is the assertion that pins the actual fix: redirects are taken
  // MANUALLY, which is the only way there is a hop to revalidate at all. The
  // old code left this at the default and let the runtime follow up to twenty
  // hops with no check between them.
  it('asks the runtime not to follow redirects for it', async () => {
    await fetchProductImages([PUBLIC_IMAGE])
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.redirect).toBe('manual')
  })

  // THE DEFECT. The old code checked the URL it was given and then let fetch
  // follow this redirect itself, unchecked.
  it('does not follow a 302 into the loopback interface', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      requested.push(url)
      if (url === PUBLIC_IMAGE) {
        return response({ status: 302, headers: { location: 'https://127.0.0.1:4000/admin' } })
      }
      return response({ headers: { 'content-type': 'image/jpeg' }, chunks: [PNG] })
    })

    const out = await fetchProductImages([PUBLIC_IMAGE])

    expect(out.size).toBe(0)
    // The first request was made; the SECOND never was.
    expect(requested).toEqual([PUBLIC_IMAGE])
  })

  it('does not follow a 302 into the cloud metadata endpoint', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      requested.push(url)
      return url === PUBLIC_IMAGE
        ? response({ status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/iam/' } })
        : response({ headers: { 'content-type': 'image/jpeg' }, chunks: [PNG] })
    })
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
    expect(requested).toEqual([PUBLIC_IMAGE])
  })

  // The redirect target resolving privately is the same attack wearing a name.
  it('re-resolves the redirect target rather than trusting the first lookup', async () => {
    lookup.mockImplementation(async (host: string) =>
      host === 'cdn.example-supplier.test' ? [{ address: '93.184.216.34' }] : [{ address: '192.168.0.9' }],
    )
    fetchMock.mockImplementation(async (url: string) => {
      requested.push(url)
      return url === PUBLIC_IMAGE
        ? response({ status: 302, headers: { location: 'https://internal-mirror.example.test/widget.jpg' } })
        : response({ headers: { 'content-type': 'image/jpeg' }, chunks: [PNG] })
    })
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
    expect(requested).toEqual([PUBLIC_IMAGE])
  })

  it('refuses a redirect that downgrades https to plain http', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      requested.push(url)
      return url === PUBLIC_IMAGE
        ? response({ status: 302, headers: { location: 'http://cdn.example-supplier.test/widget.jpg' } })
        : response({ headers: { 'content-type': 'image/jpeg' }, chunks: [PNG] })
    })
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
    expect(requested).toEqual([PUBLIC_IMAGE])
  })

  // An image the page genuinely publishes over http still loads. Refusing it
  // would make the report state that a published image was not published,
  // which is a false statement about the customer's own site.
  it('still reads an image the page itself published over http', async () => {
    const http = 'http://cdn.example-supplier.test/widget.jpg'
    const out = await fetchProductImages([http])
    expect(out.get(http)).toEqual(Buffer.from(PNG))
  })

  it('gives up rather than following a redirect chain forever', async () => {
    let n = 0
    fetchMock.mockImplementation(async (url: string) => {
      requested.push(url)
      n += 1
      return response({ status: 302, headers: { location: `https://cdn.example-supplier.test/hop-${n}.jpg` } })
    })
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
    expect(requested.length).toBeLessThanOrEqual(6)
  })
})

describe('4. non-image content is refused, and its body is never read', () => {
  it('refuses an HTML error page dressed as an image URL', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      requested.push(url)
      return response({ headers: { 'content-type': 'text/html; charset=utf-8' }, chunks: [MB(1)] })
    })
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
    // The allowlist is applied BEFORE the body is touched.
    expect(pulled).toBe(0)
  })

  it('refuses the formats pdfkit cannot decode', async () => {
    for (const type of ['image/svg+xml', 'image/webp', 'image/gif', 'application/pdf']) {
      fetchMock.mockImplementation(async () => response({ headers: { 'content-type': type }, chunks: [PNG] }))
      const out = await fetchProductImages([PUBLIC_IMAGE])
      expect(out.size, type).toBe(0)
    }
  })

  it('refuses a non-2xx response without reading its body', async () => {
    fetchMock.mockImplementation(async () =>
      response({ status: 404, headers: { 'content-type': 'image/jpeg' }, chunks: [MB(1)] }),
    )
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
    expect(pulled).toBe(0)
  })
})

describe('5 & 6. the size limit is enforced against the stream, not a header', () => {
  it('refuses a body that exceeds the limit', async () => {
    fetchMock.mockImplementation(async () =>
      response({
        headers: { 'content-type': 'image/jpeg', 'content-length': String(5 * 1024 * 1024) },
        chunks: [MB(1), MB(1), MB(1), MB(1), MB(1)],
      }),
    )
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
  })

  // THE SECOND HALF OF THE DEFECT: content-length is absent on a chunked
  // response, so the old pre-check compared zero against the cap and passed,
  // then buffered the whole body with arrayBuffer() before measuring it.
  it('refuses a CHUNKED body with no content-length at all', async () => {
    fetchMock.mockImplementation(async () =>
      response({
        headers: { 'content-type': 'image/jpeg', 'transfer-encoding': 'chunked' },
        chunks: [MB(1), MB(1), MB(1), MB(1), MB(1)],
      }),
    )
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
  })

  // A lying content-length must not be able to authorise an unbounded read.
  it('stops an endless chunked body instead of buffering it', async () => {
    fetchMock.mockImplementation(async () =>
      response({ headers: { 'content-type': 'image/jpeg', 'content-length': '1024' }, endless: true }),
    )
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
    // 4MB cap at 64KB a chunk: it stops at 65, not at infinity.
    expect(pulled).toBeGreaterThan(0)
    expect(pulled).toBeLessThan(200)
  })

  it('accepts a body comfortably inside the limit', async () => {
    fetchMock.mockImplementation(async () =>
      response({ headers: { 'content-type': 'image/jpeg' }, chunks: [MB(1), MB(1)] }),
    )
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.get(PUBLIC_IMAGE)?.byteLength).toBe(2 * 1024 * 1024)
  })
})

describe('7. a failed image is still an honest absence', () => {
  it('never throws, whatever the URL does', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(
      fetchProductImages(['https://127.0.0.1/a.jpg', PUBLIC_IMAGE, 'file:///etc/passwd', null]),
    ).resolves.toBeInstanceOf(Map)
  })

  it('returns no entry rather than a placeholder', async () => {
    fetchMock.mockImplementation(async () => response({ status: 500 }))
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.has(PUBLIC_IMAGE)).toBe(false)
    expect(out.size).toBe(0)
    // The renderer looks the URL up and finds nothing, which is what makes it
    // print "No product image published on this page". Anything else here —
    // a stock image, a 1x1, an empty Buffer — would be a fabrication.
    expect([...out.values()]).toEqual([])
  })

  it('does not let one bad image cost a good one', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      requested.push(url)
      return url === PUBLIC_IMAGE
        ? response({ headers: { 'content-type': 'image/jpeg' }, chunks: [PNG] })
        : response({ status: 403 })
    })
    const out = await fetchProductImages([PUBLIC_IMAGE, 'https://cdn.test/missing.jpg'])
    expect(out.size).toBe(1)
    expect(out.has(PUBLIC_IMAGE)).toBe(true)
  })

  it('records an empty body as no image', async () => {
    fetchMock.mockImplementation(async () => response({ headers: { 'content-type': 'image/jpeg' }, chunks: [] }))
    const out = await fetchProductImages([PUBLIC_IMAGE])
    expect(out.size).toBe(0)
  })
})
