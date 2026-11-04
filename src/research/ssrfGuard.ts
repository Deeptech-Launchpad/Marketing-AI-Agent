import dns from 'node:dns/promises'
import net from 'node:net'

// SSRF guards, ported from NXT Sales' server/src/routes/intelligence.js.
//
// This module takes a URL that a user or a model influenced and makes the
// SERVER request it. Without controls that is a straight path to the host's own
// localhost services, the private network, or a cloud metadata endpoint. The
// defences are deny-by-default and deliberately strict:
//   - http/https only (no file:, ftp:, gopher:, data:)
//   - only ports 80 and 443, on the first URL and on every redirect hop
//   - the hostname is RESOLVED and EVERY returned address checked before
//     connecting, not just the first — a name resolving to one public and one
//     private IP must not slip through
//   - THE CONNECTION USES THE ADDRESS THAT WAS CHECKED (createPinnedLookup):
//     the check and the connect are one DNS answer, not two, so a name that
//     answers "public" to a check and "127.0.0.1" to the connection (DNS
//     rebinding) cannot reach the private network
//   - redirects are followed manually and re-validated each hop, so a public
//     URL cannot 302 into the private network
//
// This is the one place in Phase 1 where a mock in place of the real thing
// would be an actual vulnerability, so it is real and unit-tested from day one.

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlockedAddressError'
  }
}

// ── Address ranges ──────────────────────────────────────────────────────────

export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const a = parts[0]!
  const b = parts[1]!
  const c = parts[2]!
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true // IETF protocol assignments + TEST-NET-1 (192.0.0.0/24, 192.0.2.0/24)
  if (a === 192 && b === 88 && c === 99) return true // 6to4 relay anycast (192.88.99.0/24)
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking (198.18.0.0/15)
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

/**
 * The eight 16-bit groups of an IPv6 address, in ANY textual form: compressed
 * (::), fully expanded, mixed-case, with a dotted IPv4 tail (::ffff:127.0.0.1),
 * in brackets, or with a zone id. Null when it is not a valid IPv6 address.
 *
 * Every range check below works on these numbers, never on the text, so one
 * address cannot be written in a form a prefix check does not recognise.
 */
export function parseIPv6(input: string): number[] | null {
  let s = (input.split('%')[0] ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!s.includes(':')) return null
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':')
    const v4 = s.slice(cut + 1)
    if (!net.isIPv4(v4)) return null
    const [a, b, c, d] = v4.split('.').map(Number) as [number, number, number, number]
    s = `${s.slice(0, cut + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null // "::" stands for at least one group
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN))
  return out.some((n) => Number.isNaN(n)) ? null : out
}

const v4Of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

export function isBlockedIPv6(ip: string): boolean {
  const g = parseIPv6(ip)
  if (!g) return true // not a valid IPv6 address — deny by default
  const zero = (from: number, to: number) => g.slice(from, to).every((n) => n === 0)

  // NAT64 — checked BEFORE the reserved 0000::/8 below, because 64:ff9b:: (0064:ff9b::) lies numerically inside it.
  // 64:ff9b::/96 carries an IPv4 address and is judged by it: 64:ff9b::7f00:1 IS 127.0.0.1. (A network
  // that uses DNS64 resolves EVERY public site to such an address, so blocking the whole prefix would make
  // the reader useless there; one that embeds a private or special address is blocked.) Anything else in
  // 64:ff9b::/32 — the local-use prefix 64:ff9b:1::/48 included — is blocked outright.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (zero(2, 6)) return isBlockedIPv4(v4Of(g[6]!, g[7]!))
    return true
  }

  // 0000::/8 is reserved: ::, ::1, IPv4-compatible (::a.b.c.d) and everything else in it are blocked —
  // EXCEPT the two forms that CARRY an IPv4 address, which are judged by that address.
  if (g[0]! >> 8 === 0) {
    if (zero(0, 5) && g[5] === 0xffff) return isBlockedIPv4(v4Of(g[6]!, g[7]!)) // IPv4-mapped ::ffff:a.b.c.d (every spelling: dotted, hex, expanded)
    if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return isBlockedIPv4(v4Of(g[6]!, g[7]!)) // IPv4-translated ::ffff:0:a.b.c.d
    return true
  }

  if (g[0] === 0x2002) return true // 6to4 (2002::/16): deprecated, embeds an IPv4 address — blocked outright
  if (g[0] === 0x2001 && g[1]! < 0x200) return true // 2001::/23 IETF protocol assignments: Teredo (2001::/32), benchmarking, ORCHID...
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation 2001:db8::/32
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return true // documentation 3fff::/20
  if (g[0] === 0x5f00) return true // SRv6 segment identifiers 5f00::/16
  if (g[0] === 0x0100 && zero(1, 4)) return true // discard-only 100::/64
  if ((g[0]! & 0xffc0) === 0xfe80) return true // link-local fe80::/10 (fe80:: through febf::)
  if ((g[0]! & 0xffc0) === 0xfec0) return true // site-local fec0::/10 (deprecated)
  if ((g[0]! & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if (g[0]! >> 8 === 0xff) return true // multicast ff00::/8
  return false
}

export function isBlockedIP(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, '')
  if (net.isIPv4(host)) return isBlockedIPv4(host)
  if (net.isIPv6(host.split('%')[0] ?? '')) return isBlockedIPv6(host)
  return true // not an IP at all — deny by default
}

// ── Ports ───────────────────────────────────────────────────────────────────

/** The only ports a company's website is read on. Anything else is a probe of a service, not a website. */
export const ALLOWED_PORTS: readonly number[] = [80, 443]

/** The port a URL will actually connect to: its explicit port, or the default of its scheme. */
export function portOf(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : Number.NaN
}

export const isAllowedPort = (url: URL): boolean => ALLOWED_PORTS.includes(portOf(url))

/** Rejects a URL on any port but 80 and 443. Checked on the first URL and on EVERY redirect hop, before anything is sent. */
export function assertAllowedPort(url: URL): void {
  if (!isAllowedPort(url)) throw new BlockedAddressError('That port is not allowed: only ports 80 and 443 are read.')
}

// ── Resolution, and the connection that uses the answer ────────────────────

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

const systemResolver: Resolver = async (hostname) => {
  const found = await dns.lookup(hostname, { all: true })
  return found.map((a) => ({ address: a.address, family: net.isIPv6(a.address) ? 6 : 4 }))
}
let resolver: Resolver = systemResolver

/** Tests only: a fake DNS. Pass null to restore the real one. */
export function setResolverForTests(r: Resolver | null): void {
  resolver = r ?? systemResolver
}

/**
 * The addresses a hostname points to — every one of them verified public — or
 * a BlockedAddressError. One DNS answer: this is what the connection uses.
 */
async function validatedAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (net.isIP(host.split('%')[0] ?? '')) {
    if (isBlockedIP(host)) throw new BlockedAddressError('That address is not publicly reachable.')
    return [{ address: host, family: net.isIPv6(host.split('%')[0] ?? '') ? 6 : 4 }]
  }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new BlockedAddressError('That address is not publicly reachable.')
  }

  let addrs: ResolvedAddress[]
  try {
    addrs = await resolver(host)
  } catch {
    throw new BlockedAddressError('That domain could not be resolved.')
  }
  if (!addrs.length) throw new BlockedAddressError('That domain could not be resolved.')

  for (const a of addrs) {
    if (isBlockedIP(a.address)) throw new BlockedAddressError('That address is not publicly reachable.')
  }
  return addrs
}

/** Rejects if ANY address the hostname resolves to is non-public. An early check; the connection is pinned separately. */
export async function assertPublicHost(hostname: string): Promise<void> {
  await validatedAddresses(hostname)
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void

/**
 * A DNS `lookup` for http.request / https.request / tls.connect that RESOLVES,
 * VALIDATES and RETURNS the same answer.
 *
 * WHY. Checking a hostname and then connecting to it is two DNS queries. A
 * hostile name answers the first with a public address and the second with
 * 127.0.0.1 (DNS rebinding), and the connection goes to the private network
 * after every check has passed. Here the socket layer asks THIS function where
 * to connect: it asks DNS once, refuses the whole answer if any address in it
 * is private or special, and hands back only addresses that passed. There is no
 * second query to poison, and no address that was not checked.
 *
 * An IP literal is not looked up by Node at all, so literals are checked
 * separately (assertPublicHost, before each request).
 */
export function createPinnedLookup(): (hostname: string, options: unknown, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    const opts = (typeof options === 'object' && options !== null ? options : {}) as { family?: number | string; all?: boolean }
    validatedAddresses(hostname).then(
      (addrs) => {
        const family = opts.family === 4 || opts.family === 'IPv4' ? 4 : opts.family === 6 || opts.family === 'IPv6' ? 6 : 0
        const wanted = family ? addrs.filter((a) => a.family === family) : addrs
        if (!wanted.length) {
          callback(Object.assign(new BlockedAddressError('That domain could not be resolved.'), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException, '')
          return
        }
        if (opts.all) callback(null, wanted.map((a) => ({ address: a.address, family: a.family })))
        else callback(null, wanted[0]!.address, wanted[0]!.family)
      },
      (err: unknown) => callback(err as NodeJS.ErrnoException, ''),
    )
  }
}

/**
 * An explicit non-http(s) scheme is REJECTED, never repaired. Blindly
 * prepending "https://" to "file:///etc/passwd" produces "https://file/..." —
 * a valid URL pointing at an entirely unintended host. Keying on "://" rather
 * than any "word:" keeps a bare "example.com:8080" working, since that colon
 * introduces a port, not a scheme.
 */
export function normalizeUrl(raw: string): URL | null {
  const v = String(raw ?? '').trim()
  if (!v) return null

  const sep = v.indexOf('://')
  if (sep !== -1 && !/^https?$/i.test(v.slice(0, sep))) return null

  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return u
}
