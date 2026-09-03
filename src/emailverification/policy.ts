import type { VerificationPolicy } from './types.js'

// The verification policy.
//
// Versioned data, not code, for the same reason the scoring weights are: the
// Team Answer settles that verification must happen and says nothing about
// what to do with a risky address. That gap is a business decision, so it is
// expressed as a policy the business can change without a deploy — and marked
// `provisional` so nobody mistakes our default for their decision.

export const VERIFICATION_POLICY_V1: VerificationPolicy = {
  version: 'ev1-provisional',
  status: 'provisional',

  // Only `deliverable` may be sent to.
  //
  // `risky` is excluded on purpose. A catch-all domain accepts everything and
  // proves nothing, and a disposable address is not a buyer. Including it
  // would raise reach and lower deliverability, which is precisely the
  // trade-off Section 21 asks us to protect. If the business wants risky
  // addresses in scope, that is one entry in this array — deliberately, and
  // by them.
  outreachReadyResults: ['deliverable'],

  // A verified address is not verified forever. People leave. 90 days matches
  // the re-enrichment cadence the team confirmed in Section 7, so a company's
  // data and its contacts age out together rather than on two clocks.
  revalidateAfterDays: 90,

  notes: [
    'PROVISIONAL. The Team Answer confirms that verification is required and names Hunter.io and Verifalia, ' +
      'but does not state how a "risky" address should be treated. This policy excludes them, which is the ' +
      'conservative reading, and is the setting to revisit first.',
    'Only "deliverable" is outreach-ready. "unknown" is not a soft yes — it means the provider could not tell.',
    'Re-validation after 90 days is aligned to the confirmed re-enrichment cadence, not chosen independently.',
  ],
}

export function getVerificationPolicy(): VerificationPolicy {
  return VERIFICATION_POLICY_V1
}

/** Whether a stored verification is still current under the active policy. */
export function isStale(verifiedAt: Date | null, policy: VerificationPolicy, now = new Date()): boolean {
  if (!verifiedAt) return true
  const ageDays = (now.getTime() - verifiedAt.getTime()) / 86_400_000
  return ageDays > policy.revalidateAfterDays
}
