import { describe, expect, it } from 'vitest'
import { toActivity } from '../../src/crm/nxtSales/mappers.js'
import { assessReply, engagementSignal, isAutomatedMessage, summariseInbound } from '../../src/warmleads/replies.js'

// An automated-LOOKING SUBJECT never decides alone when the message text was read. Customers reply under OUR subject line, so "Re: Out of office
// furniture crates quote" can carry a person's explicit "please unsubscribe me". A genuine refusal in the person's own (unquoted) words wins; real
// mail-system output (auto-replies, bounces) is still recognised, and with no text at all the subject is all there is.

const NOW = new Date('2026-11-10T00:00:00Z')
const mk = (subject: string, body: string | undefined) =>
  toActivity(
    { id: 'a1', type: 'email', companyId: 'c1', subject, direction: 'inbound', createdAt: '2026-11-09T10:00:00Z', ...(body === undefined ? {} : { body }), fromEmail: 'p@cust.example', mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example' },
    body !== undefined,
    NOW,
  )
const signalOf = (a: ReturnType<typeof mk>) => engagementSignal([a], NOW, undefined, 30, { requireText: true })

describe('a genuine refusal is not discarded because the subject looks automated', () => {
  it('THE REVIEW\'S EXAMPLE: "Re: Out of office furniture crates quote" + "Please unsubscribe me and stop sending emails." is a person\'s opt-out', () => {
    const a = mk('Re: Out of office furniture crates quote', 'Please unsubscribe me and stop sending emails.')
    expect(isAutomatedMessage(a)).toBe(false)
    expect(assessReply(a, true)).toMatchObject({ verdict: 'declined', kind: 'opt_out', basis: 'text' })
    const s = summariseInbound([a], NOW, undefined, true)
    expect(s.automated).toEqual([])
    expect(s.declined).toHaveLength(1)
    expect(signalOf(a)).toMatchObject({ signalType: 'reply_opt_out', polarity: 'neutral' }) // not "automated_inbound_only", and not silence
  })

  it('the same under the other automated-looking subjects ("do not reply", "on leave", "no-reply", "Automatic reply:")', () => {
    for (const subject of ['Re: Do not reply to old quotes', 'Re: Crates while on leave', 'Re: no-reply crates quote', 'Automatic reply: crates quote', 'Re: OOO crates']) {
      const a = mk(subject, 'Please remove us from your mailing list.')
      expect(isAutomatedMessage(a), subject).toBe(false)
      expect(assessReply(a, true), subject).toMatchObject({ verdict: 'declined', kind: 'opt_out' })
      expect(signalOf(a), subject).toMatchObject({ signalType: 'reply_opt_out' })
    }
  })

  it('an out-of-office that ALSO asks to be removed is a person\'s reply; a plain "not interested" under such a subject is a refusal too', () => {
    expect(isAutomatedMessage(mk('Out of office: crates', 'I am out of the office until Monday. Please unsubscribe me.'))).toBe(false)
    expect(assessReply(mk('Re: Out of office crates quote', 'Not interested, thanks.'), true)).toMatchObject({ verdict: 'declined', kind: 'not_interested' })
  })

  it('the person\'s UNQUOTED words decide: a refusal that is only in the quoted earlier message or a footer does not turn mail-system output into a person\'s reply', () => {
    const quoted = mk('Automatic reply: crates quote', 'I am out of the office until Monday.\n\nOn Mon, 3 Nov 2026, Sales <sales@ours.example> wrote:\n> To unsubscribe reply STOP\n> Please do not email me again')
    expect(isAutomatedMessage(quoted)).toBe(true)
    const footer = mk('Out of office', 'I am away until Monday.\n\nClick here to unsubscribe')
    expect(isAutomatedMessage(footer)).toBe(true)
  })
})

describe('real mail-system output is still recognised', () => {
  it('an out-of-office / auto-reply body under an automated subject stays automated, and says nothing about a person', () => {
    const a = mk('Automatic reply: crates quote', 'I am out of the office until Monday and will reply on my return. For urgent matters contact John.')
    expect(isAutomatedMessage(a)).toBe(true)
    expect(signalOf(a)).toMatchObject({ signalType: 'automated_inbound_only' })
  })

  it('a bounce stays automated', () => {
    expect(isAutomatedMessage(mk('Undeliverable: crates quote', 'Your message to x@y.example could not be delivered. The address was not found.'))).toBe(true)
    expect(isAutomatedMessage(mk('Delivery Status Notification (Failure)', 'The recipient mailbox does not exist.'))).toBe(true)
  })

  it('"X no longer works here" / a declined meeting are mail-system wording, not a refusal that turns an auto-reply into a person\'s reply', () => {
    expect(isAutomatedMessage(mk('Automatic reply: crates', 'Ravi is no longer with the company. Please write to sales@cust.example.'))).toBe(true)
    expect(isAutomatedMessage(mk('Out of office', 'This meeting has been declined. I am away until Monday.'))).toBe(true)
  })

  it('with NO text at all the subject is all there is: still automated', () => {
    expect(isAutomatedMessage(mk('Out of office', undefined))).toBe(true)
  })
})

describe('a body that was cut is never trusted to hold no refusal', () => {
  it('automated subject + a long body whose end was not read: judged as a person\'s message, so never interest and never silently dropped', () => {
    const a = mk('Re: Out of office furniture crates quote', 'Thanks for the offer. '.repeat(400) + 'Please remove us from your mailing list.')
    expect(isAutomatedMessage(a)).toBe(false)
    const r = assessReply(a, true)
    expect(r.verdict).not.toBe('interested')
    expect(signalOf(a)?.polarity).not.toBe('positive')
  })
})
