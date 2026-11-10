import { describe, expect, it } from 'vitest'
import { accessFailureReason, classify, EARLY_SIGNAL_MIN, needsDeepCheck, POINTS, retryReason, ruledOutByCrm, WARM_THRESHOLD, type EvaluationInput, type ObservedSignal, type WebsiteObservation } from '../../src/warmleads/score.js'

// The warm-lead rule: pure, so every outcome is pinned here.

// Each signal type defaults to its OWN source page, as separate events do in practice; tests that need two
// signals on one page and day (the same event twice) say so explicitly.
const sig = (over: Partial<ObservedSignal>): ObservedSignal => ({
  signalType: 'x',
  signalCategory: 'business',
  polarity: 'positive',
  confidence: 'high',
  freshness: 'fresh',
  status: 'active',
  summary: 'something happened',
  evidence: 'quoted text',
  sourceUrl: `https://news.example/${over.signalType ?? 'x'}`,
  observedAt: '2026-10-20T00:00:00Z',
  ...over,
})
const crmSig = (signalType: string, polarity = 'positive') => sig({ signalType, signalCategory: 'crm', polarity, sourceUrl: null, summary: signalType })

const site = (over: Partial<WebsiteObservation> = {}): WebsiteObservation => ({
  status: 'reachable',
  url: 'https://acme.example/',
  hasProductSchema: false,
  commercePlatforms: [],
  ...over,
})
const input = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  crm: { ok: true, signals: [] },
  website: site(),
  deep: { status: 'not_needed', signals: [] },
  ...over,
})

describe('warm-lead classification', () => {
  it('a company merely existing with a website is NOT warm, and not even flagged for web research', () => {
    const r = classify(input())
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(0)
    expect(r.reasons.map((x) => x.signal)).toEqual(['website_reachable'])
    expect(needsDeepCheck(input().crm, site())).toBe(false)
  })

  it('a shop / product catalogue is fit, not intent: few points, never warm on its own', () => {
    const w = site({ commercePlatforms: ['Shopify'], hasProductSchema: true })
    const r = classify(input({ website: w }))
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(POINTS.websiteFit)
    expect(r.reasons[0]).toMatchObject({ signal: 'website_product_fit', points: POINTS.websiteFit, sourceUrl: 'https://acme.example/' })
    expect(needsDeepCheck(input().crm, w)).toBe(true) // fit earns the web research
  })

  it('a recent reply plus fit is warm with high confidence, and the reasons carry the evidence', () => {
    const r = classify(input({ crm: { ok: true, signals: [crmSig('inbound_engagement')] }, website: site({ commercePlatforms: ['Magento'] }) }))
    expect(r.score).toBe(POINTS.inboundEngagement + POINTS.websiteFit)
    expect(r.score).toBeGreaterThanOrEqual(WARM_THRESHOLD)
    expect(r.classification).toBe('warm')
    expect(r.confidence).toBe('high')
    expect(r.reasons.find((x) => x.signal === 'inbound_engagement')).toMatchObject({ points: 45, source: 'crm', evidence: 'quoted text', observedAt: '2026-10-20' })
  })

  it('web research findings count by confidence and age; low confidence, weak or expired evidence counts nothing', () => {
    const deep = {
      status: 'done' as const,
      signals: [
        sig({ signalType: 'expansion', confidence: 'high' }), // 25
        sig({ signalType: 'rfp', confidence: 'medium', freshness: 'aging' }), // 15/2 = 7
        sig({ signalType: 'post', confidence: 'low' }), // 0
        sig({ signalType: 'old', status: 'expired' }), // skipped
        sig({ signalType: 'maybe', status: 'weak' }), // skipped
        sig({ signalType: 'stale', freshness: 'stale' }), // 0
        sig({ signalType: 'inbound_engagement', signalCategory: 'crm' }), // counted from the CRM read only
      ],
    }
    const r = classify(input({ website: site({ commercePlatforms: ['Shopify'] }), deep }))
    expect(r.score).toBe(POINTS.websiteFit + 25 + 7)
    expect(r.classification).toBe('early_signal') // 42: below 50, with a verified fresh event
    expect(r.reasons.map((x) => x.signal)).not.toContain('old')
    expect(r.reasons.map((x) => x.signal)).not.toContain('maybe')
    expect(r.reasons.find((x) => x.signal === 'post')!.summary).toMatch(/not counted/)
  })

  it('two strong public signals make a company warm even without a reply; public points are capped', () => {
    const deep = { status: 'done' as const, signals: [1, 2, 3].map((i) => sig({ signalType: `event${i}` })) }
    const r = classify(input({ website: site({ hasProductSchema: true }), deep }))
    expect(r.score).toBe(POINTS.websiteFit + POINTS.publicSignalCap) // 25+25+10 (capped at 60)
    expect(r.classification).toBe('warm')
    expect(r.confidence).toBe('high')
    expect(r.reasons.filter((x) => x.source === 'web_research').map((x) => x.sourceUrl)).toEqual(['https://news.example/event1', 'https://news.example/event2', 'https://news.example/event3'])
  })

  it('platforms detected by the web research are fit, not intent: listed with 0 points (the first test run\'s mistake)', () => {
    // Jamesco Trading, 2026-10-30: WooCommerce + WordPress seen on the site were counted 25 + 25 and made it "warm".
    const deep = {
      status: 'done' as const,
      signals: [
        sig({ signalType: 'platform_detected', signalCategory: 'technology', summary: 'WooCommerce detected on the company website' }),
        sig({ signalType: 'platform_detected', signalCategory: 'technology', summary: 'WordPress detected on the company website' }),
        sig({ signalType: 'community_question', signalCategory: 'catalog', summary: 'Question about product data' }),
      ],
    }
    const r = classify(input({ website: site({ commercePlatforms: ['WooCommerce'] }), deep }))
    expect(r.classification).toBe('cold')
    expect(r.score).toBe(POINTS.websiteFit)
    expect(r.summary).toBe('Web research found no current buying signal.')
    const listed = r.reasons.filter((x) => x.source === 'web_research')
    expect(listed).toHaveLength(3)
    expect(listed.every((x) => x.points === 0 && /not counted as intent/.test(x.summary))).toBe(true)
    // the raw markup that proved a platform is not copied into the result
    expect(r.reasons.filter((x) => x.signal === 'platform_detected').every((x) => x.evidence === null)).toBe(true)
  })

  it('a high score without any intent signal is never warm', () => {
    // Only fit and a technology change are positive here; technology_added is intent, so check the pure-fit case.
    const r = classify(input({ website: site({ commercePlatforms: ['A', 'B'], hasProductSchema: true }) }))
    expect(r.classification).not.toBe('warm')
  })

  it('existing customers, active opportunities and do-not-contact are their OWN statuses — never cold — whatever else is found', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['existing_customer', 'existing_customer', /Existing customer/],
      ['open_opportunity', 'active_opportunity', /Active opportunity/],
      ['suppressed', 'do_not_contact', /Do not contact.*never approached by outreach/],
    ]
    for (const [signal, expected, text] of cases) {
      const crm = { ok: true, signals: [crmSig(signal, 'negative'), crmSig('inbound_engagement')] } // even a fresh reply and a shop
      const r = classify(input({ crm, website: site({ commercePlatforms: ['Shopify'] }) }))
      expect(r.classification, signal).toBe(expected)
      expect(r.classification).not.toBe('cold')
      expect(r.summary).toMatch(text)
      expect(r.confidence).toBe('high')
      expect(needsDeepCheck(crm, site({ commercePlatforms: ['Shopify'] }))).toBe(false) // no money spent on them
    }
  })

  it('a company the CRM rules out is not read at all: "not checked" gives the same status, with no website request behind it', () => {
    const notChecked: WebsiteObservation = { status: 'not_checked', url: 'https://acme.example/', hasProductSchema: false, commercePlatforms: [] }
    for (const [t, status] of [['existing_customer', 'existing_customer'], ['open_opportunity', 'active_opportunity'], ['suppressed', 'do_not_contact']] as const) {
      const r = classify(input({ crm: { ok: true, signals: [crmSig(t, 'negative')] }, website: notChecked }))
      expect(r.classification, t).toBe(status)
      expect(r.reasons.find((x) => x.signal === 'website_not_checked')!.summary).toMatch(/not read: the CRM already rules this company out/)
    }
    expect(ruledOutByCrm([crmSig('suppressed')])).toBe(true)
    expect(ruledOutByCrm([crmSig('inbound_engagement')])).toBe(false)
    expect(needsDeepCheck({ ok: true, signals: [crmSig('suppressed', 'negative')] }, notChecked)).toBe(false)
  })

  it('when a company is several of them, the most restrictive status wins: do not contact, then active opportunity, then existing customer — and every fact stays listed', () => {
    const all = { ok: true, signals: [crmSig('existing_customer', 'negative'), crmSig('open_opportunity', 'negative'), crmSig('suppressed', 'negative')] }
    const r = classify(input({ crm: all }))
    expect(r.classification).toBe('do_not_contact')
    expect(r.reasons.filter((x) => x.points === POINTS.excluded)).toHaveLength(3)
    expect(classify(input({ crm: { ok: true, signals: [crmSig('existing_customer', 'negative'), crmSig('open_opportunity', 'negative')] } })).classification).toBe('active_opportunity')
    expect(classify(input({ crm: { ok: true, signals: [crmSig('existing_customer', 'negative')] } })).classification).toBe('existing_customer')
  })

  it('nothing to read (no website on the record, or the site itself says its page does not exist) is "not enough data", not cold', () => {
    for (const status of ['no_website', 'unreachable'] as const) {
      const r = classify(input({ website: site({ status, url: null }) }))
      expect(r.classification, status).toBe('insufficient_data')
      expect(r.confidence).toBe('low')
    }
    // a CRM reply is something to read: still evaluable without a website
    const r = classify(input({ crm: { ok: true, signals: [crmSig('inbound_engagement')] }, website: site({ status: 'no_website', url: null }) }))
    expect(r.classification).toBe('early_signal') // 45: a fresh reply alone is below 50, so an early signal to review, not warm
  })

  it('a website that could not be READ (reset, block page, timeout, 403...) is a FAILED evaluation to retry: never "not enough data", never "cold"', () => {
    const w = site({ status: 'access_failed', failureReason: 'The website could not be read: the connection was reset.' })
    const retry = retryReason(input({ website: w }))
    expect(retry).toMatch(/connection was reset/)
    // even with a CRM reply and a fit elsewhere: a company whose site was not read has not been looked at
    expect(retryReason(input({ crm: { ok: true, signals: [crmSig('inbound_engagement')] }, website: w }))).toMatch(/could not be read/)
    // classify refuses to turn it into an answer
    expect(() => classify(input({ website: w }))).toThrow(/must be retried/)
    expect(accessFailureReason(w, retry!)).toMatchObject({ signal: 'website_access_failed', points: 0, source: 'website' })
  })

  it('a company the CRM already rules out keeps its status even when its website could not be read', () => {
    for (const [t, status] of [['existing_customer', 'existing_customer'], ['open_opportunity', 'active_opportunity'], ['suppressed', 'do_not_contact']] as const) {
      const i = input({ crm: { ok: true, signals: [crmSig(t, 'negative')] }, website: site({ status: 'access_failed', failureReason: 'reset' }) })
      expect(retryReason(i), t).toBeNull()
      expect(classify(i).classification, t).toBe(status)
    }
  })

  it('web research that did not run (limit) is "not enough data"; web research that could not READ its pages is a failure to retry', () => {
    const w = site({ commercePlatforms: ['Shopify'] })
    expect(classify(input({ website: w, deep: { status: 'skipped_cap', signals: [] } })).classification).toBe('insufficient_data')
    expect(retryReason(input({ website: w, deep: { status: 'skipped_cap', signals: [] } }))).toBeNull()
    const failed = input({ website: w, deep: { status: 'failed', signals: [], reason: 'The web research found 8 page(s) but could read none of them.' } })
    expect(retryReason(failed)).toMatch(/could read none of them.*Retry/)
    expect(() => classify(failed)).toThrow(/must be retried/)
  })

  it('a CRM read that failed never clears a company: no web research is spent on it', () => {
    expect(needsDeepCheck({ ok: false, signals: [] }, site({ commercePlatforms: ['Shopify'] }))).toBe(false)
  })

  it('the thresholds are the decided ones: warm 50, early signal from 25', () => {
    expect(WARM_THRESHOLD).toBe(50)
    expect(EARLY_SIGNAL_MIN).toBe(25)
  })

  it('PRO SAFETY: a real, fresh, sourced announcement plus shop fit = 35 is an EARLY SIGNAL — not cold, not warm', () => {
    const deep = {
      status: 'done' as const,
      signals: [sig({ signalType: 'public_business_activity', summary: 'ProSafety officially became a CleanSpace service center.', sourceUrl: 'https://prosafety.com/en/blog', observedAt: '2026-10-23' })],
    }
    const r = classify(input({ website: site({ commercePlatforms: ['PrestaShop'] }), deep }))
    expect(r.score).toBe(35)
    expect(r.classification).toBe('early_signal')
    expect(r.confidence).toBe('medium')
    expect(r.summary).toMatch(/Early signal — needs review: ProSafety officially became a CleanSpace service center/)
    expect(r.summary).not.toMatch(/\.\./) // no doubled full stop
    expect(r.summary).toBe('Early signal — needs review: ProSafety officially became a CleanSpace service center. Score 35; 50 and a verified signal are needed for warm.')
    expect(r.summary).toMatch(/50 and a verified signal are needed for warm/)
    const event = r.reasons.find((x) => x.signal === 'public_business_activity')!
    expect(event).toMatchObject({ points: 25, freshness: 'fresh', sourceUrl: 'https://prosafety.com/en/blog', observedAt: '2026-10-23' })
  })

  it('ONE EVENT, ONE SIGNAL: the same announcement found twice (same page, same day, different words) counts once — Pro Safety must stay at 35', () => {
    const url = 'https://prosafety.com/en/blog'
    const a = sig({ signalType: 'public_business_activity', summary: 'ProSafety officially became a CleanSpace service center.', sourceUrl: url, observedAt: '2026-10-23', evidence: 'ProSafety officially becomes a CleanSpace service center.' })
    const b = sig({ signalType: 'public_business_activity', summary: 'ProSafety officially became a CleanSpace service center to monitor respiratory devices.', sourceUrl: url + '/', observedAt: '2026-10-23T00:00:00Z', evidence: 'ProSafety officially becomes a CleanSpace service center.' })
    for (const order of [[a, b], [b, a]]) {
      const r = classify(input({ website: site({ commercePlatforms: ['PrestaShop'] }), deep: { status: 'done', signals: order } }))
      expect(r.score, 'two copies of one event').toBe(35)
      expect(r.classification).toBe('early_signal')
      expect(r.reasons.filter((x) => x.points === 25)).toHaveLength(1)
      expect(r.reasons.filter((x) => /counted once/.test(x.summary))).toHaveLength(1)
    }
    // the better-evidenced copy is the one kept, whichever order they arrive in
    const worse = sig({ signalType: 'public_business_activity', summary: 'ProSafety officially became a CleanSpace service centre for devices', sourceUrl: url, observedAt: '2026-10-23', confidence: 'medium' })
    const kept = classify(input({ deep: { status: 'done', signals: [worse, a] } }))
    expect(kept.reasons.find((x) => x.points > 0 && x.source === 'web_research')!.summary).toBe(a.summary)
  })

  it('different events are NOT merged: another day, or another page, counts separately', () => {
    const e = (day: string, url: string, n: string) => sig({ signalType: 'public_business_activity', summary: `event ${n}`, sourceUrl: url, observedAt: day })
    const r = classify(input({ deep: { status: 'done', signals: [e('2026-10-23', 'https://x.example/blog', '1'), e('2026-10-20', 'https://x.example/blog', '2'), e('2026-10-23', 'https://x.example/news', '3')] } }))
    expect(r.reasons.filter((x) => x.points === 25)).toHaveLength(2) // capped at 60 total, but all three are separate
    expect(r.reasons.filter((x) => /counted once/.test(x.summary))).toHaveLength(0)
    expect(r.classification).toBe('warm')
  })

  it('DUPLICATE EVIDENCE: the same page found again without a date, or the same news on two pages the same day, counts once', () => {
    const url = 'https://prosafety.com/en/blog'
    const words = 'ProSafety officially became a CleanSpace service center for respiratory devices'
    const dated = sig({ signalType: 'public_business_activity', summary: `${words}.`, sourceUrl: url, observedAt: '2026-10-23' })
    const undated = sig({ signalType: 'public_business_activity', summary: `${words} in Germany.`, sourceUrl: `${url}/?utm_source=x`, observedAt: null })
    const otherPage = sig({ signalType: 'public_business_activity', summary: `ProSafety officially became a CleanSpace service center for respiratory devices, say reports`, sourceUrl: 'https://trade-news.example/prosafety', observedAt: '2026-10-23' })
    for (const signals of [[dated, undated], [undated, dated], [dated, otherPage], [otherPage, dated], [dated, undated, otherPage], [otherPage, undated, dated]]) {
      const r = classify(input({ website: site({ commercePlatforms: ['PrestaShop'] }), deep: { status: 'done', signals } }))
      expect(r.score, `${signals.length} copies of one event`).toBe(35)
      expect(r.classification).toBe('early_signal')
      expect(r.reasons.filter((x) => x.points === 25)).toHaveLength(1)
    }
    // the copy that can be checked (has a source) is kept over one that cannot
    const unsourced = sig({ signalType: 'public_business_activity', summary: `${words}.`, sourceUrl: null, observedAt: '2026-10-23', evidence: 'a much longer piece of quoted text than the sourced one has' })
    const kept = classify(input({ deep: { status: 'done', signals: [unsourced, dated] } }))
    expect(kept.reasons.find((x) => x.points > 0 && x.source === 'web_research')!.sourceUrl).toBe(url)
  })

  it('DIFFERENT EVENTS stay separate: the same words long afterwards, another kind, or a different story on the same day', () => {
    const mk = (type: string, day: string, summary: string, url: string) => sig({ signalType: type, summary, sourceUrl: url, observedAt: day })
    const a = mk('public_business_activity', '2026-10-23', 'ProSafety officially became a CleanSpace service center for respiratory devices', 'https://a.example/1')
    const nextDay = mk('public_business_activity', '2026-11-20', 'ProSafety officially became a CleanSpace service center for respiratory devices', 'https://b.example/1')
    const otherKind = mk('hiring', '2026-10-23', 'ProSafety officially became a CleanSpace service center for respiratory devices', 'https://c.example/1')
    const otherStory = mk('public_business_activity', '2026-10-23', 'ProSafety opened a second warehouse near Munich to ship orders faster', 'https://d.example/1')
    const r = classify(input({ deep: { status: 'done', signals: [a, nextDay, otherKind, otherStory] } }))
    expect(r.reasons.filter((x) => /counted once/.test(x.summary))).toHaveLength(0)
    // four separate events: 25 + 25 + 10 hit the public-signal cap of 60 (so the last scores 0 because of the cap, not because it was a repeat)
    expect(r.reasons.filter((x) => x.source === 'web_research' && x.points > 0)).toHaveLength(3)
    expect(r.score).toBe(POINTS.publicSignalCap)
  })

  it('two different announcements by one company on one day (two warehouses) are NOT merged, though they share the company and the verb', () => {
    const a = sig({ signalType: 'public_business_activity', summary: 'ProSafety opened a new warehouse in Pune', sourceUrl: 'https://a.example/1', observedAt: '2026-10-23' })
    const b = sig({ signalType: 'public_business_activity', summary: 'ProSafety opened a new warehouse in Delhi', sourceUrl: 'https://b.example/2', observedAt: '2026-10-23' })
    for (const order of [[a, b], [b, a]]) {
      const r = classify(input({ deep: { status: 'done', signals: order } }))
      expect(r.reasons.filter((x) => x.source === 'web_research' && x.points === 25)).toHaveLength(2)
      expect(r.reasons.filter((x) => /counted once/.test(x.summary))).toHaveLength(0)
    }
  })

  // ── The same announcement republished on another site the next day ────────────────────────────────────────────────────────────
  // Found in review: counted twice it was worth 25 + 25, which turned an early signal of 35 / 45 into a false Warm of 60 / 70.
  describe('the same announcement republished on a second URL on the next day', () => {
    const P = 'ProSafety officially became a CleanSpace service center for respiratory devices'
    const original = () => sig({ signalType: 'public_business_activity', summary: P + '.', sourceUrl: 'https://prosafety.com/en/blog', observedAt: '2026-10-23' })
    const republished = (over: Partial<ObservedSignal> = {}) => sig({ signalType: 'public_business_activity', summary: P + ', trade press reports.', sourceUrl: 'https://trade-news.example/prosafety', observedAt: '2026-10-24', ...over })
    const tech = () => sig({ signalType: 'technology_added', signalCategory: 'technology', summary: 'Moved to Shopify', observedAt: '2026-10-20' })
    const score = (website: WebsiteObservation, signals: ObservedSignal[]) => classify(input({ website, deep: { status: 'done', signals } }))

    it('counts once, so it can never lift a company over 50: shop fit alone, and shop fit plus a platform change', () => {
      const fit = site({ hasProductSchema: true })
      const fitAndPlatform = site({ hasProductSchema: true, commercePlatforms: ['Shopify'] })
      // one copy
      expect(score(fit, [original()]).score).toBe(35)
      expect(score(fitAndPlatform, [original(), tech()]).score).toBe(45)
      // both copies: the same score, and still an early signal - never Warm
      for (const order of [[original(), republished()], [republished(), original()]]) {
        const a = score(fit, order)
        expect(a.score, 'fit only').toBe(35)
        expect(a.classification).toBe('early_signal')
        const b = score(fitAndPlatform, [...order, tech()])
        expect(b.score, 'fit + platform change').toBe(45)
        expect(b.classification).toBe('early_signal')
        expect(b.reasons.filter((x) => x.points === 25)).toHaveLength(1)
        expect(b.reasons.filter((x) => /counted once/.test(x.summary))).toHaveLength(1)
      }
    })

    it('keeps the ORIGINAL (earliest) copy as the event, so a republication cannot make old news look fresh', () => {
      const kept = classify(input({ deep: { status: 'done', signals: [republished({ freshness: 'fresh' }), { ...original(), freshness: 'aging' }] } }))
      const counted = kept.reasons.find((x) => x.source === 'web_research' && x.points > 0)!
      expect(counted.sourceUrl).toBe('https://prosafety.com/en/blog') // the 23 Oct original
      expect(counted.observedAt).toBe('2026-10-23')
    })

    it('holds within a week and stops there: the same words eight days later are a new item', () => {
      const dayN = (n: number) => '2026-10-' + String(23 + n).padStart(2, '0')
      const at = (n: number) => score(site({ hasProductSchema: true }), [original(), republished({ observedAt: dayN(n) })])
      for (const n of [0, 1, 3, 7]) expect(at(n).score, n + ' days later').toBe(35)
      expect(at(8).score).toBe(60)
      expect(at(8).classification).toBe('warm')
    })

    it('a genuinely NEW development is never folded into an older one - another place, company or number, even the next day', () => {
      const ev = (summary: string, url: string, day: string) => sig({ signalType: 'public_business_activity', summary, sourceUrl: url, observedAt: day })
      const pairs: Array<[ObservedSignal, ObservedSignal]> = [
        [ev('ProSafety opened a new warehouse in Pune', 'https://a.example/1', '2026-10-23'), ev('ProSafety opened a new warehouse in Delhi', 'https://b.example/1', '2026-10-24')],
        [ev('ProSafety Ltd opened a new large warehouse in Pune', 'https://a.example/2', '2026-10-23'), ev('ProSafety Ltd opened a new large warehouse in Delhi', 'https://b.example/2', '2026-10-24')],
        [ev('ProSafety signed a distribution agreement with Acme Retail for respiratory devices', 'https://a.example/3', '2026-10-23'), ev('ProSafety signed a distribution agreement with Globex Retail for respiratory devices', 'https://b.example/3', '2026-10-24')],
        [ev('ProSafety is hiring 5 engineers for its respiratory devices division', 'https://a.example/4', '2026-10-23'), ev('ProSafety is hiring 50 engineers for its respiratory devices division', 'https://b.example/4', '2026-10-24')],
        [ev('Raised a Series A round to expand its catalogue', 'https://a.example/5', '2026-10-23'), ev('Opened a second distribution centre near Munich', 'https://b.example/5', '2026-10-24')],
      ]
      for (const [a, b] of pairs) {
        for (const order of [[a, b], [b, a]]) {
          const r = score(site({ hasProductSchema: true }), order)
          expect(r.reasons.filter((x) => /counted once/.test(x.summary)), a.summary).toHaveLength(0)
          expect(r.reasons.filter((x) => x.source === 'web_research' && x.points === 25), a.summary).toHaveLength(2)
          expect(r.score).toBe(60)
        }
      }
    })

    it('a vaguer retelling joins the event it retells, but a third copy cannot bridge two different developments', () => {
      const pune = sig({ signalType: 'public_business_activity', summary: 'ProSafety Ltd opened a new large warehouse in Pune', sourceUrl: 'https://a.example/1', observedAt: '2026-10-23' })
      const delhi = sig({ signalType: 'public_business_activity', summary: 'ProSafety Ltd opened a new large warehouse in Delhi', sourceUrl: 'https://b.example/1', observedAt: '2026-10-24' })
      const vague = sig({ signalType: 'public_business_activity', summary: 'ProSafety Ltd opened a new large warehouse', sourceUrl: 'https://c.example/1', observedAt: '2026-10-24' })
      for (const order of [[pune, delhi, vague], [vague, delhi, pune], [delhi, vague, pune], [pune, vague, delhi]]) {
        const r = score(site({ hasProductSchema: true }), order)
        // Pune and Delhi are two developments; the vague copy joins one of them, never both: two events count
        expect(r.reasons.filter((x) => x.source === 'web_research' && x.points === 25)).toHaveLength(2)
        expect(r.reasons.filter((x) => /counted once/.test(x.summary))).toHaveLength(1)
      }
    })

    it('the same words as a different kind of signal are not merged', () => {
      const r = score(site({ hasProductSchema: true }), [original(), republished({ signalType: 'funding_round' })])
      expect(r.reasons.filter((x) => /counted once/.test(x.summary))).toHaveLength(0)
      expect(r.score).toBe(60)
    })
  })

  it('evaluating again never adds up: the score is worked out afresh from the evidence every time', () => {
    const e = sig({ signalType: 'public_business_activity', summary: 'ProSafety officially became a CleanSpace service center', sourceUrl: 'https://prosafety.com/en/blog', observedAt: '2026-10-23' })
    const first = classify(input({ website: site({ commercePlatforms: ['PrestaShop'] }), deep: { status: 'done', signals: [e] } }))
    const again = classify(input({ website: site({ commercePlatforms: ['PrestaShop'] }), deep: { status: 'done', signals: [e, { ...e }, { ...e }] } }))
    expect(again.score).toBe(first.score)
    expect(again.classification).toBe(first.classification)
  })

  it('a fresh reply from a person alone (45) is an early signal; an older reply in the window is not fresh, so it is cold; reply + fit is warm', () => {
    const fresh = classify(input({ crm: { ok: true, signals: [sig({ signalType: 'inbound_engagement', signalCategory: 'crm', sourceUrl: null, freshness: 'fresh' })] } }))
    expect(fresh.score).toBe(45)
    expect(fresh.classification).toBe('early_signal')
    const old = classify(input({ crm: { ok: true, signals: [sig({ signalType: 'inbound_engagement', signalCategory: 'crm', sourceUrl: null, freshness: 'aging' })] } }))
    expect(old.score).toBe(45)
    expect(old.classification).toBe('cold')
    expect(old.summary).toMatch(/nothing fresh enough for an early signal/)
    const warm = classify(input({ crm: { ok: true, signals: [sig({ signalType: 'inbound_engagement', signalCategory: 'crm', sourceUrl: null, freshness: 'fresh' })] }, website: site({ commercePlatforms: ['Shopify'] }) }))
    expect(warm.score).toBe(55)
    expect(warm.classification).toBe('warm')
  })

  it('a score in the early-signal range WITHOUT a verified fresh intent signal is cold: platform detection and fit never qualify', () => {
    // fit 10 + a platform change 10 = 20 (the most fit can ever give), plus an AGING verified event (half of 15 = 7): 27 is in the
    // early-signal range, but nothing is fresh, so it is cold.
    const deep = {
      status: 'done' as const,
      signals: [
        sig({ signalType: 'technology_added', signalCategory: 'technology', summary: 'Moved to Shopify' }),
        sig({ signalType: 'expansion', confidence: 'medium', freshness: 'aging' }),
      ],
    }
    const r = classify(input({ website: site({ commercePlatforms: ['Shopify'], hasProductSchema: true }), deep }))
    expect(r.score).toBe(27)
    expect(r.score).toBeGreaterThanOrEqual(EARLY_SIGNAL_MIN)
    expect(r.score).toBeLessThan(WARM_THRESHOLD)
    expect(r.classification).toBe('cold')
    expect(r.reasons.find((x) => x.signal === 'technology_added')!.summary).toMatch(/platform detection: fit, not a qualifying intent signal/)
    // and no number of platform detections reaches the early-signal range, let alone warm: fit alone is worth at most 20
    const many = { status: 'done' as const, signals: [1, 2, 3, 4, 5, 6].map((i) => sig({ signalType: 'technology_added', signalCategory: 'technology', summary: `platform ${i}` })) }
    const stacked = classify(input({ website: site({ commercePlatforms: ['A'] }), deep: many }))
    expect(stacked.score).toBe(POINTS.websiteFit + POINTS.technologyAdded)
    expect(stacked.classification).toBe('cold')
  })

  it('PLATFORM DETECTIONS DO NOT STACK: the same fit recorded again is duplicate evidence and earns nothing more', () => {
    const many = { status: 'done' as const, signals: [1, 2, 3, 4, 5, 6].map((i) => sig({ signalType: 'technology_added', signalCategory: 'technology', summary: `moved to platform ${i}` })) }
    const r = classify(input({ website: site({ commercePlatforms: ['Shopify'] }), deep: many }))
    const tech = r.reasons.filter((x) => x.signal === 'technology_added')
    expect(tech.filter((x) => x.points === POINTS.technologyAdded)).toHaveLength(1)
    expect(tech.filter((x) => x.points === 0)).toHaveLength(5)
    expect(tech.filter((x) => x.points === 0).every((x) => /fit points were already counted/.test(x.summary))).toBe(true)
    // and fit cannot push a weak event over the warm line: one medium event (15) + at most 20 of fit = 35, an early signal at best
    const withEvent = classify(input({ website: site({ commercePlatforms: ['Shopify'] }), deep: { status: 'done', signals: [...many.signals, sig({ signalType: 'expansion', confidence: 'medium' })] } }))
    expect(withEvent.score).toBe(10 + 10 + 15)
    expect(withEvent.classification).toBe('early_signal')
  })

  it('an event is verified only with a source address: without one it counts for nothing and qualifies nothing', () => {
    const deep = { status: 'done' as const, signals: [sig({ signalType: 'rumour', sourceUrl: null, confidence: 'high', freshness: 'fresh' })] }
    const r = classify(input({ website: site({ commercePlatforms: ['Shopify'] }), deep }))
    expect(r.score).toBe(POINTS.websiteFit)
    expect(r.classification).toBe('cold')
    expect(r.reasons.find((x) => x.signal === 'rumour')).toMatchObject({ points: 0 })
    expect(r.reasons.find((x) => x.signal === 'rumour')!.summary).toMatch(/no source address to verify it/)
  })

  it('an aging event counts half and qualifies for warm only with enough points, but is not "fresh" for an early signal', () => {
    const deep = { status: 'done' as const, signals: [sig({ signalType: 'expansion', confidence: 'high', freshness: 'aging' })] }
    const r = classify(input({ website: site({ commercePlatforms: ['Shopify'] }), deep })) // 10 + 12
    expect(r.score).toBe(22)
    expect(r.classification).toBe('cold') // below 25 anyway
    const more = { status: 'done' as const, signals: [sig({ signalType: 'a', confidence: 'high', freshness: 'aging' }), sig({ signalType: 'b', confidence: 'high', freshness: 'aging' })] }
    const r2 = classify(input({ website: site({ commercePlatforms: ['Shopify'] }), deep: more })) // 10 + 12 + 12 = 34, nothing fresh
    expect(r2.score).toBe(34)
    expect(r2.classification).toBe('cold')
    expect(r2.summary).toMatch(/nothing fresh enough for an early signal/)
  })

  it('warm still needs BOTH a score of 50 and a verified intent signal', () => {
    // 60 points from verified events: warm
    const deep = { status: 'done' as const, signals: [1, 2, 3].map((i) => sig({ signalType: `event${i}` })) }
    expect(classify(input({ website: site({ hasProductSchema: true }), deep })).classification).toBe('warm')
    // 50+ points but no verified intent signal is never warm: a company whose only points are fit (at most 20) cannot get there, and
    // a high score from a reply that is NOT interest (declined) or from unverifiable events is not warm either
    const stack = { status: 'done' as const, signals: Array.from({ length: 8 }, (_, i) => sig({ signalType: 'technology_added', signalCategory: 'technology', summary: `p${i}` })) }
    const r = classify(input({ website: site({ commercePlatforms: ['A'] }), deep: stack }))
    expect(r.score).toBeLessThan(WARM_THRESHOLD)
    expect(r.classification).toBe('cold')
  })

  it('RESEARCH THAT DID NOT FINISH IS NEVER "COLD": the Gemini call ceiling or the research cap leaves the company open', () => {
    for (const status of ['skipped_ceiling', 'skipped_cap'] as const) {
      // nothing found at all: not enough data, not cold
      const none = classify(input({ website: site({ commercePlatforms: ['Shopify'] }), deep: { status, signals: [] } }))
      expect(none.classification, status).toBe('insufficient_data')
      expect(none.summary, status).toMatch(/Not classified as cold; evaluate again/)
      // some interest found, but not enough to classify: still open, not cold
      // (an older reply alone is 45: with a shop it would be 55 and warm, so this company has none)
      const old = classify(input({ crm: { ok: true, signals: [sig({ signalType: 'inbound_engagement', signalCategory: 'crm', sourceUrl: null, freshness: 'aging' })] }, deep: { status, signals: [] } }))
      expect(old.classification, status).toBe('insufficient_data')
      expect(old.summary, status).toMatch(/Some interest was found/)
    }
    expect(classify(input({ website: site({ commercePlatforms: ['Shopify'] }), deep: { status: 'skipped_ceiling', signals: [] } })).summary).toMatch(/Gemini call ceiling/)
  })

  it('what WAS found before the ceiling still stands: a fresh reply is an early signal, and reply + fit is warm', () => {
    const reply = sig({ signalType: 'inbound_engagement', signalCategory: 'crm', sourceUrl: null, freshness: 'fresh' })
    expect(classify(input({ crm: { ok: true, signals: [reply] }, deep: { status: 'skipped_ceiling', signals: [] } })).classification).toBe('early_signal')
    expect(classify(input({ crm: { ok: true, signals: [reply] }, website: site({ commercePlatforms: ['Shopify'] }), deep: { status: 'skipped_ceiling', signals: [] } })).classification).toBe('warm')
  })

  it('incomplete research does not change the statuses the CRM decides, and finished research can still be cold', () => {
    for (const [t, status] of [['existing_customer', 'existing_customer'], ['open_opportunity', 'active_opportunity'], ['suppressed', 'do_not_contact']] as const) {
      expect(classify(input({ crm: { ok: true, signals: [crmSig(t, 'negative')] }, deep: { status: 'skipped_ceiling', signals: [] } })).classification).toBe(status)
    }
    expect(classify(input({ website: site({ commercePlatforms: ['Shopify'] }), deep: { status: 'done', signals: [] } })).classification).toBe('cold')
    expect(classify(input({ deep: { status: 'not_needed', signals: [] } })).classification).toBe('cold') // nothing flagged it for research: that is a finished screen
  })

  it('negative public findings lower the score; the score stays within 0–100', () => {
    const deep = { status: 'done' as const, signals: [sig({ signalType: 'layoffs', polarity: 'negative' })] }
    const r = classify(input({ deep }))
    expect(r.score).toBe(0)
    expect(r.reasons.find((x) => x.signal === 'layoffs')!.points).toBe(POINTS.negativePublicSignal)
  })
})

// A company nobody examined cannot be called cold. A bounce, an auto-reply or an old lost deal is a note in the CRM, not an
// examination; without a website that was read, or research that finished, the honest answer is "not enough data".
describe('no website, no research: never cold on a CRM note alone', () => {
  const noSite = site({ status: 'no_website', url: null })

  it('a bounce or auto-reply is not enough to call a company cold', () => {
    const r = classify(input({ crm: { ok: true, signals: [crmSig('automated_inbound_only', 'neutral')] }, website: noSite }))
    expect(r.classification).toBe('insufficient_data')
    expect(r.summary).toMatch(/Nothing to evaluate/)
  })

  it('nor is a negative note such as a past lost deal', () => {
    const r = classify(input({ crm: { ok: true, signals: [crmSig('lost_deal', 'negative')] }, website: noSite }))
    expect(r.classification).toBe('insufficient_data')
  })

  it('a real reply still makes it an early signal without a website (unchanged)', () => {
    const r = classify(input({ crm: { ok: true, signals: [crmSig('inbound_engagement')] }, website: noSite }))
    expect(r.classification).toBe('early_signal')
  })

  it('a website that WAS read, with nothing found, is still cold (the rule is not simply "never cold")', () => {
    const r = classify(input({ crm: { ok: true, signals: [crmSig('automated_inbound_only', 'neutral')] }, website: site() }))
    expect(r.classification).toBe('cold')
  })

  it('web research that finished (nothing found) may call a company without a website cold', () => {
    const r = classify(input({ crm: { ok: true, signals: [crmSig('automated_inbound_only', 'neutral')] }, website: noSite, deep: { status: 'done', signals: [] } }))
    expect(r.classification).toBe('cold')
  })
})
