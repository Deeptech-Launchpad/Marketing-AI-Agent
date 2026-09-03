import { createHash } from 'node:crypto'
import { EVENT_ACTOR, type EngagementChannel, type EngagementEventType } from '../engagement/types.js'
import { CALCULATION_VERSION, decayMultiplier, levelFor, ruleIndex } from './policy.js'
import type {
  Contactability,
  Contribution,
  ScoreResult,
  ScoringPolicy,
  ScoringRule,
} from './types.js'

// TASK #984 — the arithmetic.
//
// PURE AND DETERMINISTIC.
//
// This file reads no clock, no database, no environment and no random source.
// Everything it needs arrives as an argument, so the same events with the same
// policy and the same `evaluatedAt` always produce the same score — which is
// what makes a historical recalculation reproducible rather than merely
// plausible.
//
// No Gemini, no model, no inference. The score is a sum of published weights.

/** The engagement facts the engine needs. Nothing more is read. */
export interface ScorableEvent {
  id: string
  eventType: string
  channel: string
  occurredAt: Date
  sessionRef: string | null
}

export interface ScoreInput {
  tenantId: string
  crmCompanyId: string
  events: ScorableEvent[]
  policy: ScoringPolicy
  /** The instant the score describes. Required — never defaulted to "now". */
  evaluatedAt: Date
}

/**
 * Whole days between two instants, always rounded DOWN.
 *
 * Flooring matters: it makes the band boundaries crisp, so an event is in the
 * "within a week" band for the whole of day 7 rather than drifting across the
 * boundary depending on the hour a recalculation happened to run.
 */
export function ageInDays(occurredAt: Date, evaluatedAt: Date): number {
  const ms = evaluatedAt.getTime() - occurredAt.getTime()
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.floor(ms / 86_400_000)
}

/**
 * Rounds half AWAY from zero.
 *
 * `Math.round` breaks ties towards positive infinity, so -2.5 becomes -2 while
 * 2.5 becomes 3 — an asymmetry that would make a negative weight quietly
 * gentler than the same positive one. This is symmetric.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * Whether an event's actor may contribute to the interest score.
 *
 * Task #983's EVENT_ACTOR table is the single source of this classification —
 * reused rather than restated, so the two stages cannot drift apart.
 */
function actorEligible(policy: ScoringPolicy, eventType: string): boolean {
  const actor = EVENT_ACTOR[eventType as EngagementEventType]
  if (!actor) return false
  return policy.scoringActors.includes(actor)
}

function excluded(event: ScorableEvent, rule: ScoringRule | undefined, reason: string): Contribution {
  return {
    engagementEventId: event.id,
    eventType: event.eventType as EngagementEventType,
    channel: event.channel as EngagementChannel,
    occurredAt: event.occurredAt,
    ruleId: rule?.ruleId ?? 'none',
    dimension: rule?.dimension ?? 'interest',
    basePoints: rule?.points ?? 0,
    freshnessMultiplier: 0,
    freshnessLabel: 'not applied',
    ageDays: 0,
    adjustedPoints: 0,
    excluded: true,
    reason,
  }
}

/**
 * Scores one company's engagement.
 *
 * Every event that was CONSIDERED appears in the output, including those that
 * contributed nothing. A breakdown that silently omitted the excluded events
 * would look complete while hiding the reason a score is lower than someone
 * expected — which is the question a breakdown exists to answer.
 */
export function calculateScore(input: ScoreInput): ScoreResult {
  const { policy, evaluatedAt } = input
  const rules = ruleIndex(policy)

  // Deterministic order: oldest first, id as the tiebreaker. Caps are consumed
  // in this order, so which occurrences win a capped slot never depends on the
  // order the database happened to return rows in.
  const events = [...input.events].sort((a, b) => {
    const byTime = a.occurredAt.getTime() - b.occurredAt.getTime()
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
  })

  const contributions: Contribution[] = []
  const contactabilityReasons: string[] = []
  let contactabilityStatus: Contactability['status'] = 'unknown'

  // Cap counters.
  const perSession = new Map<string, number>()
  const perType = new Map<string, number>()
  const totalByType = new Map<string, number>()

  for (const event of events) {
    const rule = rules.get(event.eventType)

    if (!rule) {
      contributions.push(
        excluded(event, undefined, `The policy has no rule for "${event.eventType}", so it contributes nothing.`),
      )
      continue
    }

    // Contactability is assessed but never scored into the interest total.
    if (rule.dimension === 'contactability') {
      if (event.eventType === 'email_bounced') {
        contactabilityStatus = contactabilityStatus === 'blocked' ? 'blocked' : 'degraded'
        contactabilityReasons.push('An email to this company bounced, so at least one address is not reachable.')
      }
      contributions.push(
        excluded(
          event,
          rule,
          'Recorded as a contactability fact. It carries no interest points, because a delivery failure says nothing about whether the person is interested.',
        ),
      )
      continue
    }

    if (!actorEligible(policy, event.eventType)) {
      const actor = EVENT_ACTOR[event.eventType as EngagementEventType] ?? 'unknown'
      contributions.push(
        excluded(
          event,
          rule,
          actor === 'altiusnxt'
            ? 'Performed by AltiusNXT, not by the prospect, so it is not evidence of their interest.'
            : `Performed by "${actor}", which the policy does not count towards interest.`,
        ),
      )
      continue
    }

    // ── Repeat caps ────────────────────────────────────────────────────────
    const sessionKey = `${event.eventType}|${event.sessionRef ?? 'no-session'}`
    const sessionCount = perSession.get(sessionKey) ?? 0
    if (rule.maxPerSession !== null && sessionCount >= rule.maxPerSession) {
      contributions.push(
        excluded(
          event,
          rule,
          `Beyond the limit of ${rule.maxPerSession} scoring occurrence(s) of this act per visit.`,
        ),
      )
      continue
    }

    const typeCount = perType.get(event.eventType) ?? 0
    if (rule.maxOccurrences !== null && typeCount >= rule.maxOccurrences) {
      contributions.push(
        excluded(event, rule, `Beyond the limit of ${rule.maxOccurrences} scoring occurrence(s) of this act overall.`),
      )
      continue
    }

    // ── Freshness ──────────────────────────────────────────────────────────
    const ageDays = ageInDays(event.occurredAt, evaluatedAt)
    const band =
      rule.decay === 'none'
        ? { multiplier: 1, label: 'no decay applied by policy', fromDays: 0, toDays: null }
        : decayMultiplier(policy, ageDays)

    let adjusted = roundHalfAwayFromZero(rule.points * band.multiplier)

    // ── Per-type contribution ceiling, applied after freshness ─────────────
    let cappedNote = ''
    if (rule.maxContribution !== null) {
      const already = totalByType.get(event.eventType) ?? 0
      const headroom = rule.maxContribution - already
      if (adjusted > headroom) {
        cappedNote = ` Reduced from ${adjusted} to stay within the ${rule.maxContribution}-point ceiling for this act.`
        adjusted = Math.max(0, headroom)
      }
    }

    perSession.set(sessionKey, sessionCount + 1)
    perType.set(event.eventType, typeCount + 1)
    totalByType.set(event.eventType, (totalByType.get(event.eventType) ?? 0) + adjusted)

    const decayNote =
      rule.decay === 'none'
        ? 'This act does not decay with age.'
        : `Aged ${ageDays} day(s) — ${band.label}, multiplier ${band.multiplier}.`

    contributions.push({
      engagementEventId: event.id,
      eventType: event.eventType as EngagementEventType,
      channel: event.channel as EngagementChannel,
      occurredAt: event.occurredAt,
      ruleId: rule.ruleId,
      dimension: rule.dimension,
      basePoints: rule.points,
      freshnessMultiplier: band.multiplier,
      freshnessLabel: band.label,
      ageDays,
      adjustedPoints: adjusted,
      excluded: adjusted === 0 && rule.points !== 0,
      reason: `${rule.points >= 0 ? 'Base' : 'Penalty'} ${rule.points}. ${decayNote}${cappedNote}`,
    })

    if (event.eventType === 'email_unsubscribed') {
      contactabilityStatus = 'blocked'
      contactabilityReasons.push('This company unsubscribed. They must not be contacted by email again.')
    }
  }

  const rawScore = contributions.reduce((sum, c) => sum + c.adjustedPoints, 0)
  const normalizedScore = Math.min(policy.maxScore, Math.max(policy.minScore, rawScore))
  const clamped = normalizedScore !== rawScore

  if (contactabilityStatus === 'unknown' && contributions.some((c) => !c.excluded)) {
    contactabilityStatus = 'ok'
    contactabilityReasons.push('No delivery failure or unsubscribe has been observed for this company.')
  }

  const scored = contributions.filter((c) => c.adjustedPoints !== 0)

  const result: Omit<ScoreResult, 'resultHash'> = {
    crmCompanyId: input.crmCompanyId,
    tenantId: input.tenantId,
    rawScore,
    normalizedScore,
    scoreRange: { min: policy.minScore, max: policy.maxScore },
    clamped,
    level: levelFor(policy, normalizedScore),
    policyVersion: policy.version,
    policyStatus: policy.status,
    calculationVersion: CALCULATION_VERSION,
    evaluatedAt,
    contributions,
    contactability: {
      status: contactabilityStatus,
      reasons: contactabilityReasons.length ? contactabilityReasons : ['Nothing has been observed either way.'],
    },
    eventsConsidered: events.length,
    eventsScored: scored.length,
    eventsExcluded: events.length - scored.length,
  }

  return { ...result, resultHash: hashResult(result) }
}

/**
 * A fingerprint of what was calculated.
 *
 * Used to avoid appending an identical row to the score history: a
 * recalculation that changes nothing is not a change. `evaluatedAt` is
 * deliberately EXCLUDED — otherwise every rerun would look different purely
 * because time passed, and the history would fill with noise.
 */
function hashResult(result: Omit<ScoreResult, 'resultHash'>): string {
  const material = [
    result.tenantId,
    result.crmCompanyId,
    result.policyVersion,
    result.calculationVersion,
    String(result.rawScore),
    String(result.normalizedScore),
    result.level,
    result.contactability.status,
    ...result.contributions
      .map((c) => `${c.engagementEventId}:${c.ruleId}:${c.adjustedPoints}:${c.excluded ? 1 : 0}`)
      .sort(),
  ].join('|')
  return createHash('sha256').update(material).digest('hex')
}

/** Points grouped by channel, for the breakdown. Counts only what was scored. */
export function byChannel(contributions: Contribution[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of contributions) {
    if (c.adjustedPoints === 0) continue
    out[c.channel] = (out[c.channel] ?? 0) + c.adjustedPoints
  }
  return out
}

/** Points grouped by event type, for the breakdown. */
export function byEventType(contributions: Contribution[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of contributions) {
    if (c.adjustedPoints === 0) continue
    out[c.eventType] = (out[c.eventType] ?? 0) + c.adjustedPoints
  }
  return out
}
