// Typed error hierarchy. Every error that reaches the HTTP layer carries the
// status it should produce, so route handlers never hand-roll status codes and
// an unmapped error can never leak as a 200.

export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.details = details
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'bad_request', message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'unauthorized', message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'forbidden', message)
  }
}

/**
 * Also used for cross-tenant access: a resource belonging to another tenant is
 * reported as NOT FOUND rather than FORBIDDEN, so the API never confirms that
 * an id exists in a tenant the caller cannot see.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'not_found', message)
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, 'conflict', message, details)
  }
}

/** Raised by budgetGuard BEFORE a dispatch, never after one. */
export class BudgetExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super(429, 'budget_exceeded', message, details)
  }
}

/** Raised by the tool dispatcher when a call fails any of its seven checks. */
export class ToolBlockedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(403, 'tool_blocked', message, details)
  }
}

export class UpstreamError extends AppError {
  readonly retryable: boolean

  constructor(message: string, opts: { retryable: boolean; details?: unknown }) {
    super(502, 'upstream_error', message, opts.details)
    this.retryable = opts.retryable
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof UpstreamError && err.retryable
}

/** Serialisable shape for persisting into AgentRun.error / AgentStep.error. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) {
    return { name: err.name, code: err.code, message: err.message, details: err.details ?? null }
  }
  if (err instanceof Error) {
    return { name: err.name, code: 'internal_error', message: err.message }
  }
  return { name: 'UnknownError', code: 'internal_error', message: String(err) }
}
