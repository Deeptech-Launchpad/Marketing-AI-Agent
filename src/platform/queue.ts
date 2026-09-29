import PgBoss from 'pg-boss'
import { env } from '../config/env.js'
import { logger } from './logger.js'

// Durable queue on the SAME Postgres instance, in its own `pgboss` schema.
//
// This is the piece that makes a run resumable: a step is enqueued as a real
// job row, so a crash mid-run redelivers that job and the run continues from
// its last persisted step. NXT Sales' background work uses bare setInterval
// with in-memory state, which loses everything on restart — that pattern is
// deliberately not reused here.

export const QUEUE_RUN_STEP = 'run.step'
export const QUEUE_KNOWLEDGE_INGEST = 'knowledge.ingest'
export const QUEUE_PROSPECT_DISCOVER = 'prospect.discover'
export const QUEUE_COMPANY_ENRICH = 'company.enrich'
export const QUEUE_INTENT_DETECT = 'intent.detect'
export const QUEUE_DM_DISCOVER = 'decisionmaker.discover'
export const QUEUE_WEBSITE_AUDIT = 'website.audit'
export const QUEUE_OUTREACH_ACTION = 'outreach.action'
export const QUEUE_INTENT_SCORE = 'intent.score'
export const QUEUE_QUALIFICATION_EVALUATE = 'qualification.evaluate'
export const QUEUE_CRM_SYNC = 'crm.sync'
/** Scheduled check for new leads that need decision-maker discovery. */
export const QUEUE_DM_LEAD_WATCH = 'decisionmaker.lead_watch'
/**
 * Open-web company discovery (2026-09-24 restructure). Deliberately a
 * separate queue from QUEUE_PROSPECT_DISCOVER, whose handler is CRM-only by
 * explicit design — this keeps that boundary unambiguous rather than
 * overloading one queue with two different contracts.
 */
export const QUEUE_COMPANY_WEB_DISCOVER = 'company.web_discover'
/** Scheduled re-check of Intent Signals for companies being worked (2026-09-29). */
export const QUEUE_INTENT_MONITOR = 'intent.monitor'
/** Scheduled sender for approved TEST-batch emails (internal test inboxes only). */
export const QUEUE_OUTREACH_TEST_DISPATCH = 'outreach.test_dispatch'

const ALL_QUEUES = [
  QUEUE_RUN_STEP,
  QUEUE_KNOWLEDGE_INGEST,
  QUEUE_PROSPECT_DISCOVER,
  QUEUE_COMPANY_ENRICH,
  QUEUE_INTENT_DETECT,
  QUEUE_DM_DISCOVER,
  QUEUE_WEBSITE_AUDIT,
  QUEUE_OUTREACH_ACTION,
  QUEUE_INTENT_SCORE,
  QUEUE_QUALIFICATION_EVALUATE,
  QUEUE_CRM_SYNC,
  QUEUE_DM_LEAD_WATCH,
  QUEUE_COMPANY_WEB_DISCOVER,
  QUEUE_OUTREACH_TEST_DISPATCH,
  QUEUE_INTENT_MONITOR,
]

/**
 * Prisma-specific query params (?schema=) are not meaningful to node-postgres,
 * so they are stripped before handing the URL to pg-boss.
 */
function connectionString(): string {
  const url = new URL(env.MARKETING_DATABASE_URL)
  url.search = ''
  return url.toString()
}

let boss: PgBoss | null = null

export async function getQueue(): Promise<PgBoss> {
  if (boss) return boss

  const instance = new PgBoss({ connectionString: connectionString(), schema: 'pgboss' })
  instance.on('error', (err) => logger.error({ err }, 'pg-boss error'))
  await instance.start()
  for (const q of ALL_QUEUES) {
    await instance.createQueue(q)
  }
  boss = instance
  return instance
}

export async function stopQueue(): Promise<void> {
  if (!boss) return
  await boss.stop({ graceful: true })
  boss = null
}

/**
 * retryLimit is deliberately NON-ZERO.
 *
 * A step that fails logically never surfaces as a failed JOB: executeNextStep
 * catches it, marks the run failed, and the job completes normally. So the only
 * way pg-boss sees a failure here is the process actually dying mid-step — and
 * that is precisely the case that must be redelivered. With retryLimit: 0 a
 * crash would leave the run stranded in `running` with nothing to resume it,
 * which would make "resumable" a claim rather than a property.
 *
 * expireInSeconds bounds how long a job may be held by a worker that has gone
 * away without releasing it.
 */
export async function enqueue(queue: string, data: Record<string, unknown>): Promise<string | null> {
  const q = await getQueue()
  return q.send(queue, data, {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 900,
  })
}

/**
 * Enqueues at most one pending job per key within a window.
 *
 * TASK #984: a busy Workbench visit produces ten engagement events in seconds.
 * Enqueuing a scoring job for each would run the same calculation ten times
 * over an input that has barely changed. A singleton key per company collapses
 * that burst into one job — the score still catches up, and the worker is not
 * asked to do nine redundant passes.
 *
 * The job is a HANDOFF, not scoring inline: event capture stays free of scoring
 * logic, which is also what keeps the two from looping into each other.
 */
export async function enqueueDebounced(
  queue: string,
  data: Record<string, unknown>,
  key: string,
  windowSeconds: number,
): Promise<string | null> {
  const q = await getQueue()
  return q.send(queue, data, {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 900,
    singletonKey: key,
    singletonSeconds: windowSeconds,
  })
}

/**
 * pg-boss v10 hands the handler an array of jobs. Earlier majors handed a
 * single job. Normalising here keeps the call sites version-agnostic.
 */
export async function work(
  queue: string,
  handler: (data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const q = await getQueue()
  await q.work(queue, { batchSize: 1 }, async (arg: unknown) => {
    const jobs = Array.isArray(arg) ? arg : [arg]
    for (const job of jobs) {
      const data = (job as { data?: Record<string, unknown> })?.data ?? {}
      await handler(data)
    }
  })
}
