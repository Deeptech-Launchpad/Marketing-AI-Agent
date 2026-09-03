import { env } from '../config/env.js'
import { logger } from '../platform/logger.js'
import { enqueueDebounced, QUEUE_CRM_SYNC } from '../platform/queue.js'

// TASK #986 — the handoff from qualification to CRM sync.
//
//   engagement → intent score → qualification → CRM sync
//
// The fourth and last arrow. It carries no CRM logic: Task #985 says "this
// lead is qualified" and stops, and Task #986 decides what that means for the
// CRM. Keeping the two apart is why `salesqualification` contains no mapping,
// no provider and no payload.
//
// NO LOOP IS POSSIBLE. CRM sync writes only its own three tables — never an
// engagement event, an intent score or a qualification — so it cannot feed the
// chain that feeds it. A unit test asserts that structurally.

export async function requestCrmSync(tenantId: string, qualificationId: string): Promise<void> {
  if (!env.CRM_SYNC_AUTO) return

  try {
    await enqueueDebounced(
      QUEUE_CRM_SYNC,
      { tenantId, qualificationId },
      `crm-sync:${tenantId}:${qualificationId}`,
      env.CRM_SYNC_DEBOUNCE_SECONDS,
    )
  } catch (err) {
    logger.warn({ err, qualificationId }, 'crm sync: could not enqueue a handoff')
  }
}
