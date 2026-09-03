// TASK #982 — MULTICHANNEL OUTREACH vocabulary.
//
// This is an engine, not a send script. Every action it produces has to answer
// one question on demand: "why was this message sent to this person?" So an
// action carries its target, its channel, its purpose, the evidence behind its
// wording, the provider that would carry it, its approval state and its
// schedule — and none of those is optional.
//
// The status enum is the honest part. In this environment three of the five
// channels have no provider at all, and one of them has no recipient address
// either. Those are different failures and they are recorded differently:
// `provider_unavailable` is a fact about us, `no_valid_target` is a fact about
// the data, and neither is allowed to look like "sent".

export const OUTREACH_CHANNELS = ['email', 'linkedin', 'call', 'email_followup', 'whatsapp'] as const
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number]

/**
 * What a provider can report about itself.
 *
 * `draft_only` is the important one. It means the channel is legitimate and the
 * message is worth writing, but this platform may not execute it — a human
 * does. That is not a failure, and collapsing it into "unavailable" would hide
 * a perfectly good LinkedIn message an SDR could send by hand in ten seconds.
 */
export const PROVIDER_STATUSES = [
  'available',
  'draft_only',
  'not_configured',
  'unauthorized',
  'unsupported_action',
  'rate_limited',
  'provider_unavailable',
  'disabled_by_policy',
] as const
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number]

/**
 * The life of one outreach action.
 *
 * `ready_to_send` is the default terminal state for anything external. The
 * platform composes, validates and schedules; a human releases it. Automatic
 * sending is opt-in per channel and per tenant, never a default.
 */
export const ACTION_STATUSES = [
  'draft',
  'ready_to_send',
  'scheduled',
  'sending',
  'sent',
  'manual_required',
  'blocked_suppressed',
  'blocked_provider_unavailable',
  'blocked_validation_failed',
  'blocked_no_target',
  // Team Answer, Section 4: an address must be verified before it may be used.
  // Kept apart from `blocked_suppressed` deliberately — suppression means we
  // must not contact this person, this means we cannot yet reach this address.
  // One is consent, the other is deliverability, and a report that confuses
  // them would misstate both.
  'blocked_email_unverified',
  'failed',
  'cancelled',
  'skipped',
] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

/** Statuses from which nothing further should be attempted. */
export const TERMINAL_STATUSES: ActionStatus[] = ['sent', 'cancelled', 'skipped', 'blocked_suppressed']

/**
 * How a provider failure should be treated on retry.
 *
 * Retrying a permanent failure is how a system ends up hammering someone
 * else's API with a request that can never succeed, so the classification is
 * explicit rather than inferred from a status code at the call site.
 */
export const FAILURE_KINDS = ['transient', 'permanent', 'invalid_destination', 'unauthorized', 'rate_limited', 'policy'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

export const RETRYABLE_FAILURES: FailureKind[] = ['transient', 'rate_limited']

/** Why a contact must not be approached. */
export const SUPPRESSION_REASONS = [
  'opt_out',
  'do_not_contact',
  'domain_suppressed',
  'company_suppressed',
  'open_opportunity',
  'existing_customer',
  'cooldown',
  'invalid_destination',
  'missing_consent',
] as const
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

/** Where a message's wording came from. Mirrors the audit's provenance idea. */
export interface MessageEvidence {
  /** e.g. "catalog_finding", "page_observation", "workbench_field", "crm_record" */
  kind: string
  /** The row this came from, so a claim can be traced. */
  referenceId: string | null
  /** What it says, in the words the message relies on. */
  summary: string
  sourceUrl: string | null
}

/** A composed message, before any provider sees it. */
export interface ComposedMessage {
  channel: OutreachChannel
  templateKey: string
  templateVersion: string
  subject: string | null
  body: string
  /** The blocks the body was assembled from, for review and diffing. */
  blocks: Record<string, string>
  ctaUrl: string | null
  workbenchUrl: string | null
  evidence: MessageEvidence[]
  /** Characters, for channel limits. */
  length: number
}

/** Who an action is aimed at. */
export interface OutreachTarget {
  /** A named person, when the channel needs one. */
  contactName: string | null
  contactTitle: string | null
  /** The decision-maker candidate this came from, when there is one. */
  decisionMakerId: string | null
  /** Channel-specific destination: an address, a profile URL, a phone number. */
  destination: string | null
  destinationKind: 'email' | 'linkedin_profile' | 'phone' | 'internal_task' | null
  companyName: string
  crmCompanyId: string
}

export interface ChannelLimits {
  maxSubject: number | null
  maxBody: number
  requiresPerson: boolean
  requiresDestination: boolean
}

/**
 * Channel rules, in one place.
 *
 * `requiresDestination` is why email cannot proceed in this environment even if
 * a provider appeared: Task #978 verified 16 people and stored zero addresses,
 * because it refused to guess any. That refusal is upstream of this file and
 * this file honours it.
 */
export const CHANNEL_LIMITS: Record<OutreachChannel, ChannelLimits> = {
  email: { maxSubject: 120, maxBody: 5000, requiresPerson: true, requiresDestination: true },
  email_followup: { maxSubject: 120, maxBody: 5000, requiresPerson: true, requiresDestination: true },
  // LinkedIn connection notes are capped at 300 characters by the platform.
  linkedin: { maxSubject: null, maxBody: 300, requiresPerson: true, requiresDestination: true },
  // A call task is internal work for an SDR: it needs no external destination.
  call: { maxSubject: 200, maxBody: 4000, requiresPerson: false, requiresDestination: false },
  whatsapp: { maxSubject: null, maxBody: 1000, requiresPerson: true, requiresDestination: true },
}
