import { describe, expect, it } from 'vitest'
import { isIncompleteChainError, resetChainCache } from '../../src/research/tlsChain.js'

// COMPLETING A CHAIN IS NOT THE SAME AS TRUSTING ONE.
//
// A real prospect — 247lighting.net — was reported unreachable by enrichment,
// the website audit and intent's social discovery all at once, while opening
// fine in a browser. One cause:
//
//   leaf *.247lighting.net -> intermediate "YR1" -> "ISRG Root YR"
//
// The server sends only the leaf, and the CA above the missing intermediate is
// a Let's Encrypt root cross-signed by ISRG Root X1 — which Node has trusted
// all along. Browsers follow each certificate's AUTHORITY INFORMATION ACCESS
// pointer up the chain until they reach something trusted. Node does not, so
// it could not build a path and refused, correctly, on what it had.
//
// The recovery fetches those published issuer certificates and retries with
// verification STILL ON. So the only thing that changes is whether a path can
// be built; whether the path is acceptable is decided by OpenSSL against the
// platform roots, exactly as before.
//
// These tests guard the line between those two things. The narrow classifier
// below is what keeps a broken certificate broken: an expired, self-signed or
// wrong-hostname certificate is a fact about the site, and no number of extra
// downloads can or should change it.

describe('only an INCOMPLETE chain is eligible for recovery', () => {
  const err = (code: string) => ({ cause: { code } })

  it('accepts the two codes that mean "the path is missing a link"', () => {
    expect(isIncompleteChainError(err('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe(true)
    expect(isIncompleteChainError(err('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))).toBe(true)
  })

  // THE SAFETY PROPERTY. Each of these is a real defect in the site's
  // certificate, and fetching its issuers cannot repair any of them. A site in
  // one of these states must stay unfetched and be described accurately.
  it('refuses every code that means the certificate itself is bad', () => {
    for (const code of [
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_REVOKED',
      'CERT_SIGNATURE_FAILURE',
      'UNABLE_TO_GET_CRL',
    ]) {
      expect(isIncompleteChainError(err(code)), code).toBe(false)
    }
  })

  it('refuses transport failures, which have nothing to do with certificates', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN']) {
      expect(isIncompleteChainError(err(code)), code).toBe(false)
    }
  })

  it('refuses an error carrying no code at all', () => {
    expect(isIncompleteChainError(new Error('fetch failed'))).toBe(false)
    expect(isIncompleteChainError(undefined)).toBe(false)
    expect(isIncompleteChainError(null)).toBe(false)
    expect(isIncompleteChainError({})).toBe(false)
  })

  // node's fetch buries the reason in err.cause.code; a bare throw from the
  // tls layer carries it on the error itself. Both shapes reach this.
  it('reads the code from either shape', () => {
    expect(isIncompleteChainError({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })).toBe(true)
    expect(isIncompleteChainError({ code: 'CERT_HAS_EXPIRED' })).toBe(false)
  })
})

describe('the recovery is company-agnostic', () => {
  it('names no host, domain, company or certificate authority', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/research/tlsChain.ts', 'utf8')
    // Strip comments: the file explains itself by naming the prospect and the
    // CA that exposed the gap, and an explanation is not a branch.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')

    for (const literal of ['247lighting', 'lencr', 'ISRG', 'Root YR', 'YR1', "Let's Encrypt", 'badssl']) {
      expect(code, literal).not.toContain(literal)
    }
    // No allowlist of hosts or issuers anywhere in the logic.
    expect(code).not.toMatch(/allowlist|whitelist|KNOWN_(HOSTS|CAS|ROOTS)/i)
  })

  it('never disables verification on the request that carries data', async () => {
    const { readFileSync } = await import('node:fs')
    const fetcher = readFileSync('src/research/pageFetch.ts', 'utf8')
    // The retry must assert verification explicitly rather than inherit it.
    expect(fetcher).toContain('rejectUnauthorized: true')
    // And must never turn it off.
    expect(fetcher).not.toMatch(/rejectUnauthorized:\s*false/)
    expect(fetcher).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED')

    // The one unverified handshake in the codebase is the chain READ, and it
    // must stay inside tlsChain.ts where its purpose is documented. Counted in
    // CODE only — the comment above it names the setting to explain why it is
    // there, and an explanation is not a second handshake.
    const chainCode = readFileSync('src/research/tlsChain.ts', 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect((chainCode.match(/rejectUnauthorized:\s*false/g) ?? []).length).toBe(1)
  })

  it('bounds the walk so a hostile chain cannot loop', async () => {
    const { readFileSync } = await import('node:fs')
    const chain = readFileSync('src/research/tlsChain.ts', 'utf8')
    expect(chain).toMatch(/MAX_AIA_HOPS\s*=\s*[1-5]\b/)
    expect(chain).toMatch(/MAX_CERT_BYTES/)
    expect(chain).toMatch(/AIA_TIMEOUT_MS/)
    // The issuer URL comes out of a third party's certificate, so it is an
    // address a stranger chose and goes through the same SSRF guard.
    expect(chain).toContain('assertPublicHost')
  })
})

describe('the cache', () => {
  it('can be cleared, so a test never inherits another test’s chain', () => {
    expect(() => resetChainCache()).not.toThrow()
  })
})
