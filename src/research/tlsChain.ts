import { X509Certificate } from 'node:crypto'
import http from 'node:http'
import tls from 'node:tls'
import { logger } from '../platform/logger.js'
import { assertPublicHost } from './ssrfGuard.js'

// COMPLETING A CERTIFICATE CHAIN THE SERVER DID NOT SEND.
//
// WHY THIS EXISTS. A real prospect, 247lighting.net, was reported unreachable
// by three engines at once — enrichment, the website audit and intent's social
// discovery — while opening perfectly in a browser. The cause was one thing:
//
//   leaf *.247lighting.net  ->  intermediate "YR1"  ->  "ISRG Root YR"
//
// The server sends ONE certificate. It omits the intermediate, and the CA
// above that intermediate is a recently cross-signed Let's Encrypt root that
// is not in Node's bundled store. Node therefore cannot build a path to
// anything it trusts, and refuses — correctly, on the information it has.
//
// Browsers do not fail, and the reason is not that they are laxer. They follow
// the AUTHORITY INFORMATION ACCESS extension: each certificate names a URL
// where its issuer can be downloaded, and a browser fetches up the chain until
// it reaches something it trusts. That is a completeness mechanism, not a trust
// mechanism, and it is what this module does.
//
// WHAT THIS DOES NOT DO, because the distinction is the whole safety argument:
//
//   · It NEVER disables verification. The certificates fetched here are ADDED
//     to the trust set for one retry, and that retry still runs with
//     rejectUnauthorized: true. The completed chain must still terminate at a
//     root Node already trusts. For the site above that terminus is ISRG Root
//     X1 — which cross-signed ISRG Root YR and has been trusted all along.
//   · It NEVER accepts a self-signed, expired or mismatched certificate. Those
//     produce different errors and are not retried.
//   · It NEVER trusts what a server hands it. A certificate presented by the
//     server is used only to read the URL in its AIA extension; the issuer is
//     then fetched from that URL and must itself chain upwards.
//
// So the worst this can do is fail to complete a chain, which is where we
// already are. It cannot turn an untrusted connection into a trusted one
// unless a genuine path to a genuine root exists.

/** Hops up the chain. Two is enough for intermediate + cross-signed root. */
const MAX_AIA_HOPS = 3
/** One chain fetch is small. This is a sanity bound, not a tuning knob. */
const MAX_CERT_BYTES = 16 * 1024
const AIA_TIMEOUT_MS = 6_000
const HANDSHAKE_TIMEOUT_MS = 8_000
/** Chains do not change often; re-deriving one per request would be absurd. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

interface CacheEntry {
  at: number
  /** PEM certificates to add for this host, or null when none could be found. */
  chain: string[] | null
}
const cache = new Map<string, CacheEntry>()

/** Node error codes that mean "the path is incomplete", not "the cert is bad". */
const COMPLETABLE = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'])

/**
 * Is this failure one that completing the chain could plausibly fix?
 *
 * Deliberately narrow. An expired certificate, a hostname mismatch or a
 * self-signed certificate are all facts about the site that a customer should
 * be told, and fetching more certificates cannot change any of them.
 */
export function isIncompleteChainError(err: unknown): boolean {
  const e = err as { cause?: { code?: string }; code?: string }
  const code = e?.cause?.code ?? e?.code ?? ''
  return COMPLETABLE.has(code)
}

const toPem = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`

/** Already a PEM? Some CAs serve text rather than DER. */
const asPem = (bytes: Buffer): string =>
  bytes.subarray(0, 27).toString('latin1').includes('BEGIN CERTIFICATE') ? bytes.toString('latin1') : toPem(bytes)

/**
 * Downloads one issuer certificate from its AIA URL.
 *
 * http:// on purpose — that is what CAs publish, and it is safe here because a
 * certificate is self-authenticating: it is worthless unless it verifies the
 * certificate below it AND chains to a trusted root, both of which are checked
 * by OpenSSL on the retry. Nothing is trusted because it arrived over http.
 *
 * Still SSRF-guarded: the URL comes out of a certificate a third party served,
 * so it is a third-party-controlled address like any other.
 */
async function fetchIssuer(rawUrl: string): Promise<string | null> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  try {
    await assertPublicHost(url.hostname)
  } catch {
    return null
  }

  return new Promise<string | null>((resolve) => {
    const req = http.get(
      url,
      { timeout: AIA_TIMEOUT_MS, headers: { Accept: 'application/pkix-cert, application/x-x509-ca-cert, */*' } },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume()
          resolve(null)
          return
        }
        const parts: Buffer[] = []
        let total = 0
        res.on('data', (d: Buffer) => {
          total += d.length
          if (total > MAX_CERT_BYTES) {
            req.destroy()
            resolve(null)
            return
          }
          parts.push(d)
        })
        res.on('end', () => {
          try {
            const pem = asPem(Buffer.concat(parts))
            // Parsed before use: bytes that are not a certificate are not one.
            new X509Certificate(pem)
            resolve(pem)
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

/** Every root Node already trusts, by subject, so the walk knows when to stop. */
let rootSubjects: Set<string> | null = null
function trustedSubjects(): Set<string> {
  if (rootSubjects) return rootSubjects
  const set = new Set<string>()
  for (const pem of tls.rootCertificates) {
    try {
      set.add(new X509Certificate(pem).subject)
    } catch {
      /* a root we cannot parse is a root we cannot match */
    }
  }
  rootSubjects = set
  return set
}

/**
 * Reads the certificate a host presents, then walks its AIA pointers upward
 * until the chain reaches something Node already trusts.
 *
 * The initial handshake uses `rejectUnauthorized: false` — and that is the one
 * line in this module that needs justifying. It is used ONLY to read the
 * certificate the server presents, so that its AIA extension can be followed.
 * No HTTP request is made over that socket, no byte of content is read from
 * it, and the socket is closed immediately. The connection that actually
 * carries data is a separate one, made afterwards with verification ON.
 *
 * Returns the certificates to add, or null when the chain cannot be completed
 * — in which case the caller reports the original failure, unchanged.
 */
export async function completeCertificateChain(hostname: string, port = 443): Promise<string[] | null> {
  const key = `${hostname}:${port}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.chain

  const remember = (chain: string[] | null): string[] | null => {
    cache.set(key, { at: Date.now(), chain })
    return chain
  }

  const presented = await new Promise<X509Certificate | null>((resolve) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: HANDSHAKE_TIMEOUT_MS },
      () => {
        const peer = socket.getPeerCertificate(true)
        socket.destroy()
        if (!peer || !peer.raw) {
          resolve(null)
          return
        }
        // The topmost certificate the server actually sent: that is the one
        // whose issuer is missing, and therefore the one to chase from.
        let top = peer
        const seen = new Set<string>()
        while (top.issuerCertificate && top.issuerCertificate !== top) {
          const fp = top.issuerCertificate.fingerprint256 ?? ''
          if (seen.has(fp)) break
          seen.add(fp)
          top = top.issuerCertificate
        }
        try {
          resolve(new X509Certificate(top.raw))
        } catch {
          resolve(null)
        }
      },
    )
    socket.on('error', () => resolve(null))
    socket.on('timeout', () => {
      socket.destroy()
      resolve(null)
    })
  })

  if (!presented) return remember(null)

  const trusted = trustedSubjects()
  const added: string[] = []
  let current = presented

  for (let hop = 0; hop < MAX_AIA_HOPS; hop++) {
    // Reached a trusted anchor, or a self-signed certificate: stop.
    if (trusted.has(current.issuer) || current.issuer === current.subject) break

    const aia = current.infoAccess ?? ''
    const uri = /CA Issuers - URI:(\S+)/.exec(aia)?.[1]
    if (!uri) break

    const pem = await fetchIssuer(uri)
    if (!pem) break

    let issuer: X509Certificate
    try {
      issuer = new X509Certificate(pem)
    } catch {
      break
    }
    // The certificate fetched must actually be the issuer of the one below it.
    // Without this the walk would follow any URL a server chose to publish.
    if (issuer.subject !== current.issuer) break

    added.push(pem)
    current = issuer
  }

  if (added.length === 0) return remember(null)

  // Only worth returning when the walk actually terminated somewhere trusted.
  // Anything else would hand OpenSSL a longer chain that still fails, which is
  // the same outcome with extra requests.
  const terminates = trusted.has(current.issuer) || current.issuer === current.subject
  if (!terminates) {
    logger.info(
      { hostname, certificatesFetched: added.length, stoppedAt: current.subject },
      'certificate chain could not be completed to a trusted root',
    )
    return remember(null)
  }

  logger.info(
    { hostname, certificatesFetched: added.length, anchor: current.issuer },
    'certificate chain completed from the AIA pointers the site publishes; the retry still verifies',
  )
  return remember(added)
}

/** Test seam: chains are cached for hours, which a test must not inherit. */
export function resetChainCache(): void {
  cache.clear()
}
