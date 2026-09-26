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
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate: vi.fn() }) }))

const { STAGE_TEMPLATES, templateFor, EXPO, REPLY_FOLLOWUP_EXPO_PARAGRAPH } = await import('../../src/outreach/salesSequence/templates.js')
const { fill, findUnresolved, firstName, companyDisplayName, placeholdersIn } = await import('../../src/outreach/salesSequence/placeholders.js')
const { dayWindow, sameOrNextBusinessDay, startOfLocalDay } = await import('../../src/outreach/salesSequence/businessDays.js')
const { computeSequence } = await import('../../src/outreach/salesSequence/stageMachine.js')
const { evaluateGates } = await import('../../src/outreach/salesSequence/gates.js')
const { verifyReading } = await import('../../src/outreach/salesSequence/replies.js')
const { checkLine, appearsIn, categoryLeaf, withoutExpoParagraph, valuesFromInputs } = await import('../../src/outreach/salesSequence/compose.js')

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
