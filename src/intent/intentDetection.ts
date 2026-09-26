import { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { discoveredCompanyIdFor, resolvePipelineCompany } from '../prospects/discoveredCompanyAdapter.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { serializeError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { scoreConfidence, scoreFreshness, signalStatus } from './confidence.js'
import { CareersPageProvider } from './providers/careersPageProvider.js'
import { CrmSignalProvider } from './providers/crmProvider.js'
import { ApifyJobsProvider } from './providers/jobsProvider.js'
import { outreachAngleFor } from './outreachAngles.js'
import { ExternalSourcesProvider } from './providers/externalSourcesProvider.js'
import { CommunityQuestionsProvider } from './providers/communityQuestionsProvider.js'
import { PublicResearchSignalProvider } from './providers/publicResearchProvider.js'
import { SocialProfileProvider } from './providers/socialProvider.js'
import { TechnologySignalProvider } from './providers/technologyProvider.js'
import { runProvider, type IntentProvider, type ProviderResult, type SignalSupersession } from './providers/provider.js'
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
  // Public company profiles the company's own website links to. Last because
  // it makes the most external requests; its findings are independent of the
  // others, so nothing above it depends on the order.
  new SocialProfileProvider(),
  // The open web, searched rather than addressed directly. Last because it is
  // the widest net and the most expensive: every provider above reads a source
  // we can already name — the CRM, a meta tag, a careers path, a profile the
  // company itself links to — and this one goes looking. It adds sources; it
  // replaces none of them.
  new PublicResearchSignalProvider(),
  // What OTHER people publish about the company — forums, Reddit, reviews,
  // news, blogs, public social posts (2026-09-25). Its own site is left to the
  // providers above; this one reads only outside sources.
  new ExternalSourcesProvider(),
  // Questions asked in the forums and communities where our buyers are, kept
  // by the Community Engagement & Trust-Building method's own rules
  // (2026-09-26). Additive: it changes none of the sources above.
  new CommunityQuestionsProvider(),
]

/**
 * A role title a SOURCE actually published, or null.
 *
 * Reads only the keys providers already fill from source text: `jobTitle` on
 * a public posting, `role` on a job board or careers page. Nothing here
 * derives a title from an industry, a company size or a category — a role
 * nobody advertised must never appear in a sentence a salesperson reads out.
 */
function statedJobTitleOf(draft: IntentSignalDraft): string | null {
  if (draft.signalCategory !== 'hiring') return null
  const meta = (draft.metadata ?? {}) as Record<string, unknown>
  for (const key of ['jobTitle', 'role']) {
    const value = meta[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * How long a queued or running run is considered in flight. A second request
 * for the same company inside this window is answered with the existing run,
 * and a redelivered job for a run started inside it is ignored.
 */
export const RUN_IN_FLIGHT_MS = 30 * 60_000

/** Whether a delivered job should (re)process this run. */
export function shouldProcessRun(
  run: { status: string; startedAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (run.status === 'completed' || run.status === 'failed') return false
  if (run.status === 'running' && run.startedAt && now.getTime() - run.startedAt.getTime() < RUN_IN_FLIGHT_MS) {
    return false
  }
  return true
}

export async function queueIntentDetection(input: {
  tenantId: string
  crmCompanyId: string
  requestedByCrmUserId: string
  prospectSearchId?: string | null
  /** Set when crmCompanyId is a DiscoveredCompany.id placeholder — see that model. */
  discoveredCompanyId?: string | null
}): Promise<{ id: string }> {
  const id = newId()
  // Recorded whether or not the caller said so: the route passes only an id,
  // and the row must still say which kind of company it names.
  const discoveredCompanyId =
    input.discoveredCompanyId ?? (await discoveredCompanyIdFor(input.tenantId, input.crmCompanyId))
  await prisma.intentDetectionRun.create({
    data: {
      id,
      tenantId: input.tenantId,
      crmCompanyId: input.crmCompanyId,
      prospectSearchId: input.prospectSearchId ?? null,
      discoveredCompanyId,
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
  // A redelivered job must not write the same run twice. A finished run is
  // terminal; a running one inside the in-flight window is still being worked
  // by another delivery. A run stuck in `running` past that window is treated
  // as abandoned by a dead worker and may be picked up again.
  if (!shouldProcessRun(run)) return

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

    // A company found by "Find New Company" is read from the platform's own
    // record; anything else from NXT Sales.
    const resolved = await resolvePipelineCompany(run.tenantId, run.crmCompanyId)
    if (!resolved) {
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
    const { company, discoveredCompanyId } = resolved

    // Providers run independently and in sequence. One failing source must not
    // fail the collection — runProvider converts a throw into an ok:false
    // result, so a dead job board still leaves the CRM signals intact.
    const results: ProviderResult[] = []
    for (const provider of PROVIDERS) {
      const result = await runProvider(provider, {
        tenantId: run.tenantId,
        company,
        maxResults: env.APIFY_MAX_RESULTS_PER_COMPANY,
        isDiscovered: Boolean(discoveredCompanyId),
      })
      results.push(result)
      log.debug({ provider: result.provider, ok: result.ok, signals: result.signals.length }, 'provider finished')
    }

    const drafts = results.flatMap((r) => r.signals)
    const stored = await persistSignals(run.tenantId, runId, drafts, discoveredCompanyId)

    // A run withdraws what it has observed to be false, as well as recording
    // what it found. Applied AFTER persistence so a signal this run produced
    // is never expired by this run's own contradiction.
    const withdrawn = await applySupersessions(
      run.tenantId,
      company.id,
      runId,
      results.flatMap((r) => r.supersedes ?? []),
    )
    if (withdrawn > 0) log.info({ withdrawn }, 'signals superseded by a later observation')

    const costUsd = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)

    await prisma.intentDetectionRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        companyName: company.name,
        // Distinct events this run observed: newly recorded plus already
        // recorded ones it saw again and refreshed in place.
        signalCount: stored.created + stored.refreshed,
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
      summary: `${company.name}: ${stored.created} new signal(s), ${stored.refreshed} already recorded and refreshed, ${stored.collapsed} duplicate(s) collapsed`,
    })

    log.info(
      { created: stored.created, refreshed: stored.refreshed, collapsed: stored.collapsed, costUsd },
      'intent detection completed',
    )
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
 * Withdraws stored signals this run has observed to be false.
 *
 * WHY THIS EXISTS. Signals used only ever to accumulate. Nothing could ever
 * take one back, so a statement about the PRESENT — "the company website could
 * not be reached" — stayed on the screen as active evidence long after it
 * stopped being true.
 *
 * Ultra Taps is the case that forced it. Three runs recorded the site as
 * unreachable while its host was resetting connections; the site recovered,
 * the next run read it in 200ms, and the three stale negatives stayed `active`
 * and still chipped "counts against outreach".
 *
 * WHAT THIS IS NOT. It is not deletion and it is not a cleanup job:
 *
 *   · Only the signal types a provider NAMES are touched. There is no
 *     wildcard, because most signals are historical events — a job posted on
 *     3 August was posted on 3 August — and withdrawing one would be falsifying
 *     the record rather than correcting it.
 *   · Only signals observed BEFORE the contradicting observation are expired.
 *     Anything newer is later information and stands.
 *   · The row survives with its evidence, its date and its source intact. It is
 *     marked `expired` and carries the observation that overtook it, so the
 *     history still shows the site was once unreachable and says when that
 *     stopped being true.
 */
export async function applySupersessions(
  tenantId: string,
  crmCompanyId: string,
  runId: string,
  supersessions: SignalSupersession[],
): Promise<number> {
  let withdrawn = 0

  for (const s of supersessions) {
    const stale = await prisma.intentSignal.findMany({
      where: {
        tenantId,
        crmCompanyId,
        signalType: s.signalType,
        status: { not: 'expired' },
        // Never this run's own output: a run that both reported and withdrew
        // the same fact would be contradicting itself in one breath.
        intentRunId: { not: runId },
        OR: [{ observedAt: { lt: s.observedBefore } }, { observedAt: null }],
      },
      select: { id: true, metadata: true },
    })

    for (const row of stale) {
      if (s.appliesTo && !s.appliesTo(row.metadata)) continue
      await prisma.intentSignal.update({
        where: { id: row.id },
        data: {
          status: 'expired',
          metadata: {
            ...((row.metadata as Record<string, unknown> | null) ?? {}),
            supersededBy: { runId, at: new Date().toISOString(), reason: s.reason },
          } as never,
        },
      })
      withdrawn++
    }
  }

  return withdrawn
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
export async function persistSignals(
  tenantId: string,
  runId: string,
  drafts: IntentSignalDraft[],
  discoveredCompanyId?: string | null,
): Promise<{ created: number; refreshed: number; collapsed: number }> {
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

  // ── Across runs: the same event already on record is REFRESHED, not copied.
  //
  // There is no unique index on the fingerprint (and adding one would need a
  // migration over rows that already repeat), so the check is made here: one
  // read of every stored row carrying a fingerprint this run produced. A row a
  // later observation WITHDREW is not refreshed — if the fact has become true
  // again, that is a new observation and gets its own row, so the history of
  // the withdrawal stays intact.
  const fingerprints = [...byFingerprint.keys()]
  const stored = fingerprints.length
    ? await prisma.intentSignal.findMany({
        where: { tenantId, eventFingerprint: { in: fingerprints } },
        orderBy: { detectedAt: 'desc' },
        select: { id: true, crmCompanyId: true, eventFingerprint: true, intentRunId: true, metadata: true, detectedAt: true },
      })
    : []
  const standing = new Map<string, (typeof stored)[number]>()
  for (const row of stored) {
    const meta = (row.metadata as Record<string, unknown> | null) ?? {}
    if (meta.supersededBy) continue
    const key = `${row.crmCompanyId}|${row.eventFingerprint}`
    // Newest first, so the first standing row per event is the one refreshed.
    if (!standing.has(key)) standing.set(key, row)
  }

  let created = 0
  let refreshed = 0
  const nowIso = new Date().toISOString()
  for (const [fingerprint, entry] of byFingerprint) {
    const { draft, confidence, reasons, corroboration } = entry
    const { freshness, ageDays } = scoreFreshness(draft.observedAt)
    const existing = standing.get(`${draft.crmCompanyId}|${fingerprint}`)

    const fields = {
      intentRunId: runId,
      signalType: draft.signalType,
      signalCategory: draft.signalCategory,
      summary: draft.summary,
      interpretation: draft.interpretation,
      outreachAngle: angleFor(draft),
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
    }

    if (existing) {
      const prior = (existing.metadata as Record<string, unknown> | null) ?? {}
      const seenCount = typeof prior.seenCount === 'number' ? prior.seenCount : 1
      await prisma.intentSignal.update({
        where: { id: existing.id },
        data: {
          ...fields,
          metadata: {
            ...(draft.metadata ?? {}),
            firstRunId: typeof prior.firstRunId === 'string' ? prior.firstRunId : existing.intentRunId,
            firstDetectedAt:
              typeof prior.firstDetectedAt === 'string' ? prior.firstDetectedAt : existing.detectedAt.toISOString(),
            lastSeenAt: nowIso,
            lastRunId: runId,
            seenCount: seenCount + 1,
          } as never,
        },
      })
      refreshed++
      continue
    }

    await prisma.intentSignal.create({
      data: {
        id: newId(),
        tenantId,
        crmCompanyId: draft.crmCompanyId,
        discoveredCompanyId: discoveredCompanyId ?? null,
        eventFingerprint: fingerprint,
        ...fields,
        metadata: { ...(draft.metadata ?? {}), lastSeenAt: nowIso, lastRunId: runId, seenCount: 1 } as never,
      },
    })
    created++
  }

  return { created, refreshed, collapsed }
}

/**
 * The outreach angle for a draft, APPLIED HERE, BY THE ENGINE, FOR EVERY
 * PROVIDER.
 *
 * Same reason confidence and freshness are computed here: it is a uniform
 * rule, and a rule each provider applied for itself is a rule each provider
 * could flatter. A provider MAY supply its own — the public research one does,
 * because it holds the advertised job title verbatim — but never on a negative
 * or neutral signal, and never on a presence/description observation: those
 * are reasons not to approach, or context, not openings.
 */
export function angleFor(draft: IntentSignalDraft): string | null {
  const gate = outreachAngleFor({
    category: draft.signalCategory,
    statedJobTitle: statedJobTitleOf(draft),
    polarity: draft.polarity,
    signalType: draft.signalType,
  })
  if (gate === null) return null
  return draft.outreachAngle ?? gate
}

