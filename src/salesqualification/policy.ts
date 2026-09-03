import type { QualificationDecision, QualificationPolicy, QualificationStatus } from './types.js'

// TASK #985 — the qualification policy, as DATA.
//
// ─────────────────────────────────────────────────────────────────────────────
// NONE OF THESE NUMBERS ARE BUSINESS-APPROVED.
//
// The threshold of 70, the 15-minute SLA, the absence of a hysteresis band and
// the decision not to cancel a task on de-qualification are all PROVISIONAL
// DEFAULTS. Nobody at AltiusNXT has agreed them, and no analysis supports them
// — a threshold is a statement about how much sales capacity to spend, and that
// is a commercial decision, not a technical one.
//
// The policy carries `status: 'provisional'` and every API response repeats it.
// ─────────────────────────────────────────────────────────────────────────────
//
// The engine reads these values and contains none of them, so the business can
// move the threshold from 70 to 80 by publishing a version without anyone
// touching the comparison logic.

export const DEFAULT_QUALIFICATION_POLICY_VERSION = 'sq1-provisional'

/** Bumped when the DECISION LOGIC changes, separately from the numbers. */
export const QUALIFICATION_ENGINE_VERSION = 'qual-1'

export const DEFAULT_QUALIFICATION_POLICY: QualificationPolicy = Object.freeze({
  version: DEFAULT_QUALIFICATION_POLICY_VERSION,
  status: 'provisional',
  description:
    'Default provisional sales qualification policy. A lead is high-intent when its Task #984 intent score meets the threshold. Not business-approved.',
  threshold: 70,

  /**
   * No hysteresis.
   *
   * A band would stop a score oscillating around the threshold from flipping a
   * lead in and out, which is a genuine operational problem — but how much
   * flapping is acceptable is a business judgement, and inventing a number here
   * would quietly harden into "once hot, always hot". Zero means the simple
   * rule applies, and the consequence is documented rather than hidden: a score
   * sitting near the threshold WILL change state as new engagement arrives.
   */
  deQualifyBand: 0,

  slaMinutes: 15,
  createAlert: true,
  createFollowUpTask: true,

  /**
   * A task already given to a person is NOT withdrawn when the score dips.
   *
   * Someone may already be acting on it, and silently cancelling their work
   * because an automated number moved is worse than leaving a task that a human
   * can close. Business policy can reverse this.
   */
  cancelTaskOnDeQualification: false,

  notes: [
    'THE THRESHOLD OF 70 IS NOT BUSINESS-APPROVED. It is a provisional default and requires sign-off before sales capacity is committed against it.',
    'The 15-minute SLA is provisional. No service-level agreement exists in this system.',
    'No hysteresis band is configured, so a score near the threshold may qualify and de-qualify as new engagement arrives. This is the simple rule, stated rather than hidden.',
    'Qualification depends entirely on the Task #984 intent score, whose own weights are also provisional.',
    'A high-intent lead means observed engagement crossed a chosen threshold. It is not a prediction, a conversion probability, or a forecast of revenue.',
    'This stage creates an alert and a task. It never contacts the prospect.',
  ],
}) as QualificationPolicy

/**
 * The qualification decision. Pure, deterministic, and the whole rule.
 *
 * No model, no inference, no subjective judgement — a comparison, and a
 * sentence explaining it. `previousStatus` is consulted only for the
 * hysteresis band, so that an already-qualified lead can be held slightly
 * longer when a band is configured.
 */
export function decide(
  score: number,
  policy: QualificationPolicy,
  previousStatus?: QualificationStatus | null,
): QualificationDecision {
  const wasQualified = previousStatus === 'qualified' || previousStatus === 'qualified_unassigned'

  // With a band configured, a qualified lead is held until the score drops
  // below (threshold - band). With the default band of 0 this is exactly the
  // simple rule.
  const effectiveThreshold = wasQualified ? policy.threshold - policy.deQualifyBand : policy.threshold
  const qualifies = score >= effectiveThreshold
  const difference = score - policy.threshold

  if (qualifies) {
    const held =
      wasQualified && score < policy.threshold
        ? ` It remains qualified because the policy holds a qualified lead until the score falls below ${effectiveThreshold}.`
        : ''
    return {
      status: 'qualified',
      qualifies: true,
      score,
      threshold: policy.threshold,
      difference,
      reason: `The current intent score of ${score} meets the configured high-intent threshold of ${policy.threshold}.${held}`,
    }
  }

  return {
    status: wasQualified ? 'de_qualified' : 'not_qualified',
    qualifies: false,
    score,
    threshold: policy.threshold,
    difference,
    reason: wasQualified
      ? `The intent score of ${score} has fallen below the high-intent threshold of ${policy.threshold}. The earlier qualification is kept in the history.`
      : `The intent score of ${score} is below the configured high-intent threshold of ${policy.threshold}.`,
  }
}

/** Due time for the follow-up, from the policy's SLA. */
export function dueAt(qualifiedAt: Date, policy: QualificationPolicy): Date {
  return new Date(qualifiedAt.getTime() + policy.slaMinutes * 60_000)
}

/** Structural checks, so a malformed policy fails loudly. */
export function validateQualificationPolicy(policy: QualificationPolicy): string[] {
  const problems: string[] = []
  if (!Number.isInteger(policy.threshold) || policy.threshold < 0 || policy.threshold > 100) {
    problems.push('threshold must be a whole number between 0 and 100.')
  }
  if (policy.deQualifyBand < 0 || policy.deQualifyBand > policy.threshold) {
    problems.push('deQualifyBand must be between 0 and the threshold.')
  }
  if (!Number.isInteger(policy.slaMinutes) || policy.slaMinutes < 1) {
    problems.push('slaMinutes must be a positive whole number.')
  }
  return problems
}
