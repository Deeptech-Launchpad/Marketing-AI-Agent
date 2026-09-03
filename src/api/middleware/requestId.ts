import type { NextFunction, Request, Response } from 'express'
import { newId } from '../../platform/db.js'

// Correlates a request across logs, audit rows and any run it starts.
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id')
  const id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : newId()
  req.requestId = id
  res.setHeader('x-request-id', id)
  next()
}
