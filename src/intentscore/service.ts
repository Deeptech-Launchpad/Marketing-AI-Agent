import { Prisma } from '@prisma/client'
import { newId, prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { requestQualification } from '../salesqualification/trigger.js'
import { NotFoundError } from '../platform/errors.js'
import { CALCULATION_VERSION, DEFAULT_POLICY, DEFAULT_POLICY_VERSION, validatePolicy } from './policy.js'
import { byChannel, byEventType, calculateScore, type ScorableEvent } from './score.js'
import type { Contribution, ScoreResult, ScoringPolicy } from './types.js'

// TASK #984 — loading, scoring, persisting.
//
// The arithmetic lives in score.ts and touches nothing. This file is the part
// that talks to the database, and it is deliberately thin: load the events,
// resolve the policy, call the pure function, write the result down.
//
// WHAT THIS NEVER DOES
//
// No CRM write. No outreach. No alert, no routing, no opportunity, no campaign
// change. Scoring reads engagement and writes scores; that is the whole of it.
// It also never writes an EngagementEvent, which is what stops the
// event → score → event loop the queue design warns about.

export type ScoreTrigger = 'initial' | 'recalculation' | 'policy_change' | 'event_ingested'

/**
 * Ensures the default provisional policy exists, and returns it.
 *
 * Seeded rather than assumed so that a score row can carry a real foreign key
 * to the version that produced it. Existing rows are never rewritten — if the
 * weights need to change, that is a NEW version.
 */
export async function ensureDefaultPolicy(): Promise<ScoringPolicy> {
  const problems = validatePolicy(DEFAULT_POLICY)
  if (problems.length) {
    throw new Error(`The default scoring policy is malformed:\n  ${problems.join('\n  ')}`)
  }

  const existing = await prisma.intentScoringPolicy.findUnique({ where: { version: DEFAULT_POLICY_VERSION } })
  if (existing) return rowToPolicy(existing)

  const row = await prisma.intentScoringPolicy.create({
    data: {
      id: newId(),
      version: DEFAULT_POLICY.version,
      status: DEFAULT_POLICY.status,
      description: DEFAULT_POLICY.description,
      minScore: DEFAULT_POLICY.minScore,
      maxScore: DEFAULT_POLICY.maxScore,
      rules: DEFAULT_POLICY.rules as unknown as Prisma.InputJsonValue,
      decayBands: DEFAULT_POLICY.decayBands as unknown as Prisma.InputJsonValue,
      levelBands: DEFAULT_POLICY.levelBands as unknown as Prisma.InputJsonValue,
      scoringActors: DEFAULT_POLICY.scoringActors as unknown as Prisma.InputJsonValue,
      notes: DEFAULT_POLICY.notes as unknown as Prisma.InputJsonValue,
    },
  })
  return rowToPolicy(row)
}

function rowToPolicy(row: {
  version: string
  status: string
  description: string
  minScore: number
  maxScore: number
  rules: unknown
  decayBands: unknown
  levelBands: unknown
  scoringActors: unknown
  notes: unknown
}): ScoringPolicy {
  return {
    version: row.version,
    status: row.status as ScoringPolicy['status'],
    description: row.description,
    minScore: row.minScore,
    maxScore: row.maxScore,
    rules: row.rules as ScoringPolicy['rules'],
    decayBands: row.decayBands as ScoringPolicy['decayBands'],
    levelBands: row.levelBands as ScoringPolicy['levelBands'],
    scoringActors: row.scoringActors as ScoringPolicy['scoringActors'],
    notes: row.notes as string[],
  }
}

/**
 * Resolves a policy by version, or the default.
 *
 * A named version is loaded from the DATABASE rather than from code, so a score
 * calculated under an old policy can be reproduced exactly even after the
 * in-code default has moved on.
 */
export async function resolvePolicy(version?: string | null): Promise<ScoringPolicy> {
  if (!version || version === DEFAULT_POLICY_VERSION) return ensureDefaultPolicy()

  const row = await prisma.intentScoringPolicy.findUnique({ where: { version } })
  if (!row) throw new NotFoundError(`No scoring policy with version "${version}".`)
  return rowToPolicy(row)
}

export async function listPolicies(): Promise<ScoringPolicy[]> {
  await ensureDefaultPolicy()
  const rows = await prisma.intentScoringPolicy.findMany({ orderBy: { activeFrom: 'desc' } })
  return rows.map(rowToPolicy)
}

export interface ScoreOptions {
  tenantId: string
  crmCompanyId: string
  policyVersion?: string | null
  /**
   * The instant to score as of.
   *
   * Passed rather than read from a clock, so a historical recalculation is
   * reproducible. Defaults to now only at the outermost caller.
   */
  asOf?: Date
  trigger?: ScoreTrigger
  requestedByCrmUserId?: string | null
  /** When false, the result is computed and returned but nothing is written. */
  persist?: boolean
}

export interface ScoreOutcome extends ScoreResult {
  /** The snapshot written, or null when nothing was persisted. */
  snapshotId: string | null
  /** True when a recalculation produced an identical result and added no history. */
  unchanged: boolean
  companyName: string | null
  byChannel: Record<string, number>
  byEventType: Record<string, number>
}

/**
 * Scores one company.
 *
 * Every EngagementEvent for the company is loaded — including the ones that
 * will not score. They appear in the breakdown with a reason, because "why is
 * this only 45" is answered by the events that were set aside, not by the ones
 * that counted.
 */
export async function scoreCompany(options: ScoreOptions): Promise<ScoreOutcome> {
  const asOf = options.asOf ?? new Date()
  const persist = options.persist ?? true
  const policy = await resolvePolicy(options.policyVersion)

  const rows = await prisma.engagementEvent.findMany({
    where: {
      tenantId: options.tenantId,
      crmCompanyId: options.crmCompanyId,
      // An event that happened after the evaluation instant cannot have
      // informed a score "as of" that instant. Without this a historical
      // recalculation would quietly see the future.
      occurredAt: { lte: asOf },
    },
    select: { id: true, eventType: true, channel: true, occurredAt: true, sessionRef: true },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    take: 5000,
  })

  const events: ScorableEvent[] = rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    channel: r.channel,
    occurredAt: r.occurredAt,
    sessionRef: r.sessionRef,
  }))

  const result = calculateScore({
    tenantId: options.tenantId,
    crmCompanyId: options.crmCompanyId,
    events,
    policy,
    evaluatedAt: asOf,
  })

  const companyName =
    (
      await prisma.engagementEvent.findFirst({
        where: { tenantId: options.tenantId, crmCompanyId: options.crmCompanyId, companyName: { not: null } },
        select: { companyName: true },
      })
    )?.companyName ?? null

  const base: ScoreOutcome = {
    ...result,
    snapshotId: null,
    unchanged: false,
    companyName,
    byChannel: byChannel(result.contributions),
    byEventType: byEventType(result.contributions),
  }

  if (!persist) return base

  const persisted = await persistScore(result, {
    trigger: options.trigger ?? 'recalculation',
    requestedByCrmUserId: options.requestedByCrmUserId ?? null,
    companyName,
    policy,
  })

  // TASK #985: hand off to the qualification queue when the score actually
  // moved. An enqueue and nothing more — no threshold, no owner, no alert is
  // touched here, so scoring stays an interpretation of engagement and does not
  // become a business decision about sales priority.
  if (!persisted.unchanged) {
    await requestQualification(options.tenantId, options.crmCompanyId)
  }

  return { ...base, snapshotId: persisted.snapshotId, unchanged: persisted.unchanged }
}

/**
 * Writes the result down.
 *
 * A recalculation that produces an IDENTICAL result adds no history row — the
 * `resultHash` deliberately excludes `evaluatedAt`, so a rerun that changes
 * nothing is recognised as no change. Without that, running the worker every
 * few minutes would bury the real movements in identical rows.
 */
async function persistScore(
  result: ScoreResult,
  context: {
    trigger: ScoreTrigger
    requestedByCrmUserId: string | null
    companyName: string | null
    policy: ScoringPolicy
  },
): Promise<{ snapshotId: string | null; unchanged: boolean }> {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.intentScoreSnapshot.findFirst({
      where: { tenantId: result.tenantId, crmCompanyId: result.crmCompanyId },
      orderBy: [{ evaluatedAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, normalizedScore: true, resultHash: true },
    })

    const current = await tx.intentScore.findUnique({
      where: { tenantId_crmCompanyId: { tenantId: result.tenantId, crmCompanyId: result.crmCompanyId } },
      select: { id: true },
    })

    // Nothing changed: refresh when the score was last confirmed, and leave the
    // history alone.
    if (previous && previous.resultHash === result.resultHash) {
      if (current) {
        await tx.intentScore.update({
          where: { id: current.id },
          data: { evaluatedAt: result.evaluatedAt, updatedAt: new Date() },
        })
      }
      return { snapshotId: previous.id, unchanged: true }
    }

    const snapshotId = newId()
    await tx.intentScoreSnapshot.create({
      data: {
        id: snapshotId,
        tenantId: result.tenantId,
        crmCompanyId: result.crmCompanyId,
        rawScore: result.rawScore,
        normalizedScore: result.normalizedScore,
        clamped: result.clamped,
        level: result.level,
        policyVersion: result.policyVersion,
        policyStatus: result.policyStatus,
        calculationVersion: result.calculationVersion,
        evaluatedAt: result.evaluatedAt,
        contactabilityStatus: result.contactability.status,
        contactabilityReasons: result.contactability.reasons as unknown as Prisma.InputJsonValue,
        eventsConsidered: result.eventsConsidered,
        eventsScored: result.eventsScored,
        eventsExcluded: result.eventsExcluded,
        deltaFromPrevious: previous ? result.normalizedScore - previous.normalizedScore : null,
        resultHash: result.resultHash,
        trigger: context.trigger,
        requestedByCrmUserId: context.requestedByCrmUserId,
      },
    })

    if (result.contributions.length) {
      await tx.intentScoreContribution.createMany({
        data: result.contributions.map((c) => contributionRow(snapshotId, result.tenantId, c, result.policyVersion)),
      })
    }

    const scoreFields = {
      tenantId: result.tenantId,
      crmCompanyId: result.crmCompanyId,
      companyName: context.companyName,
      rawScore: result.rawScore,
      normalizedScore: result.normalizedScore,
      minScore: context.policy.minScore,
      maxScore: context.policy.maxScore,
      clamped: result.clamped,
      level: result.level,
      policyVersion: result.policyVersion,
      policyStatus: result.policyStatus,
      calculationVersion: result.calculationVersion,
      evaluatedAt: result.evaluatedAt,
      contactabilityStatus: result.contactability.status,
      contactabilityReasons: result.contactability.reasons as unknown as Prisma.InputJsonValue,
      eventsConsidered: result.eventsConsidered,
      eventsScored: result.eventsScored,
      eventsExcluded: result.eventsExcluded,
      resultHash: result.resultHash,
      latestSnapshotId: snapshotId,
    }

    await tx.intentScore.upsert({
      where: { tenantId_crmCompanyId: { tenantId: result.tenantId, crmCompanyId: result.crmCompanyId } },
      create: { id: newId(), ...scoreFields },
      update: scoreFields,
    })

    return { snapshotId, unchanged: false }
  })
}

function contributionRow(snapshotId: string, tenantId: string, c: Contribution, policyVersion: string) {
  return {
    id: newId(),
    tenantId,
    snapshotId,
    // Non-nullable, with a foreign key. A contribution cannot exist without it.
    engagementEventId: c.engagementEventId,
    eventType: c.eventType,
    channel: c.channel,
    occurredAt: c.occurredAt,
    ruleId: c.ruleId,
    dimension: c.dimension,
    basePoints: c.basePoints,
    freshnessMultiplier: new Prisma.Decimal(c.freshnessMultiplier.toFixed(3)),
    freshnessLabel: c.freshnessLabel,
    ageDays: c.ageDays,
    adjustedPoints: c.adjustedPoints,
    excluded: c.excluded,
    reason: c.reason,
    policyVersion,
  }
}

/** The current score, or null when a company has never been scored. */
export async function currentScore(tenantId: string, crmCompanyId: string) {
  return prisma.intentScore.findUnique({
    where: { tenantId_crmCompanyId: { tenantId, crmCompanyId } },
  })
}

/** The full breakdown behind the current score. */
export async function currentBreakdown(tenantId: string, crmCompanyId: string) {
  const score = await prisma.intentScore.findUnique({
    where: { tenantId_crmCompanyId: { tenantId, crmCompanyId } },
    include: {
      latestSnapshot: {
        include: {
          contributions: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
        },
      },
    },
  })
  return score
}

/** Score history, newest first. */
export async function scoreHistory(tenantId: string, crmCompanyId: string, limit = 50) {
  return prisma.intentScoreSnapshot.findMany({
    where: { tenantId, crmCompanyId },
    orderBy: [{ evaluatedAt: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true,
      normalizedScore: true,
      rawScore: true,
      level: true,
      clamped: true,
      policyVersion: true,
      policyStatus: true,
      calculationVersion: true,
      evaluatedAt: true,
      deltaFromPrevious: true,
      trigger: true,
      eventsConsidered: true,
      eventsScored: true,
      contactabilityStatus: true,
      createdAt: true,
    },
  })
}

/**
 * Companies with engagement that are worth (re)scoring.
 *
 * Used by the batch recalculation. Deliberately returns companies, not a
 * ranking — ordering by score would be the first step towards a "hottest
 * accounts" list, which is not this task's to build.
 */
export async function companiesWithEngagement(tenantId: string, limit = 500): Promise<string[]> {
  const rows = await prisma.engagementEvent.groupBy({
    by: ['crmCompanyId'],
    where: { tenantId },
    _max: { occurredAt: true },
    orderBy: { _max: { occurredAt: 'desc' } },
    take: Math.min(Math.max(limit, 1), 2000),
  })
  return rows.map((r) => r.crmCompanyId)
}

export async function safeScoreCompany(options: ScoreOptions): Promise<ScoreOutcome | null> {
  try {
    return await scoreCompany(options)
  } catch (err) {
    logger.error({ err, crmCompanyId: options.crmCompanyId }, 'intent score: calculation failed')
    return null
  }
}
