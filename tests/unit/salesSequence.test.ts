import { describe, expect, it, vi } from 'vitest'

// THE SALES-APPROVED OUTREACH SEQUENCE — the pure rules.
//
// The approved copy is Sales's, verbatim; placeholders are filled only from
// verified facts or Sales's own entries; the stage machine follows the PDF's
// timing; nothing can be approved while the copy still asserts a test result
// nobody confirmed; and a model's reading of a reply or its personal line is
// held to the words actually on the page.

vi.mock('../../src/platform/db.js', () => ({ prisma: {} }))
vi.mock('../../src/config/env.js', () => ({ env: { OUTREACH_SEQUENCE_TIMEZONE: 'America/New_York' } }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
// The model, stood in for. What it returns is deliberately hostile: a made-up
// product term and a written sentence, so the tests below show that neither
// can reach a customer.
const generate = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate }) }))

const { STAGE_TEMPLATES, templateFor, EXPO, REPLY_FOLLOWUP_EXPO_PARAGRAPH, PRODUCT_PAGE_LINE } = await import('../../src/outreach/salesSequence/templates.js')
const { fill, findUnresolved, firstName, companyDisplayName, placeholdersIn } = await import('../../src/outreach/salesSequence/placeholders.js')
const { dayWindow, sameOrNextBusinessDay, startOfLocalDay } = await import('../../src/outreach/salesSequence/businessDays.js')
const { computeSequence } = await import('../../src/outreach/salesSequence/stageMachine.js')
const { evaluateGates } = await import('../../src/outreach/salesSequence/gates.js')
const { verifyReading } = await import('../../src/outreach/salesSequence/replies.js')
const { checkLine, appearsIn, categoryLeaf, withoutExpoParagraph, valuesFromInputs, composeStage, withoutProductPageLine } = await import('../../src/outreach/salesSequence/compose.js')
const { verifiedProductPageUrl } = await import('../../src/outreach/salesSequence/productPage.js')

describe('the product page in Versions 1–3', () => {
  const product = (url: string | null) => ({ name: 'VIO3 electro-surgical unit', url, category: 'Surgical > Electrosurgery', description: null, gaps: [] })

  it('links only this company’s own verified product page — never another site, its homepage, or a malformed address', () => {
    expect(verifiedProductPageUrl(product('https://www.medinahealthcare.com/products/vio3'), 'medinahealthcare.com')).toBe('https://www.medinahealthcare.com/products/vio3')
    expect(verifiedProductPageUrl(product('https://shop.medinahealthcare.com/p/vio3'), 'www.medinahealthcare.com')).toBe('https://shop.medinahealthcare.com/p/vio3')
    expect(verifiedProductPageUrl(product('https://www.othersupplier.com/products/vio3'), 'medinahealthcare.com')).toBeNull()
    expect(verifiedProductPageUrl(product('https://www.medinahealthcare.com/'), 'medinahealthcare.com')).toBeNull()
    expect(verifiedProductPageUrl(product('not a url'), 'medinahealthcare.com')).toBeNull()
    // Articles, posts, searches and listings are not a product page — seen on a real company.
    expect(verifiedProductPageUrl(product('https://www.medinahealth.com.mt/2024/09/23/vio3-electro-surgical-unit-by-erbe-at-mater-dei-hospital/'), 'medinahealth.com.mt')).toBeNull()
    expect(verifiedProductPageUrl(product('https://www.medinahealthcare.com/news/vio3-launch'), 'medinahealthcare.com')).toBeNull()
    expect(verifiedProductPageUrl(product('https://www.medinahealthcare.com/products/'), 'medinahealthcare.com')).toBeNull()
    expect(verifiedProductPageUrl(product('https://www.medinahealthcare.com/catalogsearch?q=vio3'), 'medinahealthcare.com')).toBeNull()
    expect(verifiedProductPageUrl(product('https://www.medinahealthcare.com/category/electrosurgery'), 'medinahealthcare.com')).toBeNull()
    expect(verifiedProductPageUrl(product('https://www.medinahealthcare.com/item/vio3-300d'), 'medinahealthcare.com')).toBe('https://www.medinahealthcare.com/item/vio3-300d')
    // Prospects' own address rule, applied here too: recalls, contests, newsrooms, press releases.
    expect(verifiedProductPageUrl(product('https://www.kleintools.com/recall/ncvt1-sp'), 'kleintools.com')).toBeNull()
    expect(verifiedProductPageUrl(product('https://indsupply.com/a2z_crescent-contest_landing-page/'), 'indsupply.com')).toBeNull()
    expect(verifiedProductPageUrl(product('https://newsroom.stanleyblackanddecker.com/2026-09-08-Stanley-to-Present'), 'stanleyblackanddecker.com')).toBeNull()
    expect(verifiedProductPageUrl(product('https://www.parker.com/us/en/about-parker/newsroom/news-release-details/motor.html'), 'parker.com')).toBeNull()
    expect(verifiedProductPageUrl(product(null), 'medinahealthcare.com')).toBeNull()
    expect(verifiedProductPageUrl(null, 'medinahealthcare.com')).toBeNull()
  })

  const facts = (productPageUrl: string | null) => ({
    crmCompanyId: 'c1',
    discoveredCompanyId: 'd1',
    companyName: 'Medina Healthcare Ltd',
    companyDomain: 'medinahealthcare.com',
    companySummary: null,
    decisionMaker: { id: 'dm1', fullName: 'John Camilleri', title: 'Director', email: 'john@medinahealthcare.com', profileUrl: null },
    product: product(productPageUrl),
    productPageUrl,
    signals: [],
    facts: [],
  })
  const compose = (v: 'v1' | 'v2' | 'v3', url: string | null) =>
    composeStage({
      template: templateFor('initial', v),
      facts: facts(url) as never,
      sender: { firstName: 'Mani', fullName: 'Mani', email: 'mani@altius.test', companyName: 'AltiusNxt', signature: '' },
      inputs: {},
      initialSubject: null,
      tenantId: 't1',
      personalise: false,
    })

  // SALES ASKED FOR THE PRODUCT URL TO GO (2026-09-30).
  //
  // Versions 1-3 used to end with "For reference, this is the product page I
  // checked: [Product page URL]". No email carries it now — not the verified
  // page, not a placeholder, not anything. That also closes the last route by
  // which a wrong or stale link could reach a customer.
  it('leaves the product page line out of every version, even when a verified page exists', async () => {
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const r = await compose(v, 'https://www.medinahealthcare.com/products/vio3')
      expect(r.body, v).not.toContain('product page I checked')
      expect(r.body, v).not.toContain('https://www.medinahealthcare.com/products/vio3')
      expect(r.body, v).not.toContain('[Product page URL]')
      // No hole where the line used to be.
      expect(r.body, v).not.toMatch(/\n{3,}/)
      expect(r.unresolved, v).toEqual([])
      expect(r.resolution.find((x) => x.placeholder === 'productPageUrl')?.source).toMatch(/not included in any email/)
    }
  })

  it('carries no URL at all — of this company or any other', async () => {
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const r = await compose(v, 'https://www.medinahealthcare.com/products/vio3')
      expect(r.body, v).not.toMatch(/https?:\/\//)
    }
  })

  it('reads the same whether or not Prospects verified a page', async () => {
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const withPage = await compose(v, 'https://www.medinahealthcare.com/products/vio3')
      const without = await compose(v, null)
      expect(without.body, v).toBe(withPage.body)
    }
    expect(withoutProductPageLine(templateFor('initial', 'v1').body)).not.toContain(PRODUCT_PAGE_LINE)
  })
})

const TZ = 'America/New_York'

describe('the approved templates are the PDF, verbatim', () => {
  it('carries every stage of the USA sequence, with three initial versions', () => {
    expect(STAGE_TEMPLATES.map((t) => t.pdfRef)).toEqual(['1 · Version 1', '1 · Version 2', '1 · Version 3', '2.1', '2.2', '2.3', '2.4', '3', '3.1', '4'])
  })

  it('keeps the approved wording exactly, typos included', () => {
    const v1 = templateFor('initial', 'v1')
    expect(v1.subject).toBe('Who AI recommends instead of [Company] for [Product]?')
    expect(v1.body).toContain("[Company] wasn't the one recommended. Two other suppliers were.")
    expect(v1.body).toContain('We have spent 20+ years fixing exactly this for distributors like Vallen, Travers Tool Co Inc, Industrial Sales & Engineering Co, Coastal Farm, SRS Distribution Inc, etc.')
    expect(templateFor('initial', 'v2').subject).toBe('Ran a test on [Product] across the AI LLMs — thought you did want to see it')
    expect(templateFor('initial', 'v3').body).toContain('[Company / Product] was not the one recommended. Two other suppliers were.')
    expect(templateFor('reply_followup').body).toContain('no pressure either way, the reports coming regardless.')
    expect(templateFor('breakup').body).toContain('Otherwise, no worries at all the offer stands whenever it\'s useful.')
    expect(templateFor('noreply_report').body).toContain('● [1st SKU name]')
  })

  it('never hard-codes the sender', () => {
    for (const t of STAGE_TEMPLATES) {
      expect(`${t.subject ?? ''} ${t.body}`).not.toMatch(/\bManoj\b|AltiusNxt/)
      expect(t.body.trim().endsWith('[Sender first name]')).toBe(true)
    }
  })

  it('adds exactly one product page line to Versions 1, 2 and 3 — after the product paragraph — and to no other stage', () => {
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const paragraphs = templateFor('initial', v).body.split('\n\n')
      expect(paragraphs.filter((p) => p === PRODUCT_PAGE_LINE), v).toHaveLength(1)
      const at = paragraphs.indexOf(PRODUCT_PAGE_LINE)
      // The paragraph just before it is the one naming the test that was run.
      expect(paragraphs[at - 1], v).toMatch(/Two other suppliers were\.|didn't come up as the pick in any of the four\./)
    }
    for (const t of STAGE_TEMPLATES.filter((x) => x.key !== 'initial')) expect(t.body).not.toContain('[Product page URL]')
  })

  it('keeps the expo registration details, minus the PDF’s layout brackets', () => {
    expect(REPLY_FOLLOWUP_EXPO_PARAGRAPH).toContain('Code: ALTIUSVIP')
    expect(REPLY_FOLLOWUP_EXPO_PARAGRAPH).toContain(EXPO.registrationUrl)
    expect(templateFor('expo_invite').body).toContain(EXPO.registrationUrl)
    expect(templateFor('reply_followup').body).not.toMatch(/\[\s*Guest registrations/)
  })
})

describe('placeholders', () => {
  it('fills only the explicit placeholders, and leaves one with no value visible', () => {
    const out = fill('[Name], [Company] sells [Product].', { name: 'Ada', company: '3M' })
    expect(out).toBe('Ada, 3M sells [Product].')
    expect(findUnresolved(out)).toEqual(['product'])
  })

  it('does not treat the expo text as an unfilled placeholder', () => {
    expect(findUnresolved(templateFor('expo_invite').body)).toEqual(['name', 'senderFirstName'])
  })

  it('reads a first name from a verified full name, never inventing one', () => {
    expect(firstName('Dr. Jane Q. Smith')).toBe('Jane')
    expect(firstName('John "Jack" Doe')).toBe('John')
    expect(firstName('')).toBeNull()
    expect(firstName(null)).toBeNull()
  })

  it('writes the company as an email would, without its legal form', () => {
    expect(companyDisplayName('Radians, Inc.')).toBe('Radians')
    expect(companyDisplayName('Acme Safety Co LLC')).toBe('Acme Safety')
    expect(companyDisplayName('3M')).toBe('3M')
  })

  it('knows which placeholders each template uses', () => {
    expect(placeholdersIn(templateFor('noreply_followup').body)).toEqual(expect.arrayContaining(['name', 'product', 'clientCompanyName']))
  })
})

describe('business days', () => {
  it('counts "Day 9–10" as whole local calendar days', () => {
    const d0 = new Date('2026-10-01T15:00:00Z') // Thu 1 Oct, 11:00 in New York
    const w = dayWindow(d0, 9, 10, TZ)
    expect(w.start.toISOString()).toBe(startOfLocalDay(new Date('2026-10-10T16:00:00Z'), TZ).toISOString())
    expect(w.end.getTime()).toBe(startOfLocalDay(new Date('2026-10-12T16:00:00Z'), TZ).getTime() - 1)
  })

  it('answers a Friday reply by the end of Monday', () => {
    const friday = new Date('2026-10-02T18:00:00Z')
    const w = sameOrNextBusinessDay(friday, TZ)
    expect(w.end.getTime()).toBe(startOfLocalDay(new Date('2026-10-06T16:00:00Z'), TZ).getTime() - 1) // end of Mon 5 Oct
  })
})

describe('the stage machine follows the PDF', () => {
  const D0 = new Date('2026-09-28T14:00:00Z') // Mon 28 Sep
  const at = (days: number) => new Date(D0.getTime() + days * 86_400_000)
  const sent = (stageKey: string, day = 0) => ({ stageKey: stageKey as never, status: 'sent', sentAt: at(day) })
  const seq = (over: Partial<Parameters<typeof computeSequence>[0]>) =>
    computeSequence({ campaignStatus: 'active', actions: [], replies: [], now: at(0), tz: TZ, ...over })
  const stage = (s: ReturnType<typeof computeSequence>, key: string) => s.stages.find((x) => x.stageKey === key)!

  it('starts with the initial email', () => {
    const s = seq({})
    expect(s.phase).toBe('not_started')
    expect(stage(s, 'initial').canPrepare).toBe(true)
    expect(s.next.stageKey).toBe('initial')
  })

  it('opens 2.3 at Day 9–10, preparable two days ahead, and not before', () => {
    const early = seq({ actions: [sent('initial')], now: at(5) })
    expect(stage(early, 'noreply_followup').status).toBe('upcoming')
    expect(stage(early, 'noreply_followup').canPrepare).toBe(false)
    const due = seq({ actions: [sent('initial')], now: at(7.5) })
    expect(stage(due, 'noreply_followup').status).toBe('due')
    expect(stage(due, 'noreply_followup').canPrepare).toBe(true)
    expect(due.reminders[0]!.label).toMatch(/Day 4–5/)
  })

  it('runs 2.4, the expo invite and the break-up in order, each after the one before', () => {
    const s = seq({ actions: [sent('initial'), sent('noreply_followup', 9)], now: at(12) })
    expect(stage(s, 'noreply_report').canPrepare).toBe(true)
    expect(stage(s, 'expo_invite').canPrepare).toBe(false) // 2.4 not sent yet
  })

  it('skips the expo invite when it would fall on or after the expo', () => {
    const late = new Date('2026-10-25T14:00:00Z') // Day 16 = 10 Nov
    const s = computeSequence({ campaignStatus: 'active', actions: [{ stageKey: 'initial', status: 'sent', sentAt: late }], replies: [], now: late, tz: TZ })
    expect(stage(s, 'expo_invite').status).toBe('not_applicable')
    expect(stage(s, 'expo_invite').reason).toMatch(/expo/)
  })

  it('ends after the break-up email', () => {
    const s = seq({
      actions: [sent('initial'), sent('noreply_followup', 9), sent('noreply_report', 12), sent('expo_invite', 16), sent('breakup', 18)],
      now: at(19),
    })
    expect(s.phase).toBe('completed')
    expect(s.next.stageKey).toBeNull()
  })

  it('ends the no-reply track on any reply, and opens 2.1 and 2.2 for SKUs', () => {
    const s = seq({ actions: [sent('initial')], replies: [{ receivedAt: at(3), classification: 'sent_skus' }], now: at(3) })
    expect(s.phase).toBe('replied')
    expect(stage(s, 'noreply_followup').status).toBe('not_applicable')
    expect(stage(s, 'reply_followup').status).toBe('due')
    expect(stage(s, 'sku_report').status).toBe('due')
    expect(stage(s, 'expo_cannot_attend').status).toBe('not_applicable')
  })

  it('opens 3.1 for a prospect who cannot attend the expo', () => {
    const s = seq({ actions: [sent('initial')], replies: [{ receivedAt: at(17), classification: 'interested_cannot_attend_expo' }], now: at(17) })
    expect(stage(s, 'expo_cannot_attend').canPrepare).toBe(true)
  })

  it('hands an interested reply without SKUs to Sales, with no draft', () => {
    const s = seq({ actions: [sent('initial')], replies: [{ receivedAt: at(3), classification: 'wants_more_info' }], now: at(3) })
    expect(s.phase).toBe('sales_to_reply')
    expect(s.next.text).toMatch(/Sales to reply personally/)
  })

  it('reads paused and stopped from the campaign itself, so a resume resumes', () => {
    expect(seq({ campaignStatus: 'paused', actions: [sent('initial')] }).phase).toBe('paused')
    expect(seq({ campaignStatus: 'cancelled', actions: [sent('initial')] }).phase).toBe('stopped')
    const resumed = seq({ actions: [sent('initial')], replies: [{ receivedAt: at(3), classification: 'follow_up_later' }], now: at(4) })
    expect(resumed.phase).toBe('replied')
  })

  it('completes when the report is delivered', () => {
    const s = seq({ actions: [sent('initial'), sent('reply_followup', 3), sent('sku_report', 4)], replies: [{ receivedAt: at(3), classification: 'sent_skus' }], now: at(4) })
    expect(s.phase).toBe('completed')
  })
})

describe('approval gates', () => {
  const base = (over: Partial<Parameters<typeof evaluateGates>[0]> = {}) =>
    evaluateGates({
      template: templateFor('initial', 'v1'),
      stage: null,
      actionStatus: 'draft',
      subject: 'Who AI recommends instead of Acme for hard hats?',
      body: 'Jane,\n\nAda here, from AltiusNxt.\n\nAda',
      inputs: {},
      attestations: [{ key: 'ai_test', statement: 'x', byCrmUserId: 'u', at: new Date('2026-09-28').toISOString() }],
      confirmedSkus: [],
      recipientEmail: 'jane@acme.test',
      sender: { firstName: 'Ada', fullName: 'Ada L', email: 'ada@x.test', companyName: 'AltiusNxt', signature: '' },
      suppression: { suppressed: false },
      now: new Date('2026-09-29'),
      ...over,
    })
  const item = (r: ReturnType<typeof evaluateGates>, key: string) => r.items.find((i) => i.key === key)!

  it('passes a complete draft', () => {
    expect(base().ok).toBe(true)
  })

  it('refuses while a placeholder is unfilled', () => {
    const r = base({ subject: 'Who AI recommends instead of Acme for [Product]?' })
    expect(r.ok).toBe(false)
    expect(item(r, 'placeholders').detail).toMatch(/\[Product\]/)
  })

  it('refuses until Sales confirms the AI-engine test, and again after a week', () => {
    expect(item(base({ attestations: [] }), 'attest_ai_test').ok).toBe(false)
    expect(item(base({ now: new Date('2026-10-08') }), 'attest_ai_test').ok).toBe(false)
  })

  it('needs 5 SKU names and the report result before a report email', () => {
    const r = base({ template: templateFor('sku_report'), attestations: [], inputs: { skus: ['a', 'b'], xOf5: 7 } })
    expect(item(r, 'input_skus').ok).toBe(false)
    expect(item(r, 'input_x').ok).toBe(false)
    expect(item(r, 'attest_report_attached').ok).toBe(false)
  })

  it('needs the client company for 2.3, and 5 confirmed SKUs for 2.1', () => {
    expect(item(base({ template: templateFor('noreply_followup') }), 'input_client').ok).toBe(false)
    expect(item(base({ template: templateFor('reply_followup'), confirmedSkus: ['a'] }), 'confirmed_skus').ok).toBe(false)
  })

  it('needs a recipient, a configured sender, and no suppression', () => {
    expect(item(base({ recipientEmail: null }), 'recipient').ok).toBe(false)
    expect(item(base({ recipientEmail: 'not-an-email' }), 'recipient').ok).toBe(false)
    expect(item(base({ sender: { firstName: '', fullName: '', email: '', companyName: '', signature: '' } }), 'sender').ok).toBe(false)
    expect(item(base({ suppression: { suppressed: true, detail: 'Opted out' } }), 'suppression').ok).toBe(false)
  })

  it('warns — never blocks silently — when the expo has passed', () => {
    const r = base({ template: templateFor('reply_followup'), confirmedSkus: ['a', 'b', 'c', 'd', 'e'], attestations: [], now: new Date('2026-11-10') })
    expect(r.warnings[0]).toMatch(/has passed/)
  })
})

describe('reading a reply is held to the reply', () => {
  const reply = 'Sure, here are five: HX-200, HX-300, Titan Glove L, KneePad Pro, VisorMax. Thanks!'

  it('keeps a reading whose quote and SKUs are in the reply', () => {
    const r = verifyReading({ classification: 'sent_skus', evidenceQuote: 'here are five', skus: ['HX-200', 'HX-300', 'Titan Glove L', 'KneePad Pro', 'VisorMax'] }, reply)
    expect(r.classification).toBe('sent_skus')
    expect(r.skus).toHaveLength(5)
  })

  it('drops a SKU the prospect never wrote', () => {
    const r = verifyReading({ classification: 'sent_skus', evidenceQuote: 'here are five', skus: ['HX-200', 'HX-999'] }, reply)
    expect(r.skus).toEqual(['HX-200'])
    expect(r.checks.join(' ')).toMatch(/HX-999/)
  })

  it('makes an unsupported reading "unclear" instead of guessing', () => {
    expect(verifyReading({ classification: 'not_interested', evidenceQuote: 'please remove me', skus: [] }, reply).classification).toBe('unclear')
    expect(verifyReading({ classification: 'sent_skus', evidenceQuote: 'Thanks!', skus: ['Nothing Real'] }, reply).classification).toBe('unclear')
  })
})

describe('the one line the AI may add is checked', () => {
  const facts = [
    { id: 'signal.s1', label: 'Intent signal (business)', value: 'Acme opened a new distribution centre in Texas', source: 'Intent Signals', sourceUrl: null },
    { id: 'product.name', label: 'Product analysed', value: 'Titan Hard Hat X200', source: 'Prospects', sourceUrl: null },
  ]
  const allowed = ['Acme Safety Co', 'Acme', 'Jane Smith']

  it('accepts a line grounded in the facts it cites', () => {
    expect(checkLine({ text: 'Congratulations on the new distribution centre in Texas.', factIds: ['signal.s1'] }, facts, allowed).ok).toBe(true)
  })

  it('rejects a line citing nothing, or a fact that was not supplied', () => {
    expect(checkLine({ text: 'Great work lately.', factIds: [] }, facts, allowed).ok).toBe(false)
    expect(checkLine({ text: 'Great work lately.', factIds: ['signal.nope'] }, facts, allowed).ok).toBe(false)
  })

  it('rejects a number or a name the cited facts do not contain', () => {
    expect(checkLine({ text: 'Congratulations on the 3 new centres in Texas.', factIds: ['signal.s1'] }, facts, allowed).ok).toBe(false)
    expect(checkLine({ text: 'Congratulations on the new centre in Ohio.', factIds: ['signal.s1'] }, facts, allowed).ok).toBe(false)
  })

  it('takes a product term only if it is word for word in the verified product facts', () => {
    expect(appearsIn('hard hat', ['Titan Hard Hat X200'])).toBe(true)
    expect(appearsIn('safety helmets', ['Titan Hard Hat X200'])).toBe(false)
    expect(categoryLeaf('Safety > Head Protection > Hard Hats')).toBe('Hard Hats')
  })
})

describe('Sales-entered values and the expo paragraph', () => {
  it('turns the report result into the approved sentence', () => {
    const v = valuesFromInputs({ xOf5: 4 })
    expect(v.xOf5Recommended).toBe('4 of 5 went from not recommended to appearing in the AI answer')
    expect(v.xOf5NotRecommended).toBe('4 of 5 were not recommended by any of the four engines')
  })

  it('removes only the expo paragraph from 2.1, when asked', () => {
    const body = templateFor('reply_followup').body
    const out = withoutExpoParagraph(body)
    expect(out).not.toContain('B2B eCommerce World')
    expect(out).toContain('Turnaround is about 1 business day (8–12 hrs).')
    expect(out).toContain('Talk soon.')
  })
})
