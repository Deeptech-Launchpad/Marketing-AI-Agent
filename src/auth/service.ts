import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { audit } from '../platform/audit.js'
import { newId, prisma } from '../platform/db.js'
import { ConflictError, ForbiddenError, UnauthorizedError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { adminEmails, allowedDomains, isAdminEmail, roleFor, signInProblem } from './accessList.js'
import { verifyGoogleIdToken } from './google.js'
import { issueSessionToken, localAuthUnavailableReason } from './tokens.js'

// SIGNING IN WITH GOOGLE — THE ONLY WAY IN.
//
// One path, and these rules run through all of it:
//
//   1. GOOGLE PROVES WHO. The browser hands over an ID token; it is verified
//      against Google's own keys before a single field is believed. Nothing
//      the browser claims about the person is trusted.
//
//   2. CONFIGURATION DECIDES WHETHER, AND AS WHAT. Whether this address may
//      sign in at all, and whether it is an admin, are read from the
//      configured lists on EVERY sign-in — never from a stored row. So the
//      lists are the truth, and changing one takes effect immediately.
//
//   3. THE ROLE IS WRITTEN DOWN, BUT THE LIST STILL RULES. TenantMember is
//      kept in step at each sign-in so the rest of the platform can read a
//      role the way it always has, while the admin list remains the only
//      thing that decides who holds admin.

export interface SignedIn {
  token: string
  expiresAt: string
  email: string
  name: string | null
  pictureUrl: string | null
  role: 'admin' | 'operator'
  isAdmin: boolean
}

async function tenantId(): Promise<string> {
  const tenant = await prisma.tenant.findUnique({ where: { slug: env.DEFAULT_TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new ConflictError('No tenant is configured on this server. Run npm run db:seed.')
  return tenant.id
}

/**
 * The NXT Sales user with this same email, if there is one.
 *
 * Only ever a READ of the CRM. It is what lets this person be recorded as the
 * owner of a company they add to NXT Sales; without it that single action is
 * refused with its own reason and everything else works normally. A CRM that
 * cannot be reached leaves the account unlinked rather than failing sign-in.
 */
async function findCrmUserId(email: string): Promise<string | null> {
  try {
    const users = await getCrm().listUsers()
    return users.find((u) => u.email.trim().toLowerCase() === email)?.id ?? null
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'auth: NXT Sales user lookup skipped')
    return null
  }
}

/**
 * Writes the role the admin list says this person has.
 *
 * Done on every sign-in, so somebody removed from the list loses admin the
 * next time they sign in rather than keeping it because a row once said so.
 */
async function applyRole(tid: string, email: string, name: string | null, crmUserId: string | null) {
  const role = roleFor(email)
  await prisma.tenantMember.upsert({
    where: { tenantId_email: { tenantId: tid, email } },
    create: { id: newId(), tenantId: tid, email, name, role, crmUserId },
    update: { role, name: name ?? undefined, crmUserId },
  })
  return role
}

export async function signInWithGoogle(input: { credential: string; requestId?: string | null }): Promise<SignedIn> {
  const unavailable = localAuthUnavailableReason()
  if (unavailable) throw new ConflictError(unavailable)

  const identity = await verifyGoogleIdToken(input.credential)

  // Whether this account may sign in at all — configuration, not the browser.
  const refused = signInProblem(identity.email)
  if (refused) throw new ForbiddenError(refused)

  const tid = await tenantId()
  // Matched on Google's own id first, then on the email, so a person whose
  // address changed keeps their account rather than acquiring a second one.
  const existing =
    (await prisma.appUser.findFirst({ where: { tenantId: tid, googleSub: identity.sub } })) ??
    (await prisma.appUser.findUnique({ where: { tenantId_email: { tenantId: tid, email: identity.email } } }))

  if (existing && existing.status !== 'active') {
    throw new UnauthorizedError('That account has been disabled. Ask an administrator.')
  }

  const crmUserId = existing?.crmUserId ?? (await findCrmUserId(identity.email))
  const id = existing?.id ?? newId()

  // Everything stored about the person comes from the verified token.
  const profile = {
    googleSub: identity.sub,
    email: identity.email,
    emailVerified: true,
    name: identity.name,
    givenName: identity.givenName,
    familyName: identity.familyName,
    pictureUrl: identity.pictureUrl,
    locale: identity.locale,
    crmUserId,
    lastLoginAt: new Date(),
  }

  const user = await prisma.appUser.upsert({
    where: { id },
    create: { id, tenantId: tid, status: 'active', signInCount: 1, ...profile },
    update: { ...profile, signInCount: { increment: 1 } },
  })

  const role = await applyRole(tid, identity.email, identity.name, crmUserId)

  if (!existing) {
    await audit({
      tenantId: tid,
      actorType: 'user',
      actorCrmUserId: crmUserId,
      action: 'auth.account_created',
      resourceType: 'AppUser',
      resourceId: id,
      dataClass: 'customer_pii',
      summary: `First sign-in with Google: ${identity.email} (${role})`,
      requestId: input.requestId ?? null,
    })
  }

  const { token, expiresAt } = issueSessionToken({ id: user.id, email: user.email })
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    email: user.email,
    name: user.name,
    pictureUrl: user.pictureUrl,
    role,
    isAdmin: role === 'admin',
  }
}

/** What the sign-in screen needs to know before it draws itself. */
export function authCapabilities() {
  const reason = localAuthUnavailableReason()
  return {
    ready: !reason,
    reason,
    googleClientId: env.GOOGLE_CLIENT_ID.trim() || null,
    allowedDomains: allowedDomains(),
    // How many, never who: the sign-in screen has no business listing the
    // organisation's administrators to anonymous callers.
    adminCount: adminEmails().length,
  }
}

export { isAdminEmail }
