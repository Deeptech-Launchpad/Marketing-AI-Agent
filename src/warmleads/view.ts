import { warmLeadsKeyProblem } from '../llm/gemini/apiKey.js'
import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import { companyCounts } from './companies.js'
import { pilotView } from './pilot.js'
import { ensureSettings } from './settings.js'
import { recentUsage } from './usageStore.js'
import { bucketDay, windowOpen } from './window.js'

// What the Warm Leads screen shows at the top: controls, stage, counts, today's usage.
// Reads only the Marketing database - opening the screen never calls NXT Sales.

export type Stage = 'no_company_list' | 'pilot_not_requested' | 'pilot_preparing' | 'pilot_running' | 'pilot_review' | 'pilot_failed' | 'daily'

export async function buildOverview(tenantId: string, now = new Date()) {
  const s = await ensureSettings(tenantId)
  const [counts, pilot, usage] = await Promise.all([companyCounts(tenantId), pilotView(tenantId), recentUsage(tenantId, 14)])

  const win = { start: s.windowStart, end: s.windowEnd, timezone: s.timezone }
  const bucket = s.pilotApprovedAt ? bucketDay(now, win) : 'pilot'
  const today = usage.find((u) => u.bucket === bucket) ?? null

  let stage: Stage
  if (s.pilotApprovedAt) stage = 'daily'
  else if (!pilot.run) stage = counts.total === 0 ? 'no_company_list' : 'pilot_not_requested'
  else if (pilot.run.status === 'failed') stage = 'pilot_failed'
  else if (pilot.run.status === 'preparing') stage = 'pilot_preparing'
  else if (pilot.run.status === 'completed') stage = 'pilot_review'
  else stage = 'pilot_running'

  return {
    stage,
    counts,
    pilot,
    settings: {
      paused: s.paused,
      dailyCompanyLimit: s.dailyCompanyLimit,
      dailyGeminiCeiling: s.dailyGeminiCeiling,
      pilotSize: s.pilotSize,
      pilotGeminiCeiling: s.pilotGeminiCeiling,
      approvedMaxCompanies: s.approvedMaxCompanies,
      approvedMaxCeiling: s.approvedMaxCeiling,
      retryShare: s.retryShare,
      window: win,
      pilotApprovedAt: s.pilotApprovedAt,
      pilotApprovedBy: s.pilotApprovedBy,
      scaleApprovedAt: s.scaleApprovedAt,
      syncEnabled: s.syncEnabled,
      syncApprovedAt: s.syncApprovedAt,
      updatedBy: s.updatedBy,
      updatedAt: s.updatedAt,
    },
    listRefresh: { requestedAt: s.listRefreshRequestedAt, refreshedAt: s.listRefreshedAt, state: s.listRefreshState, message: s.listRefreshMessage },
    // The server's own switches, shown so "Start" never looks broken when the worker is off.
    // geminiKeyProblem is a sentence about the dedicated key (never the key); null = ready or not needed.
    server: { workerEnabled: env.WARM_LEADS_WORKER_ENABLED, syncSwitchOn: env.WARM_LEADS_SYNC_ENABLED, geminiKeyProblem: warmLeadsKeyProblem() },
    windowOpenNow: windowOpen(now, win),
    bucket,
    today,
    usage,
  }
}

/** Evaluations that stand behind the company list's "Review" drawer: most recent first. */
export async function recentEvaluations(tenantId: string, limit = 50) {
  const rows = await prisma.warmLeadEvaluation.findMany({ where: { tenantId, status: { in: ['done', 'failed'] } }, orderBy: { evaluatedAt: 'desc' }, take: limit })
  return rows.map((e) => ({ ...e, costUsd: Number(e.costUsd) }))
}
