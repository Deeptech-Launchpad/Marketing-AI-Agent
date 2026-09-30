import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../../config/env.js'
import { ROLE_PERMISSIONS, type MemberRole, type Permission } from '../../domain/enums.js'
import { prisma, newId } from '../../platform/db.js'
import { ForbiddenError, UnauthorizedError } from '../../platform/errors.js'
import { readSessionToken } from '../../auth/tokens.js'

// Verifies the caller's token, then resolves their MARKETING role from
// TenantMember.
//
// TWO WAYS TO SIGN IN, ONE WAY TO BE ALLOWED IN (2026-09-30).
//
// A token here was issued either by NXT Sales (the original path: its login,
// its secret) or by this platform itself (an account created here, with a
// password or with Google — see src/auth). They are told apart by their
// signature and issuer, never by anything the caller claims, and each is
// verified with its own secret.
//
// What follows is identical for both, and is the point: identity says WHO,
// TenantMember says WHAT THEY MAY DO. An account with no TenantMember row is
// refused whichever way it signed in, so creating an account grants nothing by
// itself and an admin still has to grant a role.
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

/** No role yet — the same sentence whichever way the person signed in. */
const NO_ROLE =
  'Your account is not allowed into the marketing platform yet. An administrator has to grant you a role.'

/**
 * An account created on THIS platform, as a principal.
 *
 * `crmUserId` is the NXT Sales user with the same email when there is one, so
 * this person can own a company they add to the CRM. When there is not, it is
 * a clearly-marked local id: nothing breaks, audit records read honestly, and
 * the one action that genuinely needs a CRM user refuses with its own reason
 * rather than recording the work against somebody else.
 */
async function principalFromAppUser(tenantId: string, appUserId: string): Promise<Principal | null> {
  const user = await prisma.appUser.findFirst({
    where: { id: appUserId, tenantId },
    select: { id: true, email: true, name: true, status: true, crmUserId: true },
  })
  if (!user) return null
  if (user.status !== 'active') throw new ForbiddenError('That account has been disabled. Ask an administrator.')

  const member =
    (await prisma.tenantMember.findUnique({ where: { tenantId_email: { tenantId, email: user.email } } })) ??
    (await bootstrapMember(tenantId, user.email, user.name, user.crmUserId))
  if (!member) throw new ForbiddenError(NO_ROLE)

  const role = member.role as MemberRole
  return {
    crmUserId: user.crmUserId ?? `local:${user.id}`,
    email: user.email,
    name: user.name ?? member.name ?? user.email,
    tenantId,
    role,
    permissions: ROLE_PERMISSIONS[role] ?? ['view'],
  }
}

/**
 * The configured admin email becomes an admin on first sign-in.
 *
 * Without this nobody could ever approve the first account: granting a role
 * needs an admin, and there would be none. Everyone else is refused until an
 * admin grants them one.
 */
async function bootstrapMember(tenantId: string, email: string, name: string | null, crmUserId: string | null) {
  if (!env.BOOTSTRAP_ADMIN_EMAIL || email !== env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase().trim()) return null
  return prisma.tenantMember.create({
    data: { id: newId(), tenantId, crmUserId, email, name, role: 'admin' },
  })
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError()
    const token = header.slice(7)
    const tenantId = await resolveTenantId()

    // Issued by this platform? Its own secret and issuer say so unambiguously.
    // Anything else falls through to the NXT Sales path below.
    const appClaims = readSessionToken(token)
    if (appClaims) {
      const principal = await principalFromAppUser(tenantId, appClaims.sub)
      if (!principal) throw new UnauthorizedError('That account no longer exists.')
      req.principal = principal
      next()
      return
    }

    let payload: CrmJwtPayload
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as CrmJwtPayload
    } catch {
      throw new UnauthorizedError('Invalid or expired token.')
    }
    if (!payload?.id || !payload?.email) throw new UnauthorizedError('Token is missing required claims.')

    const member = await resolveMember(tenantId, payload)
    if (!member) throw new ForbiddenError(NO_ROLE)

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
