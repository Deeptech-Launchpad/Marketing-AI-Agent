// TASK #986 — the vocabulary of a CRM handoff.
//
// WHAT THIS STAGE DOES
//
// Takes a qualified lead from Task #985, assembles a verified package of
// everything the CRM would need, and delivers it through an approved provider.
//
// WHAT IT FOUND
//
// There is no approved write adapter. The NXT Sales API does expose write
// endpoints, and the marketing agent's service token would technically be
// authorized to use them — the ONLY thing preventing a write today is that
// `CrmPort` has no write method and the HTTP client hard-codes `method: 'GET'`.
// Adding one is an architectural and commercial decision that has not been
// taken, so this stage stops at a prepared package and says so.
//
// The language throughout reflects that. "CRM sync prepared" is what happens.
// "CRM sync completed" is reserved for a provider confirming a write.

/**
 * The overall state of one handoff.
 *
 * Deliberately more than "done" and "not done": a partial sync where the
 * company landed and the task did not is a real outcome, and collapsing it
 * would hide which half worked.
 */
export const SYNC_STATES = [
  'pending',
  'validating',
  /**
   * Validated and mapped, waiting for a PERSON to decide.
   *
   * The confirmed flow is: the AI qualifies a lead, a user reviews it, the
   * user decides, and only then is NXT Sales updated. So a package that is
   * technically ready to send stops here. This state is the review queue, and
   * nothing leaves it without an explicit approval carrying the approver's id.
   */
  'awaiting_user_approval',
  /** A person reviewed the package and declined it. Terminal until re-run. */
  'rejected_by_user',
  /** Approved by a person and waiting for a provider that can deliver it. */
  'ready',
  'syncing',
  /** Every resource the provider supports was written and confirmed. */
  'synced',
  /** Some resources landed, others were unsupported or failed. */
  'partial',
  /** No provider can write. The package is prepared and held in the outbox. */
  'blocked_provider_unavailable',
  /** Required data was missing or inconsistent. Nothing was attempted. */
  'blocked_validation',
  /** The lead is not qualified, so it never enters the CRM flow. */
  'blocked_not_qualified',
  /** Qualified but unowned, and policy requires an owner. */
  'blocked_missing_owner',
  'failed',
  'retrying',
] as const
export type SyncState = (typeof SYNC_STATES)[number]

/** The CRM objects this engine knows how to hand over. */
export const SYNC_RESOURCES = ['company', 'lead', 'activity', 'task', 'note'] as const
export type SyncResource = (typeof SYNC_RESOURCES)[number]

/** What happened to ONE resource. Recorded per resource, never averaged. */
export const RESOURCE_RESULTS = [
  'pending',
  'created',
  'updated',
  /** The record already matched; nothing needed changing. */
  'unchanged',
  /** The provider cannot write this object at all. */
  'not_supported',
  'skipped_by_policy',
  'failed',
] as const
export type ResourceResult = (typeof RESOURCE_RESULTS)[number]

/** What a provider can actually do. Detected, never assumed. */
export interface ProviderCapabilities {
  readonly canLookup: boolean
  readonly canCreate: boolean
  readonly canUpdate: boolean
  readonly canUpsert: boolean
  readonly canAttach: boolean
  /** Which CRM objects it supports at all. */
  readonly resources: SyncResource[]
}

export const PROVIDER_STATUSES = [
  'available',
  /** No provider is configured for this installation. */
  'not_configured',
  /**
   * The provider exists and is reachable, but writing is not exposed to us.
   *
   * This is the honest state for NXT Sales today: the API has write endpoints,
   * and `CrmPort` deliberately exposes none of them.
   */
  'write_not_supported',
  'unauthorized',
  'unavailable',
  'disabled_by_policy',
] as const
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number]

export interface ProviderAvailability {
  status: ProviderStatus
  reason?: string
  /** What an operator would have to do to make writing possible. */
  remediation?: string
}

/** One resource's outcome from a provider. */
export interface ResourceOutcome {
  resource: SyncResource
  result: ResourceResult
  /** The CRM's own id, when it returned one. */
  externalId?: string | null
  reason?: string
  errorCode?: string | null
  /** Whether another attempt could plausibly succeed. */
  retryable?: boolean
}

export interface SyncOutcome {
  state: SyncState
  resources: ResourceOutcome[]
  reason: string
  errorCode?: string | null
  retryable: boolean
}

/**
 * Failure kinds, split by whether retrying could ever help.
 *
 * Retrying a schema error just burns the CRM's capacity and fills the audit
 * trail with identical failures, so the split is explicit rather than a
 * judgement made at the call site.
 */
export const RETRYABLE_ERRORS = [
  'timeout',
  'connection_reset',
  'rate_limited',
  'provider_temporarily_unavailable',
  'upstream_5xx',
] as const

export const PERMANENT_ERRORS = [
  'unauthorized',
  'forbidden',
  'validation_failed',
  'missing_required_field',
  'unsupported_operation',
  'not_configured',
  'write_not_supported',
] as const

export type ErrorCode = (typeof RETRYABLE_ERRORS)[number] | (typeof PERMANENT_ERRORS)[number]

export function isRetryable(code: string | null | undefined): boolean {
  return Boolean(code) && (RETRYABLE_ERRORS as readonly string[]).includes(code as string)
}

// ── The payload ────────────────────────────────────────────────────────────
//
// Structured, bounded and minimised. Every section carries business-useful
// facts and references; none carries a credential, a raw provider payload, an
// internal debug field, or a database implementation detail.

export interface CrmCompanySection {
  /** The CRM's own id for the company this lead is about. */
  crmCompanyId: string
  name: string
  website: string | null
  domain: string | null
  industry: string | null
  country: string | null
}

export interface CrmContactSection {
  /** Present only when Task #978 verified a decision maker. */
  name: string | null
  title: string | null
  roleGroup: string | null
  /** Only ever a value a source actually stated. Never inferred. */
  email: string | null
  phone: string | null
  linkedInUrl: string | null
  contactability: string
  evidenceNote: string | null
  decisionMakerRef: string | null
}

export interface CrmQualificationSection {
  status: string
  scoreAtQualification: number
  threshold: number
  aboveThreshold: number
  reason: string
  policyVersion: string
  policyStatus: string
  engineVersion: string
  qualifiedAt: string | null
  qualificationRef: string
}

export interface CrmIntentSection {
  score: number
  level: string
  scorePolicyVersion: string
  scorePolicyStatus: string
  calculationVersion: string
  evaluatedAt: string
  /** The strongest observed acts, referenced from Task #984. */
  topContributions: Array<{
    eventType: string
    channel: string
    points: number
    occurredAt: string
    engagementEventRef: string
  }>
}

export interface CrmEngagementSection {
  latestEvent: string | null
  latestEventAt: string | null
  firstEventAt: string | null
  totalProspectActions: number
  distinctVisits: number
  channelsObserved: string[]
  /** Counts of the acts a salesperson would care about. Never a score. */
  summary: Record<string, number>
  recentEvents: Array<{
    eventType: string
    channel: string
    occurredAt: string
    engagementEventRef: string
  }>
}

export interface CrmAuditSection {
  auditRunRef: string
  auditDate: string | null
  status: string
  approvedRevision: number | null
  approvedAt: string | null
  pagesInspected: number
  productPagesInspected: number
  /** Sample-scoped, exactly as Task #979 wrote them. Never a percentage. */
  topFindings: Array<{
    title: string
    priority: string
    metric: string
    findingRef: string
    sourceUrl: string | null
  }>
}

export interface CrmWorkbenchSection {
  demoRef: string | null
  status: string | null
  productName: string | null
  /** Included only when policy allows a customer-facing link in the CRM. */
  publicUrl: string | null
  registered: boolean
  observedFieldCount: number | null
  totalFieldCount: number | null
}

export interface CrmOutreachSection {
  campaignRef: string | null
  startedAt: string | null
  dryRun: boolean | null
  /** Per-channel status. A blocked or draft action is never shown as sent. */
  actions: Array<{
    channel: string
    stepNumber: number
    status: string
    providerStatus: string | null
    scheduledAt: string | null
    sentAt: string | null
    statusReason: string | null
  }>
  lastSentAt: string | null
}

export interface CrmFollowUpSection {
  taskRef: string | null
  ownerName: string | null
  ownerCrmUserId: string | null
  dueAt: string | null
  slaMinutes: number | null
  status: string | null
  completionStatus: string | null
  recommendedAction: string | null
}

export interface CrmSyncPayload {
  payloadVersion: string
  mappingVersion: string
  generatedAt: string
  /** Correlation key the CRM can store to recognise this lead again. */
  externalKey: string
  company: CrmCompanySection
  contact: CrmContactSection
  qualification: CrmQualificationSection
  intent: CrmIntentSection
  engagement: CrmEngagementSection
  audit: CrmAuditSection
  workbench: CrmWorkbenchSection
  outreach: CrmOutreachSection
  followUp: CrmFollowUpSection
  /** Caveats that must travel with the numbers. */
  notes: string[]
}

/** One validation problem, with enough detail to act on. */
export interface ValidationIssue {
  check: string
  severity: 'error' | 'warning'
  message: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}
