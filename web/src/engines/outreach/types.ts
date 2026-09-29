// The Sales-approved sequence, as /outreach/sequence returns it.
//
// Written from src/outreach/salesSequence/service.ts (companyView,
// listProspects), not from what the screen would like to receive. Every field
// the API can omit or null is typed that way, and the screen guards for it.

import type { CompanyContactEmail } from '../../lib/types'

export type StageKey =
  | 'initial'
  | 'reply_followup'
  | 'sku_report'
  | 'noreply_followup'
  | 'noreply_report'
  | 'expo_invite'
  | 'expo_cannot_attend'
  | 'breakup'

export type Version = 'v1' | 'v2' | 'v3'

export type ReplyClass =
  | 'sent_skus'
  | 'interested_cannot_attend_expo'
  | 'interested_no_skus'
  | 'wants_more_info'
  | 'not_interested'
  | 'follow_up_later'
  | 'unclear'

export const REPLY_LABEL: Record<ReplyClass, string> = {
  sent_skus: 'Sent SKUs',
  interested_cannot_attend_expo: 'Interested, cannot attend the expo',
  interested_no_skus: 'Interested, no SKUs yet',
  wants_more_info: 'Wants more information',
  not_interested: 'Not interested',
  follow_up_later: 'Follow up later',
  unclear: 'Unclear',
}

export interface Window {
  start: string
  end: string
}

export type Phase = 'not_started' | 'initial' | 'no_reply' | 'replied' | 'sales_to_reply' | 'paused' | 'stopped' | 'completed'

export interface NextStep {
  stageKey: StageKey | null
  text: string
  window: Window | null
  overdue: boolean
}

export interface ProspectRow {
  campaignId: string
  crmCompanyId: string
  companyName: string
  contactName: string | null
  initialVersion: Version | null
  status: string
  phase: Phase
  next: NextStep
  pendingReplies: number
  lastActivityAt: string
}

export type StageStatus = 'done' | 'approved' | 'scheduled' | 'drafted' | 'due' | 'overdue' | 'upcoming' | 'skipped' | 'not_applicable'

export interface StageView {
  stageKey: StageKey
  label: string
  pdfRef: string
  track: 'initial' | 'no_reply' | 'reply'
  status: StageStatus
  window: Window | null
  reason: string | null
  canPrepare: boolean
}

export interface Fact {
  id: string
  label: string
  value: string
  source: string
  sourceUrl: string | null
}

export interface Resolution {
  placeholder: string
  value: string | null
  source: string
  factId: string | null
}

export interface Personalization {
  templateSet?: string
  facts?: Fact[]
  resolution?: Resolution[]
  aiLine?: { status: 'added' | 'none' | 'rejected' | 'not_offered'; text: string | null; factIds: string[]; reason: string | null }
  signalsConsidered?: string[]
  signalsUsed?: string[]
  unresolved?: string[]
  model?: string | null
}

export interface GateItem {
  key: string
  ok: boolean
  label: string
  detail: string | null
}

export interface Attestation {
  key: 'ai_test' | 'report_attached'
  statement: string
  byCrmUserId: string
  at: string
}

export interface MessageInputs {
  clientCompanyName?: string | null
  skus?: string[] | null
  xOf5?: number | null
  product?: string | null
  productCategory?: string | null
  name?: string | null
  recipientEmail?: string | null
}

export interface Draft {
  actionId: string
  stageKey: StageKey
  label: string
  pdfRef: string
  version: Version | null
  status: string
  statusReason: string | null
  recipient: string | null
  recipientSource: string | null
  contactName: string | null
  contactTitle: string | null
  subject: string | null
  body: string
  draftSubject: string | null
  draftBody: string | null
  edited: boolean
  revision: number
  templateKey: string | null
  inputs: MessageInputs
  attestations: Attestation[]
  attestationDefs: Array<{ key: 'ai_test' | 'report_attached'; statement: string; maxAgeDays: number | null }>
  requiredInputs: Array<'clientCompanyName' | 'skus' | 'xOf5'>
  needsConfirmedSkus: boolean
  mentionsExpo: boolean
  personalization: Personalization | null
  dueStartAt: string | null
  dueEndAt: string | null
  approvedAt: string | null
  approvedByCrmUserId: string | null
  sentAt: string | null
  sentByCrmUserId: string | null
  /** "platform_test" when the test sender delivered it to the internal test inbox. */
  sentVia?: string | null
  /** When an approved test email is due to go (status "scheduled"). */
  scheduledAt?: string | null
  attempts?: SendAttempt[]
  gates: { ok: boolean; items: GateItem[]; warnings: string[] } | null
}

/** One delivery attempt of a test email — a preview or a scheduled test send. */
export interface SendAttempt {
  id: string
  at: string
  kind: 'preview' | 'scheduled'
  mode: string
  status: 'accepted' | 'failed' | 'blocked'
  intendedRecipient: string | null
  actualRecipients: string[]
  transport: string
  providerMessageId: string | null
  error: string | null
}

/** GET /outreach/sequence/sending — whether (test) email can go, and where. */
export interface SendingStatus {
  mode: 'off' | 'test'
  transport: 'capture' | 'smtp'
  ready: boolean
  reason: string | null
  testInbox: string | null
  allowList: string[]
}

export function isSendingStatus(v: unknown): v is SendingStatus {
  const o = v as SendingStatus | null
  return Boolean(o && typeof o === 'object' && (o.mode === 'off' || o.mode === 'test') && Array.isArray(o.allowList))
}

/** Statuses of an approved email that has not gone yet. */
export const APPROVED_UNSENT = ['ready_to_send', 'scheduled', 'failed']

export interface Reply {
  id: string
  receivedAt: string
  text: string
  modelClassification: ReplyClass | null
  modelEvidenceQuote: string | null
  modelSkus: string[]
  modelChecks: string[]
  classification: ReplyClass | null
  classificationSource: string | null
  skus: string[]
  confirmedAt: string | null
  confirmedBy: string | null
}

export interface SignalFact {
  id: string
  category: string
  summary: string
  interpretation: string | null
  outreachAngle: string | null
  evidence: string | null
  sourceUrl: string | null
  observedAt: string | null
  confidence: string
}

export interface CallPointsView {
  actionId: string
  body: string
  personalization: { points?: Array<{ text: string; factIds: string[]; source: 'ai' | 'facts' }>; dropped?: Array<{ text: string; reason: string }>; model?: string | null } | null
  updatedAt: string
}

export interface Sender {
  configured: boolean
  firstName: string
  fullName: string
  email: string
  companyName: string
  signature: string
}

export interface CompanySequence {
  crmCompanyId: string
  facts: {
    companyName: string
    companyDomain: string | null
    companySummary: string | null
    decisionMaker: {
      id: string
      fullName: string
      title: string | null
      email: string | null
      profileUrl: string | null
      /** A verified company mailbox, present only when the person has no email of their own. */
      companyContactEmail?: CompanyContactEmail | null
    } | null
    product: { name: string; url: string | null; category: string | null; description: string | null; gaps: Array<{ title: string; detail: string; severity: string }> } | null
    /** The verified product page V1/V2/V3 link to, or why there is none. */
    productPageUrl?: string | null
    productPageNote?: string | null
    signals: SignalFact[]
    discovered: boolean
  }
  gate: { ready: boolean; reason: string | null }
  sender: Sender
  campaign: {
    id: string
    status: string
    statusReason: string | null
    initialVersion: Version | null
    versionSource: string | null
    recipientEmail: string | null
    recipientEmailSource: string | null
    startedAt: string
    /** A test-batch rehearsal: its emails go only to internal test inboxes. */
    isTest?: boolean
    batchId?: string | null
  } | null
  sequence: {
    phase: Phase
    initialSentAt: string | null
    next: NextStep
    reminders: Array<{ label: string; window: Window | null }>
    stages: StageView[]
  } | null
  drafts: Draft[]
  callPoints: CallPointsView | null
  replies: Reply[]
  history: Array<{ id: string; at: string; action: string; summary: string; by: string | null }>
}

/** True only for a body this screen can actually draw. */
export function isCompanySequence(v: unknown): v is CompanySequence {
  const o = v as CompanySequence | null
  return Boolean(o && typeof o === 'object' && o.facts && typeof o.facts === 'object' && o.gate && Array.isArray(o.drafts))
}

export const PHASE_LABEL: Record<Phase, string> = {
  not_started: 'Not started',
  initial: 'Initial email',
  no_reply: 'No reply yet',
  replied: 'Replied',
  sales_to_reply: 'Sales to reply personally',
  paused: 'Paused',
  stopped: 'Stopped',
  completed: 'Completed',
}

const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const DATE_TIME = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : DATE.format(d)
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : DATE_TIME.format(d)
}

export function fmtWindow(w: Window | null | undefined): string {
  if (!w) return ''
  const a = fmtDate(w.start)
  const b = fmtDate(w.end)
  return a === b ? a : `${a} – ${b}`
}
