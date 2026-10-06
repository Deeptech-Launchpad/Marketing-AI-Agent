import { env } from '../config/env.js'
import type { MemberRole } from '../domain/enums.js'
import { getCrm } from '../crm/index.js'
import { audit } from '../platform/audit.js'
import { newId, prisma } from '../platform/db.js'
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { adminEmails, allowedDomains, isAdminEmail, isEmailShaped, normalizeEmail, roleFor, signInProblem } from './accessList.js'
import { mailConfigured, sendVerificationCode } from './mailer.js'
import { issueCode, useCode, type OtpPurpose } from './otp.js'
import { hashPassword, passwordProblem, verifyPassword } from './passwords.js'
import { issueSessionToken, localAuthUnavailableReason } from './tokens.js'

// ONE WAY TO PROVE WHO YOU ARE, ONE WAY TO BE ALLOWED IN.
//
// An account is created with an email address and a password, after entering a
// code sent to that address — which is what proves the address is theirs, since
// anyone can type one. That is the whole of it: this platform needs no domain,
// no OAuth client and no third party to let somebody in.
//
// Signing in with Google was removed on 2026-09-30 because it cannot work
// without a registered domain over HTTPS. The account model still carries a
// googleSub column for when it comes back, and nothing here writes it.
//
// Three rules hold throughout:
//
//   1. CONFIGURATION DECIDES WHETHER, AND AS WHAT. Whether an address may be
//      here at all, and whether it is an admin, are read from the configured
//      lists on EVERY sign-in — never from a stored row.
//
//   2. A FAILED SIGN-IN NEVER SAYS WHY. Wrong password, no such account, an
//      account with no password at all — all answer identically.
//
//   3. NOTHING IS WRITTEN UNTIL THE ADDRESS IS PROVEN. A sign-up creates no
//      account until the code is entered correctly.

export interface SignedIn {
  token: string
  expiresAt: string
  email: string
  name: string | null
  pictureUrl: string | null
  role: MemberRole
  isAdmin: boolean
}

export interface CodeSent {
  /** Always the same sentence, whether or not an account exists. */
  message: string
  /** Minutes until it expires, so the screen can say so. */
  expiresInMinutes: number
  /** DEVELOPMENT ONLY, and only with AUTH_DEV_RETURN_OTP on. */
  devCode?: string
}

const SIGN_IN_REFUSED = 'That email and password do not match an account here.'

async function tenantId(): Promise<string> {
  const tenant = await prisma.tenant.findUnique({ where: { slug: env.DEFAULT_TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new ConflictError('No tenant is configured on this server. Run npm run db:seed.')
  return tenant.id
}

function assertReady(): void {
  const reason = localAuthUnavailableReason()
  if (reason) throw new ConflictError(reason)
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
 * Settles this person's role at sign-in.
 *
 * The admin list decides ADMIN, in both directions, every time: an address on
 * it is an admin, and a stored "admin" for an address taken off it drops to an
 * ordinary user. Every OTHER role is the one an administrator chose in
 * Registered users, and is kept.
 *
 * It used to write roleFor(email) — admin or operator — on every sign-in, so a
 * Viewer or Approver an admin had set became an Operator again the next time
 * they signed in: a viewer gained the right to run every engine, and an
 * approver silently lost the right to approve (2026-10-06).
 */
async function applyRole(tid: string, email: string, name: string | null, crmUserId: string | null): Promise<MemberRole> {
  const existing = await prisma.tenantMember.findUnique({
    where: { tenantId_email: { tenantId: tid, email } },
    select: { role: true },
  })
  const stored = existing?.role as MemberRole | undefined
  const role: MemberRole = isAdminEmail(email)
    ? 'admin'
    : !stored || stored === 'admin'
      ? roleFor(email)
      : stored
  await prisma.tenantMember.upsert({
    where: { tenantId_email: { tenantId: tid, email } },
    create: { id: newId(), tenantId: tid, email, name, role, crmUserId },
    update: { role, name: name ?? undefined, crmUserId },
  })
  return role
}

async function session(user: { id: string; email: string; name: string | null; pictureUrl: string | null }, role: MemberRole): Promise<SignedIn> {
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

/** Sends a code, and reports what the caller may tell the person. */
async function deliverCode(tid: string, email: string, purpose: OtpPurpose, ip: string | null): Promise<CodeSent> {
  const { code } = await issueCode({ tenantId: tid, email, purpose, ip })
  const mail = await sendVerificationCode({ to: email, code, minutes: env.AUTH_OTP_TTL_MINUTES, purpose })

  const message = mail.sent
    ? `A ${String(env.AUTH_OTP_TTL_MINUTES)}-minute code has been sent to ${email}. Enter it below.`
    : env.AUTH_DEV_RETURN_OTP
      ? 'No mail server is configured, so the code is shown here for testing.'
      : 'The code could not be emailed. Ask an administrator to configure the mail server.'

  if (!mail.sent && !env.AUTH_DEV_RETURN_OTP) {
    logger.warn({ email, purpose, reason: mail.reason }, 'verification code could not be delivered')
  }
  return {
    message,
    expiresInMinutes: env.AUTH_OTP_TTL_MINUTES,
    ...(!mail.sent && env.AUTH_DEV_RETURN_OTP ? { devCode: code } : {}),
  }
}

// ── Creating an account ────────────────────────────────────────────────────

/** Step one: prove the address is yours. No account exists until step two. */
export async function startRegistration(input: { email: string; ip?: string | null; requestId?: string | null }): Promise<CodeSent> {
  assertReady()
  const email = normalizeEmail(input.email)

  // Who may be here at all, checked before a single row is written or a single
  // email is sent.
  const refused = signInProblem(email)
  if (refused) throw new ForbiddenError(refused)

  const tid = await tenantId()
  const existing = await prisma.appUser.findUnique({
    where: { tenantId_email: { tenantId: tid, email } },
    select: { passwordHash: true },
  })
  if (existing?.passwordHash) {
    throw new ConflictError('An account with that email already exists. Sign in instead, or use “Forgot password”.')
  }

  return deliverCode(tid, email, 'register', input.ip ?? null)
}

/** Step two: the code proves the address, and the account is created. */
export async function completeRegistration(input: {
  email: string
  code: string
  password: string
  name?: string | null
  requestId?: string | null
}): Promise<SignedIn> {
  assertReady()
  const email = normalizeEmail(input.email)
  const refused = signInProblem(email)
  if (refused) throw new ForbiddenError(refused)

  const weak = passwordProblem(input.password)
  if (weak) throw new BadRequestError(weak)

  const tid = await tenantId()
  const check = await useCode({ tenantId: tid, email, purpose: 'register', code: input.code })
  if (!check.ok) throw new BadRequestError(check.reason)

  const existing = await prisma.appUser.findUnique({ where: { tenantId_email: { tenantId: tid, email } } })
  const crmUserId = existing?.crmUserId ?? (await findCrmUserId(email))
  const id = existing?.id ?? newId()
  const name = input.name?.trim() || existing?.name || null

  // Upsert rather than create: an address that somehow already has an account
  // without a password gains one, rather than colliding on the unique index.
  const user = await prisma.appUser.upsert({
    where: { id },
    create: {
      id,
      tenantId: tid,
      email,
      name,
      passwordHash: await hashPassword(input.password),
      emailVerified: true,
      status: 'active',
      crmUserId,
      signInCount: 1,
      lastLoginAt: new Date(),
    },
    update: {
      name,
      passwordHash: await hashPassword(input.password),
      emailVerified: true,
      crmUserId,
      signInCount: { increment: 1 },
      lastLoginAt: new Date(),
    },
  })

  const role = await applyRole(tid, email, name, crmUserId)
  await audit({
    tenantId: tid,
    actorType: 'user',
    actorCrmUserId: crmUserId,
    action: existing ? 'auth.password_added' : 'auth.account_created',
    resourceType: 'AppUser',
    resourceId: id,
    dataClass: 'customer_pii',
    summary: existing
      ? `Password added to the existing account for ${email} (${role})`
      : `Account created with a verified email address: ${email} (${role})`,
    requestId: input.requestId ?? null,
  })
  return session(user, role)
}

// ── Signing in with a password ─────────────────────────────────────────────

export async function signInWithPassword(input: { email: string; password: string }): Promise<SignedIn> {
  assertReady()
  const email = normalizeEmail(input.email)
  if (!isEmailShaped(email)) throw new UnauthorizedError(SIGN_IN_REFUSED)

  const tid = await tenantId()
  const user = await prisma.appUser.findUnique({ where: { tenantId_email: { tenantId: tid, email } } })

  // The same answer whether the account is missing, has no password, or the
  // password is simply wrong.
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new UnauthorizedError(SIGN_IN_REFUSED)
  }
  if (user.status !== 'active') throw new UnauthorizedError('That account has been disabled. Ask an administrator.')

  // Checked again at sign-in: an address removed from the allow-list cannot
  // keep getting in on an account it created earlier.
  const refused = signInProblem(email)
  if (refused) throw new ForbiddenError(refused)

  const crmUserId = user.crmUserId ?? (await findCrmUserId(email))
  const updated = await prisma.appUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), signInCount: { increment: 1 }, crmUserId },
  })
  const role = await applyRole(tid, email, updated.name, crmUserId)
  return session(updated, role)
}

// ── Recovering an account ──────────────────────────────────────────────────

export async function startPasswordReset(input: { email: string; ip?: string | null }): Promise<CodeSent> {
  assertReady()
  const email = normalizeEmail(input.email)
  const tid = await tenantId()
  const user = isEmailShaped(email)
    ? await prisma.appUser.findUnique({ where: { tenantId_email: { tenantId: tid, email } }, select: { status: true } })
    : null

  // Whether an address has an account here is not something this endpoint
  // will tell an anonymous caller, so the answer is the same either way and
  // no code is created for an address that has none.
  const generic: CodeSent = {
    message: `If an account exists for ${email}, a code has been sent to it. It expires in ${String(env.AUTH_OTP_TTL_MINUTES)} minutes.`,
    expiresInMinutes: env.AUTH_OTP_TTL_MINUTES,
  }
  if (!user || user.status !== 'active') return generic

  const sent = await deliverCode(tid, email, 'reset', input.ip ?? null)
  return { ...generic, ...(sent.devCode ? { devCode: sent.devCode } : {}) }
}

export async function completePasswordReset(input: {
  email: string
  code: string
  password: string
  requestId?: string | null
}): Promise<SignedIn> {
  assertReady()
  const email = normalizeEmail(input.email)
  const weak = passwordProblem(input.password)
  if (weak) throw new BadRequestError(weak)

  const tid = await tenantId()
  const check = await useCode({ tenantId: tid, email, purpose: 'reset', code: input.code })
  if (!check.ok) throw new BadRequestError(check.reason)

  const user = await prisma.appUser.findUnique({ where: { tenantId_email: { tenantId: tid, email } } })
  if (!user || user.status !== 'active') {
    throw new BadRequestError('That code is not valid any more. Ask for a new one.')
  }

  const updated = await prisma.appUser.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.password),
      // Completing a reset proves the person reads that mailbox.
      emailVerified: true,
      lastLoginAt: new Date(),
      signInCount: { increment: 1 },
    },
  })
  const role = await applyRole(tid, email, updated.name, updated.crmUserId)
  await audit({
    tenantId: tid,
    actorType: 'user',
    actorCrmUserId: updated.crmUserId,
    action: 'auth.password_reset',
    resourceType: 'AppUser',
    resourceId: updated.id,
    dataClass: 'customer_pii',
    summary: `Password reset completed for ${email}`,
    requestId: input.requestId ?? null,
  })
  return session(updated, role)
}

/** What the sign-in screen needs to know before it draws itself. */
export function authCapabilities() {
  const reason = localAuthUnavailableReason()
  return {
    ready: !reason,
    reason,
    /** Creating an account and recovering one both need a code by email. */
    emailSignIn: true,
    mailConfigured: mailConfigured(),
    allowedDomains: allowedDomains(),
    otpMinutes: env.AUTH_OTP_TTL_MINUTES,
    // How many, never who: the sign-in screen has no business listing the
    // organisation's administrators to anonymous callers.
    adminCount: adminEmails().length,
  }
}

export { isAdminEmail }
