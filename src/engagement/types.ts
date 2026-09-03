// TASK #983 — ENGAGEMENT vocabulary.
//
// The question this stage answers is "WHAT DID THE PROSPECT ACTUALLY DO?" —
// never "how interested are they?". So there is no score anywhere in this
// module, and no type here has a field one could be stored in. A future
// scoring engine reads these rows; it does not get help from them.
//
// Two disciplines run through the whole file:
//
//   An event names an OBSERVED ACT, not an inference. `workbench_cta_clicked`
//   is a fact. `high_interest` is a conclusion, and this stage does not draw
//   conclusions.
//
//   An event says how it was observed. A page render and a QR scan are
//   different observations even when they produce the same page, and
//   collapsing them would let "someone opened a URL" become "someone scanned
//   the code we printed".

export const ENGAGEMENT_CHANNELS = ['workbench', 'audit_report', 'email', 'linkedin', 'call', 'whatsapp'] as const
export type EngagementChannel = (typeof ENGAGEMENT_CHANNELS)[number]

/**
 * The event whitelist.
 *
 * Closed on purpose: public ingestion validates against this list, so a caller
 * cannot invent an event type, and a provider webhook cannot introduce one by
 * sending an unfamiliar string.
 */
export const ENGAGEMENT_EVENT_TYPES = [
  // ── Audit report / tracked link ──────────────────────────────────────────
  'audit_link_opened',
  'audit_report_viewed',
  'audit_report_downloaded',
  'audit_report_qr_scanned',

  // ── Workbench ────────────────────────────────────────────────────────────
  'workbench_link_opened',
  'workbench_registration_started',
  'workbench_registration_completed',
  'workbench_viewed',
  'workbench_before_viewed',
  'workbench_after_viewed',
  'workbench_comparison_used',
  'workbench_evidence_viewed',
  'workbench_cta_clicked',

  // ── Outreach lifecycle (facts about US, not about the prospect) ──────────
  'outreach_action_created',
  'outreach_action_scheduled',
  'outreach_action_blocked',
  'outreach_action_failed',

  // ── Email, only ever from a verified provider webhook ───────────────────
  'email_sent',
  'email_delivered',
  'email_opened',
  'email_clicked',
  'email_bounced',
  'email_unsubscribed',

  // ── LinkedIn: a draft we produced, or a human confirming they acted ──────
  'linkedin_draft_created',
  'linkedin_action_manually_confirmed',

  // ── Call: internal task lifecycle, never a claim that a call connected ──
  'call_task_created',
  'call_task_completed',
  'call_outcome_recorded',
] as const
export type EngagementEventType = (typeof ENGAGEMENT_EVENT_TYPES)[number]

/**
 * Event types a PUBLIC visitor may generate.
 *
 * Everything else is server-originated. A public client cannot record an email
 * bounce, an outreach lifecycle event, or a call outcome — those are facts
 * observed elsewhere, and accepting them from a browser would let anyone
 * fabricate the history of an account.
 */
export const PUBLIC_EVENT_TYPES: EngagementEventType[] = [
  'workbench_link_opened',
  'workbench_registration_started',
  'workbench_registration_completed',
  'workbench_viewed',
  'workbench_before_viewed',
  'workbench_after_viewed',
  'workbench_comparison_used',
  'workbench_evidence_viewed',
  'workbench_cta_clicked',
  'audit_report_qr_scanned',
]

/** How the event reached us. Part of the answer to "how was this observed?". */
export const ENGAGEMENT_SOURCES = [
  /** Server-rendered navigation inside the public Workbench. */
  'workbench_app',
  /** A tracked link or QR code resolving on our own server. */
  'tracked_link',
  /** A verified provider webhook. */
  'provider_webhook',
  /** The outreach engine recording its own lifecycle. */
  'outreach_engine',
  /** A human in our team confirming they did something. */
  'manual_confirmation',
] as const
export type EngagementSourceKind = (typeof ENGAGEMENT_SOURCES)[number]

/**
 * Freshness, as METADATA rather than a judgement.
 *
 * Thresholds are configurable, and the raw age in hours is stored alongside the
 * label so a later stage can reclassify without re-deriving anything. The
 * label exists to be read, not to be weighted.
 */
export const FRESHNESS_LABELS = ['fresh', 'recent', 'old', 'unknown'] as const
export type FreshnessLabel = (typeof FRESHNESS_LABELS)[number]

export const PROCESSING_STATUSES = ['recorded', 'duplicate', 'rejected'] as const
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number]

/**
 * Evidence for one event: what, where, when, who, how.
 *
 * Deliberately small. Task #983 minimises PII, so this carries references and
 * opaque identifiers rather than payloads — no raw IP, no browser
 * fingerprinting, no provider blob kept "just in case".
 */
export interface EventEvidence {
  /** WHAT was observed, in plain words. */
  what: string
  /** WHERE: a URL, a provider name, an internal surface. */
  where: string | null
  /** HOW it was observed. */
  how: string
  /** The record this event is about: an action, a demo, a link. */
  referenceKind: string | null
  referenceId: string | null
}

/** The normalized event, before it is stored. */
export interface NormalizedEvent {
  eventType: EngagementEventType
  channel: EngagementChannel
  source: EngagementSourceKind
  sourceProvider: string | null
  /** When the act happened, per the best available source. */
  occurredAt: Date
  crmCompanyId: string
  tenantId: string
  /** Opaque, hashed visitor session. Never a raw identifier. */
  sessionRef: string | null
  /** The provider's own event id, when there is one. */
  providerEventId: string | null
  workbenchDemoId: string | null
  outreachActionId: string | null
  auditRunId: string | null
  dedupeKey: string
  evidence: EventEvidence
  /** Small, whitelisted extras. Never a raw provider payload. */
  metadata: Record<string, string | number | boolean | null>
}

/**
 * Which channel an event belongs to.
 *
 * A table rather than a prefix match, so adding an event type forces a
 * deliberate decision about where it belongs.
 */
export const EVENT_CHANNEL: Record<EngagementEventType, EngagementChannel> = {
  audit_link_opened: 'audit_report',
  audit_report_viewed: 'audit_report',
  audit_report_downloaded: 'audit_report',
  audit_report_qr_scanned: 'audit_report',

  workbench_link_opened: 'workbench',
  workbench_registration_started: 'workbench',
  workbench_registration_completed: 'workbench',
  workbench_viewed: 'workbench',
  workbench_before_viewed: 'workbench',
  workbench_after_viewed: 'workbench',
  workbench_comparison_used: 'workbench',
  workbench_evidence_viewed: 'workbench',
  workbench_cta_clicked: 'workbench',

  // These four span every channel — an action can be blocked on LinkedIn just
  // as easily as on email — so the channel is a property of the ACTION, not of
  // the event type. The outreach adapter always supplies it explicitly; these
  // entries are only the fallback for a caller that does not.
  //
  // They were hard-mapped to `email` at first, which made a blocked LinkedIn
  // action appear as email activity and made the summary report LinkedIn as
  // "not observed" while LinkedIn actions existed.
  outreach_action_created: 'email',
  outreach_action_scheduled: 'email',
  outreach_action_blocked: 'email',
  outreach_action_failed: 'email',

  email_sent: 'email',
  email_delivered: 'email',
  email_opened: 'email',
  email_clicked: 'email',
  email_bounced: 'email',
  email_unsubscribed: 'email',

  linkedin_draft_created: 'linkedin',
  linkedin_action_manually_confirmed: 'linkedin',

  call_task_created: 'call',
  call_task_completed: 'call',
  call_outcome_recorded: 'call',
}

/**
 * Whether repeats of an event type are separate acts or one act reported twice.
 *
 * This is the deduplication POLICY, written down where it can be read:
 *
 *   `once_per_session`  the act only meaningfully happens once per visit.
 *                       Opening the Workbench four times in one session is one
 *                       viewing, not four.
 *
 *   `repeatable`        two occurrences are two real acts. Two CTA clicks
 *                       minutes apart are two clicks, and collapsing them
 *                       would erase something the prospect actually did.
 *
 *   `once_ever`         the act cannot recur for a given reference. An outreach
 *                       action is created exactly once.
 */
export const DEDUPE_POLICY: Record<EngagementEventType, 'once_per_session' | 'repeatable' | 'once_ever'> = {
  audit_link_opened: 'repeatable',
  audit_report_viewed: 'once_per_session',
  audit_report_downloaded: 'repeatable',
  audit_report_qr_scanned: 'repeatable',

  // Once per visit, NOT per page load. Every navigation inside the demo
  // re-renders this route, so a repeat-window would have made the count an
  // artifact of how fast someone clicked rather than a record of anything they
  // did. Known limit: a genuine return visit in the same browser, while the
  // visit cookie is still alive, is not distinguished from the first.
  workbench_link_opened: 'once_per_session',
  workbench_registration_started: 'once_per_session',
  workbench_registration_completed: 'once_ever',
  workbench_viewed: 'once_per_session',
  workbench_before_viewed: 'once_per_session',
  workbench_after_viewed: 'once_per_session',
  // Toggling back and forth IS the comparison behaviour, so each toggle counts.
  workbench_comparison_used: 'repeatable',
  workbench_evidence_viewed: 'once_per_session',
  workbench_cta_clicked: 'repeatable',

  outreach_action_created: 'once_ever',
  outreach_action_scheduled: 'once_ever',
  outreach_action_blocked: 'once_ever',
  outreach_action_failed: 'repeatable',

  // Provider webhooks dedupe on the provider's own event id instead.
  email_sent: 'once_ever',
  email_delivered: 'once_ever',
  email_opened: 'repeatable',
  email_clicked: 'repeatable',
  email_bounced: 'once_ever',
  email_unsubscribed: 'once_ever',

  linkedin_draft_created: 'once_ever',
  linkedin_action_manually_confirmed: 'repeatable',

  call_task_created: 'once_ever',
  call_task_completed: 'once_ever',
  call_outcome_recorded: 'repeatable',
}

/**
 * WHO performed the act.
 *
 * Three categories, not two, because three things genuinely happen:
 *
 *   `prospect`    they did it. Only these are evidence about them.
 *   `altiusnxt`   we did it. Our own activity is not their interest, and
 *                 counting it as such is the most misleading thing an
 *                 engagement record can do.
 *   `system`      neither party did it — a mail server bounced a message, a
 *                 provider confirmed a delivery. These are facts about the
 *                 PLUMBING. Treating a bounce as a prospect act would turn a
 *                 wrong email address into a statement of disinterest.
 *
 * A Record rather than a Set, so adding an event type forces a deliberate
 * decision about who performed it instead of silently defaulting.
 *
 * THIS IS THE ONLY CLASSIFICATION. It is published on every timeline entry so
 * that no consumer — API client, interface or report — has any reason to write
 * a second one. A duplicate map is not merely redundant: the two drift, and
 * the drift is invisible until an actor type that is rare today becomes common.
 */
export const EVENT_ACTORS = ['prospect', 'altiusnxt', 'system'] as const
/**
 * Who performed an act.
 *
 * Named as a type so it can cross the API boundary. Before it was, every
 * consumer that needed the distinction had to re-derive it from the event
 * type — and one of them did, which is how a `system` event ended up rendered
 * in the "AltiusNXT actions" lane of the interface.
 */
export type EventActor = (typeof EVENT_ACTORS)[number]

export const EVENT_ACTOR: Record<EngagementEventType, EventActor> = {
  audit_link_opened: 'prospect',
  audit_report_viewed: 'prospect',
  audit_report_downloaded: 'prospect',
  audit_report_qr_scanned: 'prospect',

  workbench_link_opened: 'prospect',
  workbench_registration_started: 'prospect',
  workbench_registration_completed: 'prospect',
  workbench_viewed: 'prospect',
  workbench_before_viewed: 'prospect',
  workbench_after_viewed: 'prospect',
  workbench_comparison_used: 'prospect',
  workbench_evidence_viewed: 'prospect',
  workbench_cta_clicked: 'prospect',

  outreach_action_created: 'altiusnxt',
  outreach_action_scheduled: 'altiusnxt',
  outreach_action_blocked: 'altiusnxt',
  outreach_action_failed: 'altiusnxt',

  email_sent: 'altiusnxt',
  // The provider accepted it. Nobody at the prospect has done anything yet.
  email_delivered: 'system',
  email_opened: 'prospect',
  email_clicked: 'prospect',
  // An address failed. That is a contactability fact, not a decision by a person.
  email_bounced: 'system',
  // A deliberate act by a person, and the clearest one in the whole vocabulary.
  email_unsubscribed: 'prospect',

  linkedin_draft_created: 'altiusnxt',
  // A member of OUR team confirming they sent something.
  linkedin_action_manually_confirmed: 'altiusnxt',

  call_task_created: 'altiusnxt',
  call_task_completed: 'altiusnxt',
  // Our SDR writing down what happened on a call, not an act of the prospect.
  call_outcome_recorded: 'altiusnxt',
}

export function isKnownEventType(value: string): value is EngagementEventType {
  return (ENGAGEMENT_EVENT_TYPES as readonly string[]).includes(value)
}

export function isPublicEventType(value: string): value is EngagementEventType {
  return isKnownEventType(value) && PUBLIC_EVENT_TYPES.includes(value)
}
