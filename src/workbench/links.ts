import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'
import { prisma, newId } from '../platform/db.js'

// TASK #981 — share links and visitor sessions.
//
// A Workbench link is a bearer credential: whoever holds it opens the demo. So
// it is treated like one — 256 bits of entropy, stored only as a SHA-256 hash,
// compared in constant time, expiring, revocable, and countable.
//
// Storing the plaintext would mean a database read yields working customer
// links for every prospect. The token is returned exactly once, at creation.

const TOKEN_BYTES = 32

export interface MintedLink {
  linkId: string
  /** Returned ONCE. Never recoverable from storage afterwards. */
  token: string
  url: string
  expiresAt: Date
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time comparison, so a lookup cannot be timed character by character. */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function workbenchUrl(token: string): string {
  return `${env.WORKBENCH_PUBLIC_BASE_URL.replace(/\/+$/, '')}/workbench/${token}`
}

/**
 * The URL a printed QR code encodes.
 *
 * TASK #983: the `s=qr` marker is what lets the server tell a SCAN from a link
 * someone was sent and clicked. Over plain HTTP those two requests are
 * otherwise identical, and recording a scan the server cannot distinguish would
 * be inventing an observation.
 *
 * The marker is a hint, not proof: anyone who copies the URL out of a scanned
 * code carries it with them. That limit is stated in the evidence on every
 * event this produces rather than left for a reader to discover.
 */
export function workbenchQrUrl(token: string): string {
  return `${workbenchUrl(token)}?s=qr`
}

export async function mintLink(input: {
  tenantId: string
  demoId: string
  createdByCrmUserId: string
  label?: string | null
  ttlDays?: number
  maxViews?: number | null
}): Promise<MintedLink> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const ttl = input.ttlDays ?? env.WORKBENCH_LINK_TTL_DAYS
  const expiresAt = new Date(Date.now() + ttl * 86_400_000)
  const linkId = newId()

  await prisma.workbenchLink.create({
    data: {
      id: linkId,
      tenantId: input.tenantId,
      demoId: input.demoId,
      tokenHash: hashToken(token),
      // Enough to tell two links apart in a list, not enough to open either.
      tokenHint: token.slice(-6),
      label: input.label ?? null,
      expiresAt,
      maxViews: input.maxViews ?? null,
      createdByCrmUserId: input.createdByCrmUserId,
    },
  })

  return { linkId, token, url: workbenchUrl(token), expiresAt }
}

export type LinkRejection = 'unknown' | 'expired' | 'revoked' | 'exhausted'

export interface ResolvedLink {
  ok: boolean
  rejection?: LinkRejection
  reason?: string
  link?: Awaited<ReturnType<typeof prisma.workbenchLink.findFirst>>
}

/**
 * Resolves a public token to its link.
 *
 * Every rejection returns the same shape and a deliberately unspecific reason.
 * Telling an anonymous caller the difference between "no such link" and "that
 * link expired" leaks which tokens ever existed.
 */
export async function resolveLink(token: string): Promise<ResolvedLink> {
  if (!token || token.length < 20 || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, rejection: 'unknown', reason: 'This link is not valid.' }
  }

  const link = await prisma.workbenchLink.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!link) return { ok: false, rejection: 'unknown', reason: 'This link is not valid.' }

  if (link.revokedAt) {
    return { ok: false, rejection: 'revoked', reason: 'This link has been withdrawn.', link }
  }
  if (link.expiresAt.getTime() < Date.now()) {
    return { ok: false, rejection: 'expired', reason: 'This link has expired.', link }
  }
  if (link.maxViews !== null && link.viewCount >= link.maxViews) {
    return { ok: false, rejection: 'exhausted', reason: 'This link has reached its view limit.', link }
  }

  return { ok: true, link }
}

export async function recordView(linkId: string): Promise<void> {
  const now = new Date()
  await prisma.workbenchLink.update({
    where: { id: linkId },
    data: {
      viewCount: { increment: 1 },
      lastViewedAt: now,
      // Only set on the first view; later views leave it alone.
      firstViewedAt: (await prisma.workbenchLink.findUnique({ where: { id: linkId }, select: { firstViewedAt: true } }))
        ?.firstViewedAt
        ? undefined
        : now,
    },
  })
}

export async function revokeLink(tenantId: string, linkId: string, crmUserId: string): Promise<boolean> {
  const res = await prisma.workbenchLink.updateMany({
    where: { id: linkId, tenantId, revokedAt: null },
    data: { revokedAt: new Date(), revokedByCrmUserId: crmUserId },
  })
  return res.count > 0
}

// ── Visitor sessions ───────────────────────────────────────────────────────

export const SESSION_COOKIE = 'wb_session'

/**
 * Reads a cookie without adding a parser dependency.
 *
 * Only this one cookie is ever read, so a full parser would be more surface
 * than the feature needs.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return null
}

export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url')
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

export function hashSession(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** IPs are hashed before storage: enough to spot abuse, not a stored address. */
export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null
  return createHash('sha256').update(`${ip}|${env.JWT_SECRET}`).digest('hex').slice(0, 32)
}

export function sessionCookieValue(token: string): string {
  const maxAge = env.WORKBENCH_SESSION_TTL_DAYS * 86_400
  // HttpOnly and SameSite=Lax: the cookie is never readable by script (there is
  // no script) and is not sent from a third-party context.
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/workbench; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
}

// ── Anonymous visit correlation (Task #983) ────────────────────────────────
//
// A SECOND cookie, deliberately separate from the session above.
//
// `wb_session` is a credential: holding it is what grants access to a
// registered demonstration. `wb_visit` grants nothing. It exists only so that
// several page views by the same browser can be recognised as ONE VISIT rather
// than several anonymous strangers.
//
// Keeping them separate matters in both directions. Engagement correlation must
// not become a way to obtain access, and the access credential must not become
// the only way to count a visit — before registration there is no session, and
// without this every unregistered visitor would share the same empty identity
// and their acts would deduplicate into one another.
//
// The stored value is a hash. The cookie itself is a random token that means
// nothing on its own, carries no personal data, and is never written to
// NXT Sales.

export const VISIT_COOKIE = 'wb_visit'

export function newVisitToken(): { token: string; hash: string } {
  const token = randomBytes(18).toString('base64url')
  return { token, hash: hashVisit(token) }
}

export function hashVisit(token: string): string {
  return createHash('sha256').update(`visit|${token}`).digest('hex')
}

export function visitCookieValue(token: string): string {
  const maxAge = env.WORKBENCH_SESSION_TTL_DAYS * 86_400
  return `${VISIT_COOKIE}=${encodeURIComponent(token)}; Path=/workbench; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
}
