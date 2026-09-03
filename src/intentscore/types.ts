import type { EngagementChannel, EngagementEventType } from '../engagement/types.js'

// TASK #984 — the vocabulary of an intent score.
//
// WHAT THIS IS
//
// A rule-based score derived from engagement acts that Task #983 actually
// observed. It is arithmetic over a published table of weights, and every point
// names the event that produced it.
//
// WHAT THIS IS NOT
//
// Not predictive scoring, not a machine-learning lead score, not a conversion
// or purchase probability, not a close probability. Nothing here is trained on
// anything, and nothing here forecasts. Those words are avoided in the code and
// in the API because using them would claim a property this does not have.
//
// The honest description, used throughout: "an intent score based on observed
// engagement".

/** How a contribution affects the picture. Kept apart on purpose — see below. */
export const SCORE_DIMENSIONS = ['interest', 'contactability'] as const
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number]

/**
 * Whether a rule's contribution decays with age.
 *
 * `standard`  positive evidence gets weaker as it ages — someone who clicked a
 *             CTA this morning is telling us more than someone who clicked one
 *             in March.
 * `none`      the contribution does not weaken. Used for withdrawal of
 *             consent: an unsubscribe from six months ago has not become less
 *             true, and letting it decay would quietly restore a score the
 *             person explicitly asked us to stop building.
 */
export const DECAY_PROFILES = ['standard', 'none'] as const
export type DecayProfile = (typeof DECAY_PROFILES)[number]

/** One scoring rule. Data, not code — see policy.ts. */
export interface ScoringRule {
  /** Stable identifier, recorded on every contribution it produces. */
  ruleId: string
  eventType: EngagementEventType
  /** Points before any freshness adjustment. May be negative. */
  points: number
  dimension: ScoreDimension
  decay: DecayProfile
  /**
   * How many occurrences of this event type may score within ONE session.
   * null means no per-session limit.
   */
  maxPerSession: number | null
  /**
   * How many occurrences may score across the whole evaluation.
   * null means no overall limit.
   */
  maxOccurrences: number | null
  /**
   * Ceiling on the total points this event type may contribute, applied after
   * freshness. null means no ceiling.
   */
  maxContribution: number | null
  /** Why this weight, in plain words. Shown in the policy API. */
  note: string
}

/** A freshness band. Deterministic, closed at both ends except the last. */
export interface DecayBand {
  /** Inclusive lower bound, in whole days of age. */
  fromDays: number
  /** Exclusive upper bound, or null for "and older". */
  toDays: number | null
  multiplier: number
  label: string
}

/** Score-to-level bands. Never "hot" — see the note in policy.ts. */
export interface LevelBand {
  level: 'LOW' | 'MEDIUM' | 'HIGH'
  fromScore: number
  toScore: number
}

/**
 * Whether a policy's numbers have been signed off by the business.
 *
 * This exists so nobody can mistake a placeholder for a decision. Every weight
 * currently in the system is `provisional`.
 */
export const POLICY_STATUSES = ['provisional', 'business_approved'] as const
export type PolicyStatus = (typeof POLICY_STATUSES)[number]

export interface ScoringPolicy {
  version: string
  status: PolicyStatus
  description: string
  /** Bounds of the final score. */
  minScore: number
  maxScore: number
  rules: ScoringRule[]
  decayBands: DecayBand[]
  levelBands: LevelBand[]
  /**
   * Actors whose acts may contribute to the INTEREST score.
   *
   * Defaults to prospect-only. Our own activity is not evidence about them, and
   * a bounce is a fact about an address rather than a decision by a person.
   */
  scoringActors: Array<'prospect' | 'altiusnxt' | 'system'>
  notes: string[]
}

/**
 * One traceable contribution.
 *
 * There is no way to build one of these without an engagement event: the field
 * is required here, non-nullable in the database, and carries a foreign key.
 */
export interface Contribution {
  engagementEventId: string
  eventType: EngagementEventType
  channel: EngagementChannel
  occurredAt: Date
  ruleId: string
  dimension: ScoreDimension
  /** Points before freshness. */
  basePoints: number
  freshnessMultiplier: number
  freshnessLabel: string
  ageDays: number
  /** Points after freshness and after any cap. This is what was counted. */
  adjustedPoints: number
  /** True when a cap or an ineligible actor reduced this to zero. */
  excluded: boolean
  /** Why this contributed what it did, in plain words. */
  reason: string
}

/** Contactability, reported beside the score and never folded into it. */
export const CONTACTABILITY_STATUSES = ['unknown', 'ok', 'degraded', 'blocked'] as const
export type ContactabilityStatus = (typeof CONTACTABILITY_STATUSES)[number]

export interface Contactability {
  status: ContactabilityStatus
  reasons: string[]
}

/** The result of one calculation. */
export interface ScoreResult {
  crmCompanyId: string
  tenantId: string
  /** Sum of adjusted contributions, before bounding. */
  rawScore: number
  /** The bounded score actually reported. */
  normalizedScore: number
  scoreRange: { min: number; max: number }
  /** True when bounding changed the number, so nothing is hidden. */
  clamped: boolean
  level: LevelBand['level']
  policyVersion: string
  policyStatus: PolicyStatus
  /** Bumped when the ARITHMETIC changes, independently of the weights. */
  calculationVersion: string
  /** The instant the score describes. Recalculation with the same value repeats it. */
  evaluatedAt: Date
  contributions: Contribution[]
  contactability: Contactability
  /** Counts, so a reader can see what was considered and what was set aside. */
  eventsConsidered: number
  eventsScored: number
  eventsExcluded: number
  /** Stable fingerprint of the inputs and outputs, used to avoid duplicate history. */
  resultHash: string
}
