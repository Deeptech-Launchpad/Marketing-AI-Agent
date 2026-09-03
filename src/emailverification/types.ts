// EMAIL VERIFICATION — the layer between "we have an address" and "we may use
// it".
//
// BUSINESS SOURCE: Team Answer, Section 4 and the document's own margin note
// naming Hunter.io and Verifalia. The rule it exists to enforce is short:
//
//   "Do NOT guess email addresses. An address must be verified before the
//    system treats it as outreach-ready."
//
// Two things follow from that, and they shape this whole module.
//
// First, verification is a RECORD, not a boolean. The team asked for provider,
// timestamp, result and preserved evidence, because six months after a bounce
// the useful question is "what did we know, when, and who told us" — and a
// stored `true` answers none of it.
//
// Second, an unverified address is not a suppressed one. Suppression means we
// must not contact a person; unverified means we cannot yet reach an address.
// They block the same send for completely different reasons, and collapsing
// them would let a deliverability gap look like consent withdrawal.

/**
 * What a verification attempt concluded.
 *
 * Deliberately closed, and deliberately not a score. Providers each publish
 * their own vocabulary — Hunter returns deliverable/undeliverable/risky/unknown,
 * Verifalia returns a status plus a classification — and every adapter maps
 * into this set so the rest of the platform reads one language.
 */
export const VERIFICATION_RESULTS = [
  /** The mailbox accepts mail. The only result that is outreach-ready. */
  'deliverable',
  /** The mailbox does not exist or the domain cannot receive mail. */
  'undeliverable',
  /**
   * Accepted, but with a reason to doubt it: catch-all domains, disposable
   * addresses, full mailboxes. Deliverable in the narrow sense and a poor bet
   * for cold outreach, which is why it is kept apart from `deliverable`.
   */
  'risky',
  /** The provider ran and could not decide. Honest, and not a failure. */
  'unknown',
  /** No verification has been attempted for this address yet. */
  'unverified',
] as const
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number]

/**
 * Why an address is risky, when it is. Kept separate from the result so the
 * reason survives a policy change about what to do with risky addresses.
 */
export const RISK_REASONS = [
  'catch_all',
  'disposable',
  'role_account',
  'mailbox_full',
  'no_mx_record',
  'greylisted',
  'provider_unspecified',
] as const
export type RiskReason = (typeof RISK_REASONS)[number]

/** How a verification attempt ended, as distinct from what it concluded. */
export const VERIFICATION_STATUSES = [
  'completed',
  /** No provider is configured. Never reported as a verification result. */
  'not_configured',
  'unauthorized',
  'rate_limited',
  'error',
] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

/**
 * The evidence a provider gave for its conclusion.
 *
 * `raw` holds the provider's own answer, trimmed to the fields that justify
 * the verdict. It exists so a disputed bounce can be traced to what the
 * provider actually said rather than to our interpretation of it.
 */
export interface VerificationEvidence {
  provider: string
  /** The provider's own verdict word, before mapping. */
  providerVerdict: string | null
  /** Provider confidence 0–100 where one is published. */
  providerScore: number | null
  /** SMTP/DNS observations the provider reported, when it reported any. */
  checks: {
    syntaxValid: boolean | null
    domainHasMx: boolean | null
    smtpAccepted: boolean | null
    catchAll: boolean | null
    disposable: boolean | null
    roleAccount: boolean | null
  }
  raw: Record<string, unknown>
}

export interface VerificationRecord {
  email: string
  result: VerificationResult
  status: VerificationStatus
  riskReasons: RiskReason[]
  provider: string | null
  verifiedAt: Date | null
  /** Why this result, in a sentence a salesperson can read. */
  reason: string
  evidence: VerificationEvidence | null
  /** Whether outreach may use this address, under the active policy. */
  outreachReady: boolean
}

export interface VerificationPolicy {
  version: string
  status: 'provisional' | 'approved'
  /**
   * Which results may be sent to. The Team Answer does not state what to do
   * with `risky`, so the default excludes it — sending to a catch-all domain
   * is the kind of decision the business gets to make, not the engine.
   */
  outreachReadyResults: VerificationResult[]
  /** Re-verify an address older than this before reusing it. */
  revalidateAfterDays: number
  notes: string[]
}
