import { env } from '../config/env.js'
import { logger } from '../platform/logger.js'
import { enqueueDebounced, QUEUE_INTENT_SCORE } from '../platform/queue.js'

// TASK #984 — the handoff from engagement capture to scoring.
//
//   Engagement event  →  intent scoring job  →  score calculation
//
// This file is the arrow. It contains no scoring logic at all, and the module
// it lives in is never imported by the engagement capture path except through
// this one function — so Task #983 stays a record of what happened, and
// Task #984 stays an interpretation of it.
//
// NO RECURSION IS POSSIBLE. The scoring path never writes an EngagementEvent,
// so a score can never trigger the event that triggers a score. A unit test
// asserts that structurally rather than trusting the comment.

/**
 * Asks for a company to be rescored, soon.
 *
 * Debounced per company: a Workbench visit produces ten events in seconds, and
 * ten identical calculations would be waste. One job per company per window
 * catches all of them.
 *
 * Never throws. Recording what a prospect did must not fail because a
 * downstream interpretation could not be scheduled — the engagement record is
 * the valuable artifact, and the next tick of the batch recalculation picks up
 * anything a dropped job missed.
 */
export async function requestRescore(
  tenantId: string,
  crmCompanyId: string,
  reason: 'event_ingested' | 'policy_change' = 'event_ingested',
): Promise<void> {
  if (!env.INTENT_SCORE_AUTO_RECALCULATE) return

  try {
    await enqueueDebounced(
      QUEUE_INTENT_SCORE,
      { tenantId, crmCompanyId, trigger: reason },
      `intent-score:${tenantId}:${crmCompanyId}`,
      env.INTENT_SCORE_DEBOUNCE_SECONDS,
    )
  } catch (err) {
    logger.warn({ err, crmCompanyId }, 'intent score: could not enqueue a rescore')
  }
}
