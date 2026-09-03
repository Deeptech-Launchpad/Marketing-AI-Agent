import type { DecayBand, LevelBand, ScoringPolicy, ScoringRule } from './types.js'

// TASK #984 — the scoring policy, as DATA.
//
// ─────────────────────────────────────────────────────────────────────────────
// THESE WEIGHTS ARE NOT BUSINESS-APPROVED.
//
// Nobody at AltiusNXT has signed off on the numbers below. They were not
// derived from won deals, from a conversion analysis, or from any measurement
// of what these acts predict — no such data exists in this system. They are a
// DEFAULT PROVISIONAL POLICY: a starting point that is internally consistent,
// published, versioned and adjustable.
//
// The policy carries `status: 'provisional'` and every API response repeats it,
// so a number cannot travel without the caveat attached.
//
// What IS defensible here is the ordering: an act that costs the prospect more
// effort, or that they can only do deliberately, is weighted above one that
// costs them nothing. Clicking the CTA outranks loading a page. That ordering
// is a judgement about behaviour, not a measurement of outcome, and it is
// stated rather than implied.
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything below is data. No weight appears anywhere else in the codebase,
// so management can change the numbers by adding a policy version without
// anyone editing the arithmetic.

/** Bumped when the ARITHMETIC changes, separately from the weights. */
export const CALCULATION_VERSION = 'calc-1'

export const DEFAULT_POLICY_VERSION = 'v1-provisional'

/**
 * Freshness bands.
 *
 * Ages are measured in whole days from the event to `evaluatedAt`, so the same
 * inputs always land in the same band. The last band is zero rather than a
 * small residue: an act from two months ago is not evidence of current intent,
 * and letting it contribute a trickle would keep a dormant account warm for no
 * reason anyone could defend.
 */
const DECAY_BANDS: DecayBand[] = [
  { fromDays: 0, toDays: 2, multiplier: 1.0, label: 'within the last day or two' },
  { fromDays: 2, toDays: 8, multiplier: 0.8, label: 'within the last week' },
  { fromDays: 8, toDays: 31, multiplier: 0.5, label: 'within the last month' },
  { fromDays: 31, toDays: null, multiplier: 0.0, label: 'older than a month' },
]

/**
 * Level bands.
 *
 * Deliberately LOW / MEDIUM / HIGH and not "hot". "Hot lead" implies a routing
 * decision — someone should call them now — and routing is not this task's to
 * make. A level here describes the score, nothing more.
 */
const LEVEL_BANDS: LevelBand[] = [
  { level: 'LOW', fromScore: 0, toScore: 29 },
  { level: 'MEDIUM', fromScore: 30, toScore: 69 },
  { level: 'HIGH', fromScore: 70, toScore: 100 },
]

/**
 * The rules.
 *
 * Only event types that a PROSPECT can perform have interest rules. Our own
 * acts — an email we sent, a call task we created — have no rule at all, so
 * they cannot contribute even if the actor filter were changed.
 */
const RULES: ScoringRule[] = [
  // ── Audit report and QR ──────────────────────────────────────────────────
  {
    ruleId: 'r.audit_report_qr_scanned',
    eventType: 'audit_report_qr_scanned',
    points: 5,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 3,
    maxContribution: null,
    note: 'Scanning the printed code is a small deliberate act. Weighted low because the marker that identifies a scan is a hint rather than proof.',
  },
  {
    ruleId: 'r.audit_link_opened',
    eventType: 'audit_link_opened',
    points: 3,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 3,
    maxContribution: null,
    note: 'Opening a link costs almost nothing, so it is weighted near the floor.',
  },
  {
    ruleId: 'r.audit_report_viewed',
    eventType: 'audit_report_viewed',
    points: 8,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 5,
    maxContribution: null,
    note: 'Reading the report is more than opening it.',
  },
  {
    ruleId: 'r.audit_report_downloaded',
    eventType: 'audit_report_downloaded',
    points: 12,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 2,
    maxOccurrences: 5,
    maxContribution: null,
    note: 'Downloading suggests keeping it, or sharing it internally.',
  },

  // ── Workbench ────────────────────────────────────────────────────────────
  {
    ruleId: 'r.workbench_link_opened',
    eventType: 'workbench_link_opened',
    points: 10,
    dimension: 'interest',
    decay: 'standard',
    // Task #983 already records this once per visit; the cap is belt-and-braces
    // so a future change there cannot silently inflate a score here.
    maxPerSession: 1,
    maxOccurrences: 5,
    maxContribution: null,
    note: 'Opening the personalised demonstration.',
  },
  {
    ruleId: 'r.workbench_registration_started',
    eventType: 'workbench_registration_started',
    points: 2,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 3,
    maxContribution: null,
    note: 'The form was shown. Almost nothing has happened yet, so almost nothing is scored.',
  },
  {
    ruleId: 'r.workbench_registration_completed',
    eventType: 'workbench_registration_completed',
    points: 20,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 2,
    maxContribution: null,
    note: 'Giving a name, a company and a work email is a real cost to the prospect. One of the strongest acts available.',
  },
  {
    ruleId: 'r.workbench_viewed',
    eventType: 'workbench_viewed',
    points: 10,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 5,
    maxContribution: null,
    note: 'Seeing the before/after comparison. Capped at once per visit so reloading cannot inflate it.',
  },
  {
    ruleId: 'r.workbench_before_viewed',
    eventType: 'workbench_before_viewed',
    points: 5,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 4,
    maxContribution: null,
    note: 'Focusing on their own page as it stands today.',
  },
  {
    ruleId: 'r.workbench_after_viewed',
    eventType: 'workbench_after_viewed',
    points: 10,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 4,
    maxContribution: null,
    note: 'Focusing on what the page could be. Weighted above the "before" view because it is the proposal rather than the status quo.',
  },
  {
    ruleId: 'r.workbench_comparison_used',
    eventType: 'workbench_comparison_used',
    points: 15,
    dimension: 'interest',
    decay: 'standard',
    // Two switches is engagement; twenty is a fidget. Task #983 records each
    // switch as a separate act, so the CAP is what keeps that honest here.
    maxPerSession: 2,
    maxOccurrences: 6,
    maxContribution: null,
    note: 'Actively moving between the two versions. Capped at two per visit so repeated toggling cannot run the score up.',
  },
  {
    ruleId: 'r.workbench_evidence_viewed',
    eventType: 'workbench_evidence_viewed',
    points: 10,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 4,
    maxContribution: null,
    note: 'Checking where our claims came from. A buying-committee behaviour rather than a browsing one.',
  },
  {
    ruleId: 'r.workbench_cta_clicked',
    eventType: 'workbench_cta_clicked',
    points: 25,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: 1,
    maxOccurrences: 3,
    maxContribution: null,
    note: 'Asking for a walkthrough. The most deliberate act the demonstration offers, and the highest single weight.',
  },

  // ── Email, prospect acts only ────────────────────────────────────────────
  {
    ruleId: 'r.email_opened',
    eventType: 'email_opened',
    points: 3,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: null,
    maxOccurrences: 5,
    maxContribution: 9,
    note: 'Weighted very low on purpose: image-proxy prefetching means an "open" is often the mail client, not a person.',
  },
  {
    ruleId: 'r.email_clicked',
    eventType: 'email_clicked',
    points: 12,
    dimension: 'interest',
    decay: 'standard',
    maxPerSession: null,
    maxOccurrences: 5,
    maxContribution: 36,
    note: 'A click is a person. Weighted well above an open for that reason.',
  },
  {
    ruleId: 'r.email_unsubscribed',
    eventType: 'email_unsubscribed',
    points: -30,
    dimension: 'interest',
    // Does NOT decay. A withdrawal of consent has not become less true with age.
    decay: 'none',
    maxPerSession: null,
    maxOccurrences: 1,
    maxContribution: null,
    note: 'A deliberate instruction to stop. The only strong negative interest signal in the policy, and it never decays.',
  },

  // ── Contactability, kept out of the interest score entirely ──────────────
  {
    ruleId: 'r.email_bounced',
    eventType: 'email_bounced',
    points: 0,
    dimension: 'contactability',
    decay: 'none',
    maxPerSession: null,
    maxOccurrences: null,
    maxContribution: null,
    note: 'A bounce means an address failed. It says nothing about whether the person is interested — they may never have seen the message — so it carries ZERO interest points and is reported as a contactability problem instead.',
  },
]

/**
 * The default provisional policy.
 *
 * Frozen so nothing can mutate it at runtime and change a historical result.
 */
export const DEFAULT_POLICY: ScoringPolicy = Object.freeze({
  version: DEFAULT_POLICY_VERSION,
  status: 'provisional',
  description:
    'Default provisional intent scoring policy. Rule-based, derived from engagement acts observed in Task #983. Not business-approved.',
  minScore: 0,
  maxScore: 100,
  rules: RULES,
  decayBands: DECAY_BANDS,
  levelBands: LEVEL_BANDS,
  // Prospect acts only. Our own activity and infrastructure facts are excluded
  // structurally, not by convention.
  scoringActors: ['prospect'],
  notes: [
    'THESE WEIGHTS ARE NOT BUSINESS-APPROVED. They are a provisional default and require sign-off before any commercial decision rests on them.',
    'The weights encode an ordering by how much deliberate effort an act costs the prospect. They are not derived from conversion data, because none exists in this system.',
    'No machine learning is involved. This is arithmetic over a published table, and it predicts nothing.',
    'Only acts performed by the prospect contribute. Acts performed by AltiusNXT and facts produced by mail infrastructure are excluded.',
    'A bounced email carries zero interest points. It is a contactability fact, reported separately.',
    'An unsubscribe does not decay, because a withdrawal of consent does not become less true with age.',
  ],
}) as ScoringPolicy

/** Rule lookup by event type. Built once; the policy is immutable. */
export function ruleIndex(policy: ScoringPolicy): Map<string, ScoringRule> {
  const index = new Map<string, ScoringRule>()
  for (const rule of policy.rules) index.set(rule.eventType, rule)
  return index
}

/**
 * The freshness multiplier for an age in whole days.
 *
 * Bands are half-open [fromDays, toDays), so an age falls in exactly one and
 * the same age always yields the same multiplier.
 */
export function decayMultiplier(policy: ScoringPolicy, ageDays: number): DecayBand {
  for (const band of policy.decayBands) {
    if (ageDays >= band.fromDays && (band.toDays === null || ageDays < band.toDays)) return band
  }
  // Unreachable with a well-formed policy; failing closed is safer than
  // silently granting full weight to an age no band covers.
  return { fromDays: 0, toDays: null, multiplier: 0, label: 'outside every configured band' }
}

export function levelFor(policy: ScoringPolicy, score: number): LevelBand['level'] {
  for (const band of policy.levelBands) {
    if (score >= band.fromScore && score <= band.toScore) return band.level
  }
  return 'LOW'
}

/** Structural checks, so a malformed policy fails loudly rather than scoring oddly. */
export function validatePolicy(policy: ScoringPolicy): string[] {
  const problems: string[] = []

  if (policy.minScore >= policy.maxScore) problems.push('minScore must be below maxScore.')

  const seenRules = new Set<string>()
  const seenTypes = new Set<string>()
  for (const rule of policy.rules) {
    if (seenRules.has(rule.ruleId)) problems.push(`Duplicate ruleId "${rule.ruleId}".`)
    seenRules.add(rule.ruleId)
    if (seenTypes.has(rule.eventType)) problems.push(`More than one rule for "${rule.eventType}".`)
    seenTypes.add(rule.eventType)
    if (rule.maxPerSession !== null && rule.maxPerSession < 1) {
      problems.push(`${rule.ruleId}: maxPerSession must be at least 1 or null.`)
    }
  }

  // The bands must cover every age with no gap and no overlap.
  const bands = [...policy.decayBands].sort((a, b) => a.fromDays - b.fromDays)
  if (bands[0]?.fromDays !== 0) problems.push('Decay bands must start at day 0.')
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]!
    if (band.multiplier < 0 || band.multiplier > 1) {
      problems.push(`Decay multiplier ${band.multiplier} is outside 0..1.`)
    }
    const next = bands[i + 1]
    if (next && band.toDays !== next.fromDays) {
      problems.push(`Decay bands leave a gap or overlap between day ${band.toDays} and day ${next.fromDays}.`)
    }
    if (!next && band.toDays !== null) problems.push('The last decay band must be open-ended.')
  }

  // The level bands must cover the whole score range contiguously.
  const levels = [...policy.levelBands].sort((a, b) => a.fromScore - b.fromScore)
  if (levels[0]?.fromScore !== policy.minScore) problems.push('Level bands must start at minScore.')
  if (levels[levels.length - 1]?.toScore !== policy.maxScore) problems.push('Level bands must end at maxScore.')
  for (let i = 0; i < levels.length - 1; i++) {
    if (levels[i]!.toScore + 1 !== levels[i + 1]!.fromScore) {
      problems.push(`Level bands leave a gap or overlap around ${levels[i]!.toScore}.`)
    }
  }

  return problems
}
