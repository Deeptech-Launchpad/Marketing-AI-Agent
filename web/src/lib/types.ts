// ─────────────────────────────────────────────────────────────────────────
// Contracts, mirrored from the marketing-agent routes.
//
// Every field here exists on a real response. Where the backend can return
// null it is typed null, so a screen has to decide what to show rather than
// rendering "undefined" — that is how honest empty states stay honest.
// ─────────────────────────────────────────────────────────────────────────

export type Permission = 'view' | 'operate' | 'approve' | 'admin'
export type MemberRole = 'viewer' | 'operator' | 'approver' | 'admin'

export interface Principal {
  crmUserId: string
  email: string
  name: string
  tenantId: string
  role: MemberRole
  permissions: Permission[]
}

/** The status vocabulary the whole interface renders. */
export type UiStatus = 'ready' | 'running' | 'complete' | 'blocked' | 'review' | 'error' | 'idle'

// ── Prospect discovery (#977) ───────────────────────────────────────────
export interface ProspectSearch {
  id: string
  objective: string
  status: string
  totalMatched: number
  totalReturned: number
  mappingStatus: string | null
  requiresApproval: boolean
  createdAt: string
  finishedAt: string | null
}

// ── Enrichment (#977) ───────────────────────────────────────────────────
export interface EnrichmentRow {
  id: string
  crmCompanyId: string
  companyName: string | null
  status: string
  sourceUrl: string | null
  technologies: unknown
  technologyCount: number
  failureReason: string | null
  createdAt: string
  finishedAt: string | null
}

export interface EnrichmentList {
  enrichments: EnrichmentRow[]
  byStatus?: Record<string, number>
}

export interface DetectedTechnology {
  name: string
  category: string
  confidence: string
  evidence?: Array<{ what?: string; where?: string; fragment?: string; sourceUrl?: string }>
}

// ── Intent signals (#977) ───────────────────────────────────────────────
export interface IntentSignal {
  id: string
  signalType: string
  signalCategory: string
  summary: string
  confidence: string
  status: string
  sourceUrl: string | null
  detectedAt: string
  evidence?: unknown
}

// ── Decision makers (#978) ──────────────────────────────────────────────
export interface DecisionMakerCandidate {
  id: string
  fullName: string
  rawTitle: string | null
  normalizedTitle: string | null
  roleGroup: string | null
  seniority: string | null
  companyMatch: string
  profileUrl: string | null
  location: string | null
  email: string | null
  phone: string | null
  confidence: string
  contactability: string
  outcome: string
  rank: number | null
  evidence?: unknown
}

// ── Website audit (#979) ────────────────────────────────────────────────
export interface AuditRun {
  id: string
  crmCompanyId: string
  companyName: string | null
  startUrl: string | null
  rootHost: string | null
  status: string
  pagesFetched: number
  productPages: number
  categoryPages: number
  otherPages: number
  httpErrors: number
  unreachablePages: number
  createdAt: string
  finishedAt?: string | null
}

export interface CatalogFinding {
  id: string
  code: string
  title: string
  category: string
  priority: 'high' | 'medium' | 'low' | string
  metric: string
  finding: string
  impact: string
  recommendation: string
  affectedCount: number
  observedCount: number
  sampleSize: number
  sampleUnit: string
  evidence?: Array<{ observationId?: string; sourceUrl?: string; fragment?: string; field?: string }>
}

// ── Approval (#980) ─────────────────────────────────────────────────────
export interface ApprovalState {
  reportId: string
  status: string
  currentRevision: number
  approvedRevision: number | null
  lockVersion: number
  reviewerCrmUserId: string | null
  reviewerEmail: string | null
  reviewedAt: string | null
  decisionReason?: string | null
}

export interface ApprovalEvent {
  id: string
  action: string
  fromStatus: string | null
  toStatus: string
  reviewerEmail: string | null
  reason: string | null
  occurredAt: string
}

// ── Workbench (#981) ────────────────────────────────────────────────────
export interface WorkbenchField {
  field: string
  label: string
  before: string | null
  after: string | null
  delta: 'added' | 'restructured' | 'reworded' | 'unchanged' | 'still_absent' | string
  headline: boolean
  sourceUrl?: string | null
  sourcePath?: string | null
  sourceFragment?: string | null
  transformKind?: string
  transformRule?: string
}

export interface WorkbenchDemo {
  id: string
  status: string
  statusReason: string | null
  companyName: string | null
  productName: string | null
  productPageUrl: string | null
  observedFieldCount: number
  totalFieldCount: number
  improvedFieldCount: number
  builtFromUnapproved: boolean
  sourceReportStatus: string | null
  generatedAt: string
  fields?: WorkbenchField[]
  valuePoints?: Array<{ title: string; why: string }>
}

// ── Outreach (#982) ─────────────────────────────────────────────────────
export interface ChannelStatus {
  channel: string
  provider: string
  status: string
  reason?: string
  remediation?: string
}

export interface OutreachAction {
  id: string
  channel: string
  stepNumber: number
  status: string
  statusReason: string | null
  providerName: string | null
  providerStatus: string | null
  contactName: string | null
  destination: string | null
  scheduledAt: string | null
  sentAt: string | null
}

export interface OutreachCampaign {
  campaignId?: string
  id?: string
  companyName: string | null
  crmCompanyId?: string
  status?: string
  dryRun?: boolean
  startsAt?: string
  actions: OutreachAction[]
}

// ── Engagement (#983) ───────────────────────────────────────────────────
/** Who performed an act. Classified by the backend, never re-derived here. */
export type EventActor = 'prospect' | 'altiusnxt' | 'system'

export interface EngagementEvent {
  id: string
  eventType: string
  /**
   * The canonical actor, from the API.
   *
   * The interface previously re-derived this from the event type with its own
   * pattern list, which classified infrastructure events (a bounce, a delivery
   * receipt) as AltiusNXT actions. The classification lives in one place now.
   */
  actor: EventActor
  channel: string
  source: string
  sourceProvider: string | null
  occurredAt: string
  receivedAt: string
  freshnessLabel: string
  ageHours: number
  timestampNote: string | null
  sessionRef: string | null
  workbenchDemoId: string | null
  outreachActionId: string | null
  auditRunId: string | null
  evidence: { what: string; where: string | null; how: string; referenceKind: string | null; referenceId: string | null }
  metadata: Record<string, unknown>
}

export interface EngagementSummary {
  crmCompanyId: string
  totalEvents: number
  prospectEvents: number
  ourEvents: number
  systemEvents: number
  byChannel: Record<string, number>
  byEventType: Record<string, number>
  bySource: Record<string, number>
  firstEventAt: string | null
  lastEventAt: string | null
  lastEventFreshness: string
  lastEventAgeHours: number | null
  distinctSessions: number
  channelsObserved: string[]
  channelsNotObserved: string[]
  note?: string
}

// ── Intent scoring (#984) ───────────────────────────────────────────────
export interface IntentScore {
  crmCompanyId: string
  scored: boolean
  reason?: string
  score?: number
  rawScore?: number
  scoreRange?: { min: number; max: number }
  clamped?: boolean
  level?: 'LOW' | 'MEDIUM' | 'HIGH'
  policyVersion?: string
  policyStatus?: string
  calculationVersion?: string
  evaluatedAt?: string
  contactability?: { status: string; reasons: string[] }
  eventsConsidered?: number
  eventsScored?: number
  eventsExcluded?: number
  note?: string
}

export interface ScoreContribution {
  engagementEventId: string
  eventType: string
  channel: string
  occurredAt: string
  policyRuleId: string
  dimension: string
  basePoints: number
  freshnessMultiplier: number
  freshnessLabel: string
  ageDays: number
  contribution: number
  excluded: boolean
  reason: string
  scoringPolicyVersion: string
}

export interface ScoreBreakdown {
  crmCompanyId: string
  score: number
  rawScore: number
  scoreRange: { min: number; max: number }
  clamped: boolean
  level: string
  policyVersion: string
  policyStatus: string
  calculationVersion: string
  evaluatedAt: string
  contactability: { status: string; reasons: string[] }
  contributions: ScoreContribution[]
  setAside: ScoreContribution[]
  totals: {
    counted: number
    setAside: number
    pointsFromPositive: number
    pointsFromNegative: number
    byChannel: Record<string, number>
    byEventType: Record<string, number>
  }
  note: string
}

export interface ScoreSnapshot {
  snapshotId: string
  score: number
  rawScore: number
  level: string
  clamped: boolean
  change: number | null
  policyVersion: string
  policyStatus: string
  calculationVersion: string
  evaluatedAt: string
  trigger: string
  eventsConsidered: number
  eventsScored: number
  contactability: string
  recordedAt: string
}

export interface ScoringPolicy {
  version: string
  status: string
  description: string
  minScore: number
  maxScore: number
  rules: Array<{
    ruleId: string
    eventType: string
    points: number
    dimension: string
    decay: string
    maxPerSession: number | null
    maxOccurrences: number | null
    maxContribution: number | null
    note: string
  }>
  decayBands: Array<{ fromDays: number; toDays: number | null; multiplier: number; label: string }>
  levelBands: Array<{ level: string; fromScore: number; toScore: number }>
  scoringActors: string[]
  notes: string[]
  note?: string
}

// ── Sales qualification (#985) ──────────────────────────────────────────
export interface Qualification {
  evaluated?: boolean
  id?: string
  crmCompanyId: string
  companyName: string | null
  status?: string
  stage?: string
  intentScore?: number
  threshold?: number
  aboveThreshold?: number
  reason?: string
  qualificationPolicyVersion?: string
  qualificationEngineVersion?: string
  scorePolicyVersion?: string
  scoreCalculationVersion?: string
  scoreEvaluatedAt?: string
  intentScoreSnapshotId?: string | null
  owner?: { crmUserId: string | null; name: string | null; email: string | null; source: string; reason: string | null }
  alert?: { status: string }
  followUp?: { status: string; dueAt: string | null }
  qualifiedAt?: string | null
  deQualifiedAt?: string | null
  evaluationCount?: number
  lastEvaluatedAt?: string
  whyQualified?: {
    summary: string
    intentScore: number
    threshold: number
    aboveThreshold: number
    keyObservedActions: Array<{
      engagementEventId: string
      intentScoreContributionId: string
      eventType: string
      channel: string
      contribution: number
      occurredAt: string
    }>
  }
  alerts?: Array<{
    id: string
    status: string
    provider: string
    destination: string
    delivered: boolean
    subject?: string
    body?: string
    reason: string | null
    createdAt: string
  }>
  followUpTasks?: Array<{
    id: string
    status: string
    provider: string
    destination: string
    title: string
    body?: string
    recommendedAction?: string
    owner?: string | null
    dueAt: string
    slaMinutes: number
    completionStatus: string
    reason: string | null
  }>
  reasonText?: string
  note?: string
}

export interface QualificationTransition {
  id: string
  transition: string
  from: string | null
  to: string
  previousScore: number | null
  score: number
  threshold: number
  difference: number
  reason: string
  qualificationPolicyVersion: string
  alertStatus: string | null
  taskStatus: string | null
  actorType: string
  occurredAt: string
}

export interface QualificationPolicy {
  version: string
  status: string
  description: string
  threshold: number
  deQualifyBand: number
  slaMinutes: number
  createAlert: boolean
  createFollowUpTask: boolean
  cancelTaskOnDeQualification: boolean
  notes: string[]
  providers?: {
    alert: Array<{ name: string; destination: string; status: string; reason?: string; remediation?: string }>
    task: Array<{ name: string; destination: string; status: string; reason?: string; remediation?: string }>
  }
  note?: string
}

// ── CRM sync (#986) ─────────────────────────────────────────────────────
export interface CrmSyncResource {
  resource: string
  result: string
  externalId: string | null
  reason?: string
  errorCode?: string | null
  retryable?: boolean
}

export interface CrmSyncRecord {
  prepared?: boolean
  reason?: string
  syncId: string
  qualificationId: string
  crmCompanyId: string
  companyName: string | null
  state: string
  stateLabel: string
  provider: { name: string; status: string }
  mappingVersion: string
  payloadVersion: string
  externalKey: string
  resources: CrmSyncResource[]
  externalIds: Record<string, string>
  validation: { ok: boolean; issues: Array<{ check: string; severity: string; message: string }> }
  owner: { crmUserId: string | null; status: string }
  attempts: number
  lastAttemptAt: string | null
  lastError: { code: string; message: string } | null
  retryable: boolean
  syncedAt: string | null
  outbox?: {
    id: string
    state: string
    reason: string
    blockedBy: string | null
    attemptCount: number
    createdAt: string
  } | null
}

export interface CrmSyncProviderInfo {
  name: string
  destination: string
  capabilities: {
    canLookup: boolean
    canCreate: boolean
    canUpdate: boolean
    canUpsert: boolean
    canAttach: boolean
    resources: string[]
  }
  status: string
  reason?: string
  remediation?: string
}

export interface CrmSyncProviders {
  activeProvider: string
  providers: CrmSyncProviderInfo[]
  mappingVersion: string
  payloadVersion: string
  note: string
}

export interface CrmFieldMapping {
  source: string
  target: string
  resource: string
  disposition: 'write' | 'read_only_reference' | 'blocked_no_target_field'
  note?: string
}
