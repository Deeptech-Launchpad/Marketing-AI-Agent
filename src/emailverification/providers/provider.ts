import type { RiskReason, VerificationEvidence, VerificationResult, VerificationStatus } from '../types.js'

// The verification provider boundary.
//
//   verification service -> EmailVerificationProvider -> VerificationOutcome
//
// The service knows this interface and nothing else, so swapping Hunter for
// Verifalia (or adding a third) is a new file and one registry entry. The
// Team Answer names two candidates and says "another approved verification
// provider", which is exactly why this is an adapter rather than a client.
//
// No provider decides whether an address may be used. It reports what it
// observed; the policy decides what that means. That split is what lets the
// business change its mind about risky addresses without touching an adapter.

export interface VerificationOutcome {
  provider: string
  status: VerificationStatus
  /** Only meaningful when status is `completed`. */
  result: VerificationResult
  riskReasons: RiskReason[]
  reason: string
  evidence: VerificationEvidence | null
  durationMs: number
  costUsd?: number
}

export interface EmailVerificationProvider {
  readonly name: string
  /**
   * Whether this provider can run right now, and if not, precisely why.
   * A missing key is `not_configured`, a rejected key is `unauthorized` —
   * the two need different actions from whoever reads the report.
   */
  available(): { status: VerificationStatus; reason?: string }
  verify(email: string): Promise<VerificationOutcome>
}

/**
 * Runs a provider so that no failure can be mistaken for a verdict.
 *
 * Every path out of here that is not a real answer carries `result:
 * 'unverified'`. A provider that is down, rate limited or unauthorised has
 * told us nothing about the address, and the one dangerous mistake this module
 * could make is letting that read as deliverable.
 */
export async function runVerificationProvider(
  provider: EmailVerificationProvider,
  email: string,
): Promise<VerificationOutcome> {
  const started = Date.now()

  const availability = provider.available()
  if (availability.status !== 'completed') {
    return {
      provider: provider.name,
      status: availability.status,
      result: 'unverified',
      riskReasons: [],
      reason: availability.reason ?? 'Provider reported itself unavailable without a reason.',
      evidence: null,
      durationMs: 0,
    }
  }

  try {
    return await provider.verify(email)
  } catch (err) {
    const message = (err as Error).message
    const status: VerificationStatus = /\b429\b|rate.?limit|too many requests/i.test(message)
      ? 'rate_limited'
      : /\b401\b|\b403\b|unauthor/i.test(message)
        ? 'unauthorized'
        : 'error'
    return {
      provider: provider.name,
      status,
      result: 'unverified',
      riskReasons: [],
      reason: `${provider.name} failed: ${message}`,
      evidence: null,
      durationMs: Date.now() - started,
    }
  }
}

/**
 * Syntax and shape checks that need no provider.
 *
 * This is not verification and must never be reported as such — a
 * syntactically perfect address for a mailbox that does not exist is the
 * normal case. It exists to avoid spending a paid lookup on a string that
 * cannot be an email, and to catch the personal-address policy from
 * Section E.4 before an address is stored at all.
 */
export function inspectSyntax(email: string): { valid: boolean; reason: string } {
  const value = String(email ?? '').trim()
  if (!value) return { valid: false, reason: 'No address was supplied.' }
  if (value.length > 254) return { valid: false, reason: 'Address exceeds the 254-character maximum.' }

  // Deliberately strict about structure, deliberately permissive about the
  // local part: real addresses contain +, ', and dots in orders no simple
  // rule predicts, and rejecting a valid address is worse than passing a
  // doubtful one to a provider that will settle it.
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return { valid: false, reason: 'Address has no local part or no domain.' }
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  if (local.length > 64) return { valid: false, reason: 'Local part exceeds the 64-character maximum.' }
  if (/\s/.test(value)) return { valid: false, reason: 'Address contains whitespace.' }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    return { valid: false, reason: `"${domain}" is not a well-formed domain.` }
  }
  if (value.includes('..')) return { valid: false, reason: 'Address contains a double dot.' }
  return { valid: true, reason: 'Address is well-formed. Shape only — this is not deliverability.' }
}

/** Free-mail domains, which for B2B outreach indicate a personal address. */
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'gmx.net', 'yandex.com', 'mail.com', 'zoho.com',
])

/**
 * Whether an address looks personal rather than work.
 *
 * Section E.4 permits collecting a WORK email and forbids a personal one, so
 * this is a policy check rather than a quality one: a personal address is not
 * a worse lead, it is one we are not allowed to keep.
 */
export function isPersonalAddress(email: string): boolean {
  const domain = String(email ?? '').trim().toLowerCase().split('@').pop()
  return domain ? PERSONAL_DOMAINS.has(domain) : false
}

/** Role accounts — info@, sales@ — which are shared rather than a person. */
export function isRoleAccount(email: string): boolean {
  const local = String(email ?? '').trim().toLowerCase().split('@')[0] ?? ''
  return /^(info|sales|support|admin|contact|help|hello|enquiries|inquiries|office|team|marketing|billing|accounts|noreply|no-reply|postmaster|webmaster)$/.test(
    local,
  )
}

export function riskReasonFor(evidence: VerificationEvidence | null, email: string): RiskReason[] {
  const reasons: RiskReason[] = []
  if (evidence?.checks.catchAll) reasons.push('catch_all')
  if (evidence?.checks.disposable) reasons.push('disposable')
  if (evidence?.checks.roleAccount || isRoleAccount(email)) reasons.push('role_account')
  if (evidence?.checks.domainHasMx === false) reasons.push('no_mx_record')
  return reasons
}
