import type { CrmActivity } from '../crm/types.js'
import { RECENT_ACTIVITY_DAYS } from '../intent/providers/crmProvider.js'
import type { ObservedSignal } from './score.js'

// WARM LEADS — what counts as a reply (2026-10-31). Pure: no I/O.
//
// NXT Sales files every message that comes IN to a mailbox as an inbound email,
// including the mail system's own: delivery failures, out-of-office notices,
// automatic replies. The first 30-company test called AWFS "warm: replied in the
// last 90 days" on the strength of "Delivery Status Notification (Failure)" —
// the bounce of OUR email, the opposite of interest. A reply is a message a
// person wrote. Automated mail is listed so it can be seen, and counts for
// nothing.

/** Subjects that automated mail carries: bounces, out-of-office, auto-replies, no-reply senders. */
const AUTOMATED_SUBJECT = new RegExp(
  [
    'delivery status notification',
    'undeliver(able|ed)',
    'delivery (has )?failed',
    'delivery failure',
    'mail delivery (subsystem|failed|failure)',
    'returned mail',
    'mail system error',
    'failure notice',
    'message (not delivered|blocked|rejected)',
    'could not be delivered',
    '^\\s*(automatic|auto)[ -]?reply',
    '^\\s*auto[- ]?response',
    '^\\s*autoreply',
    'out of (the )?office',
    '^\\s*ooo\\b',
    'away from (my )?(desk|office|email)',
    'on (annual )?(leave|vacation|holiday)',
    'no[- ]?reply',
    'do not reply',
    'read receipt',
    // NOT calendar answers ("Accepted: ..."): a person accepting a meeting is engagement.
  ].join('|'),
  'i',
)

export function isAutomatedEmail(subject: string | null | undefined): boolean {
  return AUTOMATED_SUBJECT.test(subject ?? '')
}

export interface InboundSummary {
  /** Messages a person wrote, inside the window, newest first. */
  replies: CrmActivity[]
  /** Automated inbound mail inside the window (bounces, auto-replies). */
  automated: CrmActivity[]
}

export function summariseInbound(activities: CrmActivity[], now: Date = new Date(), days: number = RECENT_ACTIVITY_DAYS): InboundSummary {
  const cutoff = now.getTime() - days * 86_400_000
  const inbound = activities
    .filter((a) => a.direction === 'inbound' && new Date(a.createdAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return { replies: inbound.filter((a) => !isAutomatedEmail(a.subject)), automated: inbound.filter((a) => isAutomatedEmail(a.subject)) }
}

/** Whether a company has a real reply in the window (used to find them for the test sample). */
export const hasRecentReply = (activities: CrmActivity[], now?: Date): boolean => summariseInbound(activities, now).replies.length > 0

/**
 * The engagement signal for an evaluation, from the emails themselves.
 * Replaces the CRM provider's own, which counts any inbound message.
 */
export function engagementSignal(activities: CrmActivity[], now: Date = new Date(), days: number = RECENT_ACTIVITY_DAYS, freshDays: number = 30): ObservedSignal | null {
  const { replies, automated } = summariseInbound(activities, now, days)
  const base = { signalCategory: 'crm', confidence: 'high', freshness: 'unknown', status: 'active', sourceUrl: null }
  if (replies.length) {
    const latest = replies[0]!
    // FRESH = the latest reply is within freshDays (Intent Signals' own INTENT_FRESH_DAYS); older in the window is aging.
    const ageDays = (now.getTime() - new Date(latest.createdAt).getTime()) / 86_400_000
    return {
      ...base,
      freshness: ageDays <= freshDays ? 'fresh' : 'aging',
      signalType: 'inbound_engagement',
      polarity: 'positive',
      summary: `${replies.length} reply(ies) written by a person in the last ${days} days`,
      evidence: `Inbound email "${latest.subject ?? '(no subject)'}" on ${latest.createdAt.slice(0, 10)}`,
      observedAt: latest.createdAt,
    }
  }
  if (automated.length) {
    const latest = automated[0]!
    return {
      ...base,
      signalType: 'automated_inbound_only',
      polarity: 'neutral',
      summary: `${automated.length} automated inbound message(s) in the last ${days} days (delivery failure or auto-reply) — not a reply from a person`,
      evidence: `Inbound email "${latest.subject ?? '(no subject)'}" on ${latest.createdAt.slice(0, 10)}`,
      observedAt: latest.createdAt,
    }
  }
  return null
}
