import type { NextFunction, Request, Response } from 'express'
import { env } from '../../config/env.js'
import { AppError } from '../../platform/errors.js'
import { logger } from '../../platform/logger.js'

// Terminal error handler.
//
// Everything that reaches here becomes a typed JSON error with the right
// status. An unmapped error is a 500 with a generic message — the internal
// detail goes to the log, never to the client, so an upstream failure can never
// echo a key or a connection string back out.

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } })
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId ?? null

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, requestId }, 'request failed')
    else logger.warn({ code: err.code, requestId, path: req.path }, 'request rejected')

    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined, requestId },
    })
    return
  }

  logger.error({ err, requestId, path: req.path }, 'unhandled error')
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong.',
      // Only in development, and only the message — never a stack in a response.
      details: env.NODE_ENV === 'development' ? (err as Error)?.message : undefined,
      requestId,
    },
  })
}

/** Express 4 does not forward async rejections; this wrapper does. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(
  fn: T,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next)
  }
}
