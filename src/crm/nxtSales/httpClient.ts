import { AsyncLocalStorage } from 'node:async_hooks'
import jwt from 'jsonwebtoken'
import pLimit from 'p-limit'
import { env } from '../../config/env.js'
import { assertServiceIdentity, isLocalTarget } from '../../crmsync/writeGate.js'
import { UpstreamError } from '../../platform/errors.js'
import { logger } from '../../platform/logger.js'

// HTTP transport for NXT Sales.
//
// SERVICE ACCOUNT — no NXT Sales code change is required for this to work.
// NXT Sales' authMiddleware verifies a bearer JWT signed with JWT_SECRET and
// carrying {id, email, name, role}; this client mints exactly that for a
// dedicated User row whose id is NXT_SALES_SERVICE_USER_ID. The token is
// short-lived and re-minted rather than stored.
//
// KNOWN LIMITATION, deliberately accepted: NXT Sales enforces no role checks
// anywhere, so this token has the same reach any logged-in user has. This is
// contained by keeping the writes few, named and gated (crmPut / crmPost
// below, CRM_WRITE_ENABLED, CRM_WRITE_ALLOW_LIVE, the confirmed identity).
// Narrowing the credential itself is Phase 0 RBAC work in NXT Sales and is
// tracked as a follow-up, not silently assumed to be in place.

const TOKEN_TTL_SECONDS = 600
const RETRYABLE_STATUS = new Set([502, 503, 504])

let cached: { token: string; expiresAt: number } | null = null

function serviceToken(): string {
  // A pre-made token is used as it is: nothing is signed, so JWT_SECRET is not needed for CRM access at all.
  if (env.NXT_SALES_STATIC_TOKEN) return env.NXT_SALES_STATIC_TOKEN
  const now = Date.now()
  if (cached && cached.expiresAt > now + 30_000) return cached.token
  const token = jwt.sign(
    {
      id: env.NXT_SALES_SERVICE_USER_ID,
      email: env.NXT_SALES_SERVICE_USER_EMAIL,
      name: 'Marketing Agent (service)',
      role: 'member',
    },
    env.JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS },
  )
  cached = { token, expiresAt: now + TOKEN_TTL_SECONDS * 1000 }
  return token
}

// ── THE ONE DOOR TO NXT SALES ────────────────────────────────────────────────
//
// Every request this platform sends to NXT Sales goes through crmFetch — it is
// the only call to fetch() in this file (a test scans for that), and no other
// module builds a CRM URL (a test scans for that too). That makes it the place
// to enforce READ-ONLY MODE (CRM_READ_ONLY=true) at the TRANSPORT, below every
// feature switch:
//
//   · only the method GET, written exactly so; POST, PUT, PATCH, DELETE, HEAD, OPTIONS
//     and anything else are refused before a socket is opened;
//   · only the endpoints in READ_ONLY_ENDPOINTS, matched on the whole path;
//   · only the configured CRM origin, with no credentials in the URL;
//   · no body, and a redirect is an error rather than something followed (a
//     redirect could carry the token — or turn into another request — elsewhere).
//
// So a write is blocked even if CRM_WRITE_ENABLED, CRM_WRITE_ALLOW_LIVE,
// BULK_SEND_VIA=crm and WARM_LEADS_SYNC_ENABLED were ALL switched on by mistake.

/** The only endpoints read-only mode allows, matched on the entire path (the query string is free). */
export const READ_ONLY_ENDPOINTS: readonly RegExp[] = [
  /^\/api\/companies$/, // the company list, one page at a time
  /^\/api\/companies\/[A-Za-z0-9_-]{16,40}$/, // ONE company by id (ids are 16+ characters, so /export and the other named routes never match)
  /^\/api\/deals$/, // a company's deals
  /^\/api\/deals\/export$/, // every deal, one read
  /^\/api\/activities$/, // a company's emails
]

export class CrmReadOnlyViolation extends UpstreamError {
  constructor(message: string, path: string) {
    super(`Blocked by CRM_READ_ONLY: ${message}`, { retryable: false, details: { path } })
    this.name = 'CrmReadOnlyViolation'
  }
}

const crmRequestCounts = { allowed: 0, blocked: 0 }
/** How many requests read-only mode let through and refused — reported by the isolated test. */
export const crmRequestStats = () => ({ ...crmRequestCounts })

/** Throws unless this request is a permitted read. Pure apart from the counters; no network. */
export function assertReadOnlyAllowed(method: unknown, rawUrl: string, init?: { body?: unknown }): void {
  const refuse = (why: string, path = rawUrl): never => {
    crmRequestCounts.blocked++
    throw new CrmReadOnlyViolation(why, path)
  }
  if (method !== 'GET') refuse(`method ${JSON.stringify(method)} is not GET`)
  if (init?.body !== undefined && init.body !== null) refuse('a GET with a body')
  let url: URL
  let origin: URL
  try {
    url = new URL(rawUrl)
    origin = new URL(env.NXT_SALES_BASE_URL)
  } catch {
    return refuse('the URL could not be read')
  }
  if (url.origin !== origin.origin) refuse(`${url.origin} is not the configured CRM`, url.pathname)
  if (url.username || url.password) refuse('credentials in the URL', url.pathname)
  if (!READ_ONLY_ENDPOINTS.some((re) => re.test(url.pathname))) refuse('this endpoint is not on the read-only list', url.pathname)
}

// ── SCOPED ACCESS (Warm Leads, permanent module) ─────────────────────────────
//
// CRM_READ_ONLY is all-or-nothing for the whole process, which suits the isolated
// test but not production: the same installation sends bulk email through the CRM.
// So read-only is also a SCOPE:
//
//   · a process can declare itself read-only (setCrmProcessReadOnly) - the Warm Leads
//     worker does; every CRM request that process makes is a permitted GET, whatever
//     feature asked;
//   · code can open a read-only scope (withCrmReadOnly) inside a wider process;
//   · the one narrow exception is the 'sync' scope, which additionally allows PUT/DELETE
//     on the Warm Leads endpoints of NXT Sales and nothing else. Only the Warm Leads
//     sender opens it, and only after its own switches pass.
//
// The global CRM_READ_ONLY=true always wins: no scope can lift it.

export type CrmAccessMode = 'read' | 'sync'
const accessScope = new AsyncLocalStorage<CrmAccessMode>()
let processReadOnly = false

export const withCrmReadOnly = <T>(fn: () => Promise<T>): Promise<T> => accessScope.run('read', fn)
export const withCrmWarmLeadsSync = <T>(fn: () => Promise<T>): Promise<T> => accessScope.run('sync', fn)
/** For a dedicated process: every CRM request it makes is a read unless a narrower scope says otherwise. */
export function setCrmProcessReadOnly(on = true): void {
  processReadOnly = on
}

/** The only write endpoints the 'sync' scope allows, matched on the whole path. */
export const WARM_SYNC_WRITE_ENDPOINTS: ReadonlyArray<{ method: 'PUT' | 'DELETE'; path: RegExp }> = [
  { method: 'PUT', path: /^\/api\/marketing-warm-leads\/companies\/[A-Za-z0-9_-]{1,100}$/ },
  { method: 'DELETE', path: /^\/api\/marketing-warm-leads\/companies\/[A-Za-z0-9_-]{1,100}$/ },
  { method: 'PUT', path: /^\/api\/marketing-warm-leads\/runs\/[A-Za-z0-9_-]{1,100}$/ },
]

/** Throws unless this request is a permitted read, or a permitted Warm Leads write inside a 'sync' scope. */
export function assertSyncScopeAllowed(method: unknown, rawUrl: string, init?: { body?: unknown }): void {
  if (method === 'GET') return assertReadOnlyAllowed(method, rawUrl, init)
  const refuse = (why: string, path = rawUrl): never => {
    crmRequestCounts.blocked++
    throw new CrmReadOnlyViolation(why, path)
  }
  let url: URL
  let origin: URL
  try {
    url = new URL(rawUrl)
    origin = new URL(env.NXT_SALES_BASE_URL)
  } catch {
    return refuse('the URL could not be read')
  }
  if (url.origin !== origin.origin) refuse(`${url.origin} is not the configured CRM`, url.pathname)
  if (url.username || url.password) refuse('credentials in the URL', url.pathname)
  if (!WARM_SYNC_WRITE_ENDPOINTS.some((e) => e.method === method && e.path.test(url.pathname))) {
    refuse(`${JSON.stringify(method)} ${url.pathname} is not a Warm Leads sync endpoint`, url.pathname)
  }
}

/** The only place this platform calls fetch() for NXT Sales. */
export async function crmFetch(url: string, init: RequestInit & { method?: string } = {}): Promise<Response> {
  const method = init.method ?? 'GET'
  const scope = accessScope.getStore()
  if (env.CRM_READ_ONLY || (scope === undefined && processReadOnly) || scope === 'read') {
    assertReadOnlyAllowed(method, url, init)
    crmRequestCounts.allowed++
    return fetch(url, { ...init, method: 'GET', redirect: 'error' })
  }
  if (scope === 'sync') {
    assertSyncScopeAllowed(method, url, init)
    crmRequestCounts.allowed++
    return fetch(url, { ...init, method, redirect: 'error' })
  }
  return fetch(url, init)
}

// NXT Sales has no rate limiting of its own, so throttling is this client's
// responsibility. An agent run issues dozens of calls; unbounded concurrency
// against a single-process CRM that people are actively using is not acceptable.
const limit = pLimit(env.NXT_SALES_MAX_CONCURRENCY)

/**
 * Whether NXT Sales is reachable AND accepts this platform's credential.
 *
 * Used by /health/ready. It asks GET /api/auth/me — one read of the service
 * user, nothing written — through the same base address and token as every
 * real call, so a pass means the real calls will work. The old probe asked
 * for /health with no token; NXT Sales has no such page behind its website,
 * which answered with its HTML, so readiness reported the CRM down every time
 * (2026-10-06). Five seconds, no retry: a readiness check must be quick.
 */
export async function probeCrm(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await crmFetch(`${env.NXT_SALES_BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${serviceToken()}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return { ok: false, detail: `NXT Sales answered HTTP ${res.status}.` }
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      return { ok: false, detail: 'NXT Sales answered with a web page instead of data — check NXT_SALES_BASE_URL.' }
    }
    const body = (await res.json().catch(() => null)) as { id?: string } | null
    if (!body?.id || body.id !== env.NXT_SALES_SERVICE_USER_ID) {
      return { ok: false, detail: 'NXT Sales does not recognise this platform’s service user (NXT_SALES_SERVICE_USER_ID).' }
    }
    return { ok: true }
  } catch (err) {
    const e = err as Error
    return { ok: false, detail: e.name === 'TimeoutError' ? 'NXT Sales did not answer within 5 seconds.' : e.message }
  }
}

export interface QueryParams {
  [k: string]: string | number | boolean | string[] | undefined
}

/**
 * Builds the query string with the encodings NXT Sales actually expects.
 * Array values are emitted as REPEATED `key[]=` params — the encoding axios
 * produces and the one companies.js relies on for `industries`. Comma-joining
 * them would shred any value containing a comma.
 */
export function buildQuery(params: QueryParams): string {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v !== undefined && v !== null && v !== '') sp.append(`${key}[]`, String(v))
      }
    } else {
      sp.append(key, String(value))
    }
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function once<T>(path: string, params: QueryParams): Promise<T> {
  const url = `${env.NXT_SALES_BASE_URL}${path}${buildQuery(params)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.NXT_SALES_TIMEOUT_MS)

  try {
    const res = await crmFetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${serviceToken()}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 4xx is a contract problem — retrying it just burns the CRM's capacity.
      throw new UpstreamError(`NXT Sales ${res.status} on ${path}`, {
        retryable: RETRYABLE_STATUS.has(res.status),
        details: { status: res.status, body: body.slice(0, 400) },
      })
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof UpstreamError) throw err
    if ((err as Error).name === 'AbortError') {
      throw new UpstreamError(`NXT Sales timed out on ${path}`, { retryable: true })
    }
    throw new UpstreamError(`NXT Sales unreachable on ${path}`, {
      retryable: true,
      details: { message: (err as Error).message },
    })
  } finally {
    clearTimeout(timer)
  }
}

/** GET with bounded concurrency and one retry for genuinely transient failures. */
export async function crmGet<T>(path: string, params: QueryParams = {}): Promise<T> {
  return limit(async () => {
    try {
      return await once<T>(path, params)
    } catch (err) {
      if (err instanceof UpstreamError && err.retryable) {
        logger.warn({ path }, 'NXT Sales call failed, retrying once')
        await new Promise((r) => setTimeout(r, 750))
        return once<T>(path, params)
      }
      throw err
    }
  })
}

/**
 * The writes this client can perform: PUT (update a company) and, since
 * 2026-09-29, POST (create a company or its Lead Source setup, on a person's
 * click — see src/crm/leads). Both go through `write()` below and nothing else.
 *
 * Separate functions rather than a `method` parameter on `once()`, so the read
 * path keeps its hard-coded GET and cannot be turned into a write by passing
 * an argument. Everything about a write is deliberately narrow:
 *
 *   GATED    Refuses unless CRM_WRITE_ENABLED. The check is here as well as in
 *            the write gate because this is the last code that touches the
 *            wire, and a guard that only exists further up is a guard a future
 *            caller can route around.
 *
 *   NO RETRY A failed write is NOT retried. A GET is idempotent so retrying it
 *            costs nothing; a write that may or may not have landed must be
 *            reported and decided on, not repeated hopefully. A create that
 *            timed out is found again by the duplicate check on the next try.
 *
 *   NO DELETE There is no PATCH or DELETE. Deleting records is outside the
 *            approved scope, so it has no implementation to be enabled by
 *            mistake.
 */
export async function crmPut<T>(path: string, body: unknown): Promise<T> {
  return write<T>('PUT', path, body)
}

/** Create — same gate, same single attempt as crmPut. */
export async function crmPost<T>(path: string, body: unknown): Promise<T> {
  return write<T>('POST', path, body)
}

async function write<T>(method: 'PUT' | 'POST', path: string, body: unknown): Promise<T> {
  if (!env.CRM_WRITE_ENABLED) {
    throw new UpstreamError('Refusing to write to NXT Sales: CRM_WRITE_ENABLED is off.', {
      retryable: false,
      details: { path },
    })
  }

  // A LIVE CRM IS READ-ONLY UNLESS SOMEONE SAYS OTHERWISE, SEPARATELY.
  //
  // Enabling writes against a local snapshot is ordinary. Pointing the base URL
  // at the real CRM is also ordinary. What must not be ordinary is the two of
  // them together happening by accident, so a non-local target needs its own
  // deliberate switch, and the default answer is no.
  if (!isLocalTarget(env.NXT_SALES_BASE_URL) && !env.CRM_WRITE_ALLOW_LIVE) {
    throw new UpstreamError(
      'Refusing to write to a non-local NXT Sales: CRM_WRITE_ALLOW_LIVE is off. This platform is connected to ' +
        'the live CRM for reading only. Nothing was sent.',
      { retryable: false, details: { path } },
    )
  }

  // Checked here as well as in the write gate. This is the last code before the
  // wire, and a guard only at the top protects only the callers that go through
  // the top. Signing a live write with the wrong id cannot be undone: NXT Sales
  // checks the signature alone, so the CRM would record the change against
  // whoever that id names.
  try {
    assertServiceIdentity()
  } catch (err) {
    throw new UpstreamError((err as Error).message, { retryable: false, details: { path } })
  }

  return limit(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), env.NXT_SALES_TIMEOUT_MS)
    try {
      const res = await crmFetch(`${env.NXT_SALES_BASE_URL}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${serviceToken()}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // A 400 here is almost always an unlisted dropdown option. Say so,
        // because "NXT Sales 400" alone sends someone reading logs nowhere.
        const hint =
          res.status === 400
            ? ' The most likely cause is a value the target field does not accept — check the dropdown options.'
            : ''
        throw new UpstreamError(`NXT Sales ${res.status} on ${method} ${path}.${hint}`, {
          // Never retryable. See the note above.
          retryable: false,
          details: { status: res.status, body: text.slice(0, 400) },
        })
      }
      return (await res.json()) as T
    } catch (err) {
      if (err instanceof UpstreamError) throw err
      if ((err as Error).name === 'AbortError') {
        throw new UpstreamError(`NXT Sales timed out on ${method} ${path}. The write may or may not have landed.`, {
          retryable: false,
          details: { timedOut: true },
        })
      }
      throw new UpstreamError(`NXT Sales unreachable on ${method} ${path}`, {
        retryable: false,
        details: { message: (err as Error).message },
      })
    } finally {
      clearTimeout(timer)
    }
  })
}

/** Same as crmGet but resolves to null on 404 instead of throwing. */
export async function crmGetOrNull<T>(path: string, params: QueryParams = {}): Promise<T | null> {
  try {
    return await crmGet<T>(path, params)
  } catch (err) {
    const status = (err as UpstreamError)?.details as { status?: number } | undefined
    if (status?.status === 404) return null
    throw err
  }
}

/**
 * Bulk Email sending through NXT Sales (2026-10-09): the one channel to the
 * CRM's /api/marketing-bulk API. It does not create or change CRM records
 * itself — NXT Sales sends the email through its own pipeline and records it —
 * so it has its own explicit switch (BULK_SEND_VIA=crm) rather than
 * CRM_WRITE_ENABLED, which stays off. The same service identity check as
 * every write still applies to a live CRM.
 *
 * Answers with the HTTP status and the JSON body whatever the status, because
 * the API's error answers carry the send outcome. Throws only when NXT Sales
 * gave no answer (unreachable, timeout) — in that case the email may or may
 * not have been sent, and the caller must treat it as unknown.
 */
export async function crmBulkRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = env.NXT_SALES_TIMEOUT_MS): Promise<{ status: number; body: T | null }> {
  if (env.BULK_SEND_VIA !== 'crm') {
    throw new UpstreamError('Refusing to call the NXT Sales bulk-send API: BULK_SEND_VIA is not "crm".', { retryable: false, details: { path } })
  }
  try {
    assertServiceIdentity()
  } catch (err) {
    throw new UpstreamError((err as Error).message, { retryable: false, details: { path } })
  }
  return limit(async () => {
    const res = await crmFetch(`${env.NXT_SALES_BASE_URL}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${serviceToken()}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const parsed = (await res.json().catch(() => null)) as T | null
    return { status: res.status, body: parsed }
  })
}

/**
 * Warm leads (2026-10-30): writes one evaluation result or run summary to NXT
 * Sales' /api/marketing-warm-leads. It changes no company field — NXT Sales
 * stores the result in its own table — so it has its own switch
 * (WARM_LEADS_SYNC_ENABLED) rather than CRM_WRITE_ENABLED, plus the same rule
 * for a live CRM (WARM_LEADS_ALLOW_LIVE) and the same service identity check
 * as every write. A PUT of the same result is harmless twice, so one retry is
 * made when NXT Sales gave no answer or a 5xx.
 */
export async function crmWarmLeadsPut(path: string, body: unknown): Promise<void> {
  return warmLeadsWrite('PUT', path, body)
}

/** Removes one company from NXT Sales' Warm Leads list (its evidence stays in the Marketing database). Same gates as the PUT. */
export async function crmWarmLeadsDelete(path: string): Promise<void> {
  return warmLeadsWrite('DELETE', path, undefined)
}

async function warmLeadsWrite(method: 'PUT' | 'DELETE', path: string, body: unknown): Promise<void> {
  if (!env.WARM_LEADS_SYNC_ENABLED) {
    throw new UpstreamError('Not sent to NXT Sales: WARM_LEADS_SYNC_ENABLED is off.', { retryable: false, details: { path } })
  }
  if (!isLocalTarget(env.NXT_SALES_BASE_URL) && !env.WARM_LEADS_ALLOW_LIVE) {
    throw new UpstreamError('Not sent to NXT Sales: it is not a local CRM and WARM_LEADS_ALLOW_LIVE is off.', { retryable: false, details: { path } })
  }
  try {
    assertServiceIdentity()
  } catch (err) {
    throw new UpstreamError((err as Error).message, { retryable: false, details: { path } })
  }
  const attempt = () =>
    limit(() =>
      // The 'sync' scope is opened here and nowhere else: it permits only the Warm Leads endpoints (WARM_SYNC_WRITE_ENDPOINTS),
      // and never lifts the global CRM_READ_ONLY.
      withCrmWarmLeadsSync(async () => {
        const res = await crmFetch(`${env.NXT_SALES_BASE_URL}/api/marketing-warm-leads${path}`, {
          method,
          signal: AbortSignal.timeout(env.NXT_SALES_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${serviceToken()}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new UpstreamError(`NXT Sales ${res.status} on ${method} /api/marketing-warm-leads${path}`, {
            retryable: res.status >= 500,
            details: { status: res.status, body: text.slice(0, 400) },
          })
        }
      }),
    )
  try {
    await attempt()
  } catch (err) {
    // No answer at all (network, timeout) or a 5xx: once more. A 4xx is a real refusal.
    if (err instanceof UpstreamError && !err.retryable) throw err
    await new Promise((r) => setTimeout(r, 750))
    await attempt()
  }
}
