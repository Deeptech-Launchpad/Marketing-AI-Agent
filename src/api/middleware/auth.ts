import type { NextFunction, Request, Response } from 'express'
import { env } from '../../config/env.js'
import { isAdminEmail, roleFor } from '../../auth/accessList.js'
import { readSessionToken } from '../../auth/tokens.js'
import { ROLE_PERMISSIONS, type MemberRole, type Permission } from '../../domain/enums.js'
import { prisma } from '../../platform/db.js'
import { ForbiddenError, UnauthorizedError } from '../../platform/errors.js'

// WHO IS CALLING, AND WHAT THEY MAY DO (2026-09-30).
//
// One way in: a session token this platform issued after Google proved who
// somebody is. There is no password path and no second identity provider, so
// there is exactly one thing to verify and one place it can come from.
//
// THE ADMIN LIST IS CHECKED ON EVERY REQUEST, NOT JUST AT SIGN-IN.
//
// The stored role exists so the rest of the platform can read a role the way
// it always has. It is not trusted on its own: admin is granted here only when
// the address is on the configured list as well. Taking an address off that
// list therefore takes the person's admin away on their very next request,
// without touching the database, and a row edited by any other means cannot
// hand somebody admin they were not given.

export interface Principal {
  crmUserId: string
  email: string
  name: string
  tenantId: string
  role: MemberRole
  permissions: readonly Permission[]
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal
      requestId?: string
      /**
       * The exact bytes of a JSON body, kept by the parser's `verify` hook.
       *
       * Task #983 needs this to check a provider webhook's HMAC: the signature
       * covers what was sent, and re-serialising the parsed object would change
       * key order and whitespace and reject every genuine request.
       */
      rawBody?: string
    }
  }
}

async function resolveTenantId(): Promise<string> {
  const tenant = await prisma.tenant.findUnique({ where: { slug: env.DEFAULT_TENANT_SLUG } })
  if (!tenant) throw new ForbiddenError('No tenant is configured. Run npm run db:seed.')
  return tenant.id
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError()

    const claims = readSessionToken(header.slice(7))
    if (!claims) throw new UnauthorizedError('Invalid or expired session. Sign in again.')

    const tenantId = await resolveTenantId()
    const user = await prisma.appUser.findFirst({
      where: { id: claims.sub, tenantId },
      select: { id: true, email: true, name: true, status: true, crmUserId: true },
    })
    if (!user) throw new UnauthorizedError('That account no longer exists. Sign in again.')
    if (user.status !== 'active') throw new ForbiddenError('That account has been disabled. Ask an administrator.')

    const member = await prisma.tenantMember.findUnique({
      where: { tenantId_email: { tenantId, email: user.email } },
      select: { role: true, name: true },
    })

    // The stored role, but never more than the admin list allows. A stored
    // "admin" for an address that is not on the list is read as an ordinary
    // user; the list is the only thing that grants admin.
    const stored = (member?.role as MemberRole | undefined) ?? roleFor(user.email)
    const role: MemberRole = stored === 'admin' && !isAdminEmail(user.email) ? 'operator' : stored

    req.principal = {
      // The NXT Sales user with this email when there is one, so this person
      // can own a company in the CRM. Otherwise a clearly-marked local id: the
      // one action that needs a real CRM user refuses, rather than recording
      // the work against somebody else.
      crmUserId: user.crmUserId ?? `local:${user.id}`,
      email: user.email,
      name: user.name ?? member?.name ?? user.email,
      tenantId,
      role,
      permissions: ROLE_PERMISSIONS[role] ?? ['view'],
    }
    next()
  } catch (err) {
    next(err)
  }
}
