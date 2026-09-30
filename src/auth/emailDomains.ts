import { env } from '../config/env.js'

// WHO MAY CREATE AN ACCOUNT HERE.
//
// This platform reads the whole CRM — every company, every contact — so an
// account on it is an account on that data. Registration is therefore closed
// by default and opened one domain at a time, through
// AUTH_ALLOWED_EMAIL_DOMAINS.
//
// An EMPTY list means nobody may register. That is the safe direction to fail:
// a misconfigured server refuses everyone rather than admitting everyone.

export function allowedDomains(): string[] {
  return env.AUTH_ALLOWED_EMAIL_DOMAINS.split(/[,;\s]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => d.includes('.'))
}

export function normalizeEmail(raw: string): string {
  return String(raw ?? '').trim().toLowerCase()
}

export function isEmailShaped(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)
}

export function domainOf(email: string): string {
  return normalizeEmail(email).split('@')[1] ?? ''
}

/**
 * Why this address may not register, or null when it may.
 *
 * A subdomain of an allowed domain is accepted (mail.altiusnxt.com under
 * altiusnxt.com), because that is the same organisation. Nothing else is.
 */
export function registrationProblem(email: string): string | null {
  const address = normalizeEmail(email)
  if (!isEmailShaped(address)) return 'That does not look like an email address.'

  const domains = allowedDomains()
  if (domains.length === 0) {
    return (
      'Creating an account is not open on this server. An administrator sets which email domains may ' +
      'register (AUTH_ALLOWED_EMAIL_DOMAINS), or can create your account for you.'
    )
  }

  const domain = domainOf(address)
  const allowed = domains.some((d) => domain === d || domain.endsWith(`.${d}`))
  if (!allowed) {
    return `Accounts can only be created for a work address at: ${domains.join(', ')}.`
  }
  return null
}
