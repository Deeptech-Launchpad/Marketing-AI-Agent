import { describe, expect, it } from 'vitest'
import { isBlockedIP, isBlockedIPv4, isBlockedIPv6, normalizeUrl } from '../../src/research/ssrfGuard.js'

// These are the highest-value tests in the suite. This module decides whether
// the SERVER will make a request to an address a user or a model influenced, so
// a gap here is an actual vulnerability rather than a bug.

describe('isBlockedIPv4', () => {
  it.each([
    ['0.0.0.0', true],
    ['10.1.2.3', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['192.0.0.1', true],
    ['100.64.0.1', true], // CGNAT
    ['224.0.0.1', true], // multicast
    ['255.255.255.255', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.15.0.1', false], // just outside the private range
    ['172.32.0.1', false],
    ['100.63.255.255', false], // just outside CGNAT
  ])('%s -> blocked=%s', (ip, blocked) => {
    expect(isBlockedIPv4(ip)).toBe(blocked)
  })

  it('rejects malformed input rather than letting it through', () => {
    expect(isBlockedIPv4('not.an.ip.at.all')).toBe(true)
    expect(isBlockedIPv4('1.2.3')).toBe(true)
    expect(isBlockedIPv4('999.1.1.1')).toBe(true)
  })
})

describe('isBlockedIPv6', () => {
  it.each([
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12::1', true],
    ['ff02::1', true],
    ['2606:4700:4700::1111', false],
  ])('%s -> blocked=%s', (ip, blocked) => {
    expect(isBlockedIPv6(ip)).toBe(blocked)
  })

  it('judges an IPv4-mapped address by its IPv4 half', () => {
    expect(isBlockedIPv6('::ffff:10.0.0.1')).toBe(true)
    expect(isBlockedIPv6('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedIPv6('::ffff:8.8.8.8')).toBe(false)
  })
})

describe('isBlockedIP', () => {
  it('denies anything that is not a recognisable IP', () => {
    expect(isBlockedIP('example.com')).toBe(true)
    expect(isBlockedIP('')).toBe(true)
  })
})

describe('normalizeUrl', () => {
  it('accepts http and https', () => {
    expect(normalizeUrl('https://example.com')?.protocol).toBe('https:')
    expect(normalizeUrl('http://example.com')?.protocol).toBe('http:')
  })

  it('adds https to a bare host', () => {
    expect(normalizeUrl('example.com')?.toString()).toBe('https://example.com/')
  })

  it('REJECTS a non-http scheme rather than repairing it', () => {
    // The bug this guards: prepending https:// to "file:///etc/passwd" yields
    // "https://file/etc/passwd" — a valid URL to an unintended host.
    expect(normalizeUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeUrl('ftp://example.com')).toBeNull()
    expect(normalizeUrl('gopher://example.com')).toBeNull()
    expect(normalizeUrl('data:text/html,<script>')).toBeNull()
  })

  it('keeps a bare host:port working — that colon is a port, not a scheme', () => {
    expect(normalizeUrl('example.com:8080')?.port).toBe('8080')
  })

  it('returns null for empty or unparseable input', () => {
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
    expect(normalizeUrl('http://')).toBeNull()
  })
})
