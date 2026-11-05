import type { CrmActivity } from '../crm/types.js'
import { RECENT_ACTIVITY_DAYS } from '../intent/providers/crmProvider.js'
import type { ObservedSignal } from './score.js'

// WARM LEADS — what counts as a reply (2026-10-31, text added 2026-11-05). Pure: no I/O.
//
// NXT Sales files every message that comes IN to a mailbox as an inbound email,
// including the mail system's own: delivery failures, out-of-office notices,
// automatic replies. The first 30-company test called AWFS "warm: replied in the
// last 90 days" on the strength of "Delivery Status Notification (Failure)" —
// the bounce of OUR email, the opposite of interest. A reply is a message a
// person wrote. Automated mail is listed so it can be seen, and counts for
// nothing.
//
// And a reply is not always interest: "please unsubscribe us" is a message a person wrote. The
// subject is read, and so is what the person wrote in the message itself (the text that NXT Sales
// already returns with each email on the authorised /api/activities read; quoted earlier messages
// and signatures are cut off first). A reply whose text is not available is "unverified" and never
// counts as interest. The text is read in memory and is never stored.

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

/**
 * Words that say NO: unsubscribe, stop writing, not interested, wrong person. A message that says it is a reply, but the
 * opposite of buying intent, so it never counts as interest. The same list is applied to the subject and to what the person
 * wrote. (Deliberately not "no need": "no need to call, just email me" is not a refusal.)
 */
const REFUSALS: RegExp[] = [
  /\bun-?subscri(?:be|bed|bing)\b/i,
  /\bopt[- ]?(?:out|ing out)\b/i,
  /\b(?:remove|take|delete)\s+(?:me|us|my|our)\b[^.!?]{0,40}?\b(?:list|mailing|database|contacts?|e-?mails?|details|address|off)\b/i,
  /\btake\s+(?:me|us)\s+off\b/i,
  /\bstop\s+(?:e-?mailing|sending|contacting|mailing|writing|messaging|spamming)\b/i,
  /\b(?:do\s*not|don'?t|dont|never)\s+(?:e-?mail|contact|send|write|call|message)\b/i,
  /\b(?:not|no\s+longer|never)\s+(?:really\s+|currently\s+)?interested\b/i,
  /\bno\s+(?:further\s+)?interest\b/i,
  /\bnot\s+(?:looking|in\s+the\s+market|in\s+need)\b/i,
  /\b(?:do\s*not|don'?t|dont)\s+need\b/i,
  /\bnot\s+(?:relevant|applicable|a\s+(?:good\s+)?fit)\b/i,
  /\bno,?\s+thank(?:s|\s+you)\b/i,
  /\bwrong\s+(?:person|contact|company|address|e-?mail)\b/i,
  /\bnot\s+the\s+right\s+(?:person|contact)\b/i,
  /\b(?:this\s+is|it'?s)\s+spam\b/i,
]

/** The first refusal in a text, as the few words that matched (at most 60 characters), or null. */
export function refusalIn(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/[‘’]/g, "'")
  for (const re of REFUSALS) {
    const m = re.exec(t)
    if (m) return m[0].replace(/\s+/g, ' ').toLowerCase().slice(0, 60)
  }
  return null
}

export function isDecliningReply(subject: string | null | undefined): boolean {
  return refusalIn(subject) !== null
}

/** Where the quoted earlier messages begin in an e-mail's text (it arrives with the line breaks already removed). */
const QUOTE_STARTS: RegExp[] = [
  /\bon\s+(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}[\s/.-]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[^]{0,150}?\bwrote\s*:/i, // On Tue, 3 Nov 2026, A <a@b> wrote:
  /-{2,}\s*(?:original message|forwarded message|reply above this line)\s*-{2,}/i,
  /_{5,}/,
  /\bfrom\s*:[^]{0,200}?\b(?:sent|date)\s*:/i, // an Outlook header block
  /\bde\s*:[^]{0,200}?\benvoy[eé]/i,
  /(?:^|\s)>\s?[^\s>]/, // a quoted line
]
/** Where a signature or a standard footer begins. */
const SIGNATURE_STARTS: RegExp[] = [
  /\s--\s/,
  /\bsent from my\b/i,
  /\bget outlook for\b/i,
  /\b(?:best|kind|warm|kindest|with kind|many)\s+regards\b/i,
  /\bregards,/i,
  /\byours\s+(?:sincerely|faithfully|truly)\b/i,
  /\bsincerely\b/i,
  /\bconfidentiality notice\b/i,
  /\bthis\s+(?:e-?mail|message)(?:\s+and\s+any\s+attachments)?\s+(?:is|are|may\s+contain|contains)\b/i,
  /\bdisclaimer\b/i,
]

/**
 * What the person wrote in THIS message: the text before the quoted earlier messages and before the signature or footer
 * (a footer often says "unsubscribe", and a quoted copy of our own mail says things the person did not).
 */
export function ownWords(text: string | null | undefined): string {
  let t = (text ?? '').replace(/\s+/g, ' ').trim()
  let cut = t.length
  for (const re of [...QUOTE_STARTS, ...SIGNATURE_STARTS]) {
    const m = re.exec(t)
    if (m && m.index < cut) cut = m.index
  }
  t = t.slice(0, cut).trim()
  return t.slice(0, 1500)
}

export type ReplyVerdict = 'interested' | 'declined' | 'unverified'
export interface ReplyAssessment {
  activity: CrmActivity
  verdict: ReplyVerdict
  /** The few words of a refusal, when there is one. */
  phrase: string | null
  /** What the verdict rests on: the subject, the person's own words, or nothing readable. */
  basis: 'subject' | 'text' | 'no_text'
}

const CALENDAR_ANSWER = /^\s*(?:tentatively\s+)?accepted\b/i

/**
 * Whether one message a person wrote is a refusal, interest, or cannot be told.
 *   declined    the subject or the person's own words refuse
 *   interested  the person's own words were read and refuse nothing (or a calendar invitation was accepted)
 *   unverified  the text was not available or held nothing of the person's own - never counted as interest
 * With `requireText` false and no text loaded (the test sample only needs to find replies) only the subject is read.
 */
export function assessReply(a: CrmActivity, requireText: boolean): ReplyAssessment {
  const bySubject = refusalIn(a.subject)
  if (bySubject) return { activity: a, verdict: 'declined', phrase: bySubject, basis: 'subject' }
  if (a.body === undefined) return requireText ? { activity: a, verdict: 'unverified', phrase: null, basis: 'no_text' } : { activity: a, verdict: 'interested', phrase: null, basis: 'subject' }
  const own = ownWords(a.body)
  const byText = refusalIn(own)
  if (byText) return { activity: a, verdict: 'declined', phrase: byText, basis: 'text' }
  if (!own) return CALENDAR_ANSWER.test(a.subject ?? '') ? { activity: a, verdict: 'interested', phrase: null, basis: 'subject' } : { activity: a, verdict: 'unverified', phrase: null, basis: 'no_text' }
  return { activity: a, verdict: 'interested', phrase: null, basis: 'text' }
}

export interface InboundSummary {
  /** Messages a person wrote that the subject does not refuse, inside the window, newest first. */
  replies: CrmActivity[]
  /** Automated inbound mail inside the window (bounces, auto-replies). */
  automated: CrmActivity[]
  /** Replies whose SUBJECT declines or asks not to be contacted: listed, never counted as interest. */
  declined: CrmActivity[]
  /** Every message a person wrote inside the window, newest first. */
  written: CrmActivity[]
}

export function summariseInbound(activities: CrmActivity[], now: Date = new Date(), days: number = RECENT_ACTIVITY_DAYS): InboundSummary {
  const cutoff = now.getTime() - days * 86_400_000
  const inbound = activities
    .filter((a) => a.direction === 'inbound' && new Date(a.createdAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const automated = inbound.filter((a) => isAutomatedEmail(a.subject))
  const written = inbound.filter((a) => !isAutomatedEmail(a.subject))
  return { replies: written.filter((a) => !isDecliningReply(a.subject)), automated, declined: written.filter((a) => isDecliningReply(a.subject)), written }
}

/** Whether a company has a real reply in the window (used to find them for the test sample). */
export const hasRecentReply = (activities: CrmActivity[], now?: Date): boolean => summariseInbound(activities, now).replies.length > 0

/**
 * The engagement signal for an evaluation, from the emails themselves.
 * Replaces the CRM provider's own, which counts any inbound message.
 *
 * The NEWEST message a person wrote decides: a refusal after a friendly reply withdraws the interest; a friendly reply after a
 * refusal counts. If the newest message cannot be read (`requireText` and no text, or nothing of the person's own) it is
 * "unverified" - listed, scoring nothing, never interest - even when an older message was friendly.
 */
export function engagementSignal(
  activities: CrmActivity[],
  now: Date = new Date(),
  days: number = RECENT_ACTIVITY_DAYS,
  freshDays: number = 30,
  opts: { requireText?: boolean } = {},
): ObservedSignal | null {
  const { automated, written } = summariseInbound(activities, now, days)
  const base = { signalCategory: 'crm', confidence: 'high', freshness: 'unknown', status: 'active', sourceUrl: null }
  const seen = (a: CrmActivity) => `Inbound email "${a.subject ?? '(no subject)'}" on ${a.createdAt.slice(0, 10)}`
  if (written.length) {
    const assessed = written.map((a) => assessReply(a, opts.requireText === true))
    const latest = assessed[0]!
    if (latest.verdict === 'declined') {
      const n = assessed.filter((x) => x.verdict === 'declined').length
      return {
        ...base,
        signalType: 'reply_declined',
        polarity: 'neutral',
        summary: `${n} reply(ies) in the last ${days} days declining or asking not to be contacted — not interest. Consider adding the company to the suppression list`,
        evidence: `${seen(latest.activity)}${latest.basis === 'text' ? `; the message says "${latest.phrase}"` : ''}`,
        observedAt: latest.activity.createdAt,
      }
    }
    if (latest.verdict === 'unverified') {
      return {
        ...base,
        signalType: 'reply_unverified',
        polarity: 'neutral',
        summary: "The newest reply could not be checked (its text was not available or held nothing of the person's own words) — not counted as interest",
        evidence: seen(latest.activity),
        observedAt: latest.activity.createdAt,
      }
    }
    const interested = assessed.filter((x) => x.verdict === 'interested')
    // FRESH = the latest reply is within freshDays (Intent Signals' own INTENT_FRESH_DAYS); older in the window is aging.
    const ageDays = (now.getTime() - new Date(latest.activity.createdAt).getTime()) / 86_400_000
    return {
      ...base,
      freshness: ageDays <= freshDays ? 'fresh' : 'aging',
      signalType: 'inbound_engagement',
      polarity: 'positive',
      summary: `${interested.length} reply(ies) written by a person in the last ${days} days${latest.basis === 'text' ? ', the newest read and containing no refusal' : ''}`,
      evidence: seen(latest.activity),
      observedAt: latest.activity.createdAt,
    }
  }
  if (automated.length) {
    const latest = automated[0]!
    return {
      ...base,
      signalType: 'automated_inbound_only',
      polarity: 'neutral',
      summary: `${automated.length} automated inbound message(s) in the last ${days} days (delivery failure or auto-reply) — not a reply from a person`,
      evidence: seen(latest),
      observedAt: latest.createdAt,
    }
  }
  return null
}
