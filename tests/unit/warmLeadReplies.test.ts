import { describe, expect, it } from 'vitest'
import type { CrmActivity } from '../../src/crm/types.js'
import { classify, retryReason, type EvaluationInput, type WebsiteObservation } from '../../src/warmleads/score.js'
import { toActivity } from '../../src/crm/nxtSales/mappers.js'
import { ACTIVITY_BODY_MAX } from '../../src/crm/types.js'
import { engagementSignal, hasRecentReply, isAutomatedEmail, isDecliningReply, ownWords, refusalIn, summariseInbound } from '../../src/warmleads/replies.js'
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
    expect(real.evidence).toMatch(/RE: Proposal/)

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

describe('a reply that says NO is not interest', () => {
  const site: WebsiteObservation = { status: 'reachable', url: 'https://acme.example/', hasProductSchema: true, commercePlatforms: ['Shopify'] }
  const verdict = (activities: CrmActivity[]) => {
    const e = engagementSignal(activities, NOW)
    return classify({ crm: { ok: true, signals: e ? [e] : [] }, website: site, deep: { status: 'not_needed', signals: [] } })
  }

  it('unsubscribe, stop, not interested and similar subjects are recognised; ordinary subjects are not', () => {
    for (const s of ['Unsubscribe', 'Re: Please unsubscribe me', 'opt out', 'Remove me from your list', 'Stop emailing us', "Don't contact us again", 'Not interested', 'We are no longer interested', 'No thanks', 'Wrong person']) expect(isDecliningReply(s), s).toBe(true)
    for (const s of ['RE: Product Data Enrichment Proposal', 'Accepted: Product Data Enrichment Solution Walkthrough', 'Re: interested - can we talk Tuesday?', 'Interested in a demo', '']) expect(isDecliningReply(s), s).toBe(false)
  })

  it('a declining reply is listed but gives no points and no intent: the company is not warm and not an early signal', () => {
    const r = verdict([mail('Re: Stop emailing us', 'inbound', 5)])
    const line = r.reasons.find((x) => x.signal === 'reply_declined')!
    expect(line).toMatchObject({ points: 0, polarity: 'neutral' })
    expect(line.summary).toMatch(/not interest/)
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(10) // only the website fit
  })

  it('the newest word wins: a decline AFTER a friendly reply withdraws the interest; a friendly reply after a decline counts', () => {
    const declinedLater = [mail('Re: proposal', 'inbound', 20), mail('Unsubscribe', 'inbound', 2)]
    expect(summariseInbound(declinedLater, NOW).replies).toHaveLength(1)
    expect(engagementSignal(declinedLater, NOW)!.signalType).toBe('reply_declined')
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

describe('the newest reply is judged by what the person wrote', () => {
  const site: WebsiteObservation = { status: 'reachable', url: 'https://acme.example/', hasProductSchema: true, commercePlatforms: ['Shopify'] }
  const withText = (subject: string, daysAgo: number, body: string): CrmActivity => ({ ...mail(subject, 'inbound', daysAgo), body })
  const signal = (activities: CrmActivity[]) => engagementSignal(activities, NOW, undefined, 30, { requireText: true })
  const verdict = (activities: CrmActivity[]) => {
    const e = signal(activities)
    return classify({ crm: { ok: true, signals: e ? [e] : [] }, website: site, deep: { status: 'not_needed', signals: [] } })
  }

  it('a friendly subject with a refusal in the text is a refusal', () => {
    const a = [withText('Re: Product data proposal', 3, 'Hi, thanks for the note, but we are not interested at this time.')]
    expect(signal(a)).toMatchObject({ signalType: 'reply_declined', polarity: 'neutral' })
    expect(signal(a)!.evidence).toMatch(/the message says "not interested"/)
    const r = verdict(a)
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(10)
    expect(r.reasons.find((x) => x.signal === 'reply_declined')).toMatchObject({ points: 0 })
  })

  it('a friendly earlier reply followed by a refusal: the refusal is the latest word and wins', () => {
    const a = [withText('Re: proposal', 20, 'Sounds great, please send pricing.'), withText('Re: proposal', 2, 'On reflection, please stop emailing us.')]
    expect(signal(a)!.signalType).toBe('reply_declined')
    expect(verdict(a).classification).toBe('cold')
    // and the other way round, a refusal long ago followed by a real answer counts
    const b = [withText('Re: proposal', 20, 'Not interested.'), withText('Re: proposal', 2, 'Actually things changed, can we talk about pricing next week?')]
    expect(signal(b)!.signalType).toBe('inbound_engagement')
    expect(verdict(b).classification).toBe('warm')
  })

  it('"unsubscribe" and "remove me" written in the text', () => {
    for (const body of ['Please unsubscribe us from your list.', 'Could you remove me from your mailing list?', 'Take us off your list please', 'We want to opt out of these emails', "Don't email us again.", 'This is spam, stop.']) {
      expect(signal([withText('Re: hello', 4, body)])!.signalType, body).toBe('reply_declined')
    }
  })

  it('"not interested" and similar written in the text', () => {
    for (const body of ['Not interested.', 'We are no longer interested in this.', "No thanks, we already have a provider.", 'We are not looking for anything like this', "I think you have the wrong person.", 'we do not need this']) {
      expect(signal([withText('Re: hello', 4, body)])!.signalType, body).toBe('reply_declined')
    }
  })

  it('a positive reply with no refusal is interest, and says its text was read', () => {
    const a = [withText('Re: hello', 4, 'Thanks for reaching out, we would like to see a demo next week. Please do not hesitate to call me.')]
    const s = signal(a)!
    expect(s.signalType).toBe('inbound_engagement')
    expect(s.summary).toMatch(/the newest read and containing no refusal/)
    const r = verdict(a)
    expect(r.classification).toBe('warm') // 45 + 10 fit
    expect(r.score).toBe(55)
  })

  it('words that only look like refusals are not refusals', () => {
    for (const t of ['Do not hesitate to contact us', 'No need to call, just email me', 'We would be interested in a demo', "I'm not sure yet, send details", 'Contact me on Monday', 'Is this relevant to retailers? We are one.']) expect(refusalIn(t), t).toBeNull()
  })

  it('what the person quoted or signed is not what the person said', () => {
    const quoted = 'Yes, please send details. On Tue, 3 Nov 2026 at 10:15, Sales <sales@altius.example> wrote: > If you do not want to hear from us, unsubscribe here. > We are not looking to bother you.'
    expect(ownWords(quoted)).toBe('Yes, please send details.')
    expect(signal([withText('Re: hello', 3, quoted)])!.signalType).toBe('inbound_engagement')
    const outlook = 'Interested, please call me. From: Sales Sent: Tuesday, November 3, 2026 10:15 AM To: Buyer Subject: Hello If you wish to unsubscribe reply STOP'
    expect(signal([withText('RE: Hello', 3, outlook)])!.signalType).toBe('inbound_engagement')
    const original = 'Send the pricing. -----Original Message----- From: Sales Please unsubscribe by replying'
    expect(signal([withText('RE: Hello', 3, original)])!.signalType).toBe('inbound_engagement')
    const footer = 'Sounds good, call me Monday. -- John Smith | Acme Retail | To unsubscribe from our newsletter click here'
    expect(ownWords(footer)).toBe('Sounds good, call me Monday.')
    expect(signal([withText('Re: Hello', 3, footer)])!.signalType).toBe('inbound_engagement')
    const regards = 'Happy to talk. Kind regards, Sam. This email is confidential. If you are not the intended recipient, unsubscribe.'
    expect(signal([withText('Re: Hello', 3, regards)])!.signalType).toBe('inbound_engagement')
    // a refusal ABOVE the signature is still caught
    expect(signal([withText('Re: Hello', 3, 'Please unsubscribe us. Best regards, Sam')])!.signalType).toBe('reply_declined')
    // an "On ..." earlier in the sentence does not hide a refusal that comes before the quote header
    expect(signal([withText('Re: Hello', 3, 'Based on this, we are not interested. On Tue, 3 Nov 2026, Sales wrote: hello')])!.signalType).toBe('reply_declined')
  })

  it('a reply whose text is not available is unverified - listed, worth nothing, never interest', () => {
    const noText = [mail('Re: proposal', 'inbound', 4)] // no body field at all
    expect(signal(noText)).toMatchObject({ signalType: 'reply_unverified', polarity: 'neutral' })
    const r = verdict(noText)
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(10)
    expect(r.reasons.find((x) => x.signal === 'reply_unverified')).toMatchObject({ points: 0 })
    // empty text, or only quoted text and a signature: nothing of the person's own
    expect(signal([withText('Re: proposal', 4, '')])!.signalType).toBe('reply_unverified')
    expect(signal([withText('Re: proposal', 4, 'On Tue, 3 Nov 2026, Sales <s@x.com> wrote: hello there')])!.signalType).toBe('reply_unverified')
    expect(signal([withText('Re: proposal', 4, 'Sent from my iPhone')])!.signalType).toBe('reply_unverified')
    // a friendly OLDER reply does not rescue a newest reply that cannot be read
    const mixed = [withText('Re: proposal', 20, 'Sounds great, send pricing.'), withText('Re: proposal', 2, '')]
    expect(signal(mixed)!.signalType).toBe('reply_unverified')
    expect(verdict(mixed).classification).toBe('cold')
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

describe('the message text is only kept when asked for', () => {
  const raw = { id: 'a1', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: '2026-10-30T10:00:00Z', body: '<p>Hello&nbsp;there</p>   <b>not interested</b> &amp; thanks', bodyHtml: '<html>secret</html>', fromEmail: 'x@y.example' }
  it('the usual object is unchanged: no body, no addresses', () => {
    const a = toActivity(raw)
    expect(a).toEqual({ id: 'a1', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: '2026-10-30T10:00:00.000Z' })
    expect('body' in a).toBe(false)
  })
  it('with withBody: plain text only (tags and entities removed), bounded, and nothing else is copied', () => {
    const a = toActivity(raw, true)
    expect(a.body).toBe('Hello there not interested & thanks')
    expect(JSON.stringify(a)).not.toMatch(/secret|x@y\.example/)
    expect(toActivity({ ...raw, body: 'x'.repeat(10_000) }, true).body).toHaveLength(ACTIVITY_BODY_MAX)
    expect(toActivity({ ...raw, body: null }, true).body).toBe('')
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
