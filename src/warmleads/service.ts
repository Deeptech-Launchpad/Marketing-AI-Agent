import { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { crmWarmLeadsPut } from '../crm/nxtSales/httpClient.js'
import type { CrmCompany } from '../crm/types.js'
import { queueCompanyEnrichment, runCompanyEnrichment } from '../enrichment/companyEnrichment.js'
import { queueIntentDetection, runIntentDetection } from '../intent/intentDetection.js'
import { CrmSignalProvider } from '../intent/providers/crmProvider.js'
import { runProvider } from '../intent/providers/provider.js'
import { presentSignals } from '../intent/signalView.js'
import type { IntentSignalDraft } from '../intent/types.js'
import { audit } from '../platform/audit.js'
import { newId, prisma } from '../platform/db.js'
import { ConflictError, NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { buildSample, SAMPLE_SIZE, type SampleResult } from './sample.js'
import { geminiCallStats, geminiCeilingExhausted } from '../llm/gemini/callCeiling.js'
import { accessFailureReason, classify, COMPANY_LEVEL_REFUSALS, needsDeepCheck, retryReason, ruledOutByCrm, type DeepCheck, type EvaluationResult, type ObservedSignal, type Reason, type WebsiteObservation } from './score.js'
import { candidateAddresses, optOutSignals, persistedOptOuts, proposeOptOuts, signalsToReasons, type OptOutProposal } from './optOut.js'
import { engagementSignal, summariseInbound } from './replies.js'
import { assertNxtSendable, runSummaryPayload } from './runSummary.js'
import { interpretWebsiteFailure, looksLikeBlockPage, looksLikePlaceholderSite, looksLikeStubPage, researchUnreadable } from './websiteAccess.js'

// WARM LEADS (2026-10-30).
//
// Evaluates NXT Sales companies as warm / cold / not enough data with the
// evidence this platform already collects, and writes each result to NXT
// Sales (Companies → Warm Leads). Read-only towards companies: nothing here
// sends an email, starts a campaign, or changes a company record.
//
// For each company, in order:
//   1. the CRM read            — Intent Signals' CRM provider: deals, replies, do-not-contact
//   2. the website             — Stage 2 enrichment: one fetch of the site on record
//   3. web research, only when — Intent Signals with every provider (Gemini + search,
//      1+2 flag the company      the only paid step), at most WARM_LEADS_DEEP_MAX_PER_RUN per run
//   4. the rule in score.ts, which keeps every reason it counted
//
// Rollout, enforced here and not only on the screen:
//   test  — a fixed-seed representative sample of SAMPLE_SIZE companies
//           (sample.ts); nothing else can start until it is approved
//   batch — the next N not yet evaluated, only after a test run was approved
//   retry — companies whose last evaluation failed or could not finish

export const TEST_SIZE = SAMPLE_SIZE
/** A company in `running` longer than this was abandoned by a stopped worker (web research can take ~30 min). */
export const EVALUATION_IN_FLIGHT_MS = 40 * 60_000
/** The job may run the web research inline, which takes up to 30 minutes. */
export const WARM_LEAD_JOB_EXPIRE_SECONDS = 45 * 60
const PAGE = 100
const COMMERCE_CATEGORIES = new Set(['ecommerce', 'pim'])

type Kind = 'test' | 'batch' | 'retry'

const log = logger.child({ module: 'warmleads' })

function contactOf(c: CrmCompany) {
  return {
    email: c.email ?? null,
    emails: c.emails.slice(0, 5),
    phone: c.phone ?? null,
    contactPersons: c.contactPersons.slice(0, 5),
  }
}

/** Fails evaluations stranded in `running` by a worker that stopped. */
export async function failStaleEvaluations(tenantId: string, now = new Date()): Promise<number> {
  const stale = await prisma.warmLeadEvaluation.findMany({
    where: { tenantId, status: 'running', startedAt: { lt: new Date(now.getTime() - EVALUATION_IN_FLIGHT_MS) } },
    select: { id: true, runId: true },
  })
  for (const e of stale) {
    await prisma.warmLeadEvaluation.update({
      where: { id: e.id },
      data: { status: 'failed', error: 'The evaluation did not finish within 40 minutes (the worker probably stopped). Retry it.', evaluatedAt: now },
    })
  }
  for (const runId of new Set(stale.map((e) => e.runId))) await finishRunIfDone(runId)
  return stale.length
}

/**
 * CRM ids that already have an evaluation that finished, failed or is under way
 * - never picked again for a batch. A failed one is taken again only by a
 * retry, so a batch cannot keep returning to the same unreadable companies.
 */
async function handledIds(tenantId: string): Promise<Set<string>> {
  const rows = await prisma.warmLeadEvaluation.findMany({
    where: { tenantId, status: { in: ['queued', 'running', 'done', 'failed'] } },
    select: { crmCompanyId: true },
    distinct: ['crmCompanyId'],
  })
  return new Set(rows.map((r) => r.crmCompanyId))
}

/**
 * The next `n` companies, in NXT Sales' own default list order (pinned first,
 * then newest), that have not been evaluated yet. Recycle-binned companies are
 * never listed by NXT Sales, so they are never picked.
 */
export async function nextCompanies(tenantId: string, n: number): Promise<CrmCompany[]> {
  const skip = await handledIds(tenantId)
  const picked: CrmCompany[] = []
  const crm = getCrm()
  for (let page = 1; picked.length < n; page++) {
    const res = await crm.searchCompanies({ page, limit: PAGE })
    for (const c of res.items) {
      if (!skip.has(c.id) && c.name?.trim()) picked.push(c)
      if (picked.length >= n) break
    }
    if (res.items.length < PAGE || page * PAGE >= res.total) break
  }
  return picked
}

async function latestTest(tenantId: string) {
  return prisma.warmLeadRun.findFirst({ where: { tenantId, kind: 'test' }, orderBy: { createdAt: 'desc' } })
}

/**
 * Starts a run. Refuses while another run is under way, refuses a batch until a
 * test run has been approved, and caps every batch at WARM_LEADS_MAX_BATCH.
 */
export async function startRun(input: {
  tenantId: string
  kind: Kind
  size?: number
  requestedBy: string
  enqueueJob: (evaluationId: string) => Promise<unknown>
  /** A test sample the caller already built (and showed): used as it is, so the CRM is not read a second time. */
  prebuilt?: Awaited<ReturnType<typeof buildSample>>
}): Promise<{ runId: string; total: number }> {
  const { tenantId, kind } = input
  await failStaleEvaluations(tenantId)

  const active = await prisma.warmLeadRun.findFirst({ where: { tenantId, status: { in: ['queued', 'running'] } }, select: { id: true, kind: true } })
  if (active) throw new ConflictError(`A ${active.kind} run is still in progress. Wait for it to finish.`)

  const test = await latestTest(tenantId)
  const approved = Boolean(test?.approvedAt)
  let companies: CrmCompany[] = []
  let sample: Prisma.InputJsonValue | undefined

  if (kind === 'test') {
    if (approved) throw new ConflictError('The test was already approved. Run the next batch instead.')
    if (test) {
      // A repeated test evaluates the SAME companies again, so the results can be compared.
      const ids = (test.companyIds as string[]) ?? []
      for (const id of ids) {
        const c = await getCrm().getCompany(id)
        if (c) companies.push(c)
      }
      if (test.sample) sample = test.sample as Prisma.InputJsonValue
    } else {
      // The representative sample (sample.ts): the same for this seed and CRM data.
      const built = input.prebuilt ?? (await buildSample({ seed: env.WARM_LEADS_SAMPLE_SEED }))
      companies = built.sample.picks.map((p) => built.companies.get(p.id)).filter((c): c is CrmCompany => Boolean(c))
      sample = built.sample as unknown as Prisma.InputJsonValue
    }
  } else if (kind === 'batch') {
    if (!approved) throw new ConflictError('The 10-company test has not been approved. Review and approve it first; nothing else is evaluated before that.')
    const size = Math.min(Math.max(1, Math.floor(input.size ?? env.WARM_LEADS_MAX_BATCH)), env.WARM_LEADS_MAX_BATCH)
    companies = await nextCompanies(tenantId, size)
  } else {
    // Retry: each company whose LATEST evaluation failed, or could not finish its web research.
    const rows = await prisma.warmLeadEvaluation.findMany({
      where: { tenantId, status: { in: ['done', 'failed'] } },
      orderBy: { createdAt: 'desc' },
      select: { crmCompanyId: true, status: true, deepCheck: true, runId: true },
    })
    const latest = new Map<string, (typeof rows)[number]>()
    for (const r of rows) if (!latest.has(r.crmCompanyId)) latest.set(r.crmCompanyId, r)
    const testIds = new Set((test?.companyIds as string[] | undefined) ?? [])
    const ids = [...latest.values()]
      .filter((r) => r.status === 'failed' || r.deepCheck === 'skipped_cap' || r.deepCheck === 'skipped_ceiling' || r.deepCheck === 'failed')
      .map((r) => r.crmCompanyId)
      // Before the approval, only the test's own companies may be retried.
      .filter((id) => approved || testIds.has(id))
      .slice(0, env.WARM_LEADS_MAX_BATCH)
    for (const id of ids) {
      const c = await getCrm().getCompany(id)
      if (c) companies.push(c)
    }
  }

  if (!companies.length) throw new ConflictError(kind === 'retry' ? 'Nothing to retry.' : 'No company is left to evaluate.')

  const runId = newId()
  await prisma.warmLeadRun.create({
    data: {
      id: runId,
      tenantId,
      kind,
      status: 'queued',
      requestedBy: input.requestedBy,
      companyIds: companies.map((c) => c.id),
      ...(sample ? { sample } : {}),
      total: companies.length,
      deepCheckCap: env.WARM_LEADS_DEEP_MAX_PER_RUN,
      evaluations: {
        create: companies.map((c) => ({
          id: newId(),
          tenantId,
          crmCompanyId: c.id,
          companyName: c.name,
          website: c.domain ?? c.endPdpUrl ?? null,
          contact: contactOf(c) as Prisma.InputJsonValue,
        })),
      },
    },
  })

  const evaluations = await prisma.warmLeadEvaluation.findMany({ where: { runId }, select: { id: true }, orderBy: { createdAt: 'asc' } })
  for (const e of evaluations) {
    try {
      await input.enqueueJob(e.id)
    } catch (err) {
      await prisma.warmLeadEvaluation.update({
        where: { id: e.id },
        data: { status: 'failed', error: `The job could not be queued: ${(err as Error).message}. Retry it.`, evaluatedAt: new Date() },
      })
    }
  }

  await audit({
    tenantId,
    actorType: 'user',
    actorCrmUserId: input.requestedBy,
    action: 'warmleads.run_started',
    resourceType: 'WarmLeadRun',
    resourceId: runId,
    summary: `Warm-lead ${kind} run started for ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}.`,
  })
  await finishRunIfDone(runId)
  await syncRun(runId)
  return { runId, total: companies.length }
}

/** The sample the test would use - read-only, nothing is started or stored. */
export async function previewSample(tenantId: string): Promise<{ sample: SampleResult; locked: boolean }> {
  const test = await latestTest(tenantId)
  // After a test exists its companies are fixed; show those, not a fresh draw.
  if (test?.sample) return { sample: test.sample as unknown as SampleResult, locked: true }
  const built = await buildSample({ seed: env.WARM_LEADS_SAMPLE_SEED })
  return { sample: built.sample, locked: false }
}

/** Approves a finished test run. Only then may batches start. */
export async function approveTest(tenantId: string, runId: string, approvedBy: string) {
  const run = await prisma.warmLeadRun.findFirst({ where: { id: runId, tenantId } })
  if (!run) throw new NotFoundError('Run not found.')
  if (run.kind !== 'test') throw new ConflictError('Only a test run is approved.')
  if (run.status !== 'completed') throw new ConflictError('The test has not finished yet.')
  if (run.approvedAt) return run
  const updated = await prisma.warmLeadRun.update({ where: { id: runId }, data: { approvedAt: new Date(), approvedBy } })
  await audit({
    tenantId,
    actorType: 'user',
    actorCrmUserId: approvedBy,
    action: 'warmleads.test_approved',
    resourceType: 'WarmLeadRun',
    resourceId: runId,
    summary: 'Warm-lead test results approved; batches may now be started.',
  })
  await syncRun(runId)
  return updated
}

// ── One company ─────────────────────────────────────────────────────────────

const crmObserved = (d: IntentSignalDraft): ObservedSignal => ({
  signalType: d.signalType,
  signalCategory: d.signalCategory,
  polarity: d.polarity,
  confidence: 'high',
  freshness: 'unknown',
  status: 'active',
  summary: d.summary,
  evidence: d.evidence,
  sourceUrl: d.sourceUrl,
  observedAt: d.observedAt,
})

async function readWebsite(tenantId: string, company: CrmCompany, requestedBy: string): Promise<{ website: WebsiteObservation; enrichmentId: string }> {
  const { id } = await queueCompanyEnrichment({ tenantId, crmCompanyId: company.id, requestedByCrmUserId: requestedBy })
  await runCompanyEnrichment(id)
  const row = await prisma.companyEnrichment.findUnique({ where: { id } })
  const signals = (row?.signals ?? {}) as { finalUrl?: unknown; hasProductSchema?: unknown; pageTitle?: unknown; metaDescription?: unknown }
  const techs = ((row?.technologies ?? []) as Array<{ name?: string; category?: string }>) ?? []
  const url = (typeof signals.finalUrl === 'string' && /^https?:/i.test(signals.finalUrl) ? signals.finalUrl : row?.sourceUrl) ?? null
  const base = {
    url,
    hasProductSchema: signals.hasProductSchema === true,
    commercePlatforms: [...new Set(techs.filter((t) => t.category && COMMERCE_CATEGORIES.has(t.category)).map((t) => String(t.name)))],
  }

  let status: WebsiteObservation['status']
  let failureReason: string | null = row?.failureReason ?? null
  switch (row?.status) {
    case 'enriched': {
      // A page that loaded can still be a firewall's or a bot wall's, not the company's own.
      const title = typeof signals.pageTitle === 'string' ? signals.pageTitle : null
      const meta = typeof signals.metaDescription === 'string' ? signals.metaDescription : null
      if (looksLikeBlockPage(title, meta)) {
        status = 'access_failed'
        failureReason = `The website could not be read: a security or firewall block page was returned (page title "${(title ?? meta ?? '').slice(0, 80)}"). This says nothing about the company; retry from a network that can open the site.`
      } else if (looksLikePlaceholderSite(title, meta)) {
        // The site itself says there is nothing there (suspended, parked, 404): a fact about the site, not the network.
        status = 'unreachable'
        failureReason = `The website shows a hosting placeholder page (page title "${(title ?? meta ?? '').slice(0, 60)}"), not the company's own site.`
      } else if (looksLikeStubPage(title)) {
        status = 'access_failed'
        failureReason = `The website could not be read: only a placeholder page was returned (page title "${(title ?? '').slice(0, 60)}"), not the company's own page. This says nothing about the company; retry from a network that can open the site.`
      } else status = 'reachable'
      break
    }
    case 'no_website':
      status = 'no_website'
      break
    case 'partial':
      status = 'partial'
      break
    case 'unreachable': {
      const f = interpretWebsiteFailure(row.failureReason)
      status = f.retryable ? 'access_failed' : 'unreachable'
      failureReason = f.message
      break
    }
    default:
      // The enrichment job itself failed (no row, or status 'failed'): nothing was learned, so it is retried, never classified.
      status = 'access_failed'
      failureReason = `The website read did not complete${row?.failureReason ? ` (${row.failureReason})` : ''}. Retry.`
  }
  return { enrichmentId: id, website: { ...base, status, failureReason } }
}

async function webResearch(tenantId: string, companyId: string, requestedBy: string): Promise<{ status: DeepCheck; signals: ObservedSignal[]; intentRunId: string; costUsd: number; reason: string | null }> {
  const { id } = await queueIntentDetection({ tenantId, crmCompanyId: companyId, requestedByCrmUserId: requestedBy })
  const before = geminiCallStats()
  await runIntentDetection(id)
  // If the call ceiling refused any call during this research, the research is incomplete — never "nothing found".
  const after = geminiCallStats()
  const cutShort = after.blocked > before.blocked
  // Gemini itself failed (a rejected key, Google's quota, an outage) and the providers carried on with "nothing found": the
  // research was NOT done, and a company must never be called cold because the question could not be asked.
  const geminiFailed = after.failed > before.failed
  const run = await prisma.intentDetectionRun.findUnique({ where: { id }, select: { status: true, failureReason: true, costUsd: true, providerResults: true } })
  const stored = await prisma.intentSignal.findMany({ where: { tenantId, crmCompanyId: companyId }, orderBy: { detectedAt: 'desc' }, take: 300 })
  const signals = presentSignals(stored).map(
    (s): ObservedSignal => ({
      signalType: s.signalType,
      signalCategory: s.signalCategory,
      polarity: s.polarity,
      confidence: s.confidence,
      freshness: s.freshness,
      status: s.status,
      summary: s.summary,
      evidence: s.evidence,
      sourceUrl: s.sourceUrl,
      observedAt: s.observedAt,
    }),
  )
  const ok = run?.status === 'completed'
  // A run that "completed" after being unable to read a single page it found has found nothing because it read nothing.
  const unreadable = ok ? researchUnreadable(run?.providerResults) : null
  const usable = ok && !unreadable
  if (cutShort) {
    // What was found before the ceiling still stands; the missing part is what makes it incomplete.
    return { status: 'skipped_ceiling', signals: ok ? signals : [], intentRunId: id, costUsd: Number(run?.costUsd ?? 0), reason: 'The Gemini call limit was reached during this research.' }
  }
  if (geminiFailed) {
    return { status: 'failed', signals: [], intentRunId: id, costUsd: Number(run?.costUsd ?? 0), reason: `Gemini returned an error during this research (${after.lastFailure ?? 'no detail'}), so it was not completed.` }
  }
  return { status: usable ? 'done' : 'failed', signals: usable ? signals : [], intentRunId: id, costUsd: Number(run?.costUsd ?? 0), reason: usable ? null : unreadable ?? run?.failureReason ?? 'The web research did not complete.' }
}

/** Reserves one web-research slot of the run; false when the run's cap is used up. */
async function reserveDeepCheck(runId: string): Promise<boolean> {
  const n = await prisma.$executeRaw`UPDATE "WarmLeadRun" SET "deepChecks" = "deepChecks" + 1, "updatedAt" = NOW() WHERE "id" = ${runId} AND "deepChecks" < "deepCheckCap"`
  return n === 1
}

/** The caller's decision on the paid web research, made only after the cheap screen flagged the company. */
export type DeepGate = () => Promise<{ allowed: true } | { allowed: false; reason: 'cap' | 'ceiling' }>

/** Everything one evaluation found, before anything is stored. */
export interface ComputedEvaluation {
  company: CrmCompany | null
  /** screen = CRM + website only; deep = the Gemini web research ran as well. */
  tier: 'screen' | 'deep'
  website: WebsiteObservation | null
  deep: DeepCheck
  enrichmentId: string | null
  intentRunId: string | null
  costUsd: number
  /** Set when the company could not be evaluated and must be retried; nothing was classified. */
  failure: { message: string; reasons: Reason[] } | null
  /** Set otherwise. */
  result: EvaluationResult | null
  /** The newest reply asked not to be contacted or said no (read in the CRM step, so known even when the evaluation could not finish). */
  refusal: boolean
  /** Opt-out addresses to add to the suppression list - only ever filled when WARM_LEADS_RECORD_OPT_OUTS is on. Written by recordOutcome. */
  optOuts: OptOutProposal[]
  /** The opt-out evidence (masked addresses, NXT activity ids, dates, status) as stored reasons - kept on a FAILED evaluation too, where no reasons are otherwise stored. */
  optOutReasons: Reason[]
}

/**
 * Evaluates ONE company: the cheap screen first (CRM read, then the website), then the paid web
 * research only if the screen flagged it AND `deepGate` allows it. Never throws and writes no
 * evaluation row: the caller stores the outcome. Sends no email and changes nothing in the CRM.
 */
export async function computeEvaluation(input: { tenantId: string; crmCompanyId: string; requestedBy: string; deepGate: DeepGate; allowOptOutWrites?: boolean }): Promise<ComputedEvaluation> {
  const blank: ComputedEvaluation = { company: null, tier: 'screen', website: null, deep: 'not_needed', enrichmentId: null, intentRunId: null, costUsd: 0, failure: null, result: null, refusal: false, optOuts: [], optOutReasons: [] }
  let state = blank
  try {
    const company = await getCrm().getCompany(input.crmCompanyId)
    if (!company) throw new Error('Company not found in NXT Sales (it may have been moved to the Recycle Bin).')
    state = { ...blank, company }

    // 1. CRM: deals, replies, do-not-contact. A failed read is not "nothing found".
    const crmResult = await runProvider(new CrmSignalProvider(), { tenantId: input.tenantId, company, maxResults: 0 })
    if (!crmResult.ok) throw new Error(`NXT Sales could not be read for this company: ${crmResult.reason ?? 'a CRM call failed'}. Retry it.`)
    // Replies come from the emails themselves: a bounce or an auto-reply is inbound mail but not a reply, so the
    // provider's own engagement signal (which counts any inbound message) is replaced by one that does not.
    let activities
    try {
      // The same read as always; `withBody` keeps each email's text (already in the response) so a refusal written inside a reply
      // can be told from interest. The text is used in memory only and is not stored, logged or copied into a result.
      activities = await getCrm().listActivities({ companyId: company.id, type: 'email', withBody: true })
    } catch (err) {
      throw new Error(`The emails of this company could not be read from NXT Sales (${(err as Error).message}). Retry it.`)
    }
    // requireText: a reply whose text is not available is "unverified" - listed, scored 0, never taken as interest.
    const engagement = engagementSignal(activities, new Date(), undefined, env.INTENT_FRESH_DAYS, { requireText: true })
    // Marketing permission is separate from buying intent: an explicit opt-out (in a reply, or already on the suppression list) stays in
    // force whatever a later message says. With WARM_LEADS_RECORD_OPT_OUTS off (the default) the address is only PROPOSED - nothing is written.
    const record = env.WARM_LEADS_RECORD_OPT_OUTS && input.allowOptOutWrites !== false
    const { assessed } = summariseInbound(activities, new Date(), undefined, true)
    const decision = proposeOptOuts(assessed, record)
    // the refusal in the replies is known BEFORE the suppression list is read: if that read fails, the evaluation fails with the refusal still on record
    state = { ...state, refusal: engagement ? COMPANY_LEVEL_REFUSALS.has(engagement.signalType) : false }
    const persisted = await persistedOptOuts(input.tenantId, candidateAddresses(company, activities))
    const permission = optOutSignals({ assessed, decision, persisted, record })
    state = {
      ...state,
      refusal: state.refusal || permission.some((s) => COMPANY_LEVEL_REFUSALS.has(s.signalType)),
      optOuts: record ? decision.proposals : [],
      optOutReasons: signalsToReasons(permission),
    }
    const crm = {
      ok: true,
      signals: [...crmResult.signals.filter((d) => d.signalType !== 'inbound_engagement' && d.signalType !== 'recent_outbound_only').map(crmObserved), ...(engagement ? [engagement] : []), ...permission],
    }

    // 2. The website on record — unless the CRM already rules the company out (an existing customer, an open
    // deal, do-not-contact): it will not be approached, so its site is not read and nothing is spent on it.
    const ruledOut = ruledOutByCrm(crm.signals)
    const read = ruledOut
      ? { website: { status: 'not_checked', url: company.domain ?? null, hasProductSchema: false, commercePlatforms: [] } as WebsiteObservation, enrichmentId: null as string | null }
      : await readWebsite(input.tenantId, company, input.requestedBy)
    const { website, enrichmentId } = read
    state = { ...state, website, enrichmentId }

    // 3. Web research, only when the screen flagged the company, and only if the caller's gate allows it.
    let deep: { status: DeepCheck; signals: ObservedSignal[]; reason: string | null } = { status: 'not_needed', signals: [], reason: null }
    let intentRunId: string | null = null
    let costUsd = 0
    if (needsDeepCheck(crm, website)) {
      const gate = await input.deepGate()
      if (gate.allowed) {
        const r = await webResearch(input.tenantId, company.id, input.requestedBy)
        deep = { status: r.status, signals: r.signals, reason: r.reason }
        intentRunId = r.intentRunId
        costUsd = r.costUsd
      } else {
        deep = { status: gate.reason === 'ceiling' ? 'skipped_ceiling' : 'skipped_cap', signals: [], reason: null }
      }
    }
    state = { ...state, deep: deep.status, intentRunId, costUsd, tier: deep.status === 'not_needed' ? 'screen' : 'deep' }

    // 4. A website or web research that could not be READ is a failure to retry - never "not enough data" or "cold".
    const retry = retryReason({ crm, website, deep })
    if (retry) return { ...state, failure: { message: retry.slice(0, 1000), reasons: [accessFailureReason(website, retry), ...state.optOutReasons] } }

    // 5. The rule.
    return { ...state, result: classify({ crm, website, deep }) }
  } catch (err) {
    return { ...state, failure: { message: ((err as Error).message ?? String(err)).slice(0, 1000), reasons: state.optOutReasons } }
  }
}

/** Queue handler for one company of a legacy run. Never throws: failures are recorded on the row. */
export async function evaluateCompany(evaluationId: string): Promise<void> {
  const ev = await prisma.warmLeadEvaluation.findUnique({ where: { id: evaluationId }, include: { run: true } })
  if (!ev) return
  if (ev.status === 'done' || ev.status === 'failed') return
  if (ev.status === 'running' && ev.startedAt && Date.now() - ev.startedAt.getTime() < EVALUATION_IN_FLIGHT_MS) return

  const elog = log.child({ evaluationId, crmCompanyId: ev.crmCompanyId })
  const now = new Date()
  await prisma.warmLeadEvaluation.update({ where: { id: evaluationId }, data: { status: 'running', startedAt: now, attempts: { increment: 1 }, error: null } })
  if (ev.run.status === 'queued') {
    await prisma.warmLeadRun.update({ where: { id: ev.runId }, data: { status: 'running', startedAt: now } })
    await syncRun(ev.runId)
  }

  const c = await computeEvaluation({
    tenantId: ev.tenantId,
    crmCompanyId: ev.crmCompanyId,
    requestedBy: ev.run.requestedBy,
    allowOptOutWrites: false, // this legacy path stores no opt-out: it must not claim one was added
    deepGate: async () => {
      if (geminiCeilingExhausted()) return { allowed: false, reason: 'ceiling' } // no call can be made: not started, and no company slot is spent on it
      return (await reserveDeepCheck(ev.runId)) ? { allowed: true } : { allowed: false, reason: 'cap' }
    },
  })

  const common = {
    companyName: c.company?.name,
    website: c.website?.url ?? c.company?.domain ?? null,
    ...(c.company ? { contact: contactOf(c.company) as Prisma.InputJsonValue } : {}),
    deepCheck: c.deep,
    enrichmentId: c.enrichmentId,
    intentRunId: c.intentRunId,
    costUsd: new Prisma.Decimal(c.costUsd),
    tier: c.tier,
    evaluatedAt: new Date(),
  }
  if (c.failure || !c.result) {
    await prisma.warmLeadEvaluation
      .update({
        where: { id: evaluationId },
        data: { ...common, status: 'failed', reasons: c.failure?.reasons.length ? (c.failure.reasons as unknown as Prisma.InputJsonValue) : undefined, error: c.failure?.message ?? 'The evaluation produced no result.' },
      })
      .catch(() => undefined)
    elog.info({ failure: c.failure?.message }, 'warm-lead evaluation failed; marked to retry')
  } else {
    await prisma.warmLeadEvaluation.update({
      where: { id: evaluationId },
      data: {
        ...common,
        status: 'done',
        classification: c.result.classification,
        score: c.result.score,
        confidence: c.result.confidence,
        summary: c.result.summary,
        reasons: c.result.reasons as unknown as Prisma.InputJsonValue,
        researchIncomplete: c.deep === 'skipped_cap' || c.deep === 'skipped_ceiling',
      },
    })
    elog.info({ classification: c.result.classification, score: c.result.score, deepCheck: c.deep }, 'warm-lead evaluation done')
  }
  if (c.costUsd) await prisma.warmLeadRun.update({ where: { id: ev.runId }, data: { costUsd: { increment: new Prisma.Decimal(c.costUsd) } } })

  await syncEvaluation(evaluationId)
  await finishRunIfDone(ev.runId)
}

/** Closes a run when none of its companies is still queued or running. */
export async function finishRunIfDone(runId: string): Promise<void> {
  const open = await prisma.warmLeadEvaluation.count({ where: { runId, status: { in: ['queued', 'running'] } } })
  if (open) return
  const r = await prisma.warmLeadRun.updateMany({
    where: { id: runId, status: { in: ['queued', 'running'] } },
    data: { status: 'completed', finishedAt: new Date() },
  })
  if (r.count) await syncRun(runId)
}

// ── NXT Sales ───────────────────────────────────────────────────────────────

export async function syncEvaluation(evaluationId: string): Promise<void> {
  const e = await prisma.warmLeadEvaluation.findUnique({ where: { id: evaluationId } })
  if (!e || (e.status !== 'done' && e.status !== 'failed')) return
  // HELD FOR A PERSON: a company that would be Warm / Early Signal but whose newest reply refused is not an actionable lead, so nothing
  // about it is sent to NXT Sales (it stays "not sent" here, and a company already listed is withdrawn by syncPending).
  if (e.status === 'done' && e.classification === 'human_review') return
  try {
    assertNxtSendable(e.status === 'done' ? (e.classification ?? '(none)') : null)
    await crmWarmLeadsPut(`/companies/${encodeURIComponent(e.crmCompanyId)}`, {
      runId: e.runId,
      evaluationId: e.id,
      classification: e.status === 'done' ? e.classification : null,
      evaluationStatus: e.status === 'done' ? 'evaluated' : 'failed',
      score: e.score,
      confidence: e.confidence,
      summary: e.summary,
      reasons: e.reasons ?? [],
      deepCheck: e.deepCheck,
      error: e.error,
      evaluatedAt: (e.evaluatedAt ?? new Date()).toISOString(),
    })
    await prisma.warmLeadEvaluation.update({ where: { id: evaluationId }, data: { crmSyncedAt: new Date(), crmSyncError: null } })
  } catch (err) {
    await prisma.warmLeadEvaluation.update({ where: { id: evaluationId }, data: { crmSyncError: (err as Error).message.slice(0, 500) } }).catch(() => undefined)
  }
}

/** The counters every view shows. Each classification has exactly one, so nothing can be silently filed under another. */
export interface Counts {
  processed: number
  warm: number
  earlySignal: number
  cold: number
  insufficient: number
  existingCustomer: number
  activeOpportunity: number
  doNotContact: number
  /** Would be Warm / Early Signal but the newest reply refused: held for a person. Not sent to NXT Sales (its run summary has no such field). */
  humanReview: number
  failed: number
  queued: number
  running: number
}
const COUNTER: Record<string, 'warm' | 'earlySignal' | 'cold' | 'insufficient' | 'existingCustomer' | 'activeOpportunity' | 'doNotContact' | 'humanReview'> = {
  warm: 'warm',
  early_signal: 'earlySignal',
  cold: 'cold',
  insufficient_data: 'insufficient',
  existing_customer: 'existingCustomer',
  active_opportunity: 'activeOpportunity',
  do_not_contact: 'doNotContact',
  human_review: 'humanReview',
}
const emptyCounts = (): Counts => ({ processed: 0, warm: 0, earlySignal: 0, cold: 0, insufficient: 0, existingCustomer: 0, activeOpportunity: 0, doNotContact: 0, humanReview: 0, failed: 0, queued: 0, running: 0 })

export async function runCounts(runId: string): Promise<Counts> {
  const rows = await prisma.warmLeadEvaluation.groupBy({ by: ['status', 'classification'], where: { runId }, _count: { _all: true } })
  const c = emptyCounts()
  for (const r of rows) {
    const n = r._count._all
    if (r.status === 'queued') c.queued += n
    else if (r.status === 'running') c.running += n
    else if (r.status === 'failed') {
      c.failed += n
      c.processed += n
    } else {
      c.processed += n
      const key = COUNTER[r.classification ?? '']
      if (key) c[key] += n
      else c.failed += n // a classification this code does not know is a defect, shown as failed rather than counted as something it is not
    }
  }
  return c
}

async function syncRun(runId: string): Promise<void> {
  const run = await prisma.warmLeadRun.findUnique({ where: { id: runId } })
  if (!run) return
  const c = await runCounts(runId)
  try {
    await crmWarmLeadsPut(`/runs/${encodeURIComponent(runId)}`, runSummaryPayload(run, c))
  } catch (err) {
    log.warn({ runId, message: (err as Error).message }, 'warm-lead run summary not sent to NXT Sales')
  }
}

/** Re-sends results NXT Sales has not acknowledged (e.g. it was down, or syncing was switched on later). */
export async function resyncPending(tenantId: string, max = 200): Promise<{ attempted: number; synced: number }> {
  const rows = await prisma.warmLeadEvaluation.findMany({
    where: { tenantId, status: { in: ['done', 'failed'] }, crmSyncedAt: null, OR: [{ classification: null }, { classification: { not: 'human_review' } }] },
    orderBy: { evaluatedAt: 'asc' },
    take: max,
    select: { id: true },
  })
  for (const r of rows) await syncEvaluation(r.id)
  const runs = await prisma.warmLeadRun.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true } })
  for (const r of runs) await syncRun(r.id)
  const synced = await prisma.warmLeadEvaluation.count({ where: { id: { in: rows.map((r) => r.id) }, crmSyncedAt: { not: null } } })
  return { attempted: rows.length, synced }
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function overview(tenantId: string) {
  await failStaleEvaluations(tenantId)
  const runs = await prisma.warmLeadRun.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 20 })
  const withCounts = await Promise.all(runs.map(async (r) => ({ ...r, costUsd: Number(r.costUsd), counts: await runCounts(r.id) })))

  // The latest result of every company evaluated so far.
  const rows = await prisma.warmLeadEvaluation.findMany({
    where: { tenantId, status: { in: ['done', 'failed'] } },
    orderBy: { createdAt: 'desc' },
    select: { crmCompanyId: true, status: true, classification: true, deepCheck: true, crmSyncedAt: true },
  })
  const seen = new Set<string>()
  const totals = { evaluated: 0, warm: 0, earlySignal: 0, cold: 0, insufficient: 0, existingCustomer: 0, activeOpportunity: 0, doNotContact: 0, humanReview: 0, failed: 0, needsReview: 0, notSynced: 0 }
  for (const r of rows) {
    if (seen.has(r.crmCompanyId)) continue
    seen.add(r.crmCompanyId)
    if (!r.crmSyncedAt) totals.notSynced++
    if (r.status === 'failed') {
      totals.failed++
      continue
    }
    totals.evaluated++
    const key = COUNTER[r.classification ?? '']
    if (key) totals[key]++
    else totals.failed++
    if (r.deepCheck === 'skipped_cap' || r.deepCheck === 'skipped_ceiling' || r.deepCheck === 'failed') totals.needsReview++
  }

  let crmTotal: number | null = null
  try {
    crmTotal = (await getCrm().searchCompanies({ page: 1, limit: 1 })).total
  } catch {
    crmTotal = null
  }
  const test = runs.find((r) => r.kind === 'test') ?? null
  return {
    runs: withCounts,
    totals,
    crmTotal,
    remaining: crmTotal == null ? null : Math.max(0, crmTotal - seen.size),
    test: test ? { id: test.id, status: test.status, approvedAt: test.approvedAt, approvedBy: test.approvedBy } : null,
    settings: {
      testSize: TEST_SIZE,
      sampleSeed: env.WARM_LEADS_SAMPLE_SEED,
      maxBatch: env.WARM_LEADS_MAX_BATCH,
      deepCheckCap: env.WARM_LEADS_DEEP_MAX_PER_RUN,
      syncEnabled: env.WARM_LEADS_SYNC_ENABLED,
    },
  }
}

export async function runDetail(tenantId: string, runId: string) {
  const run = await prisma.warmLeadRun.findFirst({ where: { id: runId, tenantId } })
  if (!run) throw new NotFoundError('Run not found.')
  const evaluations = await prisma.warmLeadEvaluation.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } })
  return {
    run: { ...run, costUsd: Number(run.costUsd), counts: await runCounts(runId) },
    evaluations: evaluations.map((e) => ({ ...e, costUsd: Number(e.costUsd) })),
  }
}
