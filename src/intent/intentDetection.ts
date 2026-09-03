import { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { serializeError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { scoreConfidence, scoreFreshness, signalStatus } from './confidence.js'
import { CareersPageProvider } from './providers/careersPageProvider.js'
import { CrmSignalProvider } from './providers/crmProvider.js'
import { ApifyJobsProvider } from './providers/jobsProvider.js'
import { TechnologySignalProvider } from './providers/technologyProvider.js'
import { runProvider, type IntentProvider, type ProviderResult } from './providers/provider.js'
import { eventFingerprint, type IntentSignalDraft } from './types.js'

// STAGE 3 — INTENT DETECTION ENGINE.
//
// Collects evidence from independent providers, normalises it into one signal
// contract, applies confidence and freshness by rule, collapses duplicate
// events, and stores the result.
//
// It produces NO composite intent score. Each signal keeps its own evidence,
// source, age, confidence and polarity, and a later stage decides what they add
// up to. Collapsing them here would throw away the only thing that makes a
// signal auditable.

const PROVIDERS: IntentProvider[] = [
  new CrmSignalProvider(),
  new TechnologySignalProvider(),
  new CareersPageProvider(),
  new ApifyJobsProvider(),
]

export async function queueIntentDetection(input: {
  tenantId: string
  crmCompanyId: string
  requestedByCrmUserId: string
  prospectSearchId?: string | null
}): Promise<{ id: string }> {
  const id = newId()
  await prisma.intentDetectionRun.create({
    data: {
      id,
      tenantId: input.tenantId,
      crmCompanyId: input.crmCompanyId,
      prospectSearchId: input.prospectSearchId ?? null,
      requestedByCrmUserId: input.requestedByCrmUserId,
      status: 'queued',
    },
  })
  return { id }
}

/** Queue handler. Never throws: failures are recorded on the run row. */
export async function runIntentDetection(runId: string): Promise<void> {
  const run = await prisma.intentDetectionRun.findUnique({ where: { id: runId } })
  if (!run) return
  if (run.status === 'completed') return

  const log = logger.child({ intentRunId: runId, crmCompanyId: run.crmCompanyId })

  // No infinite retries: a run that has already burned its attempts is failed
  // permanently rather than re-queued forever against a paid provider.
  if (run.retryCount >= env.INTENT_MAX_RETRIES) {
    await prisma.intentDetectionRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        failureReason: `Exceeded INTENT_MAX_RETRIES (${env.INTENT_MAX_RETRIES}).`,
        completedAt: new Date(),
      },
    })
    return
  }

  try {
    await prisma.intentDetectionRun.update({
      where: { id: runId },
      data: {
        status: 'running',
        startedAt: new Date(),
        retryCount: { increment: 1 },
        error: Prisma.DbNull,
      },
    })

    const company = await getCrm().getCompany(run.crmCompanyId)
    if (!company) {
      await prisma.intentDetectionRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          failureReason: 'Company not found in NXT Sales (it may have been recycle-binned).',
          completedAt: new Date(),
        },
      })
      return
    }

    // Providers run independently and in sequence. One failing source must not
    // fail the collection — runProvider converts a throw into an ok:false
    // result, so a dead job board still leaves the CRM signals intact.
    const results: ProviderResult[] = []
    for (const provider of PROVIDERS) {
      const result = await runProvider(provider, {
        tenantId: run.tenantId,
        company,
        maxResults: env.APIFY_MAX_RESULTS_PER_COMPANY,
      })
      results.push(result)
      log.debug({ provider: result.provider, ok: result.ok, signals: result.signals.length }, 'provider finished')
    }

    const drafts = results.flatMap((r) => r.signals)
    const stored = await persistSignals(run.tenantId, runId, drafts)

    const costUsd = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)

    await prisma.intentDetectionRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        companyName: company.name,
        signalCount: stored.created,
        duplicatesCollapsed: stored.collapsed,
        providerResults: results.map((r) => ({
          provider: r.provider,
          ok: r.ok,
          signals: r.signals.length,
          reason: r.reason ?? null,
          durationMs: r.durationMs,
          costUsd: r.costUsd ?? null,
          metadata: r.metadata ?? null,
        })) as never,
        costUsd: new Prisma.Decimal(costUsd),
        completedAt: new Date(),
      },
    })

    await audit({
      tenantId: run.tenantId,
      actorType: 'agent',
      action: 'intent.detected',
      resourceType: 'IntentDetectionRun',
      resourceId: runId,
      dataClass: 'customer_pii',
      summary: `${company.name}: ${stored.created} signal(s), ${stored.collapsed} duplicate(s) collapsed`,
    })

    log.info({ signals: stored.created, collapsed: stored.collapsed, costUsd }, 'intent detection completed')
  } catch (err) {
    log.error({ err }, 'intent detection failed')
    await prisma.intentDetectionRun
      .update({
        where: { id: runId },
        data: {
          status: 'failed',
          error: serializeError(err) as never,
          failureReason: (err as Error).message?.slice(0, 500),
          completedAt: new Date(),
        },
      })
      .catch(() => undefined)
  }
}

/**
 * Normalises drafts into stored signals.
 *
 * Deduplication is by EVENT, not by report. Two providers describing the same
 * hire produce one signal carrying both pieces of evidence — otherwise a
 * company whose careers page and a job board both list the same role would look
 * twice as interested as one where only the board did.
 *
 * The surviving record keeps the HIGHER-confidence source, because the point of
 * merging is to keep the best evidence, not the first-arrived.
 */
async function persistSignals(
  tenantId: string,
  runId: string,
  drafts: IntentSignalDraft[],
): Promise<{ created: number; collapsed: number }> {
  const CONF_RANK = { high: 3, medium: 2, low: 1 } as const

  const byFingerprint = new Map<
    string,
    { draft: IntentSignalDraft; confidence: 'high' | 'medium' | 'low'; reasons: string[]; corroboration: string[] }
  >()
  let collapsed = 0

  for (const draft of drafts) {
    const fingerprint = eventFingerprint({
      crmCompanyId: draft.crmCompanyId,
      signalCategory: draft.signalCategory,
      subject: draft.signalType + ' ' + draft.summary,
    })
    const { confidence, reasons } = scoreConfidence(draft)
    const existing = byFingerprint.get(fingerprint)

    if (!existing) {
      byFingerprint.set(fingerprint, { draft, confidence, reasons, corroboration: [] })
      continue
    }

    // Same underlying event. Keep every source's evidence, promote nothing.
    collapsed++
    const note = `${draft.provider} (${draft.sourceType}): ${draft.evidence}`
    if (CONF_RANK[confidence] > CONF_RANK[existing.confidence]) {
      existing.corroboration.push(`${existing.draft.provider} (${existing.draft.sourceType}): ${existing.draft.evidence}`)
      existing.draft = draft
      existing.confidence = confidence
      existing.reasons = reasons
    } else {
      existing.corroboration.push(note)
    }
  }

  let created = 0
  for (const [fingerprint, entry] of byFingerprint) {
    const { draft, confidence, reasons, corroboration } = entry
    const { freshness, ageDays } = scoreFreshness(draft.observedAt)

    await prisma.intentSignal.create({
      data: {
        id: newId(),
        tenantId,
        intentRunId: runId,
        crmCompanyId: draft.crmCompanyId,
        eventFingerprint: fingerprint,
        signalType: draft.signalType,
        signalCategory: draft.signalCategory,
        summary: draft.summary,
        interpretation: draft.interpretation,
        evidence: draft.evidence,
        sourceUrl: draft.sourceUrl,
        sourceType: draft.sourceType,
        provider: draft.provider,
        observedAt: draft.observedAt,
        ageDays,
        freshness,
        confidence,
        confidenceReasons: reasons as never,
        polarity: draft.polarity,
        status: signalStatus(confidence, freshness),
        corroboratingEvidence: corroboration.length ? (corroboration as never) : Prisma.JsonNull,
        corroborationCount: corroboration.length,
        metadata: (draft.metadata ?? undefined) as never,
      },
    })
    created++
  }

  return { created, collapsed }
}
