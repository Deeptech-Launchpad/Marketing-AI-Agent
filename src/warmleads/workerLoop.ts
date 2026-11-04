import { readFileSync } from 'node:fs'
import { env } from '../config/env.js'
import { withCrmReadOnly } from '../crm/nxtSales/httpClient.js'
import { withGeminiBudget } from '../llm/gemini/budgetContext.js'
import { prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { bucketBudget, newTally } from './budget.js'
import { claimNext, finishRunIfIdle, recordOutcome, recoverStale, refreshCompanyList } from './companies.js'
import { parseMemAvailableMb } from './isolatedTestSafety.js'
import { preparePilot } from './pilot.js'
import { runCycle, deepResearchAllowed, type CycleDeps, type CycleSettings, type CycleResult } from './scheduler.js'
import { tenantsWithSettings } from './settings.js'
import { computeEvaluation } from './service.js'
import { syncPending } from './sync.js'
import { dbUsageStore } from './usageStore.js'
import { windowOpen } from './window.js'

// THE WORKER'S LOOP (src/warmleadsWorker.ts starts it in its own PM2 process).
//
// Every tick, for every tenant whose Warm Leads section was opened:
//   1. read the company list again if an admin asked (or it is a day old and the pilot is approved)
//   2. turn a requested pilot into 100 queued evaluations
//   3. run one processing cycle (does nothing unless started, inside the window, with memory to spare)
//   4. send results to NXT Sales - which does nothing unless all three sync gates are open
//
// It uses no job queue. It sends no email. Its CRM access is read-only except for step 4.

const log = logger.child({ module: 'warmleads-worker' })
export const SYSTEM_USER = 'warm-leads-worker'
const DAY_MS = 86_400_000

function availableMb(): number {
  if (process.platform !== 'linux') return Number.POSITIVE_INFINITY // not measurable here; the server enforces it
  try {
    return parseMemAvailableMb(readFileSync('/proc/meminfo', 'utf8')) ?? 0 // unreadable on Linux = unsafe
  } catch {
    return 0
  }
}

export function productionDeps(tenantId: string): CycleDeps {
  return {
    tenantId,
    now: () => new Date(),
    workerEnabled: () => env.WARM_LEADS_WORKER_ENABLED,
    availableMb,
    stopBelowMb: env.WARM_LEADS_MIN_AVAILABLE_MB,
    startMarginMb: 1024,
    loadSettings: async (): Promise<CycleSettings> => {
      const s = await prisma.warmLeadSettings.findUniqueOrThrow({ where: { tenantId } })
      return s
    },
    usage: dbUsageStore,
    recoverStale: (now) => recoverStale(tenantId, now),
    claim: (kind, bucket, now) => claimNext(tenantId, kind, bucket, SYSTEM_USER, now),
    evaluate: async (claim, ctx) => {
      const tally = newTally()
      const budget = bucketBudget(dbUsageStore, tenantId, ctx.bucket, ctx.ceiling, tally)
      // Read-only CRM scope + this bucket's Gemini budget: every CRM call is a permitted GET, every Gemini call is reserved in the database first.
      const computed = await withCrmReadOnly(() =>
        withGeminiBudget(budget, () =>
          computeEvaluation({
            tenantId,
            crmCompanyId: claim.crmCompanyId,
            requestedBy: SYSTEM_USER,
            deepGate: async () => {
              const used = await dbUsageStore.getBucket(tenantId, ctx.bucket)
              return used && deepResearchAllowed(used) ? { allowed: true } : { allowed: false, reason: 'ceiling' }
            },
          }),
        ),
      )
      return { computed, geminiCalls: tally.calls, pricedCostUsd: tally.pricedCostUsd, unpricedCalls: tally.unpricedCalls }
    },
    record: (claim, e, ctx) => recordOutcome(claim, e.computed, { bucket: ctx.bucket, geminiCalls: e.geminiCalls, now: ctx.now }),
    afterPilotEvaluation: (claim) => finishRunIfIdle(claim.runId),
    log: (level, msg, extra) => log[level](extra ?? {}, msg),
  }
}

async function handleListRefresh(tenantId: string): Promise<void> {
  const s = await prisma.warmLeadSettings.findUniqueOrThrow({ where: { tenantId } })
  const requested = s.listRefreshRequestedAt
  const done = s.listRefreshedAt
  const dayOld = s.pilotApprovedAt && windowOpen(new Date(), { start: s.windowStart, end: s.windowEnd, timezone: s.timezone }) && (!done || Date.now() - done.getTime() > DAY_MS)
  if (!(requested && (!done || requested > done)) && !dayOld) return
  await prisma.warmLeadSettings.update({ where: { tenantId }, data: { listRefreshState: 'running', listRefreshMessage: null } })
  try {
    const r = await withCrmReadOnly(() => refreshCompanyList(tenantId))
    await prisma.warmLeadSettings.update({
      where: { tenantId },
      data: {
        listRefreshedAt: new Date(),
        listRefreshState: 'done',
        listRefreshMessage: `${r.seen.toLocaleString('en-US')} companies read, ${r.created.toLocaleString('en-US')} new${r.truncated ? ' (the list was cut off - not all were read)' : ''}${r.markedGone ? `, ${r.markedGone} no longer in NXT Sales` : ''}.`,
      },
    })
  } catch (err) {
    log.warn({ err }, 'company list could not be refreshed')
    await prisma.warmLeadSettings.update({ where: { tenantId }, data: { listRefreshState: 'failed', listRefreshMessage: ((err as Error).message ?? String(err)).slice(0, 300) } })
  }
}

/** One pass over one tenant. Never throws. */
export async function tickTenant(tenantId: string): Promise<CycleResult | null> {
  try {
    if (!env.WARM_LEADS_WORKER_ENABLED) return null
    await handleListRefresh(tenantId)
    await withCrmReadOnly(() => preparePilot(tenantId))
    const result = await runCycle(productionDeps(tenantId))
    if (result.processed) log.info(result, 'warm-lead cycle finished')
    await syncPending(tenantId).catch((err) => log.warn({ err }, 'warm-lead sync pass failed'))
    return result
  } catch (err) {
    log.error({ err, tenantId }, 'warm-lead tick failed')
    return null
  }
}

export interface WorkerHandle {
  stop(): Promise<void>
}

/** Ticks until stopped. A tick that is still running is never overlapped, and a stop waits for the company in flight. */
export function startWorkerLoop(intervalMs = 30_000): WorkerHandle {
  let stopping = false
  let timer: NodeJS.Timeout | null = null
  let running: Promise<void> = Promise.resolve()

  const tick = async () => {
    for (const tenantId of await tenantsWithSettings()) {
      if (stopping) return
      await tickTenant(tenantId)
    }
  }
  const schedule = () => {
    if (stopping) return
    timer = setTimeout(() => {
      running = tick()
        .catch((err) => log.error({ err }, 'warm-lead loop error'))
        .finally(schedule)
    }, intervalMs)
  }
  running = tick()
    .catch((err) => log.error({ err }, 'warm-lead loop error'))
    .finally(schedule)

  return {
    async stop() {
      stopping = true
      if (timer) clearTimeout(timer)
      await running
    },
  }
}
