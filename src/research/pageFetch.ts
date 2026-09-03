import crypto from 'node:crypto'
import { env } from '../config/env.js'
import { prisma, newId } from '../platform/db.js'
import { detectSignals, htmlToText, type PageSignals } from './htmlToText.js'
import { assertPublicHost, normalizeUrl } from './ssrfGuard.js'

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

async function fetchWithRedirects(start: URL): Promise<TransportResult> {
  let url = start
  const redirectChain: string[] = [start.toString()]

  for (let hop = 0; hop <= env.RESEARCH_MAX_REDIRECTS; hop++) {
    // Re-validated on EVERY hop: a public URL must not be able to 302 into the
    // private network.
    await assertPublicHost(url.hostname)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), env.RESEARCH_FETCH_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Identify honestly rather than impersonating a browser.
          'User-Agent': env.RESEARCH_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
        },
      })
    } catch (err) {
      throw new Error(describeFetchFailure(err))
    } finally {
      clearTimeout(timer)
    }

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
    if (!res.ok || !isHtmlContentType(ctype)) {
      // The body is discarded without reading it, so a 50MB PDF behind a
      // "datasheet" link costs one request rather than a download.
      await res.body?.cancel().catch(() => undefined)
      return { ...base, html: '', truncated: false, bytes: 0 }
    }

    // Streamed so an enormous or endless response cannot exhaust memory.
    const reader = res.body?.getReader()
    if (!reader) throw new Error('The site returned an empty response.')

    const chunks: Uint8Array[] = []
    let total = 0
    let truncated = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > env.RESEARCH_MAX_BYTES) {
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
      chunks.push(value)
    }

    return {
      html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'),
      finalUrl: url.toString(),
      truncated,
      status: res.status,
      contentType: ctype,
      bytes: total,
      redirectChain,
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
 */
export async function fetchAsset(
  rawUrl: string,
  opts: { allowedTypes: RegExp; maxBytes: number },
): Promise<RawAssetResult> {
  const empty = { status: null, contentType: null, bytes: null, finalUrl: null }
  const start = normalizeUrl(rawUrl)
  if (!start) return { ok: false, ...empty, reason: 'A valid http(s) URL is required.' }

  let url = start
  for (let hop = 0; hop <= env.RESEARCH_MAX_REDIRECTS; hop++) {
    // Re-validated on EVERY hop, exactly as fetchWithRedirects does.
    await assertPublicHost(url.hostname)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), env.RESEARCH_FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': env.RESEARCH_USER_AGENT, Accept: 'image/*' },
      })
    } catch (err) {
      return { ok: false, ...empty, reason: describeFetchFailure(err) }
    } finally {
      clearTimeout(timer)
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      if (!loc) return { ok: false, ...empty, reason: 'The site returned an invalid redirect.' }
      try {
        const next = new URL(loc, url)
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
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

    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, status: res.status, contentType, bytes: null, finalUrl, reason: 'Asset exceeded the size limit.' }
      }
      chunks.push(value)
    }

    return {
      ok: true,
      status: res.status,
      contentType,
      bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))),
      finalUrl,
      reason: null,
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
export async function fetchPageRaw(rawUrl: string): Promise<RawPageResult> {
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
    const r = await fetchWithRedirects(url)
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
  ctx: { tenantId: string; runId?: string | null },
): Promise<PageResult> {
  const url = normalizeUrl(rawUrl)
  if (!url) return { ok: false, requestedUrl: rawUrl, reason: 'A valid http(s) URL is required.' }

  const cached = await prisma.researchArtifact.findFirst({
    where: { tenantId: ctx.tenantId, kind: 'page', requestUrl: url.toString(), expiresAt: { gt: new Date() } },
    orderBy: { fetchedAt: 'desc' },
  })
  if (cached) {
    return {
      ok: cached.ok,
      requestedUrl: url.toString(),
      finalUrl: cached.finalUrl ?? undefined,
      text: cached.extractedText,
      signals: (cached.signals as PageSignals | null) ?? undefined,
      reason: cached.failureReason ?? undefined,
    }
  }

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

    return { ok: true, requestedUrl: url.toString(), finalUrl, text, signals, truncated }
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
        expiresAt,
      },
    })
    return { ok: false, requestedUrl: url.toString(), reason }
  }
}
