import { describe, expect, it } from 'vitest'
import type { CrmActivity } from '../../src/crm/types.js'
import { classify, COMPANY_LEVEL_REFUSALS, retryReason, type EvaluationInput, type ObservedSignal, type WebsiteObservation } from '../../src/warmleads/score.js'
import { plainBody, toActivity } from '../../src/crm/nxtSales/mappers.js'
import { ACTIVITY_BODY_MAX, ACTIVITY_BODY_RAW_MAX, ACTIVITY_BODY_WINDOW_DAYS } from '../../src/crm/types.js'
import { RECENT_ACTIVITY_DAYS } from '../../src/intent/providers/crmProvider.js'
import { assessReply, engagementSignal, hasRecentReply, isAutomatedEmail, isAutomatedMessage, ownWords, REFUSAL_SIGNAL_TYPES, substanceOf, summariseInbound } from '../../src/warmleads/replies.js'
import { looksLikeStubPage } from '../../src/warmleads/websiteAccess.js'

// The first 30-company test called AWFS "warm: replied in the last 90 days" on the
// strength of "Delivery Status Notification (Failure)" - the bounce of our own email.

const NOW = new Date('2026-10-31T00:00:00Z')
const mail = (subject: string, direction: 'inbound' | 'outbound', daysAgo: number): CrmActivity => ({
  id: `${subject}-${daysAgo}`,
  type: 'email',
  companyId: 'c1',
  subject,
  direction,
  createdAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
})

describe('what is a reply', () => {
  it('bounces, out-of-office notices and auto-replies are automated mail, not replies', () => {
    for (const s of [
      'Delivery Status Notification (Failure)',
      'Undeliverable: Elevate Your eCommerce Performance',
      'Mail delivery failed: returning message to sender',
      'Out of Office Re: Elevate Your eCommerce Performance with Product Data',
      'Automatic reply: Elevate Your eCommerce Performance',
      'Auto-Reply: your message',
      'Autoreply from Sam',
      'noreply notification',
      'I am away from my desk',
    ]) {
      expect(isAutomatedEmail(s), s).toBe(true)
    }
  })

  it('a message a person wrote - including accepting a meeting - is a reply', () => {
    for (const s of [
      'RE: Product Data Enrichment Proposal for ElectroWeld - AltiusNXT',
      'Re: Invitation: Product Data Enrichment Discussion - Halliday Hardware',
      'Accepted: Product Data Enrichment Solution Walkthrough',
      'Nautical Supplies - Australia POC',
      '',
    ]) {
      expect(isAutomatedEmail(s), s).toBe(false)
    }
    expect(isAutomatedEmail(null)).toBe(false)
  })

  it('counts only inbound mail inside the window, newest first, split into replies and automated', () => {
    const s = summariseInbound(
      [
        mail('Re: proposal', 'inbound', 10),
        mail('Re: older proposal', 'inbound', 40),
        mail('Re: much older', 'inbound', 200), // outside the 90 days
        mail('Delivery Status Notification (Failure)', 'inbound', 3),
        mail('Hello', 'outbound', 1), // ours, not theirs
      ],
      NOW,
    )
    expect(s.replies.map((a) => a.subject)).toEqual(['Re: proposal', 'Re: older proposal'])
    expect(s.automated.map((a) => a.subject)).toEqual(['Delivery Status Notification (Failure)'])
    expect(hasRecentReply([mail('Delivery Status Notification (Failure)', 'inbound', 3)], NOW)).toBe(false)
    expect(hasRecentReply([mail('Re: x', 'inbound', 3)], NOW)).toBe(true)
  })

  it('a reply is FRESH when it is within the freshness window (30 days), otherwise aging — which decides an early signal', () => {
    expect(engagementSignal([mail('RE: Proposal', 'inbound', 5)], NOW)!.freshness).toBe('fresh')
    expect(engagementSignal([mail('RE: Proposal', 'inbound', 30)], NOW)!.freshness).toBe('fresh')
    expect(engagementSignal([mail('RE: Proposal', 'inbound', 31)], NOW)!.freshness).toBe('aging')
    expect(engagementSignal([mail('RE: Proposal', 'inbound', 80)], NOW)!.freshness).toBe('aging')
    expect(engagementSignal([mail('RE: Proposal', 'inbound', 10)], NOW, 90, 7)!.freshness).toBe('aging') // the window is a setting
  })

  it('the engagement signal is positive only for a real reply; a bounce is listed as neutral and counts for nothing', () => {
    const real = engagementSignal([mail('RE: Proposal', 'inbound', 5)], NOW)!
    expect(real).toMatchObject({ signalType: 'inbound_engagement', polarity: 'positive' })
    expect(real.evidence).toBe('Inbound email on 2026-10-26') // the date only: not even the subject of the customer's mail is kept

    const bounce = engagementSignal([mail('Delivery Status Notification (Failure)', 'inbound', 5)], NOW)!
    expect(bounce).toMatchObject({ signalType: 'automated_inbound_only', polarity: 'neutral' })
    expect(bounce.summary).toMatch(/not a reply from a person/)

    expect(engagementSignal([mail('Hello', 'outbound', 5)], NOW)).toBeNull()
    expect(engagementSignal([], NOW)).toBeNull()
  })
})

describe('the AWFS case end to end', () => {
  const site: WebsiteObservation = { status: 'reachable', url: 'https://awfs.com.au/', hasProductSchema: false, commercePlatforms: ['WooCommerce'] }
  const input = (activities: CrmActivity[]): EvaluationInput => {
    const e = engagementSignal(activities, NOW)
    return { crm: { ok: true, signals: e ? [e] : [] }, website: site, deep: { status: 'done', signals: [] } }
  }

  it('a company whose only inbound mail is a bounce is NOT warm', () => {
    const r = classify(input([mail('Delivery Status Notification (Failure)', 'inbound', 74)]))
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(10) // the shop fit only
    expect(r.reasons.find((x) => x.signal === 'automated_inbound_only')).toMatchObject({ points: 0, polarity: 'neutral' })
  })

  it('the same company with a real reply is warm (reply 45 + fit 10)', () => {
    const r = classify(input([mail('Re: Product Data Enrichment Proposal', 'inbound', 20)]))
    expect(r.classification).toBe('warm')
    expect(r.score).toBe(55)
  })
})

describe('placeholder pages are not the company\'s page', () => {
  it('"Redirect", "Loading" and the like mean nothing was read', () => {
    for (const t of ['Redirect', 'Redirecting...', 'Loading', 'Please wait', 'Moved', 'Document Moved', 'Index of /']) expect(looksLikeStubPage(t), t).toBe(true)
  })
  it('a real title is never one', () => {
    for (const t of ['Redirect Cables Ltd', 'Loading Bay Equipment - Acme', 'Moved by Design | Removals', 'Home | We Supply Africa', '']) expect(looksLikeStubPage(t), t).toBe(false)
    expect(looksLikeStubPage(null)).toBe(false)
  })
})

// ── A reply that says NO, judged by its subject (no text available: the test sample, or a text-less email) ─────────────────────────

describe('a reply that says NO is not interest', () => {
  const site: WebsiteObservation = { status: 'reachable', url: 'https://acme.example/', hasProductSchema: true, commercePlatforms: ['Shopify'] }
  const verdict = (activities: CrmActivity[]) => {
    const e = engagementSignal(activities, NOW)
    return classify({ crm: { ok: true, signals: e ? [e] : [] }, website: site, deep: { status: 'not_needed', signals: [] } })
  }
  const bySubject = (subject: string) => assessReply(mail(subject, 'inbound', 3), false)

  it('unsubscribe, stop, not interested and similar subjects are recognised when there is no text; ordinary subjects are not', () => {
    for (const s of ['Unsubscribe', 'Re: Please unsubscribe me', 'opt out', 'Remove me from your list', 'Stop emailing us', "Don't contact us again", 'Not interested', 'We are no longer interested', 'No thanks', 'Wrong person']) expect(bySubject(s).verdict, s).toBe('declined')
    for (const s of ['RE: Product Data Enrichment Proposal', 'Accepted: Product Data Enrichment Solution Walkthrough', 'Re: interested - can we talk Tuesday?', 'Interested in a demo', '']) expect(bySubject(s).verdict, s).toBe('interested')
  })

  it('a declining reply is listed but gives no points and no intent: the company is not warm and not an early signal', () => {
    const r = verdict([mail('Re: Stop emailing us', 'inbound', 5)])
    const line = r.reasons.find((x) => x.signal === 'reply_opt_out')!
    expect(line).toMatchObject({ points: 0, polarity: 'neutral' })
    expect(line.summary).toMatch(/not interest/)
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(10) // only the website fit
  })

  it('the newest word wins: a decline AFTER a friendly reply withdraws the interest; a friendly reply after a decline counts', () => {
    const declinedLater = [mail('Re: proposal', 'inbound', 20), mail('Unsubscribe', 'inbound', 2)]
    expect(summariseInbound(declinedLater, NOW).replies).toHaveLength(1)
    expect(engagementSignal(declinedLater, NOW)!.signalType).toBe('reply_opt_out')
    expect(verdict(declinedLater).classification).toBe('cold')
    const friendlyLater = [mail('Unsubscribe', 'inbound', 20), mail('Re: proposal', 'inbound', 2)]
    expect(engagementSignal(friendlyLater, NOW)!.signalType).toBe('inbound_engagement')
    expect(verdict(friendlyLater).classification).toBe('warm')
  })

  it('a bounce is still automated mail, and a decline outside the window is ignored', () => {
    expect(summariseInbound([mail('Undeliverable: unsubscribe', 'inbound', 3)], NOW).declined).toHaveLength(0)
    expect(engagementSignal([mail('Unsubscribe', 'inbound', 400)], NOW)).toBeNull()
  })
})

// ── What the person WROTE, not only the subject ─────────────────────────────────────────────────────────────────────────────────
// NXT Sales returns each email's text on the same authorised read as the subject; Warm Leads reads it in memory to tell a refusal
// from interest. Quoted earlier messages and signatures are cut off first. No text = unverified = never interest.

const site: WebsiteObservation = { status: 'reachable', url: 'https://acme.example/', hasProductSchema: true, commercePlatforms: ['Shopify'] }
const withText = (subject: string, daysAgo: number, body: string): CrmActivity => ({ ...mail(subject, 'inbound', daysAgo), body })
const person = (body: string, subject = 'Re: Product data proposal'): CrmActivity => withText(subject, 3, body)
const signal = (activities: CrmActivity[]) => engagementSignal(activities, NOW, undefined, 30, { requireText: true })
const verdictOf = (activities: CrmActivity[], deep: EvaluationInput['deep'] = { status: 'not_needed', signals: [] }) => {
  const e = signal(activities)
  return classify({ crm: { ok: true, signals: e ? [e] : [] }, website: site, deep })
}
const kindOf = (body: string, subject?: string) => {
  const a = assessReply(person(body, subject), true)
  return a.verdict === 'declined' ? a.kind! : a.verdict
}

describe('the newest reply is judged by what the person wrote', () => {
  it('a friendly subject with a refusal in the text is a refusal - recorded as a KIND, never as the person\'s words', () => {
    const a = [person('Hi, thanks for the note, but we are not interested at this time.')]
    expect(signal(a)).toMatchObject({ signalType: 'reply_declined', polarity: 'neutral' })
    expect(signal(a)!.evidence).toBe('Inbound email on 2026-10-28; kind: not_interested')
    const r = verdictOf(a)
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(10)
    expect(r.reasons.find((x) => x.signal === 'reply_declined')).toMatchObject({ points: 0 })
  })

  it('a friendly earlier reply followed by a refusal: the refusal is the latest word and wins', () => {
    const a = [withText('Re: proposal', 20, 'Sounds great, please send pricing.'), withText('Re: proposal', 2, 'On reflection, please stop emailing us.')]
    expect(signal(a)!.signalType).toBe('reply_opt_out')
    expect(verdictOf(a).classification).toBe('cold')
    // and the other way round, a refusal long ago followed by a real answer counts
    const b = [withText('Re: proposal', 20, 'Not interested.'), withText('Re: proposal', 2, 'Actually things changed, can we talk about pricing next week?')]
    expect(signal(b)!.signalType).toBe('inbound_engagement')
    expect(verdictOf(b).classification).toBe('warm')
  })

  it('"unsubscribe" and "remove me" written in the text', () => {
    for (const body of ['Please unsubscribe us from your list.', 'Could you remove me from your mailing list?', 'Take us off your list please', 'We want to opt out of these emails', "Don't email us again.", 'This is spam, stop.']) {
      expect(signal([person(body)])!.signalType, body).toBe('reply_opt_out')
    }
  })

  it('"not interested" and similar written in the text', () => {
    for (const body of ['Not interested.', 'We are no longer interested in this.', 'We are not looking for anything like this', 'we do not need this']) {
      expect(signal([person(body)])!.signalType, body).toBe('reply_declined')
    }
    expect(signal([person('I think you have the wrong person.')])!.signalType).toBe('reply_wrong_contact')
  })

  it('a positive reply with no refusal is interest, and says its text was read', () => {
    const a = [person('Thanks for reaching out, we would like to see a demo next week. Please do not hesitate to call me.')]
    const s = signal(a)!
    expect(s.signalType).toBe('inbound_engagement')
    expect(s.summary).toMatch(/the newest read and containing no refusal/)
    const r = verdictOf(a)
    expect(r.classification).toBe('warm') // 45 + 10 fit
    expect(r.score).toBe(55)
  })

  it('a reply whose text is not available is unverified - listed, worth nothing, never interest', () => {
    const noText = [mail('Re: proposal', 'inbound', 4)] // no body field at all
    expect(signal(noText)).toMatchObject({ signalType: 'reply_unverified', polarity: 'neutral' })
    const r = verdictOf(noText)
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(10)
    expect(r.reasons.find((x) => x.signal === 'reply_unverified')).toMatchObject({ points: 0 })
    // empty text, or only quoted text and a signature: nothing of the person's own
    expect(signal([withText('Re: proposal', 4, '')])!.signalType).toBe('reply_unverified')
    expect(signal([withText('Re: proposal', 4, 'On Tue, 3 Nov 2026, Sales <s@x.com> wrote:\n> hello there')])!.signalType).toBe('reply_unverified')
    expect(signal([withText('Re: proposal', 4, 'Sent from my iPhone')])!.signalType).toBe('reply_unverified')
    // a friendly OLDER reply does not rescue a newest reply that cannot be read
    const mixed = [withText('Re: proposal', 20, 'Sounds great, send pricing.'), withText('Re: proposal', 2, '')]
    expect(signal(mixed)!.signalType).toBe('reply_unverified')
    expect(verdictOf(mixed).classification).toBe('cold')
    // accepting a meeting invitation has no words but is still a person acting
    expect(signal([withText('Accepted: Product Data Enrichment Walkthrough', 2, '')])!.signalType).toBe('inbound_engagement')
  })

  it('without requireText (the test sample only looks for replies) the subject alone decides, as before', () => {
    expect(engagementSignal([mail('Re: proposal', 'inbound', 4)], NOW)!.signalType).toBe('inbound_engagement')
    expect(hasRecentReply([mail('Re: proposal', 'inbound', 4)], NOW)).toBe(true)
  })

  it('bounces and out-of-office replies are still automated mail, whatever their text says', () => {
    const a = [withText('Automatic reply: Out of office', 2, 'I am away, please contact my colleague.')]
    expect(signal(a)!.signalType).toBe('automated_inbound_only')
  })
})

// ── PR #10 review, H1: the refusals people actually write ────────────────────────────────────────────────────────────────────────
describe('H1 - common one-line refusals are refusals', () => {
  it.each([
    ['STOP', 'opt_out'],
    ['Stop.', 'opt_out'],
    ['Remove', 'opt_out'],
    ['Unsubscribe', 'opt_out'],
    ['Please remove me', 'opt_out'],
    ['Kindly remove our email id from your database.', 'opt_out'],
    ['No more emails please', 'opt_out'],
    ['Kindly do not mail us again.', 'opt_out'],
    ['Do not send any more mails', 'opt_out'],
    ['We do not wish to receive further communication.', 'opt_out'],
    ['No further communication please.', 'opt_out'],
    ['Reported as spam.', 'opt_out'],
    ['Not required.', 'not_interested'],
    ['Not required', 'not_interested'],
    ['We have no requirement at present.', 'not_interested'],
    ['We will pass on this.', 'not_interested'],
    ["We'll pass, thanks", 'not_interested'],
    ['We do not require this product.', 'not_interested'],
    ['Not at this time, thanks.', 'not_interested'],
    ['No thanks', 'not_interested'],
    ['No.', 'not_interested'],
    ['Currently not looking.', 'not_interested'],
    ['We already have a supplier for this.', 'not_interested'],
    ['No budget this year.', 'not_interested'],
    ['No need.', 'not_interested'],
    ['Hello, this is not for us. Best regards', 'not_interested'],
    ['Thank you for your email. At present we do not have any requirement for this. Will contact you if needed.', 'not_interested'],
    ['Request you to stop sending these mails.', 'opt_out'],
    ['Please take my name off this list', 'opt_out'],
    ['Please delete my contact.', 'opt_out'],
    // Indian business English and Hinglish
    ['Mujhe mail mat karo', 'opt_out'],
    ['Please mail mat bhejiye', 'opt_out'],
    ['Humein is ki zaroorat nahi hai', 'not_interested'],
    ['Abhi interest nahi hai', 'not_interested'],
    ['Hume nahi chahiye', 'not_interested'],
    // other languages
    ['Bitte abbestellen', 'opt_out'],
    ['Kein Interesse, danke.', 'not_interested'],
    ['Merci de nous désabonner', 'opt_out'],
    ['Nous ne sommes pas intéressés.', 'not_interested'],
    ['Por favor, darse de baja', 'opt_out'],
    ['No estamos interesados', 'not_interested'],
  ])('%s -> %s', (body, kind) => {
    expect(kindOf(body)).toBe(kind)
  })

  it('a one-word STOP is not Warm any more (it scored 55 Warm with a shop site)', () => {
    const r = verdictOf([person('STOP')])
    expect(r.classification).not.toBe('warm')
    expect(r.reasons.find((x) => x.signal === 'reply_opt_out')).toMatchObject({ points: 0 })
  })

  it('a refusal written in a signature-shaped sentence, or with a greeting and a sign-off around it, is still found', () => {
    expect(kindOf('Hi Ravi,\n\nSTOP\n\nRegards,\nSam Patel\nPurchase Manager')).toBe('opt_out')
    expect(kindOf('Dear Sir,\nNot required.\nThanks & regards\nAcme Traders')).toBe('not_interested')
  })
})

// ── H2: a dash, ">" or "regards" inside a sentence is not a boundary ────────────────────────────────────────────────────────────
describe('H2 - quotes and signatures are removed accurately', () => {
  it.each([
    ['Thanks for reaching out -- we are not interested at this time.'],
    ['Dear Sir, with regards, we are not interested.'],
    ['Sincerely, we are not interested in this.'],
    ['Quantity > 500 is too much for us; we are not interested.'],
    ['Our ROI > 20% so thanks, but please unsubscribe us from your list'],
    ['Thanks. 3 > 2. Please stop emailing us.'],
    ['Please unsubscribe us. (price > 5)'],
  ])('%s', (body) => {
    expect(['opt_out', 'not_interested']).toContain(kindOf(body))
  })

  it('an inline answer written between quoted lines is read; the quoted lines are not', () => {
    const body = 'Hi Rahul, see my answers inline below.\n\nOn Tue, 3 Nov 2026, Sales wrote:\n> Would you like a quote?\nNo, not interested.\n> Can we call?\nNo, do not call.'
    expect(ownWords(body)).toBe('Hi Rahul, see my answers inline below.\n\nNo, not interested.\nNo, do not call.')
    expect(kindOf(body)).toBe('not_interested')
  })

  it('what the person quoted is not what the person said (">" lines, "wrote:" headers, Outlook blocks, original messages)', () => {
    const gmail = 'Yes, please send details.\n\nOn Tue, 3 Nov 2026 at 10:15, Sales <sales@altius.example> wrote:\n> If you do not want to hear from us, unsubscribe here.\n> We are not looking to bother you.'
    expect(ownWords(gmail)).toBe('Yes, please send details.')
    expect(signal([person(gmail)])!.signalType).toBe('inbound_engagement')
    const outlook = 'Interested, please call me.\n\nFrom: Sales\nSent: Tuesday, November 3, 2026 10:15 AM\nTo: Buyer\nSubject: Hello\n\nIf you wish to unsubscribe reply STOP'
    expect(ownWords(outlook)).toBe('Interested, please call me.')
    expect(signal([person(outlook, 'RE: Hello')])!.signalType).toBe('inbound_engagement')
    const original = 'Send the pricing.\n-----Original Message-----\nFrom: Sales\nPlease unsubscribe by replying'
    expect(signal([person(original, 'RE: Hello')])!.signalType).toBe('inbound_engagement')
    // the same with the line breaks lost (older data): the cut is anchored on the header
    const flat = 'Yes, please send details. On Tue, 3 Nov 2026 at 10:15, Sales <sales@altius.example> wrote: > If you do not want to hear from us, unsubscribe here.'
    expect(ownWords(flat)).toBe('Yes, please send details.')
    expect(ownWords('Send the pricing. -----Original Message----- From: Sales Please unsubscribe by replying')).toBe('Send the pricing.')
    expect(ownWords('Interested, please call me. From: Sales Sent: Tuesday, November 3, 2026 10:15 AM To: Buyer')).toBe('Interested, please call me.')
  })

  it('a signature delimiter, a mobile footer and a legal footer are cut; a refusal ABOVE them is still caught', () => {
    expect(ownWords('Sounds good, call me Monday.\n-- \nJohn Smith | Acme Retail\nTo unsubscribe from our newsletter click here')).toBe('Sounds good, call me Monday.')
    expect(signal([person('Happy to talk.\nKind regards,\nSam\nThis email is confidential. If you are not the intended recipient, unsubscribe.')])!.signalType).toBe('inbound_engagement')
    expect(signal([person('Please unsubscribe us.\nBest regards,\nSam')])!.signalType).toBe('reply_opt_out')
    expect(ownWords('Call me.\nSent from my iPhone\nplease unsubscribe')).toBe('Call me.')
    // a refusal AFTER the sign-off (a P.S.) is the person's too
    expect(kindOf('Thanks for the info.\nRegards,\nRavi\nPS: please stop emailing us')).toBe('opt_out')
    // an "On ..." earlier in the sentence does not hide a refusal that comes before the quote header
    expect(signal([person('Based on this, we are not interested. On Tue, 3 Nov 2026, Sales wrote: hello')])!.signalType).toBe('reply_declined')
  })
})

// ── H3: nothing of the person's own is not interest ──────────────────────────────────────────────────────────────────────────────
describe('H3 - a greeting, a thanks, a sign-off or a quote header alone is unverified', () => {
  it.each([
    ['Sales <s@w.com> wrote:\n> Would you like a quote?'],
    ['Hi,\n\nRegards,\nRavi'],
    ['Thanks\n\nRegards,\nRavi\n> On x wrote'],
    ['Le mar. 3 nov. 2026 à 10:15, Sales a écrit :\n> Would you like a quote?'],
    ['Am 03.11.2026 um 10:15 schrieb Sales <s@w.com>:\n> Would you like a quote?'],
    ['Hello Sir,'],
    ['Thanks'],
    ['Ok'],
    ['Ravi'],
    ['Noted, thanks.'],
    ['Ok thanks, will see'],
    ['Dear Sir/Madam,\nThanks & Regards,\nRavi Kumar\nPurchase'],
  ])('%j', (body) => {
    expect(assessReply(person(body), true).verdict).toBe('unverified')
    expect(signal([person(body)])!.signalType).toBe('reply_unverified')
  })

  it('a short reply that asks for something, or says yes, is still interest', () => {
    for (const body of ['Yes please send the quote for 1000 units.', 'Interested', 'Please send the catalogue', 'Send price list', 'Can you call me tomorrow?', 'Hi, please send the quote']) expect(assessReply(person(body), true).verdict, body).toBe('interested')
  })

  it('the substance of a message leaves out greetings, thanks and everything after a sign-off', () => {
    expect(substanceOf('Hi Rahul,\nThanks\nPlease send the price list.\nBest regards,\nSam\n+91 98765 43210')).toBe('Please send the price list.')
    expect(substanceOf('Hi, please send the quote')).toBe('please send the quote')
  })
})

// ── Second review (of the fixes) ────────────────────────────────────────────────────────────────────────────────────────────────
describe('second review - what is still found, and what is no longer wrongly refused', () => {
  const ATTR = 'On Tue, 3 Nov 2026 at 10:15, A <a@b.example> wrote:\n> hello'
  it('R1 - a refusal written directly above the quote header (no blank line) is not swallowed with it', () => {
    expect(kindOf(`Unsubscribe me\n${ATTR}`)).toBe('opt_out')
    expect(kindOf(`Not interested\n${ATTR}`)).toBe('not_interested')
    expect(kindOf(`Please send quote for pallets\n${ATTR}`)).toBe('interested')
    expect(ownWords(`Please send quote for pallets\n${ATTR}`)).toBe('Please send quote for pallets')
  })

  it.each([
    'Please drop me an email with the price list for 500 crates.',
    'Drop us a line when the new rates are out',
    'Can you take us through your product range and price?',
    'Please take me through the process of ordering',
    'Kindly do not exclude us from the tender list, send the RFQ',
    'Stop sending partial shipments. Send the full order of 500 crates.',
    "Don't bother with the catalogue, just send the price list",
    'We have no other offers, please send a quote for 500 crates',
    'We unsubscribed from our old vendor last year; please send your price list for 500 crates.',
  ])('R2 - ordinary friendly wording is not an opt-out: %s', (body) => {
    expect(kindOf(body)).toBe('interested')
  })

  it('R3 - a refusal is read before the auto-reply filter: "I am travelling" does not hide it, or a request', () => {
    const friendly = withText('Re: Crates', 40, 'Please send the quote for 500 crates')
    const optOut = withText('Re: Crates', 2, 'Please remove me from your mailing list. I am travelling till Monday.')
    expect(isAutomatedMessage(optOut)).toBe(false)
    expect(signal([friendly, optOut])!.signalType).toBe('reply_opt_out')
    expect(kindOf('I am travelling this week. Kindly send the quotation by email, we want 500 crates.')).toBe('interested')
    expect(kindOf('Please call me on Monday, I will be in the office after 10 am. We need pallets.')).toBe('interested')
    // real auto-replies are still automated
    for (const body of ['Thank you for contacting Acme Support. Your ticket number is 12345.', 'We have received your email and a member of our team will respond within 24 hours.', 'This is a system generated mail, kindly do not reply.', 'Our office will remain closed from 8 to 14 November for Diwali.', 'Your message could not be delivered to raj@acme.com because the mailbox is unavailable.']) {
      expect(isAutomatedMessage(withText('Re: Crates', 2, body)), body).toBe(true)
    }
  })

  it.each([
    ["Don't call me again.", 'opt_out'],
    ['Please do not send mails to this address.', 'opt_out'],
    ['Please remove this email id from your mailing database.', 'opt_out'],
    ['Kindly refrain from contacting us.', 'opt_out'],
    ['Why do you spam us?', 'opt_out'],
    ['We do not buy such items.', 'not_interested'],
    ['We will not be changing our supplier.', 'not_interested'],
    ['We are not in a position to take this forward at this stage.', 'not_interested'],
    ['We are unable to consider your proposal at this time.', 'not_interested'],
    ['We are satisfied with our present vendors.', 'not_interested'],
    ['We have no immediate need for packaging material.', 'not_interested'],
    ['Thank you for your mail but we are not intrested in this offer at present.', 'not_interested'],
    ['Nt interested', 'not_interested'],
    ['no requirment', 'not_interested'],
    ['We are *not* interested in this at all.', 'not_interested'],
    ['We are _not_ interested in this at all.', 'not_interested'],
    ['हमें इसकी कोई जरूरत नहीं है धन्यवाद', 'not_interested'],
    ['कृपया हमें ईमेल न भेजें धन्यवाद सर', 'opt_out'],
    ['कृपया हमें ईमेल भेजना बंद करें', 'opt_out'],
    ['हमें ईमेल करना बंद करें', 'opt_out'],
    ['हमें मेल भेजना बंद कर दें', 'opt_out'],
    ['Quiero darme de baja de su lista', 'opt_out'],
    ['Si prega di non inviarci più email', 'opt_out'],
    ['We are not interested in dealing with you.', 'not_interested'],
    ['We are not interested in cold emails.', 'not_interested'],
    ['Not interested in services', 'not_interested'],
    ['Won\'t buy', 'not_interested'],
    ['Cannot proceed', 'not_interested'],
  ])('R4/R5 - missed refusals: %s', (body, kind) => {
    expect(kindOf(body)).toBe(kind)
  })

  it('a hostile run of dashes (the longest text the mapper keeps) is analysed in linear time, not quadratic', () => {
    for (const body of ['-'.repeat(6000), `${'-'.repeat(5000)} on`, `${'-'.repeat(2999)}\n${'-'.repeat(2999)}`]) {
      const t0 = Date.now()
      kindOf(body)
      expect(Date.now() - t0, body.slice(0, 12)).toBeLessThan(100)
    }
  })

  it('R4 - short negative or bare replies are never interest: "Who are you?", "Not sure", "No meeting please"', () => {
    for (const body of ['Who are you?', 'Not sure', 'No meeting please', 'How did you get my email id?', 'No order this month', 'Not available']) expect(kindOf(body), body).not.toBe('interested')
  })

  it('R6 - a refusal at the end of a long message is still read', () => {
    expect(kindOf('We reviewed your proposal at length. ' + 'It has many interesting points about packaging and logistics. '.repeat(40) + 'Please unsubscribe us.')).toBe('opt_out')
  })

  it('R7 - invisible and look-alike characters do not hide a refusal', () => {
    expect(kindOf('We are not inter​ested in this offer.')).toBe('not_interested')
    expect(kindOf('We are not inter­ested in this offer.')).toBe('not_interested')
    expect(kindOf('We are not interеsted in this offer.')).toBe('not_interested') // Cyrillic е
    expect(kindOf('Please unsubscrіbe us.')).toBe('opt_out') // Cyrillic і
  })

  it('R8 - other mail clients\' quote headers are cut, so our own quoted text is not the person\'s', () => {
    const ours = 'If you do not wish to receive these emails please reply unsubscribe.'
    expect(kindOf(`Please send the quote for 500 crates\n---- On Tue, 03 Nov 2026 10:15:00 +0530 Sales <s@w.com> wrote ----\n${ours}`)).toBe('interested')
    expect(kindOf(`Please send the quote for 500 crates\nFrom: Sales <s@w.com> Sent: Tuesday 3 November To: Buyer Subject: Hello\n${ours}`)).toBe('interested')
  })

  it('R9 - "Sent from my factory" or "On Monday my manager wrote" are not mail-app markers', () => {
    expect(kindOf('Sent from my factory the sample. We are not interested in this.')).toBe('not_interested')
    expect(kindOf('On Monday my manager wrote: we are not interested.')).toBe('not_interested')
    expect(ownWords('Call me.\nSent from my iPhone\nplease unsubscribe')).toBe('Call me.')
  })

  it.each([
    'Thank you. I will pass this on to our purchase manager.',
    'We will pass your details to the concerned department and they will call you.',
    'I will pass on the information to our purchase team.',
    'I will pass your quote to our purchase manager, he will call you.',
  ])('R10 - handing a message on is not declining it: %s', (body) => {
    expect(kindOf(body)).not.toBe('not_interested')
  })

  it.each([
    'We are no longer working with Acme, please send your quote.',
    'Mr Sharma has left; please send the quote to me instead.',
    'I have left the drawings in the store; please quote for 500 crates.',
    'Our manager has left for the day, please call tomorrow.',
  ])('R11 - "left" and "no longer with" are not wrong-person answers unless it is about the company: %s', (body) => {
    expect(kindOf(body)).not.toBe('wrong_contact')
  })

  it.each([
    'We are not currently using any packaging supplier. Please send the price list.',
    'Samples not required, please send the price for 5000 crates',
    'GST certificate not required. Please send quotation.',
    'We do not want delays, please confirm the delivery date for our order',
    'Not interested in crates. We do need pallets, please quote.',
    'Not interested in crates; please quote pallets 500 nos.',
    'We need pallets and want a quote. Not interested in crates though.',
    'Crates nahi chahiye lekin pallets chahiye, quotation bhejiye',
  ])('R12/R13 - a refusal of one thing together with a request for another is interest: %s', (body) => {
    expect(kindOf(body)).toBe('interested')
  })

  it.each([
    'We are not interested. We still use our old supplier and the price is cheaper.',
    'Not interested in your product. However thanks for sending the quotation.',
    'We already have a supplier. But thanks for sharing your catalogue.',
    'No scope at present. However, we have received the details.',
  ])('R14 - a refusal followed by mail-words (price, details, thanks for sending) stays a refusal: %s', (body) => {
    expect(['not_interested', 'product_specific']).toContain(kindOf(body))
  })

  it('R15 - a greeting does not swallow a short request; a sign-off does not swallow a request after it', () => {
    for (const body of ['Hi please send quote', 'Hello sir send price', 'Hello team send catalog', 'Hi please call me', 'Regards,\nPlease send the quotation for 500 crates']) expect(kindOf(body), body).toBe('interested')
    expect(kindOf('Hello Sir,')).toBe('unverified')
  })

  it('R18 - a signature block alone (name, title, company) is unverified', () => {
    for (const body of ['Thanks\nJohn Smith\nSales Manager\nAcme Packaging Pvt Ltd', 'Raj Kumar\nPurchase Manager\nAcme Industries Pvt Ltd\nMumbai', 'Thanks and Best Regards,\nRaj Kumar\nPurchase Manager Acme Industries Mumbai', 'Thank you & regards,\nRaj Kumar\nPurchase Manager', 'With regards\nRaj Kumar\nPurchase Manager', 'Raj Kumar | Purchase Manager | Acme Industries Pvt Ltd | Mumbai']) {
      expect(kindOf(body), body).toBe('unverified')
    }
  })

  it('R20 - an opt-out is not erased by a LATER message that says nothing; only later interest removes it', () => {
    const optOut = withText('Re: Crates', 30, 'Please unsubscribe us')
    expect(signal([optOut, withText('Re: Crates', 2, 'Ok thanks')])!.signalType).toBe('reply_opt_out')
    expect(signal([optOut, withText('Re: Crates', 2, 'Thanks\nRaj Kumar\nPurchase Manager\nAcme Industries Pvt Ltd Mumbai')])!.signalType).toBe('reply_opt_out')
    expect(signal([optOut, withText('Re: Crates', 2, 'Thank you for contacting Acme. We have received your message and will respond within 24 hours.')])!.signalType).toBe('reply_opt_out')
    expect(signal([optOut, withText('Re: Crates', 2, 'Actually, please send the quote for 500 crates.')])!.signalType).toBe('inbound_engagement')
  })

  it('R28 - not even the subject of a customer\'s mail is kept, whatever the verdict', () => {
    const s = signal([withText('Re: Confidential Zebra pricing', 3, 'Please send the quote for 500 crates.')])!
    expect(s.signalType).toBe('inbound_engagement')
    expect(JSON.stringify(s)).not.toMatch(/Zebra|Confidential/)
    const bounce = engagementSignal([mail('Undeliverable: Zebra pricing', 'inbound', 3)], NOW)!
    expect(JSON.stringify(bounce)).not.toContain('Zebra')
  })

  it('R16 - subjects of real people are not mistaken for mail-system output', () => {
    expect(isAutomatedEmail('Undelivered goods complaint')).toBe(false)
    expect(isAutomatedEmail('Re: No reply from your side')).toBe(false)
    expect(isAutomatedEmail('Undeliverable: Elevate Your eCommerce Performance')).toBe(true)
    expect(isAutomatedEmail('noreply notification')).toBe(true)
  })
})

// ── Medium findings ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('declined meetings, out-of-office text, ties and false refusals', () => {
  it('M1 - a declined or cancelled meeting is not interest', () => {
    for (const subject of ['Declined: Product demo', 'Canceled: Product demo', 'Cancelled: Product demo']) {
      const a = assessReply(withText(subject, 2, 'Ravi Kumar has declined this invitation.'), true)
      expect(a, subject).toMatchObject({ verdict: 'declined', kind: 'meeting_declined' })
    }
    expect(signal([withText('Declined: Product demo', 2, 'Ravi Kumar has declined this invitation.')])!.signalType).toBe('reply_declined_meeting')
    // the same without the subject prefix
    expect(assessReply(withText('Re: Product demo', 2, 'This meeting has been canceled.'), true)).toMatchObject({ verdict: 'declined', kind: 'meeting_declined' })
    // a declined meeting is not a refusal to be contacted: no human review is ever caused by it
    expect(COMPANY_LEVEL_REFUSALS.has('reply_declined_meeting')).toBe(false)
  })

  it('M4 - an out-of-office text under an ordinary subject is mail-system output, not a reply', () => {
    const ooo = withText('Re: Crates', 2, 'I am out of office until 10 Nov with limited access to email.')
    expect(isAutomatedMessage(ooo)).toBe(true)
    expect(signal([ooo])!.signalType).toBe('automated_inbound_only')
    expect(assessReply(ooo, true).verdict).toBe('unverified')
    expect(isAutomatedMessage(withText('Re: Crates', 2, 'Happy to talk. I am out of office tomorrow, so call me on Thursday about the quote for 500 crates, we also want to compare three price lists from different suppliers before deciding which one we go with. ' + 'x'.repeat(600)))).toBe(false)
  })

  it('M3 - two messages with the same time: the more cautious one decides, whatever order they arrive in', () => {
    const t = '2026-10-29T10:00:00.000Z'
    const friendly = { ...person('Yes please send the quote for 1000 units.'), id: 'f', createdAt: t }
    const refusal = { ...person('Please unsubscribe us.'), id: 'r', createdAt: t }
    const unclear = { ...person('Ok'), id: 'u', createdAt: t }
    for (const order of [[friendly, refusal], [refusal, friendly]]) expect(signal(order)!.signalType, order.map((o) => o.id).join()).toBe('reply_opt_out')
    for (const order of [[friendly, unclear], [unclear, friendly]]) expect(signal(order)!.signalType).toBe('reply_unverified')
  })

  it('M11 - genuine interest is not called a refusal', () => {
    expect(kindOf('Do not call, just email me the quote for 500 crates.')).toBe('interested')
    expect(kindOf('Not interested in crates, but we do need pallets - please quote 2000 pallets.')).toBe('interested')
    expect(kindOf('The 20L is not relevant but the 40L is, please quote.')).toBe('interested')
    expect(kindOf('We have no need to call you, just send the price list.')).toBe('interested')
    expect(kindOf('No requirement for pallets however we want a quote for crates.')).toBe('interested')
    // the subject of the thread is OUR subject, left in place by "Re:" - it is not the person's refusal
    expect(kindOf('Yes, please send the quote for 500 crates.', 'Re: Not looking for a better crate supplier?')).toBe('interested')
    // and a "but" that does not ask for anything does not turn a refusal round
    expect(kindOf('Not interested, but thanks for asking.')).toBe('not_interested')
    expect(kindOf('Not interested, but we do not need quotes either.')).toBe('not_interested')
  })

  it('a rejection of ONE product is its own kind: not interest in that product, nothing about the others', () => {
    expect(kindOf('We are not interested in crates.')).toBe('product_specific')
    expect(signal([person('We are not interested in crates.')])!.signalType).toBe('reply_declined_product')
    expect(kindOf('We are not interested in your services.')).toBe('not_interested')
  })

  it('a wrong-person answer is not interest and not a refusal of the company', () => {
    expect(kindOf('I am not the right person, please write to purchase@acme.example')).toBe('wrong_contact')
    expect(kindOf('Sorry, wrong person.')).toBe('wrong_contact')
    expect(kindOf('Ravi no longer works with us.')).toBe('wrong_contact')
  })
})

// ── The owner's decision (2026-11-05): intent is separate from permission to contact ────────────────────────────────────────────────
describe('a refusal and a company with independent buying signals: HUMAN REVIEW REQUIRED', () => {
  const ev = (i: number): ObservedSignal => ({ signalType: 'expansion' + i, signalCategory: 'business', polarity: 'positive', confidence: 'high', freshness: 'fresh', status: 'active', summary: 'event ' + i + ' happened at the plant', evidence: 'q', sourceUrl: 'https://n.example/' + i, observedAt: '2026-10-27' })
  const strong: EvaluationInput['deep'] = { status: 'done', signals: [ev(1), ev(2)] }
  const moderate: EvaluationInput['deep'] = { status: 'done', signals: [ev(1)] }

  it('an unsubscribe request plus two fresh sourced events and shop fit is human review, never Warm', () => {
    const r = verdictOf([person('Please unsubscribe us.')], strong)
    expect(r.score).toBe(60)
    expect(r.classification).toBe('human_review')
    expect(r.summary).toMatch(/Human review required/)
    expect(r.summary).toMatch(/asked not to be contacted/)
    expect(r.reasons.find((x) => x.signal === 'reply_opt_out')).toMatchObject({ points: 0 })
    expect(r.reasons.filter((x) => x.points === 25)).toHaveLength(2) // the independent evidence is kept and listed
  })

  it('"not interested" plus independent evidence is human review too, also in the early-signal range', () => {
    expect(verdictOf([person('Not interested.')], strong).classification).toBe('human_review')
    const early = verdictOf([person('Not interested.')], moderate)
    expect(early.score).toBe(35)
    expect(early.classification).toBe('human_review')
    expect(early.summary).toMatch(/Early Signal/)
  })

  it('without independent evidence a refusal is simply cold (nothing to review)', () => {
    expect(verdictOf([person('Please unsubscribe us.')]).classification).toBe('cold')
  })

  it('a rejection of one product, a wrong person and a declined meeting do NOT disqualify independent demand', () => {
    for (const body of ['We are not interested in crates.', 'Sorry, wrong person.']) {
      expect(verdictOf([person(body)], strong).classification, body).toBe('warm')
    }
    expect(verdictOf([withText('Declined: Product demo', 2, 'Ravi has declined this invitation.')], strong).classification).toBe('warm')
  })

  it('a friendly reply AFTER the refusal removes it; the Warm result stands', () => {
    const a = [withText('Re: proposal', 20, 'Please unsubscribe us.'), withText('Re: proposal', 2, 'Actually, can you send the quote for 500 units?')]
    expect(verdictOf(a, strong).classification).toBe('warm')
  })

  it('a company the CRM already lists as do-not-contact stays do_not_contact (the stricter status wins)', () => {
    const suppressed: ObservedSignal = { signalType: 'suppressed', signalCategory: 'crm', polarity: 'negative', confidence: 'high', freshness: 'unknown', status: 'active', summary: 'on the list', evidence: '', sourceUrl: null, observedAt: null }
    const e = signal([person('Please unsubscribe us.')])!
    const r = classify({ crm: { ok: true, signals: [suppressed, e] }, website: site, deep: strong })
    expect(r.classification).toBe('do_not_contact')
  })

  it('only the refusal KIND and date are kept: nothing the person wrote - not the phrase, not the subject - is in the signal', () => {
    const body = 'Please unsubscribe us from the Zebra Crates mailing list. Call Ravi Kumar on 98450 12345 or write to ravi.kumar@private.example.'
    const s = signal([person(body, 'Re: Confidential Zebra pricing')])!
    const text = JSON.stringify(s)
    for (const secret of ['Zebra', 'Ravi', '98450', 'private.example', 'unsubscribe us', 'Confidential']) expect(text, secret).not.toContain(secret)
    expect(s).toMatchObject({ signalType: 'reply_opt_out', observedAt: person(body).createdAt })
    const r = verdictOf([person(body, 'Re: Confidential Zebra pricing')], strong)
    for (const secret of ['Zebra', 'Ravi', '98450', 'private.example', 'unsubscribe us', 'Confidential']) expect(JSON.stringify(r), secret).not.toContain(secret)
  })

  it('the signal names the score module knows are the ones the reply module produces', () => {
    // every company-level refusal is a reply signal the reply module produces - except the permission signal built in optOut.ts
    expect([...COMPANY_LEVEL_REFUSALS].filter((t) => t !== 'contact_opt_out').every((t) => REFUSAL_SIGNAL_TYPES.has(t))).toBe(true)
    expect(COMPANY_LEVEL_REFUSALS.has('contact_opt_out')).toBe(true)
  })
})

// ── The mapper: bounded, safe, and only for what is needed ──────────────────────────────────────────────────────────────────────────
describe('the message text is only kept when asked for', () => {
  const raw = { id: 'a1', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: '2026-10-30T10:00:00Z', body: '<p>Hello&nbsp;there</p>   <b>not interested</b> &amp; thanks', bodyHtml: '<html>secret</html>', fromEmail: 'x@y.example' }
  const now = new Date('2026-11-01T00:00:00Z')
  it('the usual object is unchanged: no body, no addresses', () => {
    const a = toActivity(raw, false, now)
    expect(a).toEqual({ id: 'a1', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: '2026-10-30T10:00:00.000Z' })
    expect('body' in a).toBe(false)
  })
  it('with withBody: plain text only (tags and entities removed), bounded, and nothing else is copied', () => {
    const a = toActivity(raw, true, now)
    expect(a.body).toBe('Hello there\nnot interested & thanks')
    expect(JSON.stringify(a)).not.toMatch(/secret/) // the HTML copy is never kept
    expect(a.fromAddresses).toEqual(['x@y.example']) // the sender's address is kept, under the same opt-in, to identify an explicit opt-out
    expect(toActivity({ ...raw, body: 'x'.repeat(10_000) }, true, now).body).toHaveLength(ACTIVITY_BODY_MAX)
    expect(toActivity({ ...raw, body: null }, true, now).body).toBe('')
  })
  it('H6/M2 - the text is processed only for an INBOUND email inside the approved window', () => {
    expect(ACTIVITY_BODY_WINDOW_DAYS).toBe(RECENT_ACTIVITY_DAYS) // the mapper's window and the reply window are one number
    expect('body' in toActivity({ ...raw, direction: 'outbound' }, true, now)).toBe(false)
    expect('body' in toActivity({ ...raw, direction: null }, true, now)).toBe(false)
    expect('body' in toActivity({ ...raw, createdAt: '2026-06-01T00:00:00Z' }, true, now)).toBe(false) // older than 90 days
    expect('body' in toActivity({ ...raw, createdAt: '2026-08-10T00:00:00Z' }, true, now)).toBe(true) // inside
  })
})

describe('H6 + M2 - the text of a hostile or HTML-only email', () => {
  const inbound = (body: string) => toActivity({ id: 'a', type: 'email', companyId: 'c', subject: 'Re: x', direction: 'inbound', createdAt: '2026-10-30T00:00:00Z', body }, true, new Date('2026-11-01T00:00:00Z'))
  const timed = (fn: () => void): number => {
    const t = process.hrtime.bigint()
    fn()
    return Number(process.hrtime.bigint() - t) / 1e6
  }

  it('no input makes the cleaning slow: a sender controls the size and the shape of an email', () => {
    const hostile: Array<[string, string]> = [
      ['300,000 "<"', '<'.repeat(300_000)],
      ['150,000 "a<"', 'a<'.repeat(150_000)],
      ['100,000 "<a"', '<a'.repeat(100_000)],
      ['unclosed tags', '<a href="' + 'x'.repeat(200_000)],
      ['many unclosed <style>', '<style>'.repeat(50_000)],
      ['many unclosed <script>', '<script>'.repeat(40_000)],
      ['many unclosed comments', '<!--'.repeat(60_000)],
      ['an entity storm', '&#39;'.repeat(100_000) + '&rsquo;'.repeat(50_000)],
      ['400,000 characters of ordinary text', 'we are not interested '.repeat(20_000)],
      ['nested tag soup', '<div><p><b>'.repeat(30_000)],
    ]
    for (const [label, body] of hostile) {
      const ms = timed(() => inbound(body))
      expect(ms, `${label}: ${ms.toFixed(0)} ms`).toBeLessThan(250) // measured before the fix: 2 s at 50,000 "<", 37 s at 300,000
    }
  })

  it('the whole chain (cleaning + reading the reply) is fast on text built to slow the reply patterns down', () => {
    const shapes: Array<[string, string]> = [
      ['"On Mon" over and over', 'On Mon '.repeat(60_000)],
      ['"wrote" without a colon', 'wrote '.repeat(60_000)],
      ['quote markers', '> '.repeat(100_000)],
      ['long lines of quote markers', ('>' + 'x'.repeat(200) + '\n').repeat(2_000)],
      ['dates and colons', ('Am 03.11.2026 um 10:15 ' + 'x'.repeat(100) + ' :\n').repeat(2_000)],
      ['"From:" blocks', ('From: a\nSent: b\n').repeat(20_000)],
      ['refusal words', 'not interested no more emails stop '.repeat(10_000)],
      ['one huge word', 'a'.repeat(400_000)],
    ]
    for (const [label, body] of shapes) {
      const ms = timed(() => {
        const a = inbound(body)
        assessReply({ ...a, subject: 'Re: x' }, true)
        engagementSignal([{ ...a, subject: 'Re: x' }], new Date('2026-11-01T00:00:00Z'), undefined, 30, { requireText: true })
      })
      expect(ms, `${label}: ${ms.toFixed(0)} ms`).toBeLessThan(400)
    }
    // and the reply module alone, given far more than the mapper ever hands it
    const direct = timed(() => assessReply({ ...mail('Re: x', 'inbound', 2), body: 'On Mon '.repeat(100_000) + 'wrote:\n> x\n'.repeat(50_000) }, true))
    expect(direct, `direct: ${direct.toFixed(0)} ms`).toBeLessThan(400)
  })

  it('the raw text is cut before any pattern runs on it, and the cleaned text before the refusal check', () => {
    const body = 'Please unsubscribe us.' + ' '.repeat(5) + 'z'.repeat(ACTIVITY_BODY_RAW_MAX * 2)
    const a = inbound(body)
    expect(a.body!.length).toBeLessThanOrEqual(ACTIVITY_BODY_MAX)
    expect(a.body!.startsWith('Please unsubscribe us.')).toBe(true)
  })

  it('an HTML-only email: style, script, head and comments are removed, so a long style block cannot hide the message', () => {
    const html = '<html><head><title>x</title><style type="text/css">' + 'body{margin:0;padding:0} table{border:0} '.repeat(200) + '</style></head><body><!-- tracking --><script>var a="not here"</script><div>Please unsubscribe us, we are not interested.</div></body></html>'
    const a = inbound(html)
    expect(a.body).toBe('Please unsubscribe us, we are not interested.')
    expect(assessReply({ ...a, subject: 'Re: proposal' }, true)).toMatchObject({ verdict: 'declined', kind: 'opt_out' })
  })

  it('common entities are decoded once, so "don&#39;t" and "don&rsquo;t" are read as the words they are', () => {
    expect(inbound('Please don&#39;t send any more email.').body).toBe("Please don't send any more email.")
    expect(inbound('We don&rsquo;t want any more emails. &lt;b&gt; &amp;amp; &#x2019;').body).toBe("We don't want any more emails. <b> &amp; ’")
    for (const body of ['Please don&#39;t send any more email.', 'We don&rsquo;t want any more emails.', 'No&nbsp;more&nbsp;emails&nbsp;please']) {
      expect(assessReply({ ...inbound(body), subject: 'Re: proposal' }, true).verdict, body).toBe('declined')
    }
  })

  it('second review - tags that merely START like a block tag are not blocks; closing tags may have spaces; plain "<...>" text is text', () => {
    expect(plainBody('<div>Thanks</div><header><img src=x></header><p>Please send the quote</p><p>Not interested</p>')).toContain('Not interested')
    expect(plainBody('<header>Logo</header><p>Please unsubscribe us</p>')).toBe('Logo\n\nPlease unsubscribe us')
    expect(plainBody('<style>a{}</style >Not interested')).toBe('Not interested')
    expect(plainBody('<STYLE>a{}</STYLE\n>Not interested')).toBe('Not interested')
    expect(plainBody('<script>x()</script >Not interested')).toBe('Not interested')
    expect(plainBody('<styled>x</styled>Not interested')).toContain('Not interested')
    expect(plainBody('Please <unsubscribe> us')).toBe('Please <unsubscribe> us')
    expect(plainBody('Quote ok. <Please remove us from your list>')).toBe('Quote ok. <Please remove us from your list>')
    expect(plainBody('Please un<span>subscribe</span> us')).toBe('Please unsubscribe us')
    expect(plainBody('Not inter<font color="red">ested</font>')).toBe('Not interested')
    expect(plainBody('<o:p></o:p>Please<br>stop')).toBe('Please\nstop')
  })

  it('second review - 6,000 characters are kept, so a refusal after a long paragraph is read', () => {
    const body = 'We reviewed your proposal at length. ' + 'It has many interesting points about packaging and logistics. '.repeat(60) + 'Please unsubscribe us.'
    const a = inbound(body)
    expect(a.body!.length).toBeGreaterThan(3000)
    expect(assessReply({ ...a, subject: 'Re: x' }, true)).toMatchObject({ verdict: 'declined', kind: 'opt_out' })
  })

  it('line breaks survive, so a quoted line can be told from a ">" inside a sentence', () => {
    const a = inbound('<p>No, not interested.</p><div>On Tue, 3 Nov 2026, Sales wrote:</div><blockquote>&gt; Would you like a quote?</blockquote>')
    expect(a.body).toContain('\n')
    expect(plainBody('Quantity > 500 is too much')).toBe('Quantity > 500 is too much')
    expect(plainBody('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2')
  })
})

describe('the summary names the real reason nothing could be evaluated', () => {
  const nothing = (status: WebsiteObservation['status']) =>
    classify({ crm: { ok: true, signals: [] }, website: { status, url: null, hasProductSchema: false, commercePlatforms: [] }, deep: { status: 'not_needed', signals: [] } }).summary
  it('says what happened to the website, not just "no readable website"', () => {
    expect(nothing('no_website')).toMatch(/no website on the CRM record/)
    expect(nothing('partial')).toMatch(/redirects to a different company/)
    expect(nothing('unreachable')).toMatch(/says its page does not exist/)
    expect(retryReason({ crm: { ok: true, signals: [] }, website: { status: 'partial', url: null, hasProductSchema: false, commercePlatforms: [] }, deep: { status: 'not_needed', signals: [] } })).toBeNull()
  })
})
