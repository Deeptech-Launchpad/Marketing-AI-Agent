import { env } from '../config/env.js'
import { crmWarmLeadsDelete, crmWarmLeadsPut } from '../crm/nxtSales/httpClient.js'
import { prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { syncAction } from './companyState.js'
import { assertNxtSendable } from './runSummary.js'

// SENDING THE CURRENT WARM / EARLY SIGNAL LIST TO NXT SALES - built, and OFF.
//
// Three independent gates must ALL be open before one byte leaves for NXT Sales:
//   1. the server switch   WARM_LEADS_SYNC_ENABLED=true   (and WARM_LEADS_ALLOW_LIVE for a non-local CRM)
//   2. the pilot is approved
//   3. an admin approved syncing (WarmLeadSettings.syncEnabled)
// On top of that the transport (httpClient.ts) only lets this code reach the Warm Leads
// endpoints: PUT/DELETE /api/marketing-warm-leads/companies/:id, nothing else.
//
// What is sent: the company's CURRENT result when it is Warm or Early Signal (company id,
// score, confidence, summary, every reason with its source link, evaluation date).
// A company that stops being Warm / Early Signal (e.g. a completed Cold) is WITHDRAWN from
// NXT Sales' list; its history stays here. Nothing about a company's CRM record is changed,
// and nothing here sends an email.
//
// Idempotent: a company's `syncedEvaluationId` records what NXT Sales holds. The same
// evaluation is never sent twice, and a repeated PUT would be harmless anyway (NXT Sales upserts
// by company and ignores an older result).

const log = logger.child({ module: 'warmleads-sync' })

export interface SyncResult {
  skipped: string | null
  put: number
  withdrawn: number
  failed: number
}

export async function syncGate(tenantId: string): Promise<string | null> {
  if (!env.WARM_LEADS_SYNC_ENABLED) return 'Sending to NXT Sales is switched off on this server (WARM_LEADS_SYNC_ENABLED).'
  const s = await prisma.warmLeadSettings.findUnique({ where: { tenantId } })
  if (!s?.pilotApprovedAt) return 'The pilot has not been approved.'
  if (!s.syncEnabled || !s.syncApprovedAt) return 'Sending to NXT Sales has not been approved.'
  return null
}

export async function syncPending(tenantId: string, max = 50): Promise<SyncResult> {
  const out: SyncResult = { skipped: null, put: 0, withdrawn: 0, failed: 0 }
  out.skipped = await syncGate(tenantId)
  if (out.skipped) return out

  const ids = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "WarmLeadCompany"
    WHERE "tenantId" = ${tenantId} AND "inCrm" = true AND (
      ("classification" IN ('warm', 'early_signal') AND "syncedEvaluationId" IS DISTINCT FROM "currentEvaluationId")
      OR (("classification" IS NULL OR "classification" NOT IN ('warm', 'early_signal')) AND "syncedEvaluationId" IS NOT NULL))
    ORDER BY "updatedAt" LIMIT ${max}`

  for (const { id } of ids) {
    const c = await prisma.warmLeadCompany.findUnique({ where: { id } })
    if (!c) continue
    const action = syncAction(c)
    try {
      if (action === 'put') {
        const e = await prisma.warmLeadEvaluation.findUnique({ where: { id: c.currentEvaluationId! } })
        if (!e || e.status !== 'done' || !e.classification) throw new Error('The evaluation to send could not be found.')
        assertNxtSendable(e.classification) // defence in depth: the company is Warm / Early Signal, but what is SENT must be a status NXT Sales accepts
        await crmWarmLeadsPut(`/companies/${encodeURIComponent(c.crmCompanyId)}`, {
          runId: e.runId,
          evaluationId: e.id,
          classification: e.classification,
          evaluationStatus: 'evaluated',
          score: e.score,
          confidence: e.confidence,
          summary: e.summary,
          reasons: e.reasons ?? [],
          deepCheck: e.deepCheck,
          error: null,
          evaluatedAt: (e.evaluatedAt ?? new Date()).toISOString(),
        })
        await prisma.warmLeadCompany.update({ where: { id }, data: { syncedEvaluationId: c.currentEvaluationId, syncedAt: new Date(), syncError: null } })
        out.put++
      } else if (action === 'delete') {
        await crmWarmLeadsDelete(`/companies/${encodeURIComponent(c.crmCompanyId)}`)
        await prisma.warmLeadCompany.update({ where: { id }, data: { syncedEvaluationId: null, syncedAt: new Date(), syncError: null } })
        out.withdrawn++
      }
    } catch (err) {
      out.failed++
      await prisma.warmLeadCompany.update({ where: { id }, data: { syncError: ((err as Error).message ?? String(err)).slice(0, 500) } }).catch(() => undefined)
      log.warn({ crmCompanyId: c.crmCompanyId, message: (err as Error).message }, 'warm-lead sync failed for a company; tried again next time')
    }
  }
  return out
}
