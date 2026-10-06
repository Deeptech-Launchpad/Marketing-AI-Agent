// ─────────────────────────────────────────────────────────────────────────
// The API client.
//
// One place that knows how to talk to the marketing agent, so every screen
// gets the same error shape, the same auth header and the same honesty about
// what went wrong.
//
// THE BACKEND IS THE SOURCE OF TRUTH. This file computes nothing: no score, no
// qualification, no availability, no state. It carries what the engines said
// and hands it to the interface unchanged.
// ─────────────────────────────────────────────────────────────────────────

const TOKEN_KEY = 'altiusnxt.marketing.token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* A browser with storage blocked still works; the session just ends on reload. */
  }
}

/**
 * A failure the interface can explain.
 *
 * Carries what failed, why, and whether the caller could do anything about it —
 * so no screen ever has to fall back on "something went wrong".
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: unknown
  readonly requestId?: string
  /**
   * True when the response carried OUR error envelope — `{ error: { code,
   * message } }` from the engines' own error handler — which means the
   * application answered and said what it could not give us.
   *
   * False when nothing recognisable came back: an HTML page, an empty body, a
   * proxy or gateway notice, or the terminal handler's "no such endpoint".
   * That is a transport or routing failure, and a screen must never present it
   * as a result the engines produced.
   */
  readonly isApplicationError: boolean

  constructor(
    status: number,
    code: string,
    message: string,
    detail?: unknown,
    requestId?: string,
    isApplicationError = false,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
    this.requestId = requestId
    this.isApplicationError = isApplicationError
  }

  /** True when the caller lacks permission rather than the request being wrong. */
  get isForbidden(): boolean {
    return this.status === 403
  }

  get isUnauthorized(): boolean {
    return this.status === 401
  }

  get isNotFound(): boolean {
    return this.status === 404
  }

  /**
   * A 404 that the application never authored: the route is gone, the dev
   * proxy answered instead of the API, or the request never reached us.
   *
   * This is the case that used to disappear. Every such 404 was collapsed to
   * null, and the screens drew null as "0 products" / "0 findings" / "no
   * workbench" — reporting a broken request as an audit result.
   */
  get isMissingRoute(): boolean {
    return this.status === 404 && !this.isApplicationError
  }
}

/**
 * What one resource turned out to be, once.
 *
 * Three outcomes that must never be confused with each other:
 *   ready  — the engines produced this, render it;
 *   absent — the engines answered, and answered that nothing has been built
 *            here yet. `reason` is the backend's own sentence, so a screen
 *            quotes it rather than inventing copy;
 *   error  — the request failed. Nothing is known about the resource, and in
 *            particular nothing about it is zero.
 */
export type ResourceState<T> =
  | { kind: 'ready'; data: T }
  | { kind: 'absent'; reason: string; code: string }
  | { kind: 'error'; error: ApiError }

/**
 * Constructors for the three outcomes.
 *
 * `absent` is exported too because a screen sometimes knows a resource is not
 * built without asking: an audit run still queued, with nothing crawled, has
 * no completed report to show even when a zero-valued report row exists for
 * it. That is an absence, and it must read as one.
 */
export const Resource = {
  ready<T>(data: T): ResourceState<T> {
    return { kind: 'ready', data }
  },
  absent<T>(reason: string, code = 'not_built'): ResourceState<T> {
    return { kind: 'absent', reason, code }
  },
  failed<T>(error: ApiError): ResourceState<T> {
    return { kind: 'error', error }
  },
}

/** The payload, when it is one of ours. */
interface ErrorEnvelope {
  code?: string
  message?: string
  requestId?: string
  details?: unknown
}

/**
 * Express's terminal handler answers a path no router claimed with our own
 * envelope, so the envelope alone cannot tell a missing route from a real
 * "nothing built here yet". This sentence is that handler's and only that
 * handler's, and it means the route is gone.
 */
const NO_SUCH_ENDPOINT = 'No such endpoint.'

/**
 * Reads our error envelope out of a response body, or nothing.
 *
 * Only the object form counts. The engines' error handler emits exactly
 * `{ error: { code, message, requestId } }`; a bare string, an HTML page or a
 * gateway's JSON is somebody else answering, and must not be mistaken for the
 * application telling us a resource does not exist.
 */
function readEnvelope(payload: unknown): ErrorEnvelope | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined
  const env = error as ErrorEnvelope
  // An envelope with neither a code nor a message says nothing; treat it as
  // nobody having answered rather than as an application response.
  if (typeof env.code !== 'string' && typeof env.message !== 'string') return undefined
  return env
}

/**
 * Whether an envelope is a HANDLER's answer rather than the router giving up.
 *
 * The catch-all's message is still worth showing — it is the clearest thing
 * anybody will say about a route that is not mounted — so it travels on the
 * ApiError. It simply must not count as the application reporting an absence.
 */
function isAuthoredByHandler(envelope: ErrorEnvelope | undefined): boolean {
  return Boolean(envelope) && envelope!.message !== NO_SUCH_ENDPOINT
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  /**
   * Return null for a 404 the APPLICATION authored — one carrying our error
   * envelope, meaning "nothing has been built here yet".
   *
   * A 404 without that envelope still throws. It used to return null too, and
   * that is the defect: a missing route and an empty result became the same
   * value, so a broken endpoint rendered as a zero-valued audit.
   */
  nullOn404?: boolean
}

/** Fired when a request made WITH a session is refused as signed-out. */
export const SESSION_EXPIRED_EVENT = 'marketing-ai:session-expired'

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiError(
      0,
      'unreachable',
      'The Marketing AI service could not be reached. It may not be running on port 4100.',
    )
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  if (!res.ok) {
    const err = readEnvelope(payload)
    const authored = isAuthoredByHandler(err)

    // Only an application-authored 404 is an absence. A 404 with no envelope —
    // or the router's own "no such endpoint" — is a route that is not mounted,
    // or a proxy answering in the API's place, and swallowing it to null is how
    // "the endpoint is gone" reached the screens disguised as "this company
    // has nothing".
    if (res.status === 404 && options.nullOn404 && authored) return null as T

    // A session that has expired, or an account that was disabled, is refused
    // on EVERY request. Each screen used to show its own "Invalid or expired
    // session" box and leave the person inside a half-signed-in app until
    // they reloaded (2026-10-06). One notice, and the sign-in screen.
    if (token && (res.status === 401 || (res.status === 403 && /disabled/i.test(err?.message ?? '')))) {
      setToken(null)
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: err?.message ?? null }))
    }

    const body = payload as { error?: unknown; message?: string }
    throw new ApiError(
      res.status,
      err?.code ?? (typeof body?.error === 'string' ? body.error : undefined) ?? `http_${res.status}`,
      err?.message ?? body?.message ?? `The request failed with status ${res.status}.`,
      payload,
      err?.requestId,
      authored,
    )
  }

  return payload as T
}

/**
 * Reads one resource and reports which of the three outcomes it was.
 *
 * Resolves rather than rejects for every HTTP failure, so a screen holds all
 * three in one value and cannot accidentally render an error as an empty
 * result. An aborted request still rejects, so useAsync drops it as before.
 */
async function requestResource<T>(
  path: string,
  options: Omit<RequestOptions, 'nullOn404'> = {},
): Promise<ResourceState<T>> {
  try {
    return Resource.ready(await request<T>(path, { ...options, nullOn404: false }))
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    if (!(err instanceof ApiError)) throw err
    // The backend's own sentence travels with the absence — "No Workbench has
    // been built for that audit run yet." reads better than anything a screen
    // could invent, and stays true when the backend changes its mind.
    if (err.status === 404 && err.isApplicationError) return Resource.absent(err.message, err.code)
    return Resource.failed(err)
  }
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),
  del: <T>(path: string, opts?: Omit<RequestOptions, 'method'>) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
  /**
   * A GET that answers "ready, absent, or broken" instead of "data or null".
   * Use this wherever a missing resource is a state the screen must name.
   */
  resource: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body' | 'nullOn404'>) =>
    requestResource<T>(path, { ...opts, method: 'GET' }),
}

// ── Signing in (2026-09-30) ────────────────────────────────────────────────
//
// Two ways to arrive: an email and password, or a one-time code that proves an
// address before an account exists for it. These are the only calls made before
// there is a token, and each reads the server's own sentence on failure —
// nothing here paraphrases a refusal.

export interface AuthCapabilities {
  /** False when the server cannot accept a sign-in at all, with the reason. */
  ready: boolean
  reason: string | null
  emailSignIn: boolean
  mailConfigured: boolean
  allowedDomains: string[]
  otpMinutes: number
  adminCount: number
}

export interface SignedIn {
  token: string
  expiresAt: string
  email: string
  name: string | null
  pictureUrl: string | null
  role: 'admin' | 'approver' | 'operator' | 'viewer'
  isAdmin: boolean
}

export interface CodeSent {
  message: string
  expiresInMinutes: number
  /** Only when the server has no mail configured AND is in development. */
  devCode?: string
}

async function authPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/v1/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'unreachable', 'The server could not be reached. Check it is running, then try again.')
  }
  const parsed = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      parsed.error?.code ?? 'sign_in_failed',
      parsed.error?.message ?? 'That did not work. Try again.',
      undefined,
      undefined,
      true,
    )
  }
  return parsed as T
}

export async function fetchAuthCapabilities(): Promise<AuthCapabilities | null> {
  try {
    const res = await fetch('/api/v1/auth/capabilities', { headers: { Accept: 'application/json' } })
    return res.ok ? ((await res.json()) as AuthCapabilities) : null
  } catch {
    return null
  }
}

export const authApi = {
  login: (email: string, password: string) => authPost<SignedIn>('/login', { email, password }),
  registerStart: (email: string) => authPost<CodeSent>('/register/start', { email }),
  registerVerify: (email: string, code: string, password: string, name?: string) =>
    authPost<SignedIn>('/register/verify', { email, code, password, ...(name?.trim() ? { name: name.trim() } : {}) }),
  forgotStart: (email: string) => authPost<CodeSent>('/forgot/start', { email }),
  forgotVerify: (email: string, code: string, password: string) =>
    authPost<SignedIn>('/forgot/verify', { email, code, password }),
}
