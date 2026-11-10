import type { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { audit } from '../platform/audit.js'
import { newId, prisma } from '../platform/db.js'
import { ConflictError, NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { finishRunIfIdle, refreshCompanyList } from './companies.js'
import { buildSample } from './sample.js'
import { ensureSettings } from './settings.js'

// THE PILOT: 100 representative companies, evaluated on the REAL NXT Sales data, results kept only
// in the Marketing database, reviewed by an admin before anything else is processed.
//
//   requestPilot   an admin asks for it (creates the run, status "preparing") - cheap, instant
//   preparePilot   the worker draws the fixed-seed sample (reads the CRM, read-only), stores the 100
//                  evaluations as "queued" and marks the companies as the pilot's
//   ... the worker evaluates them inside the window, within the pilot's own Gemini ceiling ...
//   approvePilot   an admin reviews the 100 results and approves; only then does daily processing start
//
// The pilot never writes to NXT Sales and never sends an email.

const log = logger.child({ module: 'warmleads-pilot' })

export async function requestPilot(tenantId: string, by: string): Promise<{ runId: string }> {
  const s = await ensureSettings(tenantId)
  if (s.pilotApprovedAt) throw new ConflictError('The pilot was already approved.')
  const existing = await prisma.warmLeadRun.findFirst({ where: { tenantId, kind: 'pilot' }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true } })
  if (existing && existing.status !== 'failed') throw new ConflictError('A pilot already exists. Review it, or wait for it to finish.')
  const runId = newId()
  await prisma.warmLeadRun.create({ data: { id: runId, tenantId, kind: 'pilot', status: 'preparing', requestedBy: by, companyIds: [], total: 0, bucket: 'pilot' } })
  await audit({ tenantId, actorType: 'user', actorCrmUserId: by, action: 'warmleads.pilot_requested', resourceType: 'WarmLeadRun', resourceId: runId, summary: `The ${s.pilotSize}-company pilot was requested.` })
  return { runId }
}

/** The worker's step: turns a "preparing" pilot into 100 queued evaluations. Returns true when it did something. */
export async function preparePilot(tenantId: string, build: typeof buildSample = buildSample, refresh: typeof refreshCompanyList = refreshCompanyList): Promise<boolean> {
  const run = await prisma.warmLeadRun.findFirst({ where: { tenantId, kind: 'pilot', status: 'preparing' }, orderBy: { createdAt: 'asc' } })
  if (!run) return false
  const settings = await ensureSettings(tenantId)
  try {
    // The company list must exist: the pilot companies are rows of it.
    // Read fresh: the sample is drawn from the CRM as it is NOW, so every pick must have a row, or the pilot would run short.
    await refresh(tenantId)

    const built = await build({ seed: env.WARM_LEADS_SAMPLE_SEED, size: settings.pilotSize })
    const picks = built.sample.picks.filter((p) => built.companies.has(p.id))
    if (!picks.length) throw new Error('The sample contains no company that could be read from NXT Sales.')

    // Companies the pilot takes must still be waiting: never re-evaluate one that already has a result.
    const rows = await prisma.warmLeadCompany.findMany({ where: { tenantId, crmCompanyId: { in: picks.map((p) => p.id) } }, select: { crmCompanyId: true, state: true, inCrm: true } })
    const waiting = new Set(rows.filter((r) => r.state === 'pending' && r.inCrm).map((r) => r.crmCompanyId))
    const chosen = picks.filter((p) => waiting.has(p.id))
    if (!chosen.length) throw new Error('None of the sample companies is waiting for a first evaluation.')
    // The pilot is exactly what the sample picked. A pilot that quietly runs with fewer companies than the stored sample says
    // would be reviewed and approved as something it is not, so it is refused and the reason is given.
    if (chosen.length < picks.length) {
      throw new Error(`Only ${chosen.length} of the ${picks.length} sampled companies could be queued (${picks.length - chosen.length} already have a result, are not in the company list, or are no longer in NXT Sales). Nothing was started; request the pilot again.`)
    }

    await prisma.$transaction(async (tx) => {
      await tx.warmLeadCompany.updateMany({ where: { tenantId, crmCompanyId: { in: chosen.map((p) => p.id) } }, data: { state: 'queued', cohort: 'pilot' } })
      await tx.warmLeadEvaluation.createMany({
        data: chosen.map((p) => {
          const c = built.companies.get(p.id)!
          return { id: newId(), tenantId, runId: run.id, crmCompanyId: p.id, companyName: c.name, website: c.domain ?? c.endPdpUrl ?? null, bucket: 'pilot' }
        }),
      })
      await tx.warmLeadRun.update({
        where: { id: run.id },
        data: { status: 'queued', total: chosen.length, companyIds: chosen.map((p) => p.id), sample: built.sample as unknown as Prisma.InputJsonValue, deepCheckCap: 0 },
      })
    })
    log.info({ runId: run.id, companies: chosen.length }, 'warm-lead pilot prepared')
  } catch (err) {
    log.warn({ err }, 'warm-lead pilot could not be prepared')
    await prisma.warmLeadRun.update({ where: { id: run.id }, data: { status: 'failed', failureReason: ((err as Error).message ?? String(err)).slice(0, 1000), finishedAt: new Date() } })
  }
  return true
}

/**
 * The CURRENT evaluation of each pilot company: the latest one, whichever run made it. A retry of a failed pilot company is a
 * new evaluation in a separate "retry" run, so reading only the pilot run would keep showing the old failure after the retry
 * had succeeded, and the pilot would be approved against numbers that are no longer true.
 */
export async function latestPilotEvaluations<T extends { crmCompanyId: string; createdAt: Date }>(
  load: (companyIds: string[], since: Date) => Promise<T[]>,
  run: { companyIds: unknown; createdAt: Date },
): Promise<T[]> {
  const ids = Array.isArray(run.companyIds) ? (run.companyIds as string[]) : []
  if (!ids.length) return []
  const all = await load(ids, run.createdAt)
  const latest = new Map<string, T>()
  for (const e of all) {
    const cur = latest.get(e.crmCompanyId)
    if (!cur || e.createdAt > cur.createdAt) latest.set(e.crmCompanyId, e)
  }
  return [...latest.values()]
}

export interface PilotView {
  run: { id: string; status: string; total: number; startedAt: Date | null; finishedAt: Date | null; failureReason: string | null; sample: unknown } | null
  counts: { total: number; queued: number; running: number; done: number; failed: number; incomplete: number; warm: number; earlySignal: number; cold: number; insufficientData: number; humanReview: number; other: number }
  approvedAt: Date | null
  approvedBy: string | null
  canApprove: boolean
}

export async function pilotView(tenantId: string): Promise<PilotView> {
  const s = await ensureSettings(tenantId)
  const run = await prisma.warmLeadRun.findFirst({ where: { tenantId, kind: 'pilot' }, orderBy: { createdAt: 'desc' } })
  const counts = { total: 0, queued: 0, running: 0, done: 0, failed: 0, incomplete: 0, warm: 0, earlySignal: 0, cold: 0, insufficientData: 0, humanReview: 0, other: 0 }
  if (run) {
    const latest = await latestPilotEvaluations(
      (ids, since) => prisma.warmLeadEvaluation.findMany({ where: { tenantId, crmCompanyId: { in: ids }, createdAt: { gte: since } }, select: { crmCompanyId: true, createdAt: true, status: true, classification: true, researchIncomplete: true } }),
      run,
    )
    for (const r of latest) {
      const n = 1
      counts.total += n
      if (r.status === 'queued') counts.queued += n
      else if (r.status === 'running') counts.running += n
      else if (r.status === 'failed') counts.failed += n
      else {
        counts.done += n
        if (r.researchIncomplete) counts.incomplete += n
        else if (r.classification === 'warm') counts.warm += n
        else if (r.classification === 'early_signal') counts.earlySignal += n
        else if (r.classification === 'cold') counts.cold += n
        else if (r.classification === 'insufficient_data') counts.insufficientData += n
        else if (r.classification === 'human_review') counts.humanReview += n
        else counts.other += n
      }
    }
  }
  return {
    run: run ? { id: run.id, status: run.status, total: run.total, startedAt: run.startedAt, finishedAt: run.finishedAt, failureReason: run.failureReason, sample: run.sample } : null,
    counts,
    approvedAt: s.pilotApprovedAt,
    approvedBy: s.pilotApprovedBy,
    canApprove: Boolean(run && run.status === 'completed' && !s.pilotApprovedAt && counts.queued === 0 && counts.running === 0),
  }
}

/** The pilot companies with their results, for the review screen. */
export async function pilotResults(tenantId: string) {
  const run = await prisma.warmLeadRun.findFirst({ where: { tenantId, kind: 'pilot' }, orderBy: { createdAt: 'desc' }, select: { id: true, companyIds: true, createdAt: true } })
  if (!run) return []
  const latest = await latestPilotEvaluations((ids, since) => prisma.warmLeadEvaluation.findMany({ where: { tenantId, crmCompanyId: { in: ids }, createdAt: { gte: since } } }), run)
  // best score first, as before
  latest.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.createdAt.getTime() - b.createdAt.getTime())
  return latest.map((e) => ({ ...e, costUsd: Number(e.costUsd) }))
}

/** An admin approves the finished pilot. Only then may daily processing start. */
export async function approvePilot(tenantId: string, by: string): Promise<void> {
  const s = await ensureSettings(tenantId)
  if (s.pilotApprovedAt) return
  const run = await prisma.warmLeadRun.findFirst({ where: { tenantId, kind: 'pilot' }, orderBy: { createdAt: 'desc' } })
  if (!run) throw new NotFoundError('There is no pilot to approve.')
  await finishRunIfIdle(run.id)
  const fresh = await prisma.warmLeadRun.findUniqueOrThrow({ where: { id: run.id } })
  if (fresh.status !== 'completed') throw new ConflictError('The pilot has not finished yet: some companies are still waiting or running.')
  if (!(await pilotView(tenantId)).canApprove) throw new ConflictError('Some pilot companies are being retried or are still waiting. Approve when they have finished.')
  // paused: true in the SAME update: processing was running (Start was pressed for the pilot), and approving it must not roll
  // straight into daily processing. Daily processing starts only when an admin presses Start again.
  await prisma.warmLeadSettings.update({ where: { tenantId }, data: { pilotApprovedAt: new Date(), pilotApprovedBy: by, updatedBy: by, paused: true } })
  await prisma.warmLeadRun.update({ where: { id: run.id }, data: { approvedAt: new Date(), approvedBy: by } })
  await audit({ tenantId, actorType: 'user', actorCrmUserId: by, action: 'warmleads.pilot_approved', resourceType: 'WarmLeadRun', resourceId: run.id, summary: 'Pilot results approved. Daily processing stays paused until an admin presses Start.' })
}
