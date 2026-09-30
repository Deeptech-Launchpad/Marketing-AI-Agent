import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'
import { newId, prisma } from '../platform/db.js'

// THE ONE-TIME CODE SENT TO AN EMAIL ADDRESS.
//
// It proves one thing: that whoever is asking can read that mailbox. That is
// what stands between "anybody may type an address" and "this person owns it",
// so it carries real weight and is built accordingly:
//
//   NEVER STORED IN PLAIN TEXT  Only a sha256 hash is written down. The code
//                               itself exists in the email and nowhere else,
//                               so a leaked database row cannot be used to
//                               finish a sign-up or a reset.
//
//   TIME-LIMITED                Checked at the moment it is used, not when it
//                               was made, so a code that expired while sitting
//                               in an inbox is refused.
//
//   SINGLE-USE                  Spent the moment it works. Asking for a new
//                               one spends every earlier one, so a forwarded
//                               old email is worthless.
//
//   GUESS-LIMITED               Six digits is a million possibilities, which a
//                               machine would exhaust quickly. A few wrong
//                               answers spend the code, which closes that off.

export type OtpPurpose = 'register' | 'reset'

/** Six digits, from a cryptographic source — never Math.random. */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function hashCode(code: string): string {
  return createHash('sha256').update(String(code ?? '').trim()).digest('hex')
}

/** Compares hashes without leaking, through timing, how much matched. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Issues a code for this address, spending any earlier unused one.
 *
 * Returns the code so the caller can put it in an email. It is the only time
 * it exists outside that email: it is not returned to the browser, not logged,
 * and not written to the database.
 */
export async function issueCode(input: {
  tenantId: string
  email: string
  purpose: OtpPurpose
  ip?: string | null
}): Promise<{ code: string; expiresAt: Date }> {
  await prisma.emailOtp.updateMany({
    where: { tenantId: input.tenantId, email: input.email, purpose: input.purpose, usedAt: null },
    data: { usedAt: new Date() },
  })

  const code = newCode()
  const expiresAt = new Date(Date.now() + env.AUTH_OTP_TTL_MINUTES * 60_000)
  await prisma.emailOtp.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      email: input.email,
      purpose: input.purpose,
      codeHash: hashCode(code),
      expiresAt,
      requestedIp: input.ip ?? null,
    },
  })
  return { code, expiresAt }
}

export type CodeCheck = { ok: true } | { ok: false; reason: string }

const WRONG = 'That code is not right. Check the email and try again.'
const GONE = 'That code has expired or has already been used. Ask for a new one.'

/**
 * Checks a code and spends it when it is right.
 *
 * A wrong guess is counted, and the code is spent once the allowance runs out.
 * Expired, already-used and never-issued all answer the same way, so nothing
 * about which is the case can be learned by asking.
 */
export async function useCode(input: {
  tenantId: string
  email: string
  purpose: OtpPurpose
  code: string
}): Promise<CodeCheck> {
  const row = await prisma.emailOtp.findFirst({
    where: { tenantId: input.tenantId, email: input.email, purpose: input.purpose, usedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return { ok: false, reason: GONE }
  if (row.expiresAt.getTime() < Date.now()) {
    await prisma.emailOtp.update({ where: { id: row.id }, data: { usedAt: new Date() } })
    return { ok: false, reason: GONE }
  }

  if (!sameHash(row.codeHash, hashCode(input.code))) {
    // Counted from zero whatever the row says. The column has a default, so
    // this only matters if that ever changes — and the failure it rules out is
    // an unreadable count quietly becoming an unlimited number of guesses.
    const attempts = Number(row.attempts ?? 0) + 1
    const spent = attempts >= env.AUTH_OTP_MAX_ATTEMPTS
    await prisma.emailOtp.update({
      where: { id: row.id },
      data: { attempts, ...(spent ? { usedAt: new Date() } : {}) },
    })
    return { ok: false, reason: spent ? GONE : WRONG }
  }

  await prisma.emailOtp.update({ where: { id: row.id }, data: { usedAt: new Date() } })
  return { ok: true }
}
