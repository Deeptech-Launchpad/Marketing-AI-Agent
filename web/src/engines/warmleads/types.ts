// Shapes returned by /api/warm-leads (src/warmleads/view.ts, companies.ts, pilot.ts).

export type Stage = 'no_company_list' | 'pilot_not_requested' | 'pilot_preparing' | 'pilot_running' | 'pilot_review' | 'pilot_failed' | 'daily'

export interface Counts {
  total: number
  pending: number
  inProgress: number
  evaluated: number
  warm: number
  earlySignal: number
  cold: number
  insufficientData: number
  existingCustomer: number
  activeOpportunity: number
  doNotContact: number
  humanReview: number
  failed: number
  needsReevaluation: number
  researchIncomplete: number
  notInCrm: number
}

export interface Usage {
  bucket: string
  geminiCalls: number
  geminiCeiling: number
  companiesStarted: number
  companyLimit: number
  retriesStarted: number
  retryLimit: number
  screened: number
  deepResearched: number
  completed: number
  failed: number
  incomplete: number
  pricedCostUsd: number
  unpricedCalls: number
  stoppedReason: string | null
}

export interface PilotCounts {
  total: number
  queued: number
  running: number
  done: number
  failed: number
  incomplete: number
  warm: number
  earlySignal: number
  cold: number
  insufficientData: number
  humanReview: number
  other: number
}

export interface Overview {
  stage: Stage
  counts: Counts
  pilot: {
    run: { id: string; status: string; total: number; startedAt: string | null; finishedAt: string | null; failureReason: string | null } | null
    counts: PilotCounts
    approvedAt: string | null
    approvedBy: string | null
    canApprove: boolean
  }
  settings: {
    paused: boolean
    dailyCompanyLimit: number
    dailyGeminiCeiling: number
    pilotSize: number
    pilotGeminiCeiling: number
    approvedMaxCompanies: number
    approvedMaxCeiling: number
    retryShare: number
    window: { start: string; end: string; timezone: string }
    pilotApprovedAt: string | null
    pilotApprovedBy: string | null
    scaleApprovedAt: string | null
    syncEnabled: boolean
    syncApprovedAt: string | null
  }
  listRefresh: { requestedAt: string | null; refreshedAt: string | null; state: string | null; message: string | null }
  server: { workerEnabled: boolean; syncSwitchOn: boolean; geminiKeyProblem: string | null; syncLiveAllowed: boolean }
  windowOpenNow: boolean
  bucket: string
  today: Usage | null
  usage: Usage[]
}

export interface Reason {
  signal: string
  polarity: string
  points: number
  summary: string
  evidence: string | null
  sourceUrl: string | null
  observedAt: string | null
  freshness?: string | null
  source: string
}

/** One opt-out found in a reply: masked address, day, status and the NXT Sales activity to open. Never a raw address or message text. */
export interface OptOutReviewItem {
  kind: 'proposal' | 'not_recorded' | 'reconsent' | 'omitted'
  crmCompanyId: string
  companyName: string | null
  evaluationId: string
  evaluatedAt: string | null
  status: string
  masked: string | null
  receivedOn: string | null
  activityId: string | null
  /** The company's CURRENT classification: a customer / active opportunity / do-not-contact is a warning for the approver. */
  companyClassification?: string | null
  /** true only when an administrator may approve this proposal right now (the server decides; the fingerprint itself never reaches the browser). */
  approvable?: boolean
  /** For a pending proposal that cannot be approved: why (switch_off | key_not_configured | key_changed | no_fingerprint). */
  approvalBlockedReason?: string | null
  /** The standard phrase the email consists of, by our own label. */
  phrase?: string | null
  /** The exact reason this proposal was generated, in words. */
  reason?: string | null
  summary: string
  /** The person who approved the proposal, when one did. */
  approvedBy?: string | null
}

export interface Evaluation {
  id: string
  crmCompanyId: string
  companyName: string | null
  website: string | null
  status: 'queued' | 'running' | 'done' | 'failed'
  classification: string | null
  score: number | null
  confidence: string | null
  summary: string | null
  reasons: Reason[] | null
  deepCheck: string | null
  tier: string | null
  researchIncomplete: boolean
  geminiCalls: number
  costUsd: number
  error: string | null
  evaluatedAt: string | null
  bucket: string | null
}

export interface CompanyRow {
  id: string
  crmCompanyId: string
  name: string
  domain: string | null
  country: string | null
  industry: string | null
  state: 'pending' | 'queued' | 'running' | 'evaluated' | 'failed' | 'needs_reevaluation'
  cohort: string | null
  classification: string | null
  score: number | null
  confidence: string | null
  summary: string | null
  evaluatedAt: string | null
  researchIncomplete: boolean
  attempts: number
  lastError: string | null
  nextAttemptAt: string | null
  syncedEvaluationId: string | null
  currentEvaluationId: string | null
  syncedAt: string | null
  syncError: string | null
}

export type Filter = 'all' | 'pending' | 'in_progress' | 'warm' | 'early_signal' | 'cold' | 'insufficient_data' | 'existing_customer' | 'active_opportunity' | 'do_not_contact' | 'human_review' | 'failed' | 'needs_reevaluation' | 'research_incomplete'
