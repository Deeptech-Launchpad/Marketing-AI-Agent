import dns from 'node:dns/promises'
import net from 'node:net'

// SSRF guards, ported from NXT Sales' server/src/routes/intelligence.js.
//
// This module takes a URL that a user or a model influenced and makes the
// SERVER request it. Without controls that is a straight path to the host's own
// localhost services, the private network, or a cloud metadata endpoint. The
// defences are deny-by-default and deliberately strict:
//   - http/https only (no file:, ftp:, gopher:, data:)
//   - the hostname is RESOLVED and EVERY returned address checked before
//     connecting, not just the first — a name resolving to one public and one
//     private IP must not slip through
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

export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const a = parts[0]!
  const b = parts[1]!
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

export function isBlockedIPv6(ip: string): boolean {
  const s = ip.toLowerCase().split('%')[0] ?? ''
  if (s === '::' || s === '::1') return true // unspecified / loopback
  if (s.startsWith('fe80')) return true // link-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true // unique local
  if (s.startsWith('ff')) return true // multicast
  // An IPv4-mapped address must be judged by its IPv4 half.
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1]) return isBlockedIPv4(mapped[1])
  return false
}

export function isBlockedIP(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip)
  if (net.isIPv6(ip)) return isBlockedIPv6(ip)
  return true // not an IP at all — deny by default
}

/** Rejects if ANY address the hostname resolves to is non-public. */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isBlockedIP(hostname)) throw new BlockedAddressError('That address is not publicly reachable.')
    return
  }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(hostname)) {
    throw new BlockedAddressError('That address is not publicly reachable.')
  }

  let addrs: Array<{ address: string }>
  try {
    addrs = await dns.lookup(hostname, { all: true })
  } catch {
    throw new BlockedAddressError('That domain could not be resolved.')
  }
  if (!addrs.length) throw new BlockedAddressError('That domain could not be resolved.')

  for (const a of addrs) {
    if (isBlockedIP(a.address)) throw new BlockedAddressError('That address is not publicly reachable.')
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
