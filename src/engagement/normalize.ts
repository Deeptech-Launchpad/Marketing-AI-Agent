import { createHash } from 'node:crypto'
import { env } from '../config/env.js'
import {
  DEDUPE_POLICY,
  EVENT_CHANNEL,
  type EngagementEventType,
  type EngagementChannel,
  type EngagementSourceKind,
  type EventEvidence,
  type FreshnessLabel,
  type NormalizedEvent,
} from './types.js'

// TASK #983 — normalising an observation into one stored shape.
//
// Whatever a source hands us — a page render, a webhook, a lifecycle callback —
// becomes the same row with the same guarantees: a whitelisted type, a
// timestamp we can defend, a dedupe key, and evidence saying how it was seen.
//
// There is no scoring here and nothing that could become one. The closest this
// file gets to a judgement is the freshness LABEL, and that is metadata: the
// raw age is stored beside it so a later stage can reclassify without trusting
// our thresholds.

export interface NormalizeInput {
  eventType: EngagementEventType
  source: EngagementSourceKind
  sourceProvider?: string | null
  /**
   * The channel, when the caller knows it better than the type table does.
   *
   * Needed for the generic outreach lifecycle types, which span every channel:
   * `outreach_action_blocked` is the same event whether the action was an email
   * or a LinkedIn message, and only the caller knows which. Everywhere else the
   * type determines the channel and this is omitted.
   */
  channel?: EngagementChannel | null
  tenantId: string
  crmCompanyId: string
  /** When the source says it happened. Absent means "now". */
  occurredAt?: Date | null
  sessionRef?: string | null
  providerEventId?: string | null
  workbenchDemoId?: string | null
  outreachActionId?: string | null
  auditRunId?: string | null
  evidence: EventEvidence
  metadata?: Record<string, unknown>
  /**
   * What makes this act different from another of the same type.
   *
   * Needed where one event type covers acts that are genuinely distinct.
   * Switching the comparison to "before" and switching it to "after" are both
   * `workbench_comparison_used`, seconds apart, in one session — without a
   * discriminator the repeat-window would merge them and the second switch
   * would vanish from the record.
   *
   * The rule this serves: never deduplicate two separate customer actions
   * merely because they look similar. A double-submitted "before" is still one
   * act, because the discriminator is the same.
   */
  dedupeDiscriminator?: string | null
}

/**
 * Timestamps a source may not be trusted about.
 *
 * A public client can claim any `occurredAt` it likes, and a provider can send
 * a clock-skewed one. So a timestamp from an untrusted source is CLAMPED
 * rather than rejected: a future timestamp becomes now, and one implausibly far
 * in the past is refused. Rejecting outright would lose a real event over a
 * clock problem; accepting blindly would let anyone rewrite a timeline.
 */
export function clampOccurredAt(
  claimed: Date | null | undefined,
  now: Date,
  trusted: boolean,
): { occurredAt: Date; adjusted: string | null } {
  if (!claimed || Number.isNaN(claimed.getTime())) return { occurredAt: now, adjusted: null }
  if (trusted) return { occurredAt: claimed, adjusted: null }

  // A small forward tolerance absorbs ordinary clock skew.
  const skewMs = env.ENGAGEMENT_MAX_CLOCK_SKEW_MINUTES * 60_000
  if (claimed.getTime() > now.getTime() + skewMs) {
    return { occurredAt: now, adjusted: 'A future timestamp was clamped to the time of receipt.' }
  }

  const maxAgeMs = env.ENGAGEMENT_MAX_BACKDATE_DAYS * 86_400_000
  if (claimed.getTime() < now.getTime() - maxAgeMs) {
    return {
      occurredAt: now,
      adjusted: `A timestamp older than ${env.ENGAGEMENT_MAX_BACKDATE_DAYS} day(s) was clamped to the time of receipt.`,
    }
  }

  return { occurredAt: claimed, adjusted: null }
}

/**
 * Freshness metadata. NOT a score, and never combined with anything.
 *
 * The label is a reading of the configured thresholds; `ageHours` is the fact.
 */
export function freshness(occurredAt: Date, now: Date): { label: FreshnessLabel; ageHours: number } {
  const ms = now.getTime() - occurredAt.getTime()
  if (!Number.isFinite(ms)) return { label: 'unknown', ageHours: 0 }

  const ageHours = Math.max(0, Math.round(ms / 3_600_000))
  if (ms < 0) return { label: 'unknown', ageHours: 0 }
  if (ageHours <= env.ENGAGEMENT_FRESH_HOURS) return { label: 'fresh', ageHours }
  if (ageHours <= env.ENGAGEMENT_RECENT_HOURS) return { label: 'recent', ageHours }
  return { label: 'old', ageHours }
}

/**
 * Builds the deduplication key, following the declared policy per event type.
 *
 * A provider's own event id always wins when present: a webhook redelivered
 * three times is one act, and the provider is the authority on that.
 *
 * Otherwise:
 *   once_ever         one row per reference, forever.
 *   once_per_session  one row per session — four page loads in one visit is
 *                     one viewing.
 *   repeatable        bucketed by time, so a genuine second click survives but
 *                     a double-submitted form does not become two events.
 */
export function dedupeKey(input: {
  eventType: EngagementEventType
  tenantId: string
  crmCompanyId: string
  sessionRef?: string | null
  providerEventId?: string | null
  referenceId?: string | null
  dedupeDiscriminator?: string | null
  occurredAt: Date
}): string {
  const policy = DEDUPE_POLICY[input.eventType]

  const parts: string[] = [input.tenantId, input.crmCompanyId, input.eventType]

  if (input.providerEventId) {
    parts.push('provider', input.providerEventId)
  } else if (policy === 'once_ever') {
    parts.push('ref', input.referenceId ?? 'no-reference')
  } else if (policy === 'once_per_session') {
    parts.push('session', input.sessionRef ?? 'no-session', 'ref', input.referenceId ?? '')
  } else {
    // Repeatable: a short bucket collapses an accidental double submit while
    // leaving two deliberate acts as two events.
    const bucket = Math.floor(input.occurredAt.getTime() / (env.ENGAGEMENT_DEDUPE_BUCKET_SECONDS * 1000))
    parts.push('session', input.sessionRef ?? 'no-session', 'ref', input.referenceId ?? '', 'bucket', String(bucket))
  }

  // Applied to every policy. Two acts that differ in what they did are two
  // acts, whatever window they fall in.
  if (input.dedupeDiscriminator) parts.push('what', input.dedupeDiscriminator)

  return createHash('sha256').update(parts.join('|')).digest('hex')
}

/**
 * Keeps only small, whitelisted scalars out of whatever a source supplied.
 *
 * Task #983 minimises PII, so this is an allowlist by SHAPE: strings are
 * truncated, objects and arrays are dropped entirely. That is what stops a
 * provider payload or a browser fingerprint being stored "just in case".
 */
export function sanitizeMetadata(raw: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  if (!raw) return out

  let kept = 0
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= env.ENGAGEMENT_MAX_METADATA_KEYS) break
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) continue

    if (value === null) {
      out[key] = null
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 200)
    } else {
      // Objects and arrays are dropped rather than serialised: that is where a
      // raw payload or a fingerprint would otherwise arrive.
      continue
    }
    kept++
  }
  return out
}

export interface NormalizeResult {
  event: NormalizedEvent
  freshnessLabel: FreshnessLabel
  ageHours: number
  receivedAt: Date
  /** Set when a claimed timestamp had to be corrected. */
  timestampNote: string | null
}

/** Sources whose clock we accept as-is. */
const TRUSTED_SOURCES: EngagementSourceKind[] = ['outreach_engine', 'manual_confirmation', 'workbench_app', 'tracked_link']

export function normalize(input: NormalizeInput, now = new Date()): NormalizeResult {
  const trusted = TRUSTED_SOURCES.includes(input.source)
  const { occurredAt, adjusted } = clampOccurredAt(input.occurredAt ?? null, now, trusted)
  const { label, ageHours } = freshness(occurredAt, now)

  const event: NormalizedEvent = {
    eventType: input.eventType,
    channel: input.channel ?? EVENT_CHANNEL[input.eventType],
    source: input.source,
    sourceProvider: input.sourceProvider ?? null,
    occurredAt,
    crmCompanyId: input.crmCompanyId,
    tenantId: input.tenantId,
    sessionRef: input.sessionRef ?? null,
    providerEventId: input.providerEventId ?? null,
    workbenchDemoId: input.workbenchDemoId ?? null,
    outreachActionId: input.outreachActionId ?? null,
    auditRunId: input.auditRunId ?? null,
    dedupeKey: dedupeKey({
      eventType: input.eventType,
      tenantId: input.tenantId,
      crmCompanyId: input.crmCompanyId,
      sessionRef: input.sessionRef,
      providerEventId: input.providerEventId,
      referenceId: input.evidence.referenceId,
      dedupeDiscriminator: input.dedupeDiscriminator,
      occurredAt,
    }),
    evidence: input.evidence,
    metadata: sanitizeMetadata(input.metadata),
  }

  return { event, freshnessLabel: label, ageHours, receivedAt: now, timestampNote: adjusted }
}
