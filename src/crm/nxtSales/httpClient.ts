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
    const res = await fetch(`${env.NXT_SALES_BASE_URL}/api/auth/me`, {
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
    const res = await fetch(url, {
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
      const res = await fetch(`${env.NXT_SALES_BASE_URL}${path}`, {
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
