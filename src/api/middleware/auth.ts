import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../../config/env.js'
import { ROLE_PERMISSIONS, type MemberRole, type Permission } from '../../domain/enums.js'
import { prisma, newId } from '../../platform/db.js'
import { ForbiddenError, UnauthorizedError } from '../../platform/errors.js'

// Verifies the JWT that NXT Sales issued, then resolves the caller's MARKETING
// role from TenantMember.
//
// Marketing permissions are deliberately NOT derived from NXT Sales' own
// User.role: a CRM admin is not automatically someone who may sign off a
// campaign, and approval is this platform's primary safety control. Somebody
// has to be granted the approver role here explicitly.

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

interface CrmJwtPayload {
  id: string
  email: string
  name?: string
  role?: string
}

async function resolveTenantId(): Promise<string> {
  const tenant = await prisma.tenant.findUnique({ where: { slug: env.DEFAULT_TENANT_SLUG } })
  if (!tenant) throw new ForbiddenError('No tenant is configured. Run npm run db:seed.')
  return tenant.id
}

/**
 * Finds the caller's membership, tolerating the two ways it can be seeded:
 * by crmUserId (already linked) or by email (seeded before their first login,
 * in which case the crmUserId is backfilled here).
 */
async function resolveMember(tenantId: string, payload: CrmJwtPayload) {
  const byId = await prisma.tenantMember.findFirst({
    where: { tenantId, crmUserId: payload.id },
  })
  if (byId) return byId

  const email = payload.email.toLowerCase().trim()
  const byEmail = await prisma.tenantMember.findUnique({
    where: { tenantId_email: { tenantId, email } },
  })
  if (byEmail) {
    return prisma.tenantMember.update({
      where: { id: byEmail.id },
      data: { crmUserId: payload.id, name: payload.name ?? byEmail.name },
    })
  }

  // Bootstrap: the configured admin email is granted admin on first login, so
  // a fresh install is usable without hand-editing the database. Everyone else
  // must be granted a role explicitly.
  if (env.BOOTSTRAP_ADMIN_EMAIL && email === env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase()) {
    return prisma.tenantMember.create({
      data: {
        id: newId(),
        tenantId,
        crmUserId: payload.id,
        email,
        name: payload.name ?? null,
        role: 'admin',
      },
    })
  }

  return null
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError()

    let payload: CrmJwtPayload
    try {
      payload = jwt.verify(header.slice(7), env.JWT_SECRET) as CrmJwtPayload
    } catch {
      throw new UnauthorizedError('Invalid or expired token.')
    }
    if (!payload?.id || !payload?.email) throw new UnauthorizedError('Token is missing required claims.')

    const tenantId = await resolveTenantId()
    const member = await resolveMember(tenantId, payload)
    if (!member) {
      throw new ForbiddenError('You do not have access to the marketing platform. Ask an admin for a role.')
    }

    const role = member.role as MemberRole
    req.principal = {
      crmUserId: payload.id,
      email: payload.email,
      name: payload.name ?? member.name ?? payload.email,
      tenantId,
      role,
      permissions: ROLE_PERMISSIONS[role] ?? ['view'],
    }
    next()
  } catch (err) {
    next(err)
  }
}
