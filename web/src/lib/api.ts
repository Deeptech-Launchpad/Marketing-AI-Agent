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

  constructor(status: number, code: string, message: string, detail?: unknown, requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
    this.requestId = requestId
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
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  /** Return null instead of throwing when the resource does not exist. */
  nullOn404?: boolean
}

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
    if (res.status === 404 && options.nullOn404) return null as T

    const body = payload as { error?: { code?: string; message?: string; requestId?: string } | string; message?: string }
    const err = typeof body?.error === 'object' ? body.error : undefined
    throw new ApiError(
      res.status,
      err?.code ?? (typeof body?.error === 'string' ? body.error : undefined) ?? `http_${res.status}`,
      err?.message ?? body?.message ?? `The request failed with status ${res.status}.`,
      payload,
      err?.requestId,
    )
  }

  return payload as T
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  del: <T>(path: string, opts?: Omit<RequestOptions, 'method'>) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
}

/**
 * Signs in against NXT Sales, which is the identity provider for both
 * services. The marketing agent verifies the same token with the same secret,
 * so there is no second user directory to keep in step.
 */
export async function loginWithNxtSales(email: string, password: string): Promise<string> {
  let res: Response
  try {
    res = await fetch('/nxt/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    throw new ApiError(
      0,
      'unreachable',
      'NXT Sales could not be reached to sign you in. It may not be running on port 4000.',
    )
  }

  const body = (await res.json().catch(() => ({}))) as { token?: string; message?: string }
  if (!res.ok || !body.token) {
    throw new ApiError(
      res.status,
      'login_failed',
      body.message ?? 'Those credentials were not accepted by NXT Sales.',
    )
  }
  return body.token
}
