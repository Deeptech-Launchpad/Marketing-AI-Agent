import type { NextFunction, Request, Response } from 'express'
import type { z } from 'zod'
import { BadRequestError } from '../../platform/errors.js'

// Every request body and query is validated at the edge, so no handler ever
// works with an unchecked shape.

export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return next(new BadRequestError('Invalid request body.', parsed.error.issues))
    }
    req.body = parsed.data
    next()
  }
}

export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.query)
    if (!parsed.success) {
      return next(new BadRequestError('Invalid query parameters.', parsed.error.issues))
    }
    Object.defineProperty(req, 'validatedQuery', { value: parsed.data, writable: true })
    next()
  }
}
