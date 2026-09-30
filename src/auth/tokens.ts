import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

// THE TWO KINDS OF SECRET THIS MODULE HANDLES.
//
// A SESSION TOKEN says who is signed in. It is signed with AUTH_JWT_SECRET —
// deliberately not JWT_SECRET, which is NXT Sales'. Two systems, two secrets:
// a token minted for one cannot be presented to the other, and `iss` says
// plainly which one issued it.
//
// A RESET TOKEN is a one-time secret sent to an email address. Only its HASH
// is stored, so the database never holds anything that could be used to take
// an account over; the link in the email is the only copy, and it expires.

/** What this platform puts in the `iss` claim of a token it issued itself. */
export const AUTH_ISSUER = 'altiusnxt-marketing-agent'

export interface AppTokenClaims {
  /** AppUser.id */
  sub: string
  email: string
  iss: string
  iat: number
  exp: number
}

export function localAuthConfigured(): boolean {
  return env.AUTH_JWT_SECRET.trim().length >= 16
}

/** Why local sign-in cannot run, in words an operator can act on. */
export function localAuthUnavailableReason(): string | null {
  if (!env.AUTH_JWT_SECRET.trim()) {
    return 'Sign-in with an email and password is not configured on this server (AUTH_JWT_SECRET is not set).'
  }
  if (env.AUTH_JWT_SECRET.trim().length < 16) {
    return 'AUTH_JWT_SECRET is too short to be a signing secret. Use at least 16 characters.'
  }
  return null
}

export function issueSessionToken(user: { id: string; email: string }): { token: string; expiresAt: Date } {
  const seconds = env.AUTH_SESSION_HOURS * 3600
  const token = jwt.sign({ email: user.email, iss: AUTH_ISSUER }, env.AUTH_JWT_SECRET, {
    subject: user.id,
    expiresIn: seconds,
  })
  return { token, expiresAt: new Date(Date.now() + seconds * 1000) }
}

/**
 * Reads a token this platform issued, or returns null.
 *
 * Null means "not one of ours" — a malformed token, a wrong signature, an
 * expired one, or an NXT Sales token. The caller then tries the NXT Sales
 * path, which is how both sign-ins work side by side.
 */
export function readSessionToken(token: string): AppTokenClaims | null {
  if (!localAuthConfigured()) return null
  try {
    const claims = jwt.verify(token, env.AUTH_JWT_SECRET, { issuer: AUTH_ISSUER }) as AppTokenClaims
    return claims?.sub && claims?.email ? claims : null
  } catch {
    return null
  }
}

/**
 * A fresh reset secret: the half that goes in the link, and the half stored.
 *
 * 32 random bytes — not guessable, and not derived from anything about the
 * account, so knowing the email tells an attacker nothing about the token.
 */
export function newResetToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(Date.now() + env.AUTH_RESET_TTL_MINUTES * 60_000),
  }
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Compares two hashes without leaking, through timing, how much matched. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
