import type { NextFunction, Request, Response } from 'express'
import type { Permission } from '../../domain/enums.js'
import { ForbiddenError, UnauthorizedError } from '../../platform/errors.js'

// Explicit permission gates that return a real 403.
//
// NXT Sales expresses its only ownership check as a Prisma updateMany with an
// ownerId filter, which returns 200 with zero rows changed when the caller is
// not allowed — so the UI cannot tell "saved" from "denied". That pattern is
// not reused here: a denial is a status code.

export function requirePermission(...needed: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = req.principal
    if (!principal) return next(new UnauthorizedError())

    const missing = needed.filter((p) => !principal.permissions.includes(p))
    if (missing.length) {
      return next(
        new ForbiddenError(
          `Requires the "${missing.join('", "')}" permission; your role is "${principal.role}".`,
        ),
      )
    }
    next()
  }
}
