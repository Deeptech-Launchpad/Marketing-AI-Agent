import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { audit } from '../platform/audit.js'
import { newId, prisma } from '../platform/db.js'
import { BadRequestError, ConflictError, UnauthorizedError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { normalizeEmail, isEmailShaped, registrationProblem } from './emailDomains.js'
import { verifyGoogleIdToken } from './google.js'
import { sendPasswordResetEmail, mailConfigured } from './mailer.js'
import { hashPassword, passwordProblem, verifyPassword } from './passwords.js'
import { hashResetToken, issueSessionToken, localAuthUnavailableReason, newResetToken } from './tokens.js'

// ACCOUNTS ON THIS PLATFORM — CREATE ONE, SIGN IN, RESET A PASSWORD.
//
// Two rules run through everything here:
//
//   1. SIGNING IN IS NOT THE SAME AS BEING ALLOWED IN. This module proves who
//      somebody is. What they may DO is still decided only by their
//      TenantMember role, exactly as it was before this existed — so a new
//      account sees nothing at all until an admin grants it a role. There is
//      no path here that grants one.
//
//   2. A FAILED SIGN-IN NEVER SAYS WHY. Wrong password, no such account, a
//      Google-only account asked for a password — all answer the same
//      sentence. Anything more precise is a way to discover which addresses
//      have accounts.

export interface SignedIn {
  token: string
  expiresAt: string
  email: string
  name: string | null
  /** Whether an admin has granted this account a role yet. */
  hasAccess: boolean
}

const SIGN_IN_REFUSED = 'That email and password do not match an account here.'

async function tenantId(): Promise<string> {
  const tenant = await prisma.tenant.findUnique({ where: { slug: env.DEFAULT_TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new ConflictError('No tenant is configured on this server. Run npm run db:seed.')
  return tenant.id
}

function assertLocalAuth(): void {
  const reason = localAuthUnavailableReason()
  if (reason) throw new ConflictError(reason)
}

/** Whether this account has been granted a role yet. */
async function hasRole(tid: string, email: string): Promise<boolean> {
  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_email: { tenantId: tid, email } },
    select: { id: true },
  })
  if (member) return true
  // The configured bootstrap admin is granted a role on first sign-in by the
  // auth middleware, so report them as having access rather than as pending.
  return Boolean(env.BOOTSTRAP_ADMIN_EMAIL && email === env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase().trim())
}

/**
 * The NXT Sales user with this same email, if there is one.
 *
 * Only ever a READ of the CRM, and only when the account has no link yet. It
 * is what lets this person be recorded as the owner of a company they add to
 * NXT Sales; without it that single action is refused with a clear reason and
 * everything else works normally. A CRM that cannot be reached is not an
 * error here — the account is simply left unlinked.
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

async function sessionFor(user: { id: string; email: string; name: string | null }, tid: string): Promise<SignedIn> {
  const { token, expiresAt } = issueSessionToken(user)
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    email: user.email,
    name: user.name,
    hasAccess: await hasRole(tid, user.email),
  }
}

// ── Creating an account ────────────────────────────────────────────────────

export async function register(input: {
  email: string
  password: string
  name?: string | null
  requestId?: string | null
}): Promise<SignedIn> {
  assertLocalAuth()
  const email = normalizeEmail(input.email)

  const domainProblem = registrationProblem(email)
  if (domainProblem) throw new BadRequestError(domainProblem)
  const weak = passwordProblem(input.password)
  if (weak) throw new BadRequestError(weak)

  const tid = await tenantId()
  const existing = await prisma.appUser.findUnique({ where: { tenantId_email: { tenantId: tid, email } }, select: { id: true } })
  if (existing) {
    // Said plainly: this address is already registered, so the person knows to
    // sign in or reset instead. It reveals nothing they did not just assert by
    // trying to register it, and the alternative is a dead end.
    throw new ConflictError('An account with that email already exists. Sign in instead, or reset the password.')
  }

  const id = newId()
  const user = await prisma.appUser.create({
    data: {
      id,
      tenantId: tid,
      email,
      name: input.name?.trim() || null,
      passwordHash: await hashPassword(input.password),
      emailVerified: false,
      status: 'active',
      crmUserId: await findCrmUserId(email),
      lastLoginAt: new Date(),
    },
    select: { id: true, email: true, name: true },
  })

  await audit({
    tenantId: tid,
    actorType: 'user',
    actorCrmUserId: null,
    action: 'auth.account_created',
    resourceType: 'AppUser',
    resourceId: id,
    dataClass: 'customer_pii',
    summary: `Account created for ${email} (email and password). No role granted yet.`,
    requestId: input.requestId ?? null,
  })

  return sessionFor(user, tid)
}

// ── Signing in ─────────────────────────────────────────────────────────────

export async function signIn(input: { email: string; password: string; requestId?: string | null }): Promise<SignedIn> {
  assertLocalAuth()
  const email = normalizeEmail(input.email)
  if (!isEmailShaped(email)) throw new UnauthorizedError(SIGN_IN_REFUSED)

  const tid = await tenantId()
  const user = await prisma.appUser.findUnique({ where: { tenantId_email: { tenantId: tid, email } } })

  // Same answer whether the account is missing, has no password (Google only),
  // or the password is wrong.
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new UnauthorizedError(SIGN_IN_REFUSED)
  }
  if (user.status !== 'active') {
    throw new UnauthorizedError('That account has been disabled. Ask an administrator.')
  }

  const updated = await prisma.appUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), crmUserId: user.crmUserId ?? (await findCrmUserId(email)) },
    select: { id: true, email: true, name: true },
  })
  return sessionFor(updated, tid)
}

// ── Signing in with Google ─────────────────────────────────────────────────

export async function signInWithGoogle(input: { credential: string; requestId?: string | null }): Promise<SignedIn> {
  assertLocalAuth()
  const identity = await verifyGoogleIdToken(input.credential)
  const tid = await tenantId()

  // Matched by Google's own account id first, then by email — so an account
  // created with a password becomes a Google sign-in for the same person
  // rather than a second, separate account.
  const existing =
    (await prisma.appUser.findFirst({ where: { tenantId: tid, googleSub: identity.sub } })) ??
    (await prisma.appUser.findUnique({ where: { tenantId_email: { tenantId: tid, email: identity.email } } }))

  if (!existing) {
    const problem = registrationProblem(identity.email)
    if (problem) throw new BadRequestError(problem)
  }
  if (existing && existing.status !== 'active') {
    throw new UnauthorizedError('That account has been disabled. Ask an administrator.')
  }

  const id = existing?.id ?? newId()
  const user = await prisma.appUser.upsert({
    where: { id },
    create: {
      id,
      tenantId: tid,
      email: identity.email,
      name: identity.name,
      googleSub: identity.sub,
      // Google has verified the address itself, which is stronger proof than
      // this platform could obtain on its own.
      emailVerified: true,
      status: 'active',
      crmUserId: await findCrmUserId(identity.email),
      lastLoginAt: new Date(),
    },
    update: {
      googleSub: identity.sub,
      emailVerified: true,
      name: existing?.name ?? identity.name,
      lastLoginAt: new Date(),
      crmUserId: existing?.crmUserId ?? (await findCrmUserId(identity.email)),
    },
    select: { id: true, email: true, name: true },
  })

  if (!existing) {
    await audit({
      tenantId: tid,
      actorType: 'user',
      actorCrmUserId: null,
      action: 'auth.account_created',
      resourceType: 'AppUser',
      resourceId: id,
      dataClass: 'customer_pii',
      summary: `Account created for ${identity.email} (Google). No role granted yet.`,
      requestId: input.requestId ?? null,
    })
  }
  return sessionFor(user, tid)
}

// ── Forgotting and resetting a password ────────────────────────────────────

export interface ResetRequested {
  /** Always the same sentence, whether or not the address has an account. */
  message: string
  /** DEVELOPMENT ONLY, and only with AUTH_DEV_RETURN_RESET_LINK on. */
  devResetLink?: string
}

const RESET_ASKED =
  'If an account exists for that address, a link to choose a new password has been sent to it. ' +
  'The link expires shortly and can be used once.'

function resetLinkFor(token: string): string {
  const base = env.AUTH_PUBLIC_BASE_URL.trim().replace(/\/+$/, '')
  return `${base}/reset-password?token=${encodeURIComponent(token)}`
}

export async function requestPasswordReset(input: {
  email: string
  ip?: string | null
  requestId?: string | null
}): Promise<ResetRequested> {
  assertLocalAuth()
  const email = normalizeEmail(input.email)
  const tid = await tenantId()
  const user = isEmailShaped(email)
    ? await prisma.appUser.findUnique({ where: { tenantId_email: { tenantId: tid, email } }, select: { id: true, status: true } })
    : null

  // No account, or a disabled one: the same answer, and nothing is created.
  // Whether an address has an account here is not something this endpoint
  // will tell an anonymous caller.
  if (!user || user.status !== 'active') return { message: RESET_ASKED }

  // Any earlier unused link for this account stops working, so a forwarded
  // old email cannot be used after a newer one was requested.
  await prisma.passwordResetToken.updateMany({
    where: { appUserId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  })

  const { token, tokenHash, expiresAt } = newResetToken()
  await prisma.passwordResetToken.create({
    data: { id: newId(), appUserId: user.id, tokenHash, expiresAt, requestedIp: input.ip ?? null },
  })

  const link = resetLinkFor(token)
  const mail = await sendPasswordResetEmail(email, link, env.AUTH_RESET_TTL_MINUTES)

  await audit({
    tenantId: tid,
    actorType: 'user',
    actorCrmUserId: null,
    action: 'auth.password_reset_requested',
    resourceType: 'AppUser',
    resourceId: user.id,
    dataClass: 'customer_pii',
    summary: `Password reset requested for ${email}; email ${mail.sent ? 'sent' : `not sent (${mail.reason})`}`,
    requestId: input.requestId ?? null,
  })

  // Locally, with no mail server, the link comes back in the response so the
  // flow can actually be finished. env.ts refuses this flag in production.
  if (!mail.sent && env.AUTH_DEV_RETURN_RESET_LINK) {
    return { message: RESET_ASKED, devResetLink: link }
  }
  if (!mail.sent) {
    logger.warn({ email, reason: mail.reason }, 'password reset link could not be delivered')
  }
  return { message: RESET_ASKED }
}

export async function resetPassword(input: {
  token: string
  password: string
  requestId?: string | null
}): Promise<{ email: string }> {
  assertLocalAuth()
  const weak = passwordProblem(input.password)
  if (weak) throw new BadRequestError(weak)

  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(String(input.token ?? '')) },
    include: { user: { select: { id: true, email: true, status: true, tenantId: true } } },
  })

  const invalid = 'That reset link is not valid any more. Ask for a new one.'
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) throw new BadRequestError(invalid)
  if (!row.user || row.user.status !== 'active') throw new BadRequestError(invalid)

  await prisma.$transaction([
    prisma.appUser.update({
      where: { id: row.user.id },
      data: {
        passwordHash: await hashPassword(input.password),
        // Finishing a reset proves the person reads that mailbox.
        emailVerified: true,
      },
    }),
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    // Every other outstanding link for this account is spent at the same time.
    prisma.passwordResetToken.updateMany({
      where: { appUserId: row.user.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ])

  await audit({
    tenantId: row.user.tenantId,
    actorType: 'user',
    actorCrmUserId: null,
    action: 'auth.password_reset',
    resourceType: 'AppUser',
    resourceId: row.user.id,
    dataClass: 'customer_pii',
    summary: `Password reset completed for ${row.user.email}`,
    requestId: input.requestId ?? null,
  })

  return { email: row.user.email }
}

/** What the sign-in screen needs to know before it draws itself. */
export function authCapabilities() {
  const reason = localAuthUnavailableReason()
  return {
    localSignIn: !reason,
    localSignInReason: reason,
    google: Boolean(env.GOOGLE_CLIENT_ID.trim()),
    googleClientId: env.GOOGLE_CLIENT_ID.trim() || null,
    // The NXT Sales path is always available: it needs no configuration here.
    nxtSales: true,
    registrationOpen: registrationProblem('someone@' + (env.AUTH_ALLOWED_EMAIL_DOMAINS.split(/[,;\s]+/)[0] || 'x')) === null,
    allowedDomains: env.AUTH_ALLOWED_EMAIL_DOMAINS.split(/[,;\s]+/).map((d) => d.trim().replace(/^@/, '')).filter(Boolean),
    mailConfigured: mailConfigured(),
  }
}
