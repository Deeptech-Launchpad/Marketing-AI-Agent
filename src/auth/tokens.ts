import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

// THE SESSION TOKEN — WHO IS SIGNED IN, AND UNTIL WHEN.
//
// Signed with AUTH_JWT_SECRET, which is deliberately not JWT_SECRET. `iss`
// says plainly that this platform issued it, and both are checked on the way
// back in, so a token minted elsewhere cannot be presented here.
//
// The token carries an id and an email and nothing else. It is not where
// permissions live: what somebody may do is read from the admin list and their
// TenantMember role on every request, so a token cannot carry stale authority.

/** What this platform puts in the `iss` claim of a token it issued. */
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

/** Why sign-in cannot run, in words an operator can act on. */
export function localAuthUnavailableReason(): string | null {
  if (!env.AUTH_JWT_SECRET.trim()) {
    return 'Sign-in is not configured on this server (AUTH_JWT_SECRET is not set).'
  }
  if (env.AUTH_JWT_SECRET.trim().length < 16) {
    return 'AUTH_JWT_SECRET is too short to be a signing secret. Use at least 16 characters.'
  }
  if (!env.GOOGLE_CLIENT_ID.trim()) {
    return 'Google sign-in is not configured on this server (GOOGLE_CLIENT_ID is not set).'
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
 * Null means "not ours": malformed, wrongly signed, expired, or issued by
 * something else entirely. There is no second chance and no fallback — a
 * token that does not verify here does not get in.
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
