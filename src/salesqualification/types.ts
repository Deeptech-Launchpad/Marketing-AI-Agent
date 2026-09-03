// TASK #985 — the vocabulary of a sales-qualified lead.
//
// WHAT THIS STAGE DOES
//
// Compares a Task #984 intent score against a configured business threshold and,
// when it is met, hands the lead to a person: resolve the owner, record an
// alert, create a follow-up task.
//
// WHAT IT DOES NOT DO
//
// It does not recalculate the score, touch an engagement event, change a
// scoring policy, or send anything to a prospect. Qualification is a HANDOFF,
// not outreach execution — the moment this stage sent an email it would have
// taken a decision that belongs to a person and to the outreach engine.
//
// LANGUAGE
//
// "High-intent lead", never "will buy". Nothing here claims a conversion, a
// probability, or revenue. The strongest honest statement is that observed
// engagement crossed a threshold somebody chose.

/**
 * The QUALIFICATION status — about the score and the threshold, nothing else.
 *
 * Deliberately narrow. Whether an alert reached anyone and whether a task
 * exists are SEPARATE fields, because "qualified, alert failed, task created"
 * is a real and common state that a single collapsed status cannot express.
 */
export const QUALIFICATION_STATUSES = [
  /** The score is below the threshold. */
  'not_qualified',
  /** Above the threshold, and a responsible owner was resolved. */
  'qualified',
  /**
   * Above the threshold, but no responsible sales owner is configured.
   *
   * A distinct state on purpose: the lead is real and must not be hidden, and
   * assigning it to an arbitrary user to make the record look complete would be
   * worse than admitting nobody owns it.
   */
  'qualified_unassigned',
  /** Was qualified; a later score fell below the threshold. */
  'de_qualified',
] as const
export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number]

/** Whether a person was actually notified. Separate from qualification. */
export const ALERT_STATUSES = [
  'pending',
  /**
   * An internal notification record exists and can be read by the application.
   *
   * NOT the same as "a person was pushed a message". With no Slack, Teams or
   * email provider configured, this is as far as delivery honestly goes, and
   * the wording says so rather than implying someone was interrupted.
   */
  'recorded_in_app',
  /** An external provider confirmed delivery. */
  'sent',
  'blocked_provider_unavailable',
  'failed',
  'skipped_no_owner',
] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

/** Whether a follow-up task exists. Separate again. */
export const TASK_STATUSES = [
  'pending',
  /** A task exists in the marketing platform. */
  'created',
  /** A task exists in the CRM, through an approved write adapter. */
  'created_in_crm',
  'blocked_provider_unavailable',
  'failed',
  'skipped_no_owner',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** How the responsible person was found. Recorded so it is never a mystery. */
export const OWNER_SOURCES = [
  /** The company's own owner in NXT Sales. */
  'crm_account_owner',
  /**
   * Round-robin across the configured sales reps (Team Answer, Section L.3).
   *
   * Used only where the company has no account owner of its own — an existing
   * owner is always the better answer than a rotation.
   */
  'round_robin',
  /** A configured fallback, verified to be a real CRM user. */
  'configured_fallback',
  /** A configured queue that a team watches. */
  'sales_queue',
  /** Nothing was found. The lead is reported unassigned. */
  'none',
] as const
export type OwnerSource = (typeof OWNER_SOURCES)[number]

export interface ResolvedOwner {
  resolved: boolean
  crmUserId: string | null
  name: string | null
  email: string | null
  source: OwnerSource
  /** Plain words: how this person was chosen, or why nobody was. */
  reason: string
  /**
   * The company's name as NXT Sales knows it.
   *
   * Carried back because resolving an owner already reads the company, and an
   * alert that says "cms7fiyww06..." instead of "1st Ayd" is not something a
   * salesperson can act on. Never a second CRM call just for a label.
   */
  companyName?: string | null
}

/** Availability of any handoff provider, reported honestly. */
export const PROVIDER_STATUSES = [
  'available',
  'not_configured',
  'unauthorized',
  'unavailable',
  'disabled_by_policy',
] as const
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number]

export interface ProviderAvailability {
  status: ProviderStatus
  reason?: string
  /** What an operator would have to do to make this work. */
  remediation?: string
}

export interface ProviderResult {
  status: ProviderStatus
  /** True only when the provider confirms the thing actually happened. */
  delivered: boolean
  /** The provider's own reference, when there is one. */
  externalId?: string | null
  reason?: string
  failureKind?: string | null
}

/**
 * The qualification policy — DATA, not code.
 *
 * Threshold, SLA and hysteresis all live here so the business can change them
 * by publishing a version rather than by editing the engine.
 */
export const POLICY_STATUSES = ['provisional', 'business_approved'] as const
export type PolicyStatus = (typeof POLICY_STATUSES)[number]

export interface QualificationPolicy {
  version: string
  status: PolicyStatus
  description: string
  /** A score at or above this qualifies. */
  threshold: number
  /**
   * Optional hysteresis: a qualified lead stays qualified until the score
   * falls below (threshold - band).
   *
   * ZERO by default. A band is a real business rule about how much flapping is
   * tolerable, and inventing one would quietly become "once hot, always hot".
   */
  deQualifyBand: number
  /** Minutes from qualification to the follow-up due time. */
  slaMinutes: number
  /** Whether crossing the threshold may create an alert and a task at all. */
  createAlert: boolean
  createFollowUpTask: boolean
  /** Whether a task already created is cancelled when a lead de-qualifies. */
  cancelTaskOnDeQualification: boolean
  notes: string[]
}

/** The outcome of comparing one score to one threshold. Pure and deterministic. */
export interface QualificationDecision {
  status: QualificationStatus
  qualifies: boolean
  score: number
  threshold: number
  /** Positive when above, negative when below. Always stated. */
  difference: number
  reason: string
}

/** One piece of evidence, referenced from Task #984 rather than recreated. */
export interface QualificationEvidence {
  intentScoreContributionId: string | null
  engagementEventId: string
  eventType: string
  channel: string
  contribution: number
  occurredAt: Date
}
