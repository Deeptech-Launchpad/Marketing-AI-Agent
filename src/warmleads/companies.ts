import { Prisma } from '@prisma/client'
import { getCrm } from '../crm/index.js'
import type { CrmCompany } from '../crm/types.js'
import { newId, prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { applyOutcome, DEFINITIVE, MAX_AUTO_ATTEMPTS, type CompanyState } from './companyState.js'
import { allCompanies } from './sample.js'
import type { ComputedEvaluation } from './service.js'
import { publicEvaluation } from './reasonsPublic.js'

// THE PERSISTENT COMPANY LIST (WarmLeadCompany) AND THE WORK QUEUE ON TOP OF IT.
//
// No job queue: the table IS the queue. A worker takes the next company with
// SELECT ... FOR UPDATE SKIP LOCKED, so any number of workers can run side by side
// and never take the same company twice; a company is evaluated again only when its
// state says so (pending, or failed / needs_reevaluation and due).
//
// This file reads the CRM (the company list) and writes only the Marketing database.

const log = logger.child({ module: 'warmleads-companies' })

export type WorkKind = 'pilot' | 'pending' | 'retry'

export interface Claim {
  /** WarmLeadCompany.id */
  companyRowId: string
  crmCompanyId: string
  evaluationId: string
  runId: string
  kind: WorkKind
  /** Attempts including this one. */
  attempts: number
}

/** A company in `running` longer than this was abandoned by a worker that stopped (web research can take ~30 min). */
export const STALE_AFTER_MS = 40 * 60_000
const BATCH = 500

// ── Reading the list from NXT Sales (read-only) ─────────────────────────────

export interface RefreshResult {
  seen: number
  created: number
  markedGone: number
  truncated: boolean
}

const clean = (v: string | null | undefined, max = 300): string => (v ?? '').slice(0, max)

/**
 * Reads the whole company list from NXT Sales (GET, about one request per 500 companies) and
 * brings WarmLeadCompany in line with it. New companies start as `pending`; companies already
 * known keep their state and result - only the descriptive fields and the list position change.
 * A company missing from a COMPLETE read is marked `inCrm = false` and is not taken for evaluation.
 */
export async function refreshCompanyList(tenantId: string, listAll: () => Promise<{ items: CrmCompany[]; truncated: boolean }> = () => allCompanies({}, 60)): Promise<RefreshResult> {
  const started = new Date()
  const before = await prisma.warmLeadCompany.count({ where: { tenantId } })
  const { items, truncated } = await listAll()
  // Paging a live CRM by offset can return the same company twice; one INSERT must not carry the same id twice
  // ("cannot affect row a second time"). The first occurrence wins, and list positions follow the de-duplicated order.
  const seenIds = new Set<string>()
  const named = items.filter((c) => {
    if (!c.id || !c.name?.trim() || seenIds.has(c.id)) return false
    seenIds.add(c.id)
    return true
  })

  for (let i = 0; i < named.length; i += BATCH) {
    const chunk = named.slice(i, i + BATCH)
    const ids = chunk.map(() => newId())
    const cids = chunk.map((c) => c.id)
    const names = chunk.map((c) => clean(c.name))
    const domains = chunk.map((c) => clean(c.domain))
    const countries = chunk.map((c) => clean(c.country, 100))
    const industries = chunk.map((c) => clean(c.industry, 100))
    const positions = chunk.map((_, j) => i + j)
    await prisma.$executeRaw`
      INSERT INTO "WarmLeadCompany" ("id", "tenantId", "crmCompanyId", "name", "domain", "country", "industry", "listPosition", "createdAt", "updatedAt", "firstSeenAt", "lastSeenAt")
      SELECT t.id, ${tenantId}, t.cid, t.name, NULLIF(t.domain, ''), NULLIF(t.country, ''), NULLIF(t.industry, ''), t.pos, NOW(), NOW(), NOW(), NOW()
      FROM unnest(${ids}::text[], ${cids}::text[], ${names}::text[], ${domains}::text[], ${countries}::text[], ${industries}::text[], ${positions}::int[]) AS t(id, cid, name, domain, country, industry, pos)
      ON CONFLICT ("tenantId", "crmCompanyId") DO UPDATE
      SET "name" = EXCLUDED."name", "domain" = EXCLUDED."domain", "country" = EXCLUDED."country", "industry" = EXCLUDED."industry",
          "listPosition" = EXCLUDED."listPosition", "inCrm" = true, "lastSeenAt" = NOW(), "updatedAt" = NOW()`
  }

  let markedGone = 0
  if (!truncated) {
    const r = await prisma.warmLeadCompany.updateMany({ where: { tenantId, inCrm: true, lastSeenAt: { lt: started } }, data: { inCrm: false } })
    markedGone = r.count
  }
  const after = await prisma.warmLeadCompany.count({ where: { tenantId } })
  log.info({ seen: named.length, created: after - before, markedGone, truncated }, 'warm-lead company list refreshed')
  return { seen: named.length, created: after - before, markedGone, truncated }
}

// ── Taking work ─────────────────────────────────────────────────────────────

/** Fails what a stopped worker left in `running`. Returns how many companies were recovered. */
export async function recoverStale(tenantId: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS)
  const stale = await prisma.warmLeadCompany.findMany({ where: { tenantId, state: 'running', lastAttemptAt: { lt: cutoff } }, select: { id: true, classification: true, lastEvaluationId: true } })
  for (const c of stale) {
    const hasValid = c.classification !== null && DEFINITIVE.has(c.classification)
    await prisma.warmLeadCompany.update({
      where: { id: c.id },
      data: { state: hasValid ? 'needs_reevaluation' : 'failed', nextAttemptAt: now, lastError: 'The evaluation did not finish (the worker probably stopped). It is tried again.' },
    })
  }
  await prisma.warmLeadEvaluation.updateMany({
    where: { tenantId, status: 'running', startedAt: { lt: cutoff } },
    data: { status: 'failed', error: 'The evaluation did not finish (the worker probably stopped).', evaluatedAt: now },
  })
  return stale.length
}

/** The run that groups a bucket's evaluations of one kind; created on first use. */
export async function ensureRun(tenantId: string, kind: 'pilot' | 'daily' | 'retry', bucket: string, requestedBy: string): Promise<string> {
  const existing = await prisma.warmLeadRun.findFirst({ where: { tenantId, kind, bucket }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true } })
  if (existing) {
    if (existing.status !== 'running' && kind !== 'pilot') await prisma.warmLeadRun.update({ where: { id: existing.id }, data: { status: 'running', finishedAt: null } })
    return existing.id
  }
  const id = newId()
  await prisma.warmLeadRun.create({ data: { id, tenantId, kind, status: 'running', requestedBy, companyIds: [], total: 0, bucket, startedAt: new Date() } })
  return id
}

type ClaimedRow = { id: string; crmCompanyId: string; attempts: number }

/**
 * Takes the next company of `kind` for `bucket` and starts its evaluation row, or returns null when none is due.
 * Several workers may call this at once: SKIP LOCKED gives each a different company.
 */
export async function claimNext(tenantId: string, kind: WorkKind, bucket: string, requestedBy: string, now = new Date()): Promise<Claim | null> {
  if (kind === 'pilot') return claimPilot(tenantId, bucket, now)

  const rows =
    kind === 'pending'
      ? await prisma.$queryRaw<ClaimedRow[]>`
          UPDATE "WarmLeadCompany" SET "state" = 'running', "attempts" = "attempts" + 1, "lastAttemptAt" = ${now}, "updatedAt" = NOW()
          WHERE "id" = (
            SELECT "id" FROM "WarmLeadCompany"
            WHERE "tenantId" = ${tenantId} AND "inCrm" = true AND "cohort" IS NULL AND "state" = 'pending'
            ORDER BY "listPosition", "id" FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING "id", "crmCompanyId", "attempts"`
      : await prisma.$queryRaw<ClaimedRow[]>`
          UPDATE "WarmLeadCompany" SET "state" = 'running', "attempts" = "attempts" + 1, "lastAttemptAt" = ${now}, "updatedAt" = NOW()
          WHERE "id" = (
            SELECT "id" FROM "WarmLeadCompany"
            WHERE "tenantId" = ${tenantId} AND "inCrm" = true AND "state" IN ('failed', 'needs_reevaluation')
              AND "nextAttemptAt" IS NOT NULL AND "nextAttemptAt" <= ${now} AND "attempts" < ${MAX_AUTO_ATTEMPTS}
              AND (${bucket === 'pilot'} = false OR "cohort" = 'pilot')
            ORDER BY "nextAttemptAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING "id", "crmCompanyId", "attempts"`
  const row = rows[0]
  if (!row) return null

  const runId = await ensureRun(tenantId, kind === 'retry' ? 'retry' : bucket === 'pilot' ? 'pilot' : 'daily', bucket, requestedBy)
  const evaluationId = newId()
  await prisma.warmLeadEvaluation.upsert({
    where: { runId_crmCompanyId: { runId, crmCompanyId: row.crmCompanyId } },
    create: { id: evaluationId, tenantId, runId, crmCompanyId: row.crmCompanyId, status: 'running', startedAt: now, attempts: row.attempts, bucket },
    update: { status: 'running', startedAt: now, attempts: row.attempts, error: null, evaluatedAt: null, bucket },
  })
  const ev = await prisma.warmLeadEvaluation.findUniqueOrThrow({ where: { runId_crmCompanyId: { runId, crmCompanyId: row.crmCompanyId } }, select: { id: true } })
  await prisma.warmLeadRun.update({ where: { id: runId }, data: { total: { increment: 1 } } })
  return { companyRowId: row.id, crmCompanyId: row.crmCompanyId, evaluationId: ev.id, runId, kind, attempts: row.attempts }
}

/** The pilot's evaluations are created up front (queued); a worker takes them one at a time. */
async function claimPilot(tenantId: string, bucket: string, now: Date): Promise<Claim | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; runId: string; crmCompanyId: string }>>`
    UPDATE "WarmLeadEvaluation" SET "status" = 'running', "startedAt" = ${now}, "attempts" = "attempts" + 1, "error" = NULL, "updatedAt" = NOW()
    WHERE "id" = (
      SELECT e."id" FROM "WarmLeadEvaluation" e JOIN "WarmLeadRun" r ON r."id" = e."runId"
      WHERE e."tenantId" = ${tenantId} AND r."kind" = 'pilot' AND r."bucket" = ${bucket} AND e."status" = 'queued'
      ORDER BY e."createdAt", e."id" FOR UPDATE OF e SKIP LOCKED LIMIT 1)
    RETURNING "id", "runId", "crmCompanyId"`
  const ev = rows[0]
  if (!ev) return null
  const company = await prisma.warmLeadCompany.update({
    where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: ev.crmCompanyId } },
    data: { state: 'running', attempts: { increment: 1 }, lastAttemptAt: now },
    select: { id: true, attempts: true },
  })
  await prisma.warmLeadRun.updateMany({ where: { id: ev.runId, status: 'queued' }, data: { status: 'running', startedAt: now } })
  return { companyRowId: company.id, crmCompanyId: ev.crmCompanyId, evaluationId: ev.id, runId: ev.runId, kind: 'pilot', attempts: company.attempts }
}

// ── Storing the outcome ─────────────────────────────────────────────────────

export interface StoredOutcome {
  state: CompanyState
  classification: string | null
  researchIncomplete: boolean
  failed: boolean
}

/** Writes the evaluation row, then the company's current result through the rules in companyState.ts. */
export async function recordOutcome(claim: Claim, c: ComputedEvaluation, extra: { bucket: string; geminiCalls: number; now: Date }): Promise<StoredOutcome> {
  const { now } = extra
  const incomplete = c.deep === 'skipped_cap' || c.deep === 'skipped_ceiling'
  const base = {
    companyName: c.company?.name ?? undefined,
    website: c.website?.url ?? c.company?.domain ?? null,
    deepCheck: c.deep,
    enrichmentId: c.enrichmentId,
    intentRunId: c.intentRunId,
    costUsd: new Prisma.Decimal(c.costUsd),
    tier: c.tier,
    geminiCalls: extra.geminiCalls,
    bucket: extra.bucket,
    evaluatedAt: now,
  }

  // The evaluation NEVER writes to the suppression list (owner decision of 2026-11-10: the sender of an email is not authenticated, so no
  // email-derived proposal may be recorded automatically). An opt-out found in a reply is only stored here as a PROPOSAL in the reasons of the
  // evaluation ("dry run" with the switch off, "awaiting approval" with it on); an administrator approves each one individually (optOutApproval.ts).
  const companyRow = await prisma.warmLeadCompany.findUniqueOrThrow({ where: { id: claim.companyRowId } })

  const failed = Boolean(c.failure) || !c.result
  if (failed) {
    await prisma.warmLeadEvaluation.update({
      where: { id: claim.evaluationId },
      data: {
        ...base,
        status: 'failed',
        error: c.failure?.message ?? 'The evaluation produced no result.',
        ...(c.failure?.reasons.length ? { reasons: c.failure.reasons as unknown as Prisma.InputJsonValue } : {}),
      },
    })
  } else {
    const r = c.result!
    await prisma.warmLeadEvaluation.update({
      where: { id: claim.evaluationId },
      data: {
        ...base,
        status: 'done',
        classification: r.classification,
        score: r.score,
        confidence: r.confidence,
        summary: r.summary,
        reasons: r.reasons as unknown as Prisma.InputJsonValue,
        researchIncomplete: incomplete,
      },
    })
  }

  const company = companyRow
  const patch = applyOutcome(
    {
      attempts: company.attempts,
      currentEvaluationId: company.currentEvaluationId,
      classification: company.classification,
      score: company.score,
      confidence: company.confidence,
      summary: company.summary,
      evaluatedAt: company.evaluatedAt,
    },
    failed
      ? { kind: 'failed', evaluationId: claim.evaluationId, error: c.failure?.message ?? 'The evaluation produced no result.', now, refusal: c.refusal }
      : {
          kind: 'classified',
          evaluationId: claim.evaluationId,
          classification: c.result!.classification,
          score: c.result!.score,
          confidence: c.result!.confidence,
          summary: c.result!.summary,
          researchIncomplete: incomplete,
          deferredByCeiling: c.deep === 'skipped_ceiling',
          refusal: c.refusal,
          now,
        },
  )
  await prisma.warmLeadCompany.update({
    where: { id: claim.companyRowId },
    data: {
      state: patch.state,
      attempts: patch.attempts,
      nextAttemptAt: patch.nextAttemptAt,
      lastError: patch.lastError,
      researchIncomplete: patch.researchIncomplete,
      lastEvaluationId: patch.lastEvaluationId,
      currentEvaluationId: patch.currentEvaluationId,
      classification: patch.classification,
      score: patch.score,
      confidence: patch.confidence,
      summary: patch.summary,
      evaluatedAt: patch.evaluatedAt,
      cohort: claim.kind === 'pilot' ? 'pilot' : undefined,
    },
  })
  return { state: patch.state, classification: patch.classification, researchIncomplete: patch.researchIncomplete, failed }
}

/** Closes a run when none of its evaluations is still queued or running (used for the pilot). */
export async function finishRunIfIdle(runId: string): Promise<boolean> {
  const open = await prisma.warmLeadEvaluation.count({ where: { runId, status: { in: ['queued', 'running'] } } })
  if (open) return false
  const r = await prisma.warmLeadRun.updateMany({ where: { id: runId, status: { in: ['queued', 'running'] } }, data: { status: 'completed', finishedAt: new Date() } })
  return r.count > 0
}

// ── Reading, for the screen ─────────────────────────────────────────────────

export interface CompanyCounts {
  /** Companies currently in NXT Sales. */
  total: number
  /** Waiting for a first evaluation. */
  pending: number
  /** Being evaluated now, or queued for the pilot. */
  inProgress: number
  /** Has a completed result (any classification). */
  evaluated: number
  warm: number
  earlySignal: number
  cold: number
  insufficientData: number
  existingCustomer: number
  activeOpportunity: number
  doNotContact: number
  /** Would be Warm / Early Signal, but the newest reply refused: a person decides. Not listed in NXT Sales. */
  humanReview: number
  /** Failed with no valid result; waiting for a retry. */
  failed: number
  /** Has a result but the latest attempt failed / was incomplete: re-checked later. */
  needsReevaluation: number
  /** Web research was cut short (never counted as Cold). */
  researchIncomplete: number
  notInCrm: number
}

export async function companyCounts(tenantId: string): Promise<CompanyCounts> {
  const rows = await prisma.warmLeadCompany.groupBy({ by: ['inCrm', 'state', 'classification', 'researchIncomplete'], where: { tenantId }, _count: { _all: true } })
  const c: CompanyCounts = { total: 0, pending: 0, inProgress: 0, evaluated: 0, warm: 0, earlySignal: 0, cold: 0, insufficientData: 0, existingCustomer: 0, activeOpportunity: 0, doNotContact: 0, humanReview: 0, failed: 0, needsReevaluation: 0, researchIncomplete: 0, notInCrm: 0 }
  const KEY: Record<string, keyof CompanyCounts> = {
    warm: 'warm',
    early_signal: 'earlySignal',
    cold: 'cold',
    insufficient_data: 'insufficientData',
    existing_customer: 'existingCustomer',
    active_opportunity: 'activeOpportunity',
    do_not_contact: 'doNotContact',
    human_review: 'humanReview',
  }
  for (const r of rows) {
    const n = r._count._all
    if (!r.inCrm) {
      c.notInCrm += n
      continue
    }
    c.total += n
    if (r.state === 'pending') c.pending += n
    else if (r.state === 'running' || r.state === 'queued') c.inProgress += n
    else if (r.state === 'failed') c.failed += n
    if (r.state === 'needs_reevaluation') c.needsReevaluation += n
    if (r.researchIncomplete) c.researchIncomplete += n
    if (r.classification && KEY[r.classification]) {
      c.evaluated += n
      c[KEY[r.classification]!] += n
    }
  }
  return c
}

export type CompanyFilter = 'all' | 'pending' | 'in_progress' | 'warm' | 'early_signal' | 'cold' | 'insufficient_data' | 'existing_customer' | 'active_opportunity' | 'do_not_contact' | 'human_review' | 'failed' | 'needs_reevaluation' | 'research_incomplete'

function whereFor(tenantId: string, filter: CompanyFilter, search?: string): Prisma.WarmLeadCompanyWhereInput {
  const where: Prisma.WarmLeadCompanyWhereInput = { tenantId, inCrm: true }
  switch (filter) {
    case 'pending':
      where.state = 'pending'
      break
    case 'in_progress':
      where.state = { in: ['running', 'queued'] }
      break
    case 'failed':
      where.state = 'failed'
      break
    case 'needs_reevaluation':
      where.state = 'needs_reevaluation'
      break
    case 'research_incomplete':
      where.researchIncomplete = true
      break
    case 'all':
      break
    default:
      where.classification = filter
  }
  const q = search?.trim()
  if (q) where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { domain: { contains: q, mode: 'insensitive' } }]
  return where
}

export async function listCompanies(tenantId: string, opts: { filter: CompanyFilter; search?: string; page: number; limit: number }) {
  const where = whereFor(tenantId, opts.filter, opts.search)
  const [total, rows] = await Promise.all([
    prisma.warmLeadCompany.count({ where }),
    prisma.warmLeadCompany.findMany({
      where,
      orderBy: [{ score: { sort: 'desc', nulls: 'last' } }, { listPosition: 'asc' }],
      skip: (opts.page - 1) * opts.limit,
      take: opts.limit,
    }),
  ])
  return { total, page: opts.page, limit: opts.limit, items: rows }
}

/** One company: its current result and every evaluation it has had, with the reasons and source links. */
export async function companyDetail(tenantId: string, crmCompanyId: string) {
  const company = await prisma.warmLeadCompany.findUnique({ where: { tenantId_crmCompanyId: { tenantId, crmCompanyId } } })
  if (!company) return null
  const history = await prisma.warmLeadEvaluation.findMany({ where: { tenantId, crmCompanyId }, orderBy: { createdAt: 'desc' }, take: 20 })
  return { company, history: history.map((e) => publicEvaluation({ ...e, costUsd: Number(e.costUsd) })) } // reasons without the server-only fingerprint
}

/**
 * Makes failed / incomplete companies due now (an admin pressed "Retry failed"), with their automatic
 * attempts counted afresh. Before the pilot is approved only the pilot's own companies are touched.
 */
export async function retryFailed(tenantId: string, opts: { pilotOnly: boolean }): Promise<number> {
  const r = await prisma.warmLeadCompany.updateMany({
    where: { tenantId, inCrm: true, state: { in: ['failed', 'needs_reevaluation'] }, ...(opts.pilotOnly ? { cohort: 'pilot' } : {}) },
    data: { nextAttemptAt: new Date(), attempts: 0 },
  })
  if (opts.pilotOnly && r.count > 0) {
    // Every pilot company holds one of the pilot's 100 company slots, even a failed one, so without this a finished pilot
    // could never retry anything. Give back as many slots as the pilot may still retry. The Gemini ceiling is untouched.
    await prisma.$executeRaw`
      UPDATE "WarmLeadUsage"
      SET "companiesStarted" = GREATEST(0, "companiesStarted" - LEAST(${r.count}::int, GREATEST(0, "retryLimit" - "retriesStarted"))), "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId} AND "bucket" = 'pilot'`
  }
  return r.count
}
