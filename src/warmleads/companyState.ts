import type { Classification, Confidence } from './score.js'

// WHAT AN EVALUATION DOES TO A COMPANY'S CURRENT RESULT (pure rules, no database).
//
// Each NXT Sales company has one row (WarmLeadCompany) holding its CURRENT valid
// result - the latest COMPLETED evaluation - and the state of the latest attempt.
// Every evaluation is also kept as history (WarmLeadEvaluation), so nothing is lost.
//
//   completed + definitive   replaces the current result. A completed Cold therefore
//                            takes the company off the Warm Leads list; its earlier
//                            evaluations and evidence stay in the history.
//   failed                   never replaces anything. A company that had a valid result
//                            is marked for re-evaluation and keeps that result.
//   research incomplete      (call ceiling, nightly cap) never replaces anything and is
//                            never Cold: "Research incomplete", retried later.
//   completed, but           "not enough data" never downgrades a Warm / Early Signal;
//   insufficient             it only replaces a weaker or empty result.

export type CompanyState = 'pending' | 'queued' | 'running' | 'evaluated' | 'failed' | 'needs_reevaluation'

/** Results that settle what a company is. */
export const DEFINITIVE: ReadonlySet<string> = new Set(['warm', 'early_signal', 'cold', 'existing_customer', 'active_opportunity', 'do_not_contact', 'human_review'])
/** The results NXT Sales lists on its Warm Leads tab. */
export const LISTED_IN_CRM: ReadonlySet<string> = new Set(['warm', 'early_signal'])

/** Automatic attempts after which a failing company waits for an admin to retry it. */
export const MAX_AUTO_ATTEMPTS = 3
const BACKOFF_DAYS = [1, 3, 7]

/** When a failed attempt may be tried again automatically, or null once the automatic attempts are used up. */
export function nextAttemptAfterFailure(attemptsSoFar: number, now: Date): Date | null {
  if (attemptsSoFar >= MAX_AUTO_ATTEMPTS) return null
  const days = BACKOFF_DAYS[Math.max(0, attemptsSoFar - 1)] ?? 7
  return new Date(now.getTime() + days * 86_400_000)
}

export interface CompanyResult {
  currentEvaluationId: string | null
  classification: string | null
  score: number | null
  confidence: string | null
  summary: string | null
  evaluatedAt: Date | null
}

export interface CompanySnapshot extends CompanyResult {
  /** Attempts so far INCLUDING the one that just finished. */
  attempts: number
}

export type Outcome =
  | { kind: 'failed'; evaluationId: string; error: string; now: Date; refusal?: boolean }
  | {
      kind: 'classified'
      evaluationId: string
      classification: Classification
      score: number
      confidence: Confidence
      summary: string
      /** Web research was cut short or skipped: the result is not final. */
      researchIncomplete: boolean
      /** The call ceiling was the reason (not the company): the attempt is not counted against it. */
      deferredByCeiling: boolean
      /** The newest reply asked not to be contacted / said no (a company-level refusal), whether or not this evaluation could finish. */
      refusal?: boolean
      now: Date
    }

export interface CompanyPatch extends CompanyResult {
  state: CompanyState
  attempts: number
  nextAttemptAt: Date | null
  lastError: string | null
  researchIncomplete: boolean
  lastEvaluationId: string
}

/**
 * A refusal seen by an evaluation that could not finish (the site could not be read, research was cut short, too little data) must
 * not leave an earlier Warm / Early Signal listed as an actionable lead: the company is held for a person (human_review), keeping
 * its earlier score and evidence, and is withdrawn from NXT Sales. The evaluation is still marked for a re-check.
 */
export function applyOutcome(prev: CompanySnapshot, o: Outcome): CompanyPatch {
  const patch = applyOutcomeBase(prev, o)
  if (o.refusal && (patch.classification === 'warm' || patch.classification === 'early_signal') && patch.currentEvaluationId === prev.currentEvaluationId) {
    return {
      ...patch,
      classification: 'human_review',
      summary: `Human review required: this company was ${patch.classification === 'warm' ? 'Warm' : 'an Early Signal'} (score ${patch.score}), but its newest reply asked not to be contacted or said no. It is not listed as an actionable lead until a person decides. ${patch.summary ?? ''}`.trim(),
    }
  }
  return patch
}

function applyOutcomeBase(prev: CompanySnapshot, o: Outcome): CompanyPatch {
  const keep: CompanyResult = {
    currentEvaluationId: prev.currentEvaluationId,
    classification: prev.classification,
    score: prev.score,
    confidence: prev.confidence,
    summary: prev.summary,
    evaluatedAt: prev.evaluatedAt,
  }
  const hasValid = prev.classification !== null && DEFINITIVE.has(prev.classification)

  if (o.kind === 'failed') {
    return {
      ...keep,
      state: hasValid ? 'needs_reevaluation' : 'failed',
      attempts: prev.attempts,
      nextAttemptAt: nextAttemptAfterFailure(prev.attempts, o.now),
      lastError: o.error.slice(0, 1000),
      researchIncomplete: false,
      lastEvaluationId: o.evaluationId,
    }
  }

  if (o.researchIncomplete) {
    // Never final, never Cold. A ceiling deferral costs the company nothing; it is simply tried again next night.
    const attempts = o.deferredByCeiling ? Math.max(0, prev.attempts - 1) : prev.attempts
    return {
      ...keep,
      state: 'needs_reevaluation',
      attempts,
      nextAttemptAt: o.deferredByCeiling ? o.now : nextAttemptAfterFailure(prev.attempts, o.now),
      lastError: o.deferredByCeiling ? 'Web research was not finished: the Gemini call limit was reached. It is tried again next night.' : 'Web research was not finished.',
      researchIncomplete: true,
      lastEvaluationId: o.evaluationId,
    }
  }

  const replace: CompanyResult = {
    currentEvaluationId: o.evaluationId,
    classification: o.classification,
    score: o.score,
    confidence: o.confidence,
    summary: o.summary,
    evaluatedAt: o.now,
  }

  if (DEFINITIVE.has(o.classification)) {
    return { ...replace, state: 'evaluated', attempts: 0, nextAttemptAt: null, lastError: null, researchIncomplete: false, lastEvaluationId: o.evaluationId }
  }

  // Completed, but with too little data to say anything. It must not erase a Warm / Early Signal.
  if (prev.classification === 'warm' || prev.classification === 'early_signal') {
    return {
      ...keep,
      state: 'needs_reevaluation',
      attempts: prev.attempts,
      nextAttemptAt: nextAttemptAfterFailure(prev.attempts, o.now),
      lastError: 'The latest evaluation had too little data to confirm or change the current result. It is checked again later.',
      researchIncomplete: false,
      lastEvaluationId: o.evaluationId,
    }
  }
  return { ...replace, state: 'evaluated', attempts: 0, nextAttemptAt: null, lastError: null, researchIncomplete: false, lastEvaluationId: o.evaluationId }
}

export type SyncAction = 'put' | 'delete' | 'none'

/**
 * What NXT Sales needs for this company, given what it already holds.
 *   put     the company is Warm / Early Signal and NXT Sales does not hold this evaluation
 *   delete  NXT Sales holds an evaluation of a company that is no longer Warm / Early Signal (e.g. a completed Cold)
 */
export function syncAction(c: { classification: string | null; currentEvaluationId: string | null; syncedEvaluationId: string | null }): SyncAction {
  const listed = c.classification !== null && LISTED_IN_CRM.has(c.classification)
  if (listed) return c.syncedEvaluationId === c.currentEvaluationId ? 'none' : 'put'
  return c.syncedEvaluationId ? 'delete' : 'none'
}
