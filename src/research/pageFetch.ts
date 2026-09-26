import crypto from 'node:crypto'
import https from 'node:https'
import { Readable } from 'node:stream'
import tls from 'node:tls'
import { env } from '../config/env.js'
import { prisma, newId } from '../platform/db.js'
import { detectSignals, htmlToText, type PageSignals } from './htmlToText.js'
import { assertPublicHost, normalizeUrl } from './ssrfGuard.js'
import { completeCertificateChain, isIncompleteChainError } from './tlsChain.js'

// Server-side page fetch for prospect research, ported from NXT Sales'
// /api/intelligence/page-source. Everything it returns is UNTRUSTED third-party
// text and is labelled as such wherever it reaches a prompt.

const MAX_TEXT_CHARS = 18_000

export interface PageResult {
  ok: boolean
  requestedUrl: string
  finalUrl?: string
  text?: string
  signals?: PageSignals
  truncated?: boolean
  reason?: string
  /**
   * True when this result was served from the ResearchArtifact cache rather
   * than fetched just now. A caller that reports "fetched" must check it.
   */
  cached?: boolean
  /** When the page behind this result was actually fetched (ISO 8601). */
  fetchedAt?: string
}

/**
 * The response plus the release for its deadline.
 *
 * The deadline covers the WHOLE exchange — headers and body. It used to be
 * cleared as soon as the headers arrived, so a server that answered promptly
 * and then dripped its body one byte at a time held the caller forever.
 * `release` must be called once the body has been read or discarded.
 */
interface Fetched {
  res: Response
  release: () => void
}

function hash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/**
 * Everything the transport observed. Callers that only want text ignore most
 * of it; the website audit needs the status, the content type and the redirect
 * chain as evidence in their own right.
 */
interface TransportResult {
  html: string
  finalUrl: string
  truncated: boolean
  status: number
  contentType: string
  bytes: number
  /** Every URL visited, in order, including the starting one. */
  redirectChain: string[]
}

function isHtmlContentType(ctype: string): boolean {
  return !ctype || /text\/html|application\/xhtml|text\/plain/.test(ctype)
}

/**
 * Content types a sitemap is served as.
 *
 * Opt-in rather than folded into isHtmlContentType, because every other caller
 * asks for a PAGE and an XML document is not one — widening the default would
 * hand fetchPage's text extractor a sitemap and let it call the result prose.
 */
/**
 * Content types a SPA's own bundle is served as.
 *
 * Opt-in like the XML reader, and for a narrower purpose: a site that renders
 * itself in the browser serves an empty shell, and the links it publishes —
 * its own social profiles, its own routes — live in the JavaScript it serves
 * alongside. Those assets are the company's own first-party content, fetched
 * logged-out through this same guarded transport. Reading them is not
 * executing them: the bytes are searched as text and nothing is evaluated.
 */
function isAssetContentType(ctype: string): boolean {
  return !ctype || /javascript|ecmascript|application\/json|text\/plain|text\/css/.test(ctype)
}

function isXmlContentType(ctype: string): boolean {
  return !ctype || /xml|text\/plain/.test(ctype)
}

/**
 * Says WHY a fetch failed, instead of flattening every cause into one message.
 *
 * node's fetch reports almost everything as `TypeError: fetch failed` and hides
 * the real reason in `err.cause.code`. That was fine while the only consumer
 * wanted "did we get the page or not", but the website audit collects evidence,
 * and "the certificate expired" is a genuine observation about a prospect's
 * site that "could not reach that site" throws away.
 *
 * Real causes seen against the validation prospects: CERT_HAS_EXPIRED on
 * 360industrialsupply.com, UNABLE_TO_VERIFY_LEAF_SIGNATURE on 247lighting.net,
 * UND_ERR_CONNECT_TIMEOUT on 3e-co.com — three different findings that all
 * previously read as one.
 *
 * Note what this does NOT do: it does not relax certificate verification. A
 * site with a broken certificate stays unfetched; it is merely described
 * accurately.
 */
export function describeFetchFailure(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'The site took too long to respond.'

  const code = e?.cause?.code ?? ''
  switch (code) {
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'The connection to that site timed out.'
    case 'CERT_HAS_EXPIRED':
      return "The site's TLS certificate has expired."
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return "The site's TLS certificate chain is incomplete and could not be verified."
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return "The site's TLS certificate is self-signed."
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return "The site's TLS certificate does not cover that hostname."
    case 'ENOTFOUND':
      return 'That domain could not be resolved.'
    case 'ECONNREFUSED':
      return 'The site refused the connection.'
    case 'ECONNRESET':
      return 'The site reset the connection.'
    case 'EAI_AGAIN':
      return 'DNS lookup for that domain failed temporarily.'
    default:
      return code ? `Could not reach that site (${code}).` : 'Could not reach that site.'
  }
}

/**
 * One request, with ONE retry when the failure was an incomplete chain.
 *
 * Every outbound request in this file goes through here, so the recovery is
 * uniform and there is no second code path to forget about.
 *
 * THE RECOVERY DOES NOT RELAX ANYTHING. `completeCertificateChain` downloads
 * the issuer certificates the site's own certificates point at, and the retry
 * below runs with `rejectUnauthorized: true` — the completed chain must still
 * terminate at a root Node already trusts. A site whose certificate is
 * expired, self-signed or issued for another hostname produces a different
 * error, is not retried, and is reported exactly as it was before.
 *
 * The retry uses node:https rather than fetch because a custom trust set
 * cannot be passed to global fetch without adding a dispatcher library. It
 * keeps the same timeout, the same manual-redirect behaviour and the same
 * headers, and returns a normal Response so callers are unchanged.
 */
function deadline(): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.RESEARCH_FETCH_TIMEOUT_MS)
  return { signal: controller.signal, release: () => clearTimeout(timer) }
}

async function fetchOnce(url: URL, init: { headers: Record<string, string> }): Promise<Fetched> {
  const first = deadline()
  try {
    const res = await fetch(url.toString(), {
      redirect: 'manual',
      signal: first.signal,
      headers: init.headers,
    })
    return { res, release: first.release }
  } catch (err) {
    first.release()
    if (url.protocol !== 'https:' || !isIncompleteChainError(err)) throw err

    const extra = await completeCertificateChain(url.hostname, Number(url.port) || 443)
    if (!extra || extra.length === 0) throw err

    // The retry gets its own budget, as it always has; it now also covers the
    // body, not just the socket going idle.
    const retry = deadline()
    try {
      const res = await httpsRequestVerified(url, init.headers, [...tls.rootCertificates, ...extra], retry.signal)
      return { res, release: retry.release }
    } catch (retryErr) {
      retry.release()
      throw retryErr
    }
  }
}

/**
 * Reads a body to the end (or to `maxBytes`) under the request's deadline.
 *
 * A deadline that fires mid-body surfaces as the same "took too long" failure
 * as one that fires before the headers.
 */
async function readBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<{ chunks: Uint8Array[]; total: number; overLimit: boolean }> {
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { chunks, total, overLimit: true }
      }
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined)
    throw new Error(describeFetchFailure(err))
  }
  return { chunks, total, overLimit: false }
}

/**
 * A single verified GET over node:https with an explicit trust set.
 *
 * `rejectUnauthorized` is left at its default of true and the `ca` list is the
 * platform roots PLUS the issuers the site published. Redirects are not
 * followed, matching `redirect: 'manual'` above.
 */
function httpsRequestVerified(
  url: URL,
  headers: Record<string, string>,
  ca: readonly string[],
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'GET', headers, ca: [...ca], rejectUnauthorized: true, timeout: env.RESEARCH_FETCH_TIMEOUT_MS, signal },
      (res) => {
        const headerEntries: Array<[string, string]> = []
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headerEntries.push([k, v])
          else if (Array.isArray(v)) headerEntries.push([k, v.join(', ')])
        }
        // 204/304 carry no body, and Response refuses one for those statuses.
        const status = res.statusCode ?? 502
        const bodyless = status === 204 || status === 304 || (status >= 100 && status < 200)
        if (bodyless) res.resume()
        resolve(
          new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            headers: headerEntries,
          }),
        )
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error(`The site took too long to respond.`))
    })
    req.end()
  })
}

async function fetchWithRedirects(
  start: URL,
  accepts: (ctype: string) => boolean = isHtmlContentType,
): Promise<TransportResult> {
  let url = start
  const redirectChain: string[] = [start.toString()]

  for (let hop = 0; hop <= env.RESEARCH_MAX_REDIRECTS; hop++) {
    // Re-validated on EVERY hop: a public URL must not be able to 302 into the
    // private network.
    await assertPublicHost(url.hostname)

    let fetched: Fetched
    try {
      fetched = await fetchOnce(url, {
        headers: {
          // Identify honestly rather than impersonating a browser.
          'User-Agent': env.RESEARCH_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
        },
      })
    } catch (err) {
      throw new Error(describeFetchFailure(err))
    }
    const { res } = fetched

    try {
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location')
        if (!loc) throw new Error('The site returned an invalid redirect.')
        let next: URL
        try {
          next = new URL(loc, url)
        } catch {
          throw new Error('The site returned an invalid redirect.')
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error('The site redirected to an unsupported address.')
        }
        url = next
        redirectChain.push(url.toString())
        continue
      }

      const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
      const base = { finalUrl: url.toString(), status: res.status, contentType: ctype, redirectChain }

      // A non-2xx or non-HTML response is REPORTED rather than thrown, because
      // the audit crawler treats both as evidence: a 404 on a linked datasheet
      // and a PDF spec sheet are findings, not failures. Callers that want the
      // older throw-on-error behaviour re-impose it themselves, which is what
      // fetchPage does below — its contract is unchanged.
      if (!res.ok || !accepts(ctype)) {
        // The body is discarded without reading it, so a 50MB PDF behind a
        // "datasheet" link costs one request rather than a download.
        await res.body?.cancel().catch(() => undefined)
        return { ...base, html: '', truncated: false, bytes: 0 }
      }

      // Streamed so an enormous or endless response cannot exhaust memory, and
      // read under the request's deadline so a slow-drip body cannot hang it.
      const reader = res.body?.getReader()
      if (!reader) throw new Error('The site returned an empty response.')

      const { chunks, total, overLimit } = await readBody(reader, env.RESEARCH_MAX_BYTES)

      return {
        html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'),
        finalUrl: url.toString(),
        truncated: overLimit,
        status: res.status,
        contentType: ctype,
        bytes: total,
        redirectChain,
      }
    } finally {
      fetched.release()
    }
  }

  throw new Error('The site redirected too many times.')
}

export interface RawAssetResult {
  ok: boolean
  status: number | null
  contentType: string | null
  bytes: Buffer | null
  finalUrl: string | null
  reason: string | null
}

/**
 * Fetches a binary asset through the SAME guard as everything else.
 *
 * This exists because checking a URL with one request and then downloading it
 * with a bare `fetch` is an SSRF hole: the second request re-resolves DNS and
 * re-follows redirects with no guard at all, so a host that answered safely
 * once can point the download at the private network. Both halves have to go
 * through the same per-hop `assertPublicHost` check, which means they have to
 * be the same request.
 *
 * The content-type allowlist is enforced BEFORE the body is read, and the byte
 * cap is enforced while streaming, so a hostile server cannot spend our memory.
 *
 * `httpsOnly` additionally refuses plain http on EVERY hop, so a caller that
 * started from an https URL cannot be redirected down to http. Off by default:
 * it is the caller who knows whether a downgrade would be a real loss of
 * protection or merely a refusal to read something that was always plain http.
 */
export async function fetchAsset(
  rawUrl: string,
  opts: { allowedTypes: RegExp; maxBytes: number; httpsOnly?: boolean },
): Promise<RawAssetResult> {
  const empty = { status: null, contentType: null, bytes: null, finalUrl: null }
  const start = normalizeUrl(rawUrl)
  if (!start) return { ok: false, ...empty, reason: 'A valid http(s) URL is required.' }

  const schemeAllowed = (u: URL): boolean =>
    opts.httpsOnly ? u.protocol === 'https:' : u.protocol === 'http:' || u.protocol === 'https:'
  if (!schemeAllowed(start)) return { ok: false, ...empty, reason: 'Only https is allowed for this asset.' }

  let url = start
  for (let hop = 0; hop <= env.RESEARCH_MAX_REDIRECTS; hop++) {
    // Re-validated on EVERY hop, exactly as fetchWithRedirects does.
    await assertPublicHost(url.hostname)

    let fetched: Fetched
    try {
      fetched = await fetchOnce(url, { headers: { 'User-Agent': env.RESEARCH_USER_AGENT, Accept: 'image/*' } })
    } catch (err) {
      return { ok: false, ...empty, reason: describeFetchFailure(err) }
    }
    const { res } = fetched

    try {
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location')
        if (!loc) return { ok: false, ...empty, reason: 'The site returned an invalid redirect.' }
        try {
          const next = new URL(loc, url)
          if (!schemeAllowed(next)) {
            return { ok: false, ...empty, reason: 'The site redirected to an unsupported address.' }
          }
          url = next
        } catch {
          return { ok: false, ...empty, reason: 'The site returned an invalid redirect.' }
        }
        continue
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase().split(';')[0]!.trim()
      const finalUrl = url.toString()

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        return { ok: false, status: res.status, contentType, bytes: null, finalUrl, reason: `HTTP ${res.status}.` }
      }
      if (!opts.allowedTypes.test(contentType)) {
        await res.body?.cancel().catch(() => undefined)
        return { ok: false, status: res.status, contentType, bytes: null, finalUrl, reason: `Disallowed content type "${contentType}".` }
      }

      const reader = res.body?.getReader()
      if (!reader) return { ok: false, status: res.status, contentType, bytes: null, finalUrl, reason: 'Empty response.' }

      let body: Awaited<ReturnType<typeof readBody>>
      try {
        body = await readBody(reader, opts.maxBytes)
      } catch (err) {
        return { ok: false, status: res.status, contentType, bytes: null, finalUrl, reason: (err as Error).message }
      }
      if (body.overLimit) {
        return { ok: false, status: res.status, contentType, bytes: null, finalUrl, reason: 'Asset exceeded the size limit.' }
      }

      return {
        ok: true,
        status: res.status,
        contentType,
        bytes: Buffer.concat(body.chunks.map((c) => Buffer.from(c))),
        finalUrl,
        reason: null,
      }
    } finally {
      fetched.release()
    }
  }

  return { ok: false, ...empty, reason: 'The site redirected too many times.' }
}

/** What the audit crawler sees. A failed fetch is data, not an exception. */
export interface RawPageResult {
  ok: boolean
  requestedUrl: string
  finalUrl: string | null
  status: number | null
  contentType: string | null
  html: string
  truncated: boolean
  bytes: number
  redirectChain: string[]
  reason: string | null
  durationMs: number
}

/**
 * The same transport as fetchPage, returning the raw response instead of
 * extracted text.
 *
 * This exists so the website audit does NOT get a second HTTP client. Every
 * protection lives in fetchWithRedirects above and is shared: per-hop SSRF
 * revalidation, the redirect cap, the request timeout, the streamed byte cap.
 * Adding a parallel crawler would mean maintaining those four things twice,
 * and the second copy is the one that quietly loses a check.
 *
 * Deliberately NOT cached through ResearchArtifact: that cache stores extracted
 * text keyed by URL, and writing audit crawls into it would hand Stage 2 and 3
 * pages they never requested. The audit's own AuditedPage rows are its record.
 */
export interface RawFetchOptions {
  /**
   * Read an XML document (a sitemap) instead of HTML.
   *
   * The transport, and every protection in it, is identical either way — this
   * changes only which content types are read rather than discarded.
   */
  as?: 'html' | 'xml' | 'asset'
}

export async function fetchPageRaw(rawUrl: string, opts: RawFetchOptions = {}): Promise<RawPageResult> {
  const started = Date.now()
  const empty = {
    finalUrl: null,
    status: null,
    contentType: null,
    html: '',
    truncated: false,
    bytes: 0,
    redirectChain: [] as string[],
  }

  const url = normalizeUrl(rawUrl)
  if (!url) {
    return {
      ok: false,
      requestedUrl: rawUrl,
      ...empty,
      reason: 'A valid http(s) URL is required.',
      durationMs: Date.now() - started,
    }
  }

  try {
    const accepts =
      opts.as === 'xml' ? isXmlContentType : opts.as === 'asset' ? isAssetContentType : isHtmlContentType
    const r = await fetchWithRedirects(url, accepts)
    return {
      // `ok` describes the TRANSPORT, not the usefulness of the page. A 404
      // that came back cleanly is ok:false with the status preserved, so the
      // caller can tell "the server said no" from "we never reached it".
      ok: r.status >= 200 && r.status < 300,
      requestedUrl: url.toString(),
      finalUrl: r.finalUrl,
      status: r.status,
      contentType: r.contentType,
      html: r.html,
      truncated: r.truncated,
      bytes: r.bytes,
      redirectChain: r.redirectChain,
      reason: r.status >= 200 && r.status < 300 ? null : `The site returned HTTP ${r.status}.`,
      durationMs: Date.now() - started,
    }
  } catch (err) {
    return {
      ok: false,
      requestedUrl: url.toString(),
      ...empty,
      reason: (err as Error).message || 'Could not fetch that page.',
      durationMs: Date.now() - started,
    }
  }
}

/**
 * A prospect site being unreachable is normal, not a fault: this resolves to
 * { ok: false, reason } so the RESEARCH step can carry on and generate without
 * that page, rather than failing the whole run over one dead link.
 */
export async function fetchPage(
  rawUrl: string,
  /**
   * `fresh: true` skips the cache READ (the result is still written to it).
   * For a person who has explicitly asked to look at the site again; every
   * other caller keeps the cached behaviour.
   */
  ctx: { tenantId: string; runId?: string | null; fresh?: boolean },
): Promise<PageResult> {
  const url = normalizeUrl(rawUrl)
  if (!url) return { ok: false, requestedUrl: rawUrl, reason: 'A valid http(s) URL is required.' }

  const cached = ctx.fresh
    ? null
    : await prisma.researchArtifact.findFirst({
        where: { tenantId: ctx.tenantId, kind: 'page', requestUrl: url.toString(), expiresAt: { gt: new Date() } },
        orderBy: { fetchedAt: 'desc' },
      })
  if (cached) {
    const fetchedAt: unknown = cached.fetchedAt
    return {
      ok: cached.ok,
      requestedUrl: url.toString(),
      finalUrl: cached.finalUrl ?? undefined,
      text: cached.extractedText,
      signals: (cached.signals as PageSignals | null) ?? undefined,
      reason: cached.failureReason ?? undefined,
      cached: true,
      fetchedAt: fetchedAt instanceof Date ? fetchedAt.toISOString() : undefined,
    }
  }
  const fetchedAt = new Date().toISOString()

  const expiresAt = new Date(Date.now() + env.RESEARCH_CACHE_TTL_HOURS * 3_600_000)

  try {
    const transport = await fetchWithRedirects(url)

    // fetchWithRedirects now REPORTS these instead of throwing, because the
    // audit crawler treats them as evidence. This caller's contract predates
    // that and is unchanged: a non-2xx or non-HTML response is still a failure
    // with the same message, so Stages 2, 3 and 4 behave exactly as before.
    if (transport.status < 200 || transport.status >= 300) {
      throw new Error(`The site returned HTTP ${transport.status}.`)
    }
    if (!isHtmlContentType(transport.contentType)) {
      throw new Error('That URL is not an HTML page.')
    }

    const { html, finalUrl, truncated } = transport
    const signals = detectSignals(html)
    const text = htmlToText(html).slice(0, MAX_TEXT_CHARS)

    await prisma.researchArtifact.create({
      data: {
        id: newId(),
        tenantId: ctx.tenantId,
        runId: ctx.runId ?? null,
        kind: 'page',
        requestUrl: url.toString(),
        finalUrl,
        contentHash: hash(text),
        extractedText: text,
        signals: signals as never,
        ok: true,
        expiresAt,
      },
    })

    return { ok: true, requestedUrl: url.toString(), finalUrl, text, signals, truncated, cached: false, fetchedAt }
  } catch (err) {
    const reason = (err as Error).message || 'Could not fetch that page.'
    await prisma.researchArtifact.create({
      data: {
        id: newId(),
        tenantId: ctx.tenantId,
        runId: ctx.runId ?? null,
        kind: 'page',
        requestUrl: url.toString(),
        contentHash: hash(reason),
        extractedText: '',
        ok: false,
        failureReason: reason,
        // A FAILURE IS NOT WORTH REMEMBERING AS LONG AS A PAGE.
        //
        // A page that was read is a statement about content, and content
        // changes slowly — a week is a reasonable thing to remember. A page
        // that could not be read is a statement about ONE MOMENT: the host was
        // rate-limiting, the connection reset, the certificate could not be
        // verified by the client we had at the time. Remembering that for a
        // week means one bad minute marks a company unreachable until the
        // following week, and every engine downstream repeats it as fact.
        //
        // That is exactly what happened here: a real prospect stayed
        // "unreachable" across three engines after the underlying cause had
        // been fixed, because the cached failure outlived the defect.
        //
        // Short enough that a retry sees the world as it is now; long enough
        // that one run does not hammer a host that is genuinely down.
        expiresAt: new Date(Date.now() + env.RESEARCH_FAILURE_CACHE_TTL_MINUTES * 60_000),
      },
    })
    return { ok: false, requestedUrl: url.toString(), reason, cached: false, fetchedAt }
  }
}
