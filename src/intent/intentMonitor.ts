import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { enqueue, INTENT_JOB_EXPIRE_SECONDS, QUEUE_INTENT_DETECT } from '../platform/queue.js'
import { queueIntentDetection, RUN_IN_FLIGHT_MS } from './intentDetection.js'

// LIVE INTENT MONITORING (2026-09-29).
//
// Intent Signals was a one-off: a person clicked, the providers ran once, and
// nothing new was ever found again unless someone clicked again. This repeats
// THE SAME RUN on a schedule for the companies Sales is actually working, so a
// new forum thread, news article, review or community question about them is
// picked up after deployment.
//
// Nothing about signal quality changes here. Each wake-up only queues ordinary
// Intent Signals runs; every provider, filter, freshness rule and the
// job-posting exclusion apply exactly as they do to a manual run, and a signal
// already on record is refreshed in place (persistSignals), never duplicated.
//
// WHICH COMPANIES. Only ones someone is working — never the whole CRM:
//   · a person ran Intent Signals for it in the last ACTIVE_DAYS, or
//   · it has a real (not test) outreach sequence still active or paused.
// Each is re-checked at most every INTENT_MONITOR_MIN_DAYS, oldest first, and
// at most INTENT_MONITOR_MAX_COMPANIES per wake-up, because every run spends
// search and model budget.

export const MONITOR_USER = 'intent-monitor'
/** A manual run this recent marks the company as being worked. */
export const ACTIVE_DAYS = 90

export interface MonitorResult {
  considered: number
  queued: number
  skippedInFlight: number
  failed: number
}

export async function monitorIntentSignals(now = new Date()): Promise<MonitorResult> {
  const result: MonitorResult = { considered: 0, queued: 0, skippedInFlight: 0, failed: 0 }
  if (!env.INTENT_MONITOR_ENABLED) return result

  const activeSince = new Date(now.getTime() - ACTIVE_DAYS * 86_400_000)
  const dueBefore = new Date(now.getTime() - env.INTENT_MONITOR_MIN_DAYS * 86_400_000)

  // Companies being worked: a manual Intent run recently, or a live sequence.
  const manual = await prisma.intentDetectionRun.groupBy({
    by: ['tenantId', 'crmCompanyId'],
    where: { requestedByCrmUserId: { not: MONITOR_USER }, createdAt: { gte: activeSince } },
  })
  const outreach = await prisma.outreachCampaign.findMany({
    where: { isTest: false, status: { in: ['active', 'paused'] } },
    select: { tenantId: true, crmCompanyId: true },
    distinct: ['tenantId', 'crmCompanyId'],
  })
  const working = new Map<string, { tenantId: string; crmCompanyId: string }>()
  for (const c of [...manual, ...outreach]) working.set(`${c.tenantId}|${c.crmCompanyId}`, { tenantId: c.tenantId, crmCompanyId: c.crmCompanyId })
  if (working.size === 0) return result

  // When each was last checked, by anyone.
  const last = await prisma.intentDetectionRun.groupBy({
    by: ['tenantId', 'crmCompanyId'],
    where: { crmCompanyId: { in: [...new Set([...working.values()].map((w) => w.crmCompanyId))] } },
    _max: { createdAt: true },
  })
  const lastAt = new Map(last.map((l) => [`${l.tenantId}|${l.crmCompanyId}`, l._max.createdAt]))

  const due = [...working.entries()]
    .map(([key, c]) => ({ ...c, lastAt: lastAt.get(key) ?? null }))
    .filter((c) => !c.lastAt || c.lastAt.getTime() < dueBefore.getTime())
    .sort((a, b) => (a.lastAt?.getTime() ?? 0) - (b.lastAt?.getTime() ?? 0))
    .slice(0, env.INTENT_MONITOR_MAX_COMPANIES)
  result.considered = due.length

  for (const c of due) {
    // The same guard the Intent route uses: never two runs for one company.
    const inFlight = await prisma.intentDetectionRun.findFirst({
      where: {
        tenantId: c.tenantId,
        crmCompanyId: c.crmCompanyId,
        status: { in: ['queued', 'running'] },
        createdAt: { gte: new Date(now.getTime() - RUN_IN_FLIGHT_MS) },
      },
      select: { id: true },
    })
    if (inFlight) {
      result.skippedInFlight++
      continue
    }
    const { id } = await queueIntentDetection({ tenantId: c.tenantId, crmCompanyId: c.crmCompanyId, requestedByCrmUserId: MONITOR_USER })
    try {
      await enqueue(QUEUE_INTENT_DETECT, { intentRunId: id }, { expireInSeconds: INTENT_JOB_EXPIRE_SECONDS })
      result.queued++
    } catch (err) {
      result.failed++
      await prisma.intentDetectionRun
        .update({
          where: { id },
          data: { status: 'failed', failureReason: `The monitor could not queue this run: ${(err as Error).message}`.slice(0, 500), completedAt: new Date() },
        })
        .catch(() => undefined)
    }
  }

  if (result.queued || result.failed) logger.info(result, 'intent monitor: re-checks queued')
  return result
}
