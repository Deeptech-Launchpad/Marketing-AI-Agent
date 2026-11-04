import type { GeminiBudget } from '../llm/gemini/budgetContext.js'
import type { Claim, StoredOutcome, WorkKind } from './companies.js'
import { DEEP_RESEARCH_CALL_ESTIMATE } from './limits.js'
import type { ComputedEvaluation } from './service.js'
import type { BucketLimits, BucketUsage, UsageStore } from './usageStore.js'
import { bucketDay, windowOpen, type WindowConfig } from './window.js'

// ONE PROCESSING CYCLE: what the worker does when it is allowed to work.
//
// It evaluates companies strictly one after another until something says stop:
//
//   paused / worker off / outside the window / memory low     (re-checked before EVERY company)
//   the night's company limit is used up
//   the night's Gemini ceiling is reached                     (a company whose web research could not be finished
//                                                              is "research incomplete" - never Cold - and the night stops)
//   nothing is left that is due
//
// Everything it touches is injected (CycleDeps), so the rules are tested without a database or a CRM.

export type StopReason = 'worker_disabled' | 'paused' | 'outside_window' | 'low_memory' | 'company_limit' | 'gemini_ceiling' | 'nothing_to_do' | 'repeated_failures' | 'error'

export interface CycleSettings {
  paused: boolean
  dailyCompanyLimit: number
  dailyGeminiCeiling: number
  pilotSize: number
  pilotGeminiCeiling: number
  retryShare: number
  windowStart: string
  windowEnd: string
  timezone: string
  pilotApprovedAt: Date | null
}

export interface EvaluatedClaim {
  computed: ComputedEvaluation
  geminiCalls: number
  pricedCostUsd: number
  unpricedCalls: number
}

export interface CycleDeps {
  tenantId: string
  now(): Date
  workerEnabled(): boolean
  /** Memory available to the server, in MB (Infinity where it cannot be measured and is not enforced). */
  availableMb(): number
  /** Below this a running cycle stops; a cycle only starts with this + startMarginMb. */
  stopBelowMb: number
  startMarginMb: number
  loadSettings(): Promise<CycleSettings>
  usage: UsageStore
  recoverStale(now: Date): Promise<unknown>
  claim(kind: WorkKind, bucket: string, now: Date): Promise<Claim | null>
  /** Evaluates one claimed company inside its Gemini budget and a read-only CRM scope. Must not throw for a company's own problems. */
  evaluate(claim: Claim, ctx: { bucket: string; ceiling: number }): Promise<EvaluatedClaim>
  record(claim: Claim, e: EvaluatedClaim, ctx: { bucket: string; now: Date }): Promise<StoredOutcome>
  /** After a pilot evaluation: closes the pilot run when nothing is left in it. */
  afterPilotEvaluation(claim: Claim): Promise<unknown>
  log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void
}

export interface CycleResult {
  stoppedBecause: StopReason
  bucket: string | null
  processed: number
  failed: number
  incomplete: number
}

const windowOf = (s: CycleSettings): WindowConfig => ({ start: s.windowStart, end: s.windowEnd, timezone: s.timezone })

export function limitsFor(s: CycleSettings, mode: 'pilot' | 'daily'): BucketLimits {
  const companyLimit = mode === 'pilot' ? s.pilotSize : s.dailyCompanyLimit
  return {
    geminiCeiling: mode === 'pilot' ? s.pilotGeminiCeiling : s.dailyGeminiCeiling,
    companyLimit,
    retryLimit: Math.floor((companyLimit * s.retryShare) / 100),
  }
}

/** Every Nth company is a retry while retries are available, so earlier failures are not starved by new companies. */
export function retryTurn(startedSoFar: number, retryShare: number): boolean {
  if (retryShare <= 0) return false
  const every = Math.max(1, Math.round(100 / retryShare))
  return (startedSoFar + 1) % every === 0
}

/** This many failed evaluations in a row (CRM, network or key trouble rather than one odd site) stop the cycle, so a bad hour cannot use up the night's companies. */
export const MAX_CONSECUTIVE_FAILURES = 8

export async function runCycle(d: CycleDeps): Promise<CycleResult> {
  const result: CycleResult = { stoppedBecause: 'nothing_to_do', bucket: null, processed: 0, failed: 0, incomplete: 0 }
  const stop = (why: StopReason): CycleResult => ({ ...result, stoppedBecause: why })

  let s = await d.loadSettings()
  if (!d.workerEnabled()) return stop('worker_disabled')
  if (s.paused) return stop('paused')
  let now = d.now()
  if (!windowOpen(now, windowOf(s))) return stop('outside_window')
  if (d.availableMb() < d.stopBelowMb + d.startMarginMb) return stop('low_memory')

  await d.recoverStale(now)

  let consecutiveFailures = 0
  const mode: 'pilot' | 'daily' = s.pilotApprovedAt ? 'daily' : 'pilot'
  const bucket = mode === 'pilot' ? 'pilot' : bucketDay(now, windowOf(s))
  result.bucket = bucket
  await d.usage.ensureBucket(d.tenantId, bucket, limitsFor(s, mode))

  for (;;) {
    // Re-checked before every company: pausing, closing the window or low memory stops the NEXT company (the one in flight finishes).
    s = await d.loadSettings()
    now = d.now()
    if (!d.workerEnabled()) return stop('worker_disabled')
    if (s.paused) return stop('paused')
    if (!windowOpen(now, windowOf(s))) return stop('outside_window')
    if (d.availableMb() < d.stopBelowMb) return stop('low_memory')

    // The settings may have changed during the night (an admin lowered a limit): the bucket follows them.
    const limits = limitsFor(s, mode)
    await d.usage.ensureBucket(d.tenantId, bucket, limits)
    const used = await d.usage.getBucket(d.tenantId, bucket)
    if (!used) return stop('error')
    if (used.companiesStarted >= used.companyLimit) {
      await d.usage.setStopped(d.tenantId, bucket, 'company_limit')
      return stop('company_limit')
    }
    if (used.geminiCalls >= used.geminiCeiling) {
      await d.usage.setStopped(d.tenantId, bucket, 'gemini_ceiling')
      return stop('gemini_ceiling')
    }

    const claim = await takeNext(d, s, mode, bucket, used, now)
    if (!claim) {
      await d.usage.setStopped(d.tenantId, bucket, 'nothing_to_do')
      return stop('nothing_to_do')
    }

    let outcome: StoredOutcome
    let evaluated: EvaluatedClaim
    try {
      evaluated = await d.evaluate(claim, { bucket, ceiling: limits.geminiCeiling })
      outcome = await d.record(claim, evaluated, { bucket, now: d.now() })
    } catch (err) {
      // The company stays "running" and is recovered as stale later; the cycle stops rather than looping on a broken store.
      d.log('warn', 'warm-lead cycle stopped by an error', { crmCompanyId: claim.crmCompanyId, message: (err as Error).message })
      await d.usage.setStopped(d.tenantId, bucket, 'error').catch(() => undefined)
      return stop('error')
    }

    result.processed++
    if (outcome.failed) result.failed++
    consecutiveFailures = outcome.failed ? consecutiveFailures + 1 : 0
    if (outcome.researchIncomplete) result.incomplete++
    await d.usage.addProgress(d.tenantId, bucket, {
      screened: 1,
      deepResearched: evaluated.computed.tier === 'deep' ? 1 : 0,
      completed: outcome.failed || outcome.researchIncomplete ? 0 : 1,
      failed: outcome.failed ? 1 : 0,
      incomplete: outcome.researchIncomplete ? 1 : 0,
      pricedCostUsd: evaluated.pricedCostUsd,
      unpricedCalls: evaluated.unpricedCalls,
    })
    if (claim.kind === 'pilot') await d.afterPilotEvaluation(claim)

    // Stop here rather than burn the rest of the night's companies on a systemic problem; the worker waits before trying again.
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      d.log('warn', 'warm-lead cycle stopped: too many failures in a row', { consecutiveFailures })
      await d.usage.setStopped(d.tenantId, bucket, 'repeated_failures').catch(() => undefined)
      return stop('repeated_failures')
    }

    // The web research could not be finished because the ceiling was reached: stop the night here, safely.
    if (evaluated.computed.deep === 'skipped_ceiling') {
      await d.usage.setStopped(d.tenantId, bucket, 'gemini_ceiling')
      return stop('gemini_ceiling')
    }
  }
}

/** Reserves a company slot and claims a company for it; gives the slot back when there is nothing to claim. */
async function takeNext(d: CycleDeps, s: CycleSettings, mode: 'pilot' | 'daily', bucket: string, used: BucketUsage, now: Date): Promise<Claim | null> {
  // The order to try: the pilot's own queue first (pilot), a retry on its turn, then new companies.
  const first: WorkKind[] = mode === 'pilot' ? ['pilot', 'retry'] : retryTurn(used.companiesStarted, s.retryShare) ? ['retry', 'pending'] : ['pending', 'retry']
  for (const kind of first) {
    const retry = kind === 'retry'
    if (retry && used.retriesStarted >= used.retryLimit) continue
    if (!(await d.usage.reserveCompanySlot(d.tenantId, bucket, retry))) continue
    const claim = await d.claim(kind, bucket, now)
    if (claim) return claim
    await d.usage.releaseCompanySlot(d.tenantId, bucket, retry)
  }
  return null
}

/** Whether the paid web research may start: the bucket must have enough Gemini calls left for a whole research. */
export function deepResearchAllowed(used: Pick<BucketUsage, 'geminiCalls' | 'geminiCeiling'>): boolean {
  return used.geminiCeiling - used.geminiCalls >= DEEP_RESEARCH_CALL_ESTIMATE
}

export type { GeminiBudget }
