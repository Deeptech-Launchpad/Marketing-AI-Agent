import { env } from '../config/env.js'
import { logger } from '../platform/logger.js'
import { enqueueDebounced, QUEUE_QUALIFICATION_EVALUATE } from '../platform/queue.js'

// TASK #985 — the handoff from scoring to qualification.
//
//   engagement event  →  intent scoring job  →  qualification job  →  sales handoff
//
// This file is the third arrow, and it contains no qualification logic at all.
// The chain is deliberately a chain: engagement capture does not know about
// scoring, scoring does not know about thresholds, and qualification does not
// know how the score was computed. Each stage hands off and stops.
//
// NO RECURSION IS POSSIBLE. Qualification writes no engagement event and no
// intent score, so it cannot re-trigger the stages upstream of it. A unit test
// asserts that structurally rather than trusting this comment.

/**
 * Asks for a company to be evaluated against the threshold, soon.
 *
 * Debounced per company, for the same reason as scoring: a burst of engagement
 * produces one score change worth acting on, not ten.
 *
 * Never throws. A score is worth having even if the qualification job could not
 * be scheduled, and the batch evaluation picks up anything a dropped job missed.
 */
export async function requestQualification(
  tenantId: string,
  crmCompanyId: string,
): Promise<void> {
  if (!env.SALES_QUALIFICATION_AUTO_EVALUATE) return

  try {
    await enqueueDebounced(
      QUEUE_QUALIFICATION_EVALUATE,
      { tenantId, crmCompanyId },
      `sales-qualification:${tenantId}:${crmCompanyId}`,
      env.SALES_QUALIFICATION_DEBOUNCE_SECONDS,
    )
  } catch (err) {
    logger.warn({ err, crmCompanyId }, 'sales qualification: could not enqueue an evaluation')
  }
}
