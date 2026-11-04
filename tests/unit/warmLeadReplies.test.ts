import { describe, expect, it } from 'vitest'
import type { CrmActivity } from '../../src/crm/types.js'
import { classify, retryReason, type EvaluationInput, type WebsiteObservation } from '../../src/warmleads/score.js'
import { engagementSignal, hasRecentReply, isAutomatedEmail, summariseInbound } from '../../src/warmleads/replies.js'
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
