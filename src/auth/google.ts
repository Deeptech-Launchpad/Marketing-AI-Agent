import { OAuth2Client } from 'google-auth-library'
import { env } from '../config/env.js'
import { logger } from '../platform/logger.js'

// SIGNING IN WITH GOOGLE.
//
// The browser gets an ID TOKEN from Google and sends it here. This module does
// the one thing that makes that safe: it VERIFIES the token with Google's own
// public keys, and checks the token was issued FOR THIS APPLICATION.
//
// The audience check is the part that is easy to leave out and must not be. A
// valid Google token issued for some other site proves the person has a Google
// account — it does not mean they were signing in to us. google-auth-library
// checks the signature, the issuer, the expiry and the audience together.
//
// Nothing here trusts anything the browser says about who the person is. The
// email, the name and the account id all come out of the verified token.

export interface GoogleIdentity {
  /** Google's stable id for this person. Never changes, unlike an email. */
  sub: string
  email: string
  emailVerified: boolean
  name: string | null
}

export function googleConfigured(): boolean {
  return env.GOOGLE_CLIENT_ID.trim().length > 0
}

let client: OAuth2Client | null = null
function oauthClient(): OAuth2Client {
  const id = env.GOOGLE_CLIENT_ID.trim()
  if (!client) client = new OAuth2Client(id)
  return client
}

/**
 * Verifies a Google ID token and returns who it says the person is.
 *
 * Throws with a plain sentence when the token is not acceptable. Every failure
 * is the same outcome to the caller — refused — so nothing about which check
 * failed is reported back to the browser.
 */
export async function verifyGoogleIdToken(credential: string): Promise<GoogleIdentity> {
  if (!googleConfigured()) {
    throw new Error('Google sign-in is not configured on this server.')
  }
  const token = String(credential ?? '').trim()
  if (!token) throw new Error('No Google credential was supplied.')

  let payload
  try {
    const ticket = await oauthClient().verifyIdToken({ idToken: token, audience: env.GOOGLE_CLIENT_ID.trim() })
    payload = ticket.getPayload()
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'google sign-in: token rejected')
    throw new Error('That Google sign-in could not be verified. Try again.')
  }

  if (!payload?.sub || !payload.email) {
    throw new Error('That Google account did not provide an email address.')
  }
  // Google states whether it has verified the address itself. Anything other
  // than an explicit yes proves nothing about who owns the mailbox, so it is
  // refused — an absent claim is treated as "not verified", not as "fine".
  if (payload.email_verified !== true) {
    throw new Error('That Google account’s email address is not verified with Google.')
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: true,
    name: payload.name?.trim() || null,
  }
}
