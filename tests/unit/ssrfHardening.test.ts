import { EventEmitter } from 'node:events'
import net from 'node:net'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// SSRF HARDENING (2026-11-03): the shared page reader — used by Enrichment,
// Intent Signals, the Website Audit and Warm Leads — must
//   1. connect to the address that was VALIDATED (no DNS rebinding),
//   2. refuse every private and special address range, in every spelling,
//   3. read only ports 80 and 443, on the first URL and on every redirect hop,
// and must still follow ordinary http/https/www redirects.
//
// Nothing here touches a network. DNS is a fake (setResolverForTests) and the
// socket layer is a fake (pinnedRequest's `deps`): it performs the same
// `lookup` a real socket would, records where it "connected", and answers from a script.

vi.mock('../../src/platform/db.js', () => ({ prisma: {}, newId: () => 'id_test' }))

const guard = await import('../../src/research/ssrfGuard.js')
const reader = await import('../../src/research/pageFetch.js')
const { completeCertificateChain } = await import('../../src/research/tlsChain.js')
const { isBlockedIPv4, isBlockedIPv6, isBlockedIP, assertAllowedPort, assertPublicHost, createPinnedLookup, setResolverForTests, BlockedAddressError } = guard
const { fetchPageRaw, fetchAsset, pinnedRequest, setTransportForTests, describeFetchFailure } = reader

// ── fakes ───────────────────────────────────────────────────────────────────

type Answer = Array<{ address: string; family: 4 | 6 }>
const v4 = (address: string): Answer => [{ address, family: 4 }]

/** A fake DNS. `answers[host]` is a list of answers, one per query; the last is repeated. Counts every query. */
function fakeDns(answers: Record<string, Answer | Answer[]>) {
  const queries: string[] = []
  const used: Record<string, number> = {}
  setResolverForTests(async (host) => {
    queries.push(host)
    const entry = answers[host]
    if (!entry) throw new Error('NXDOMAIN')
    const sequence: Answer[] = Array.isArray(entry[0]) ? (entry as Answer[]) : [entry as Answer]
    const i = Math.min(used[host] ?? 0, sequence.length - 1)
    used[host] = (used[host] ?? 0) + 1
    return sequence[i]!
  })
  return { queries, count: (host: string) => queries.filter((q) => q === host).length }
}

interface Reply {
  status: number
  headers?: Record<string, string>
  body?: string | Buffer
}
interface Connection {
  url: string
  address: string
  options: Record<string, unknown>
}

/** A fake socket layer: performs the lookup a real socket would, records where it connected, answers from `script`. */
function fakeSockets(script: (url: URL) => Reply | 'reset') {
  const connections: Connection[] = []
  const request = (url: URL, options: Record<string, any>, cb: (res: Readable) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void }
    req.destroy = (e) => {
      if (e) req.emit('error', e)
    }
    const answer = () => {
      const s = script(url)
      if (s === 'reset') {
        req.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
        return
      }
      const res = Readable.from([Buffer.from(s.body ?? '')]) as Readable & { statusCode: number; headers: Record<string, string> }
      res.statusCode = s.status
      res.headers = s.headers ?? {}
      cb(res)
    }
    req.end = () => {
      setImmediate(() => {
        const host = url.hostname.replace(/^\[|\]$/g, '')
        if (net.isIP(host)) {
          // A real socket connects to a literal without any lookup.
          connections.push({ url: url.toString(), address: host, options })
          answer()
          return
        }
        options.lookup(url.hostname, {}, (err: Error | null, address: string) => {
          if (err) {
            req.emit('error', err)
            return
          }
          connections.push({ url: url.toString(), address, options })
          answer()
        })
      })
    }
    return req
  }
  const deps = { http: { request }, https: { request } } as unknown as Parameters<typeof pinnedRequest>[3]
  return { connections, deps }
}

const HTML = (title: string) => `<html><head><title>${title}</title></head><body>${title}</body></html>`
const html = (title: string): Reply => ({ status: 200, headers: { 'content-type': 'text/html' }, body: HTML(title) })
const redirect = (to: string, status = 301): Reply => ({ status, headers: { location: to } })

/** Wires the reader to a fake DNS and fake sockets. */
function world(dnsAnswers: Record<string, Answer | Answer[]>, script: (url: URL) => Reply | 'reset') {
  const dns = fakeDns(dnsAnswers)
  const sockets = fakeSockets(script)
  setTransportForTests((url, headers, opts) => pinnedRequest(url, headers, opts, sockets.deps))
  return { dns, ...sockets }
}

beforeEach(() => setResolverForTests(null))
afterEach(() => {
  setResolverForTests(null)
  setTransportForTests(null)
})

// ── 2. address ranges ───────────────────────────────────────────────────────

describe('IPv4 special ranges', () => {
  it('blocks every private and special range, including 198.18.0.0/15 and the TEST-NETs', () => {
    for (const ip of [
      '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1',
      '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.7', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.9', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    ]) {
      expect(isBlockedIPv4(ip), ip).toBe(true)
    }
  })
  it('allows ordinary public addresses, and the ranges just outside the special ones', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '176.62.168.49', '205.251.141.117', '172.15.255.255', '172.32.0.1', '198.17.255.255', '198.20.0.0', '100.63.255.255', '100.128.0.0', '11.0.0.1', '223.255.255.255']) {
      expect(isBlockedIPv4(ip), ip).toBe(false)
    }
  })
})

describe('IPv6 special ranges', () => {
  it('parses an address in any spelling to the same eight groups', () => {
    const want = [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]
    for (const s of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:FFFF:7F00:0001', '[::ffff:7f00:1]', '::ffff:7f00:1%eth0', '::FFFF:127.0.0.1']) {
      expect(guard.parseIPv6(s), s).toEqual(want)
    }
    for (const bad of ['', 'zzzz::1', '1:2:3', '1:2:3:4:5:6:7:8:9', '::1::2', '1::2::3', ':::', '12345::1', '::ffff:300.1.1.1', 'not an ip']) {
      expect(guard.parseIPv6(bad), bad).toBeNull()
    }
  })

  it('blocks IPv4-mapped IPv6 in EVERY representation when the IPv4 half is private or special', () => {
    for (const ip of [
      '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:7f00:0001', '[::ffff:7f00:1]', '::FFFF:7F00:1',
      '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:192.168.1.1', '::ffff:c0a8:101', '::ffff:ac10:1', '::ffff:198.18.0.1', '::ffff:c612:1', '::ffff:0.0.0.0',
      '::ffff:0:7f00:1', // IPv4-translated (SIIT)
    ]) {
      expect(isBlockedIPv6(ip), ip).toBe(true)
      expect(isBlockedIP(ip), ip).toBe(true)
    }
    // ...and judged by the IPv4 half, so a mapped PUBLIC address is not blocked.
    for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808', '0:0:0:0:0:ffff:808:808']) expect(isBlockedIPv6(ip), ip).toBe(false)
  })

  it('blocks ::, ::1, IPv4-compatible and the rest of the reserved 0000::/8', () => {
    for (const ip of ['::', '::1', '0:0:0:0:0:0:0:1', '::7f00:1', '::10.0.0.1', '::8.8.8.8', '0:1::', '0:0:0:1::1', '::2']) expect(isBlockedIPv6(ip), ip).toBe(true)
  })

  it('NAT64: an address that embeds a private or special IPv4 is blocked; the local-use prefix is blocked outright', () => {
    for (const ip of [
      '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::c0a8:1', '64:ff9b::ac10:1', '64:ff9b::6440:1', '64:ff9b::c612:1', '64:ff9b::0.0.0.0',
      '0064:ff9b:0000:0000:0000:0000:7f00:0001',
      '64:ff9b:1::1', '64:ff9b:1::808:808', '64:ff9b::1:0:808:808', // 64:ff9b:1::/48 and the non-/96 part of 64:ff9b::/32
    ]) {
      expect(isBlockedIPv6(ip), ip).toBe(true)
    }
    // DECISION (see the report): a NAT64 address embedding a PUBLIC IPv4 is allowed — a DNS64 network resolves every public site to one.
    expect(isBlockedIPv6('64:ff9b::808:808')).toBe(false)
    expect(isBlockedIPv6('64:ff9b::8.8.8.8')).toBe(false)
  })

  it('6to4 and Teredo are blocked outright, even when the embedded IPv4 would be public', () => {
    for (const ip of ['2002:7f00:1::', '2002:a00:1::1', '2002:808:808::1', '2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2']) {
      expect(isBlockedIPv6(ip), ip).toBe(true)
    }
  })

  it('blocks link-local across all of fe80::/10, site-local, unique-local, multicast, discard and documentation', () => {
    for (const ip of ['fe80::1', 'fe90::1', 'fea0::1', 'febf:ffff::1', 'fec0::1', 'feff::1', 'fc00::1', 'fd12:3456::1', 'fdff::1', 'ff02::1', 'ff00::', '100::1', '2001:db8::1', '2001:0db8:ffff::1', '3fff::1', '3fff:fff::1', '2001:2::1', '2001:10::1', '5f00::1', 'fe80::1%eth0']) {
      expect(isBlockedIPv6(ip), ip).toBe(true)
    }
  })

  it('allows ordinary public IPv6 addresses', () => {
    for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111', '2a02:4780:1f:8705:806a:46fb:b9a1:ecb4', '2600::1', '2001:200::1', '2400:cb00::1', '3ffe::1', 'fe7f::1', 'ffff::1'.replace('ffff', '2a00')]) {
      expect(isBlockedIPv6(ip), ip).toBe(false)
    }
  })

  it('denies anything that is not a valid address', () => {
    for (const ip of ['', 'garbage', '1:2:3', '::g', '999.1.1.1']) expect(isBlockedIP(ip), ip).toBe(true)
  })
})

// ── 3. ports ────────────────────────────────────────────────────────────────

describe('port restriction', () => {
  it('allows 80 and 443, explicit or by default, on either scheme', () => {
    for (const u of ['http://a.test/', 'https://a.test/', 'http://a.test:80/', 'https://a.test:443/', 'http://a.test:443/', 'https://a.test:80/', 'https://a.test/path?x=1']) {
      expect(() => assertAllowedPort(new URL(u)), u).not.toThrow()
    }
  })
  it('refuses every other port — including common service ports — with a clear message', () => {
    for (const port of [0, 21, 22, 23, 25, 81, 110, 3000, 3306, 4100, 4300, 5000, 5432, 5433, 5434, 6379, 8000, 8009, 8080, 8110, 8443, 9200, 11211, 27017, 65535]) {
      for (const scheme of ['http', 'https']) {
        const u = new URL(`${scheme}://a.test:${port}/`)
        if (u.port === '') continue // the scheme's own default port is allowed (80 on http)
        expect(() => assertAllowedPort(u), `${scheme}:${port}`).toThrow(BlockedAddressError)
        expect(() => assertAllowedPort(u)).toThrow(/only ports 80 and 443/)
      }
    }
  })
})

// ── 1. the pinned lookup (fake DNS) ─────────────────────────────────────────

const look = (host: string, options: unknown = {}) =>
  new Promise<{ err: Error | null; address?: unknown; family?: number }>((resolve) => {
    createPinnedLookup()(host, options, (err, address, family) => resolve({ err, address, family }))
  })

describe('the pinned lookup', () => {
  it('resolves once, validates the answer, and returns that same address', async () => {
    const dns = fakeDns({ 'shop.test': v4('93.184.216.34') })
    const r = await look('shop.test')
    expect(r).toMatchObject({ err: null, address: '93.184.216.34', family: 4 })
    expect(dns.count('shop.test')).toBe(1)
  })

  it('returns the list for {all: true} and honours a family filter', async () => {
    fakeDns({ 'dual.test': [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }] })
    expect((await look('dual.test', { all: true })).address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])
    expect((await look('dual.test', { family: 6 })).address).toBe('2606:4700:4700::1111')
    expect((await look('dual.test', { family: 4 })).address).toBe('93.184.216.34')
    const none = await look('dual.test', { family: 6, all: false }) // present
    expect(none.err).toBeNull()
  })

  it('refuses the WHOLE answer when any address in it is private — it never hands back the public one', async () => {
    fakeDns({ 'mixed.test': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }] })
    const r = await look('mixed.test', { all: true })
    expect(r.err).toBeInstanceOf(BlockedAddressError)
    expect(r.address).toBe('')
  })

  it('refuses private, special and mapped answers', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '198.18.0.9', '::1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:808:808::1', 'fe80::1']) {
      fakeDns({ 'evil.test': [{ address, family: address.includes(':') ? 6 : 4 }] })
      expect((await look('evil.test')).err, address).toBeInstanceOf(BlockedAddressError)
    }
  })

  it('refuses internal names without asking DNS at all, and literals directly', async () => {
    const dns = fakeDns({})
    for (const host of ['localhost', 'localhost.', 'api.localhost', 'printer.local', 'metadata.google.internal']) {
      expect((await look(host)).err, host).toBeInstanceOf(BlockedAddressError)
    }
    expect(dns.queries).toEqual([])
    expect((await look('127.0.0.1')).err).toBeInstanceOf(BlockedAddressError)
    expect((await look('[::1]')).err).toBeInstanceOf(BlockedAddressError)
    expect((await look('8.8.8.8')).err).toBeNull()
  })

  it('an unresolvable or empty answer is "could not be resolved"', async () => {
    fakeDns({ 'empty.test': [] })
    expect((await look('nx.test')).err?.message).toBe('That domain could not be resolved.')
    expect((await look('empty.test')).err?.message).toBe('That domain could not be resolved.')
  })

  it('DNS REBINDING: every new connection is validated on its own answer — a poisoned second answer is refused, not trusted', async () => {
    const dns = fakeDns({ 'rebind.test': [v4('93.184.216.34'), v4('127.0.0.1')] })
    expect((await look('rebind.test')).address).toBe('93.184.216.34') // connection 1: the public answer, validated
    expect(dns.count('rebind.test')).toBe(1) // and it was the ONLY query: nothing second to poison
    expect((await look('rebind.test')).err).toBeInstanceOf(BlockedAddressError) // connection 2 would have gone to 127.0.0.1
  })
})

// ── 1. pinned connections end to end (fake sockets) ─────────────────────────

const hdr = { 'User-Agent': 'MarketingAgent/1.0' }
const sig = () => new AbortController().signal

describe('the pinned request', () => {
  it('connects to the address that was validated, over a fresh connection that carries the pinned lookup', async () => {
    const dns = fakeDns({ 'www.egilabo.be': v4('176.62.168.49') })
    const s = fakeSockets(() => html('Egilabo'))
    const res = await pinnedRequest(new URL('https://www.egilabo.be/'), hdr, { signal: sig() }, s.deps)
    expect(res.status).toBe(200)
    expect(s.connections).toHaveLength(1)
    expect(s.connections[0]!.address).toBe('176.62.168.49')
    expect(dns.count('www.egilabo.be')).toBe(1)
    const o = s.connections[0]!.options
    expect(typeof o.lookup).toBe('function')
    expect(o.agent).toBe(false) // no pooled socket can skip the lookup
    expect(o.rejectUnauthorized).toBe(true)
    expect(o.ca).toBeUndefined() // trust is only ever ADDED for the chain-completion retry
    expect(o.method).toBe('GET')
    expect((o.headers as Record<string, string>)['User-Agent']).toBe('MarketingAgent/1.0')
  })

  it('plain http uses the http module with no TLS options; the chain-completion retry adds issuers and keeps verification on', async () => {
    fakeDns({ 'a.test': v4('93.184.216.34') })
    const calls: string[] = []
    const make = (name: string) => (url: URL, options: any, cb: any) => {
      calls.push(`${name}:${options.rejectUnauthorized ?? 'n/a'}:${options.ca ? options.ca.length : 0}`)
      return fakeSockets(() => html('x')).deps.http.request(url, options, cb)
    }
    const deps = { http: { request: make('http') }, https: { request: make('https') } } as unknown as Parameters<typeof pinnedRequest>[3]
    await pinnedRequest(new URL('http://a.test/'), hdr, { signal: sig() }, deps)
    await pinnedRequest(new URL('https://a.test/'), hdr, { signal: sig(), ca: ['PEM-1', 'PEM-2'] }, deps)
    expect(calls).toEqual(['http:n/a:0', 'https:true:2'])
  })

  it('DNS REBINDING ATTEMPT: the early check sees a public address, the connection would get 127.0.0.1 — it never connects', async () => {
    const dns = fakeDns({ 'rebind.test': [v4('93.184.216.34'), v4('127.0.0.1')] })
    const s = fakeSockets(() => html('secret'))
    await assertPublicHost('rebind.test') // the early check passes on the first (public) answer
    await expect(pinnedRequest(new URL('https://rebind.test/'), hdr, { signal: sig() }, s.deps)).rejects.toBeInstanceOf(BlockedAddressError)
    expect(s.connections).toHaveLength(0) // not one connection was made to the private address
    expect(dns.count('rebind.test')).toBe(2)
  })

  it('a hostile answer that mixes a public and a private address is refused outright', async () => {
    fakeDns({ 'mix.test': [{ address: '93.184.216.34', family: 4 }, { address: '10.1.1.1', family: 4 }] })
    const s = fakeSockets(() => html('x'))
    await expect(pinnedRequest(new URL('https://mix.test/'), hdr, { signal: sig() }, s.deps)).rejects.toThrow(/not publicly reachable/)
    expect(s.connections).toHaveLength(0)
  })

  it('decodes gzip and deflate bodies like fetch did, and drops the encoding headers', async () => {
    fakeDns({ 'z.test': v4('93.184.216.34') })
    for (const [encoding, body] of [['gzip', zlib.gzipSync(HTML('Zipped'))], ['deflate', zlib.deflateSync(HTML('Zipped'))], ['br', zlib.brotliCompressSync(HTML('Zipped'))]] as const) {
      const s = fakeSockets(() => ({ status: 200, headers: { 'content-type': 'text/html', 'content-encoding': encoding, 'content-length': String(body.length) }, body }))
      const res = await pinnedRequest(new URL('https://z.test/'), hdr, { signal: sig() }, s.deps)
      expect(await res.text(), encoding).toBe(HTML('Zipped'))
      expect(res.headers.get('content-encoding')).toBeNull()
    }
  })

  it('refuses an encoding it cannot decode rather than returning garbage', async () => {
    fakeDns({ 'z.test': v4('93.184.216.34') })
    const s = fakeSockets(() => ({ status: 200, headers: { 'content-encoding': 'zstd' }, body: 'x' }))
    await expect(pinnedRequest(new URL('https://z.test/'), hdr, { signal: sig() }, s.deps)).rejects.toBeTruthy()
  })

  it('errors reach describeFetchFailure the way fetch\'s did', async () => {
    fakeDns({ 'r.test': v4('93.184.216.34') })
    const s = fakeSockets(() => 'reset')
    const err = await pinnedRequest(new URL('https://r.test/'), hdr, { signal: sig() }, s.deps).catch((e) => e)
    expect(describeFetchFailure(err)).toBe('The site reset the connection.')
    expect(describeFetchFailure(new BlockedAddressError('That port is not allowed: only ports 80 and 443 are read.'))).toBe('That port is not allowed: only ports 80 and 443 are read.')
    expect(describeFetchFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('The site took too long to respond.')
  })

  it('bodyless statuses (304) are returned without a body', async () => {
    fakeDns({ 'n.test': v4('93.184.216.34') })
    const s = fakeSockets(() => ({ status: 304 }))
    const res = await pinnedRequest(new URL('https://n.test/'), hdr, { signal: sig() }, s.deps)
    expect(res.status).toBe(304)
    expect(res.body).toBeNull()
  })
})

// ── the shared reader: legitimate redirects still work ──────────────────────

const PUBLIC = { 'egilabo.be': v4('176.62.168.49'), 'www.egilabo.be': v4('176.62.168.49'), 'electroheat.com.sg': v4('23.106.55.197'), 'www.electroheat.com.sg': v4('23.106.55.197'), 'smartofficesupplies.ie': v4('34.246.118.232'), 'www.smartofficesupplies.ie': v4('34.246.118.232'), 'panellingcentre.ie': v4('185.43.232.9'), 'www.panellingcentre.ie': v4('185.43.232.9') }

describe('legitimate redirects through the shared reader (regression: Enrichment, Intent, Audit, Warm Leads)', () => {
  const cases: Array<[string, string, string]> = [
    ['egilabo.be', 'https://www.egilabo.be/', 'Egilabo'],
    ['electroheat.com.sg', 'https://www.electroheat.com.sg/', 'Electroheat'],
    ['smartofficesupplies.ie', '//www.smartofficesupplies.ie', 'Smart Office Supplies'], // protocol-relative, as the live site sends it
    ['panellingcentre.ie', 'https://www.panellingcentre.ie/', 'The Panelling Centre'],
  ]
  for (const [host, location, title] of cases) {
    it(`${host}: 301 to the www host is followed and the www page is the one read`, async () => {
      const w = world(PUBLIC, (u) => (u.hostname === host ? redirect(location) : html(title)))
      const r = await fetchPageRaw(`https://${host}/`)
      expect(r.ok).toBe(true)
      expect(r.status).toBe(200)
      expect(r.finalUrl).toBe(`https://www.${host}/`)
      expect(r.redirectChain).toEqual([`https://${host}/`, `https://www.${host}/`])
      expect(r.html).toContain(`<title>${title}</title>`)
      expect(w.connections.map((c) => c.url)).toEqual([`https://${host}/`, `https://www.${host}/`])
      expect(w.connections.every((c) => c.address === PUBLIC[host as keyof typeof PUBLIC]![0]!.address)).toBe(true)
    })
  }

  it('http → https → www (two hops) and 302 / 303 / 307 / 308 are all followed', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      world(PUBLIC, (u) =>
        u.protocol === 'http:' ? redirect('https://egilabo.be/', status) : u.hostname === 'egilabo.be' ? redirect('https://www.egilabo.be/', status) : html('Egilabo'),
      )
      const r = await fetchPageRaw('http://egilabo.be/')
      expect(r.ok, String(status)).toBe(true)
      expect(r.redirectChain, String(status)).toEqual(['http://egilabo.be/', 'https://egilabo.be/', 'https://www.egilabo.be/'])
    }
  })

  it('a relative Location and an https → http downgrade still work (unchanged behaviour)', async () => {
    world(PUBLIC, (u) => (u.pathname === '/' ? redirect('/en/home') : u.pathname === '/en/home' && u.protocol === 'https:' ? redirect('http://www.egilabo.be/en/end') : html('End')))
    const r = await fetchPageRaw('https://egilabo.be/')
    expect(r.ok).toBe(true)
    expect(r.finalUrl).toBe('http://www.egilabo.be/en/end')
  })

  it('explicit 80 and 443 are accepted on any hop; a default port written out is the same URL', async () => {
    world(PUBLIC, (u) => (u.hostname === 'egilabo.be' ? redirect('https://www.egilabo.be:443/') : html('Egilabo')))
    expect((await fetchPageRaw('http://egilabo.be:80/')).ok).toBe(true)
    world(PUBLIC, (u) => (u.hostname === 'egilabo.be' ? redirect('http://www.egilabo.be:443/x') : html('Egilabo')))
    expect((await fetchPageRaw('https://egilabo.be:443/')).ok).toBe(true) // http on 443 is allowed by the rule: ports, not schemes
  })

  it('non-HTML and error pages are still reported as data, not thrown; the 2 MB cap still applies to the decoded body', async () => {
    world(PUBLIC, (u) => (u.pathname === '/missing' ? { status: 404, headers: { 'content-type': 'text/html' }, body: 'no' } : u.pathname === '/doc.pdf' ? { status: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF' } : { status: 200, headers: { 'content-type': 'text/html' }, body: 'x'.repeat(2 * 1024 * 1024 + 500) }))
    const notFound = await fetchPageRaw('https://egilabo.be/missing')
    expect(notFound).toMatchObject({ ok: false, status: 404, reason: 'The site returned HTTP 404.' })
    expect((await fetchPageRaw('https://egilabo.be/doc.pdf')).html).toBe('')
    const big = await fetchPageRaw('https://egilabo.be/')
    expect(big.truncated).toBe(true)
    expect(big.html.length).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it('fetchAsset follows a www redirect and returns the bytes', async () => {
    world(PUBLIC, (u) => (u.hostname === 'egilabo.be' ? redirect('https://www.egilabo.be/img.png') : { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }))
    const r = await fetchAsset('https://egilabo.be/img.png', { allowedTypes: /^image\//, maxBytes: 1024 })
    expect(r.ok).toBe(true)
    expect(r.finalUrl).toBe('https://www.egilabo.be/img.png')
    expect(r.bytes?.length).toBe(4)
  })
})

// ── the shared reader: the security properties ──────────────────────────────

describe('ports are enforced on the first URL and on every redirect hop, before anything is sent', () => {
  const badPorts = ['8080', '22', '6379', '8009', '5433', '3000', '8443', '4443', '25', '4100']

  it('a start URL on another port is refused without a single connection', async () => {
    const w = world(PUBLIC, () => html('x'))
    for (const port of badPorts) {
      const r = await fetchPageRaw(`https://egilabo.be:${port}/`)
      expect(r.ok, port).toBe(false)
      expect(r.reason, port).toBe('That port is not allowed: only ports 80 and 443 are read.')
    }
    expect((await fetchPageRaw('http://egilabo.be:8080/')).ok).toBe(false)
    expect(w.connections).toHaveLength(0)
    expect(w.dns.queries).toEqual([])
  })

  it('a REDIRECT to another port is rejected — and nothing is ever sent to that port', async () => {
    for (const port of badPorts) {
      for (const scheme of ['http', 'https']) {
        const w = world(PUBLIC, (u) => (u.hostname === 'egilabo.be' ? redirect(`${scheme}://www.egilabo.be:${port}/`) : html('x')))
        const r = await fetchPageRaw('https://egilabo.be/')
        expect(r.ok, `${scheme}:${port}`).toBe(false)
        expect(r.reason).toMatch(/only ports 80 and 443/)
        expect(w.connections.map((c) => c.url), `${scheme}:${port}`).toEqual(['https://egilabo.be/']) // the first hop only
      }
    }
  })

  it('a port change in the middle of a longer chain is caught on that hop', async () => {
    const w = world(PUBLIC, (u) => (u.hostname === 'egilabo.be' ? redirect('https://www.egilabo.be/a') : u.pathname === '/a' ? redirect('https://www.egilabo.be:8443/b') : html('x')))
    const r = await fetchPageRaw('https://egilabo.be/')
    expect(r.ok).toBe(false)
    expect(w.connections).toHaveLength(2)
  })

  it('fetchAsset refuses another port on the start URL and on a redirect, with the same error contract as other blocked addresses', async () => {
    const w = world(PUBLIC, (u) => (u.hostname === 'egilabo.be' ? redirect('https://www.egilabo.be:8080/i.png') : html('x')))
    await expect(fetchAsset('https://egilabo.be:8080/i.png', { allowedTypes: /^image\//, maxBytes: 10 })).rejects.toBeInstanceOf(BlockedAddressError)
    await expect(fetchAsset('https://egilabo.be/i.png', { allowedTypes: /^image\//, maxBytes: 10 })).rejects.toThrow(/only ports 80 and 443/)
    expect(w.connections.map((c) => c.url)).toEqual(['https://egilabo.be/i.png'])
  })

  it('the TLS chain helper never connects to another port', async () => {
    const w = world({}, () => html('x'))
    expect(await completeCertificateChain('egilabo.be', 8443)).toBeNull()
    expect(await completeCertificateChain('egilabo.be', 22)).toBeNull()
    expect(w.dns.queries).toEqual([])
  })
})

describe('redirects into the private network are still blocked (regression), in every spelling', () => {
  const targets = [
    'http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://localhost/', 'http://localhost./', 'http://app.localhost/',
    'http://printer.local/', 'http://metadata.google.internal/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'http://198.18.0.5/', 'http://198.19.9.9/',
    'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:7f00:1::]/', 'http://[fe80::1]/', 'http://[fd00::1]/',
  ]
  it('every one is refused before any connection is made to it', async () => {
    for (const target of targets) {
      const w = world({ ...PUBLIC, 'inside.test': v4('10.9.9.9') }, (u) => (u.hostname === 'egilabo.be' ? redirect(target) : html('secret')))
      const r = await fetchPageRaw('https://egilabo.be/')
      expect(r.ok, target).toBe(false)
      expect(r.reason, target).toMatch(/not publicly reachable|could not be resolved/)
      expect(w.connections.map((c) => c.url), target).toEqual(['https://egilabo.be/'])
    }
  })

  it('a hostname that RESOLVES to a private address is refused, as is a mixed answer', async () => {
    const w = world({ ...PUBLIC, 'inside.test': v4('10.9.9.9'), 'mixed.test': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] }, () => html('secret'))
    expect((await fetchPageRaw('https://inside.test/')).reason).toMatch(/not publicly reachable/)
    expect((await fetchPageRaw('https://mixed.test/')).reason).toMatch(/not publicly reachable/)
    expect(w.connections).toHaveLength(0)
  })

  it('an unsupported scheme in a redirect is refused', async () => {
    world(PUBLIC, (u) => (u.hostname === 'egilabo.be' ? redirect('file:///etc/passwd') : html('x')))
    expect((await fetchPageRaw('https://egilabo.be/')).reason).toBe('The site redirected to an unsupported address.')
  })
})

describe('DNS rebinding through the shared reader', () => {
  it('a name that answers "public" to the early check and "127.0.0.1" to the connection never connects', async () => {
    const w = world({ 'rebind.test': [v4('93.184.216.34'), v4('127.0.0.1')] }, () => html('internal admin page'))
    const r = await fetchPageRaw('https://rebind.test/')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('That address is not publicly reachable.')
    expect(r.html).toBe('')
    expect(w.connections).toHaveLength(0)
  })

  it('the same on a REDIRECT hop: a good first host that sends the reader to a rebinding name', async () => {
    const w = world({ ...PUBLIC, 'rebind.test': [v4('93.184.216.34'), v4('169.254.169.254')] }, (u) => (u.hostname === 'egilabo.be' ? redirect('https://rebind.test/') : html('metadata')))
    const r = await fetchPageRaw('https://egilabo.be/')
    expect(r.ok).toBe(false)
    expect(w.connections.map((c) => c.url)).toEqual(['https://egilabo.be/'])
  })

  it('an honest name is resolved once per connection and connected to at the address that was validated', async () => {
    const w = world(PUBLIC, () => html('ok'))
    await fetchPageRaw('https://egilabo.be/')
    expect(w.connections[0]!.address).toBe('176.62.168.49')
    // the early check plus the connection's own lookup: two queries, the second of which is the one that counts
    expect(w.dns.count('egilabo.be')).toBe(2)
  })

  it('fetchAsset (images) is pinned the same way', async () => {
    const w = world({ 'rebind.test': [v4('93.184.216.34'), v4('127.0.0.1')] }, () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: 'x' }))
    await expect(fetchAsset('https://rebind.test/i.png', { allowedTypes: /^image\//, maxBytes: 10 })).resolves.toMatchObject({ ok: false })
    expect(w.connections).toHaveLength(0)
  })
})

describe('loops and long chains are still cut off (regression)', () => {
  it('a redirect loop stops after the configured number of hops, with one clear message', async () => {
    const w = world(PUBLIC, (u) => redirect(u.hostname === 'egilabo.be' ? 'https://www.egilabo.be/' : 'https://egilabo.be/'))
    const r = await fetchPageRaw('https://egilabo.be/')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('The site redirected too many times.')
    expect(w.connections).toHaveLength(4) // the cap is unchanged: three redirects, four requests
  })
})
