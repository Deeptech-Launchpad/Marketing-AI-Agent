import { dayWindow, localDateStart, sameOrNextBusinessDay, withinOneBusinessDay, type Window } from './businessDays.js'
import { EXPO, STAGE_TEMPLATES, type StageKey } from './templates.js'

// THE SEQUENCE, AS RULES OVER WHAT HAS HAPPENED.
//
// Pure: given the stage actions (what was drafted, approved, marked sent),
// the replies Sales confirmed, and the time, it says where every stage stands
// and what should happen next. Nothing is stored about "the current stage";
// it is derived every time from the facts, so it cannot drift from them.
//
// The rules are the PDF's (USA - UPDATED VERSION), with D0 = the day the
// initial email was marked sent:
//
//   no reply:  2.3 Day 9–10 · 2.4 Day 12–14 · 3 Day 16–18 · 4 Day 18–20, then stop.
//              "wait until Day 4–5" is a reminder to check for a reply, not an email.
//   a reply:   sent SKUs → 2.1 same or next business day, then 2.2 within 1
//              business day of the SKUs; interested but can't attend the expo →
//              3.1 same or next business day. Any confirmed reply ends the
//              no-reply track.
//
// A no-reply stage can be prepared from 2 days before its window opens, once
// the stage before it was sent or skipped. It never becomes "sendable" on its
// own: every stage is a draft a person reviews, approves and sends.

export const REPLY_CLASSES = [
  'sent_skus',
  'interested_cannot_attend_expo',
  'interested_no_skus',
  'wants_more_info',
  'not_interested',
  'follow_up_later',
  'unclear',
] as const
export type ReplyClass = (typeof REPLY_CLASSES)[number]

/** One stage action as the machine needs it. */
export interface StageAction {
  stageKey: StageKey
  status: string // draft | ready_to_send | sent | cancelled | skipped
  sentAt: Date | null
}

export interface ConfirmedReply {
  receivedAt: Date
  classification: ReplyClass
}

export interface SequenceInput {
  /** OutreachCampaign.status: active | paused | completed | cancelled. */
  campaignStatus: string
  actions: StageAction[]
  replies: ConfirmedReply[]
  now: Date
  tz: string
}

export type StageStatus =
  | 'done' // marked sent
  | 'approved' // approved, waiting to be sent by a person
  | 'drafted' // a draft is waiting for review
  | 'due' // can be prepared now
  | 'overdue' // its window has passed and it was not sent
  | 'upcoming' // its window has not opened yet
  | 'skipped' // Sales skipped it
  | 'not_applicable' // this prospect's path does not include it

export interface StageView {
  stageKey: StageKey
  label: string
  pdfRef: string
  track: 'initial' | 'no_reply' | 'reply'
  status: StageStatus
  window: Window | null
  /** Why it is not applicable, skipped or blocked — in words Sales can act on. */
  reason: string | null
  /** A draft may be prepared (or regenerated) for it now. */
  canPrepare: boolean
}

export type Phase =
  | 'not_started'
  | 'initial' // the initial email is being prepared, approved or sent
  | 'no_reply' // sent, no reply: the no-reply track runs
  | 'replied' // a reply moved the prospect onto the reply track
  | 'sales_to_reply' // they replied, and no approved template fits
  | 'paused'
  | 'stopped'
  | 'completed'

export interface SequenceView {
  phase: Phase
  stages: StageView[]
  next: { stageKey: StageKey | null; text: string; window: Window | null; overdue: boolean }
  /** Timeline reminders that are not emails ("check for a reply"). */
  reminders: Array<{ label: string; window: Window }>
  /** D0, when the initial email was marked sent. */
  initialSentAt: Date | null
}

const NO_REPLY_TRACK: Array<{ key: StageKey; from: number; to: number }> = [
  { key: 'noreply_followup', from: 9, to: 10 },
  { key: 'noreply_report', from: 12, to: 14 },
  { key: 'expo_invite', from: 16, to: 18 },
  { key: 'breakup', from: 18, to: 20 },
]

/** A no-reply stage may be prepared this long before its window opens. */
const PREPARE_LEAD_MS = 2 * 86_400_000

const META = new Map(STAGE_TEMPLATES.map((t) => [t.key, t]))
const labelOf = (key: StageKey) => META.get(key)!.label
const pdfRefOf = (key: StageKey) => (key === 'initial' ? '1' : META.get(key)!.pdfRef)

/** The latest action for a stage that still counts (a rejected draft does not). */
function actionFor(actions: StageAction[], key: StageKey): StageAction | null {
  const live = actions.filter((a) => a.stageKey === key && a.status !== 'cancelled')
  return live[live.length - 1] ?? null
}

function statusFromAction(a: StageAction | null): StageStatus | null {
  if (!a) return null
  if (a.status === 'sent') return 'done'
  if (a.status === 'ready_to_send') return 'approved'
  if (a.status === 'skipped') return 'skipped'
  if (a.status === 'draft') return 'drafted'
  return null
}

function timeStatus(window: Window, now: Date): StageStatus {
  if (now.getTime() > window.end.getTime()) return 'overdue'
  if (now.getTime() >= window.start.getTime() - PREPARE_LEAD_MS) return 'due'
  return 'upcoming'
}

export function computeSequence(input: SequenceInput): SequenceView {
  const { actions, now, tz } = input
  const replies = [...input.replies].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
  const stages: StageView[] = []

  // ── The initial email ─────────────────────────────────────────────────
  const initial = actionFor(actions, 'initial')
  const initialSentAt = initial?.status === 'sent' ? initial.sentAt : null
  const initialStatus = statusFromAction(initial) ?? 'due'
  stages.push({
    stageKey: 'initial',
    label: 'Cold outreach (Version 1, 2 or 3)',
    pdfRef: pdfRefOf('initial'),
    track: 'initial',
    status: initialStatus,
    window: null,
    reason: null,
    canPrepare: !initial || initial.status === 'draft',
  })

  const replied = replies.length > 0
  const stopped = input.campaignStatus === 'cancelled'
  const paused = input.campaignStatus === 'paused'

  // ── The no-reply track ────────────────────────────────────────────────
  const expoStart = localDateStart(EXPO.startsOn, tz)
  let previousClosed = Boolean(initialSentAt) // the stage before is sent or skipped
  let breakupSent = false
  for (const s of NO_REPLY_TRACK) {
    const a = actionFor(actions, s.key)
    const window = initialSentAt ? dayWindow(initialSentAt, s.from, s.to, tz) : null
    const fromAction = statusFromAction(a)
    let status: StageStatus
    let reason: string | null = null
    let canPrepare = false

    if (fromAction === 'done' || fromAction === 'skipped') {
      status = fromAction
    } else if (!initialSentAt) {
      status = 'upcoming'
      reason = 'Counts from the day the initial email is marked sent.'
    } else if (replied) {
      status = 'not_applicable'
      reason = 'The prospect replied, so the no-reply follow-ups no longer apply.'
    } else if (s.key === 'expo_invite' && window && window.start.getTime() >= expoStart.getTime()) {
      status = 'not_applicable'
      reason = `This stage would fall on or after the expo (${EXPO.name}, ${EXPO.startsOn}), so there is nothing to invite them to.`
    } else if (breakupSent) {
      status = 'not_applicable'
      reason = 'The break-up email was sent; the sequence has ended.'
    } else {
      status = fromAction ?? timeStatus(window!, now)
      canPrepare = previousClosed && status !== 'upcoming' && (!a || a.status === 'draft')
      if (!previousClosed && !fromAction) reason = 'Waits until the stage before it is sent or skipped.'
    }

    if (stopped || paused) canPrepare = false
    stages.push({ stageKey: s.key, label: labelOf(s.key), pdfRef: pdfRefOf(s.key), track: 'no_reply', status, window, reason, canPrepare })

    // The next stage may follow once this one is closed, or never applied.
    previousClosed = status === 'done' || status === 'skipped' || status === 'not_applicable'
    if (s.key === 'breakup' && status === 'done') breakupSent = true
  }

  // ── The reply track ───────────────────────────────────────────────────
  const skuReply = replies.filter((r) => r.classification === 'sent_skus').pop() ?? null
  const cantAttendReply = replies.filter((r) => r.classification === 'interested_cannot_attend_expo').pop() ?? null
  const replyStage = (key: StageKey, window: Window | null, applies: boolean, why: string): StageView => {
    const a = actionFor(actions, key)
    const fromAction = statusFromAction(a)
    const status: StageStatus = fromAction ?? (applies && window ? timeStatus(window, now) : 'not_applicable')
    return {
      stageKey: key,
      label: labelOf(key),
      pdfRef: pdfRefOf(key),
      track: 'reply',
      status: fromAction === null && !applies ? 'not_applicable' : status,
      window: applies ? window : null,
      reason: fromAction === null && !applies ? why : null,
      canPrepare: applies && !stopped && !paused && (!a || a.status === 'draft'),
    }
  }
  stages.push(
    replyStage(
      'reply_followup',
      skuReply ? sameOrNextBusinessDay(skuReply.receivedAt, tz) : null,
      Boolean(skuReply),
      'Only when the prospect replies with their SKUs.',
    ),
    replyStage(
      'sku_report',
      skuReply ? withinOneBusinessDay(skuReply.receivedAt, tz) : null,
      Boolean(skuReply),
      'Only once the prospect has sent their SKUs and the report is ready.',
    ),
    replyStage(
      'expo_cannot_attend',
      cantAttendReply ? sameOrNextBusinessDay(cantAttendReply.receivedAt, tz) : null,
      Boolean(cantAttendReply),
      'Only when the prospect replies interested but unable to attend the expo.',
    ),
  )

  // ── Where the prospect is, and what happens next ──────────────────────
  const latest = replies[replies.length - 1] ?? null
  const skuReportSent = actionFor(actions, 'sku_report')?.status === 'sent'
  // Stopped and paused come from the campaign's own status, which confirming
  // a "not interested" or "follow up later" reply sets — so Sales resuming a
  // paused prospect actually resumes it.
  let phase: Phase
  if (stopped) phase = 'stopped'
  else if (paused) phase = 'paused'
  else if (skuReportSent || (breakupSent && !replied) || input.campaignStatus === 'completed') phase = 'completed'
  else if (latest && (latest.classification === 'interested_no_skus' || latest.classification === 'wants_more_info')) phase = 'sales_to_reply'
  else if (replied) phase = 'replied'
  else if (initialSentAt) phase = 'no_reply'
  else if (initial) phase = 'initial'
  else phase = 'not_started'

  const reminders: SequenceView['reminders'] = []
  if (initialSentAt && !replied) reminders.push({ label: 'Check for a reply (Day 4–5)', window: dayWindow(initialSentAt, 4, 5, tz) })

  return { phase, stages, next: nextStep(phase, stages, now), reminders, initialSentAt }
}

const ACTIVE: StageStatus[] = ['approved', 'drafted', 'overdue', 'due']

function nextStep(phase: Phase, stages: StageView[], now: Date): SequenceView['next'] {
  const none = (text: string): SequenceView['next'] => ({ stageKey: null, text, window: null, overdue: false })
  switch (phase) {
    case 'stopped':
      return none('Sequence stopped. No further outreach.')
    case 'paused':
      return none('Paused. Resume the sequence when the prospect asked to be contacted again.')
    case 'completed':
      return none('Sequence complete. No further outreach is sent after this point.')
    case 'sales_to_reply':
      return none('The prospect replied and no approved template fits — Sales to reply personally.')
  }

  // Whatever needs a person now, in the order the sequence runs.
  const order: StageKey[] = ['initial', 'reply_followup', 'sku_report', 'expo_cannot_attend', 'noreply_followup', 'noreply_report', 'expo_invite', 'breakup']
  const byKey = new Map(stages.map((s) => [s.stageKey, s]))
  for (const key of order) {
    const s = byKey.get(key)!
    if (!ACTIVE.includes(s.status)) continue
    const verb =
      s.status === 'approved'
        ? 'Send it from your mail client, then mark it sent'
        : s.status === 'drafted'
          ? 'Review and approve the draft'
          : 'Prepare the draft'
    return {
      stageKey: key,
      text: `${s.pdfRef} ${s.label}: ${verb}.`,
      window: s.window,
      overdue: s.status === 'overdue' || (s.window !== null && now.getTime() > s.window.end.getTime()),
    }
  }
  const upcoming = stages.find((s) => s.status === 'upcoming' && s.window)
  if (upcoming) return { stageKey: upcoming.stageKey, text: `${upcoming.pdfRef} ${upcoming.label}`, window: upcoming.window, overdue: false }
  if (phase === 'replied') return none('Waiting on the prospect. Paste their next reply when it arrives.')
  return none('Nothing due.')
}
