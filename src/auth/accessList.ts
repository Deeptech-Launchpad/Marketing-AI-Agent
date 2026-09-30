import { env } from '../config/env.js'

// WHO MAY SIGN IN, AND WHO IS AN ADMIN.
//
// Both answers come from configuration and nowhere else. They are read fresh
// on every sign-in rather than copied into a row somewhere, so the configured
// list is always the truth: add an address and that person is an admin the
// next time they sign in; remove it and they are not.
//
// Neither list is open by default. This platform reads the whole CRM — every
// company, every contact — so an account on it is an account on that data.

const split = (raw: string): string[] =>
  String(raw ?? '')
    .split(/[,;\s]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)

export function normalizeEmail(raw: string): string {
  return String(raw ?? '').trim().toLowerCase()
}

export function isEmailShaped(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)
}

export function domainOf(email: string): string {
  return normalizeEmail(email).split('@')[1] ?? ''
}

/** The work domains whose Google accounts may sign in. */
export function allowedDomains(): string[] {
  return split(env.AUTH_ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, '')).filter((d) => d.includes('.'))
}

/** The addresses that get admin. Everyone else who signs in is an ordinary user. */
export function adminEmails(): string[] {
  return split(env.AUTH_ADMIN_EMAILS).filter(isEmailShaped)
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().includes(normalizeEmail(email))
}

/**
 * Why this Google account may not sign in, or null when it may.
 *
 * An address on the admin list is always allowed, whatever its domain — that
 * is how a named person on a personal address gets in without opening the
 * door to everyone who shares that domain. Otherwise the domain must be one
 * of ours; a subdomain of it counts, because that is the same organisation.
 */
export function signInProblem(email: string): string | null {
  const address = normalizeEmail(email)
  if (!isEmailShaped(address)) return 'That Google account did not provide a usable email address.'
  if (isAdminEmail(address)) return null

  const domains = allowedDomains()
  if (domains.length === 0) {
    return (
      'Sign-in is not open on this server yet. An administrator sets which work domains may sign in ' +
      '(AUTH_ALLOWED_EMAIL_DOMAINS).'
    )
  }

  const domain = domainOf(address)
  if (domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return null
  return `This platform is for ${domains.join(', ')} accounts. ${address} cannot sign in here.`
}

/** The role this address gets, decided only by the admin list. */
export function roleFor(email: string): 'admin' | 'operator' {
  return isAdminEmail(email) ? 'admin' : 'operator'
}
