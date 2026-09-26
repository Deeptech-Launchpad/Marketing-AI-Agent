import { describe, expect, it, vi, beforeEach } from 'vitest'

// TEMPLATE-BASIS PERSONALIZATION (2026-09-24 restructure).
//
// The default content path once Website Audit is locked: a Sales-approved
// OutreachTemplate, personalized by Gemini for one company and person,
// grounded in Intent Signals rather than audit findings.
//
// Two safety nets are under test:
//   1. GROUNDING — a fact the model claims to have used must be a literal
//      quote from what it was actually given. One that is not discards the
//      WHOLE personalization, not just the offending sentence: what is sent
//      instead is the template exactly as Sales wrote it.
//   2. THE CLAIM GUARD — runs on whichever body is actually sent, model-
//      personalized or the plain template, so a percentage or a revenue
//      promise cannot reach a prospect either way.

const generate = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate, name: 'fake' }) }))

const { composeFromTemplate, isGroundedInFacts } = await import('../../src/outreach/personalize.js')

const TEMPLATE = {
  id: 'tmpl_1',
  key: 'email.intro',
  version: 'v1',
  subjectRaw: 'Quick question about your product data',
  bodyRaw: 'Hi there,\n\nI wanted to reach out about your product catalogue.\n\nBest,\nSales',
}

const baseInput = (over: Record<string, unknown> = {}) => ({
  channel: 'email' as const,
  target: {
    contactName: 'Jamie Fox',
    contactTitle: 'Purchasing Manager',
    decisionMakerId: 'dm1',
    destination: 'jamie@example.test',
    destinationKind: 'email' as const,
    companyName: 'Acme Safety Co',
    crmCompanyId: 'co_1',
  },
  companyName: 'Acme Safety Co',
  companySummary: 'Acme Safety Co provides site safety training and PPE across the USA.',
  intentSignals: [{ id: 'sig1', summary: 'Careers page mentions a new safety trainer role', sourceUrl: 'https://acmesafety.test/careers' }],
  template: TEMPLATE,
  senderName: 'Alex Rivera',
  senderCompany: 'AltiusNXT',
  tenantId: 't1',
  ...over,
})

beforeEach(() => {
  generate.mockReset()
})

describe('isGroundedInFacts', () => {
  const facts = ['Acme Safety Co', 'Acme Safety Co provides site safety training and PPE across the USA.', 'Jamie Fox', 'Purchasing Manager']

  it('accepts a verbatim quote from the facts given', () => {
    expect(isGroundedInFacts(['Acme Safety Co provides site safety training'], facts)).toBe(true)
  })

  it('rejects a fact that was never given', () => {
    expect(isGroundedInFacts(['Acme Safety Co just closed a $10M funding round'], facts)).toBe(false)
  })

  it('rejects a fact shorter than 3 characters, which proves nothing', () => {
    expect(isGroundedInFacts(['Co'], facts)).toBe(false)
  })

  it('accepts an empty claim list', () => {
    expect(isGroundedInFacts([], facts)).toBe(true)
  })
})

describe('composeFromTemplate — a grounded personalization', () => {
  it('sends the personalized body and cites every fact it used as evidence', async () => {
    generate.mockResolvedValue({
      data: {
        subject: 'Quick question about your product catalogue, Jamie',
        body: 'Hi Jamie,\n\nI saw Acme Safety Co provides site safety training and PPE across the USA — impressive scope.\n\nBest,\nAlex',
        factsUsed: ['Acme Safety Co provides site safety training and PPE across the USA'],
      },
      costUsd: 0.001,
    })

    const msg = await composeFromTemplate(baseInput())

    expect(msg.body).toContain('Jamie')
    expect(msg.templateKey).toBe('email.intro')
    expect(msg.templateVersion).toBe('v1')
    expect(msg.evidence.some((e) => e.kind === 'outreach_template' && e.referenceId === 'tmpl_1')).toBe(true)
    expect(msg.evidence.some((e) => e.kind === 'personalization_fact')).toBe(true)
  })
})

describe('composeFromTemplate — an ungrounded claim falls back to the plain template', () => {
  it('discards the whole personalization, not just the offending line', async () => {
    generate.mockResolvedValue({
      data: {
        subject: 'Congrats on your Series B!',
        body: 'Hi Jamie,\n\nCongrats on the recent $10M funding round — huge milestone.\n\nBest,\nAlex',
        factsUsed: ['recent $10M funding round'],
      },
      costUsd: 0.001,
    })

    const msg = await composeFromTemplate(baseInput())

    // The plain template, exactly as Sales wrote it — not the invented body.
    expect(msg.body).toBe(TEMPLATE.bodyRaw)
    expect(msg.subject).toBe(TEMPLATE.subjectRaw)
    expect(msg.body).not.toContain('funding round')
    expect(msg.evidence).toEqual([
      { kind: 'outreach_template', referenceId: 'tmpl_1', summary: expect.stringContaining('not personalized'), sourceUrl: null },
    ])
  })
})

describe('composeFromTemplate — the model call itself fails', () => {
  it('falls back to the plain template rather than throwing', async () => {
    generate.mockRejectedValue(new Error('The model timed out.'))

    const msg = await composeFromTemplate(baseInput())
    expect(msg.body).toBe(TEMPLATE.bodyRaw)
  })
})

describe('composeFromTemplate — channel length limits', () => {
  it('retries once, then falls back to the plain template if still too long', async () => {
    const tooLong = { subject: 'x', body: 'y'.repeat(400), factsUsed: [] }
    generate.mockResolvedValueOnce({ data: tooLong, costUsd: 0 }).mockResolvedValueOnce({ data: tooLong, costUsd: 0 })

    const msg = await composeFromTemplate(baseInput({ channel: 'linkedin' as const }))

    expect(generate).toHaveBeenCalledTimes(2)
    expect(msg.body).toBe(TEMPLATE.bodyRaw)
  })

  it('accepts a personalization that fits within the retry', async () => {
    const tooLong = { subject: null, body: 'y'.repeat(400), factsUsed: [] }
    const fits = { subject: null, body: 'Hi Jamie — quick note about your catalogue.', factsUsed: [] }
    generate.mockResolvedValueOnce({ data: tooLong, costUsd: 0 }).mockResolvedValueOnce({ data: fits, costUsd: 0 })

    const msg = await composeFromTemplate(baseInput({ channel: 'linkedin' as const }))

    expect(generate).toHaveBeenCalledTimes(2)
    expect(msg.body).toBe(fits.body)
  })
})

describe('composeFromTemplate — the claim guard applies to both paths', () => {
  it('throws on a personalized body carrying an unsupported claim, even though it was grounded', async () => {
    generate.mockResolvedValue({
      data: {
        subject: 's',
        // "grounded" per factsUsed, but still violates the percentage rule.
        body: '99% of clients like Acme Safety Co see results.',
        factsUsed: ['Acme Safety Co'],
      },
      costUsd: 0,
    })

    await expect(composeFromTemplate(baseInput())).rejects.toThrow()
  })

  it('throws on the plain template too, if the raw Sales copy itself violates it', async () => {
    generate.mockRejectedValue(new Error('down'))
    const badTemplate = { ...TEMPLATE, bodyRaw: 'We guarantee a 50% increase in sales.' }

    await expect(composeFromTemplate(baseInput({ template: badTemplate }))).rejects.toThrow()
  })
})

describe('composeFromTemplate — never invents a company/person beyond what was given', () => {
  it('passes no forbidden internal field name and no invented statistic through untouched', async () => {
    generate.mockResolvedValue({
      data: {
        subject: 'Hello',
        body: 'Hi Jamie, following up about Acme Safety Co and your work in site safety training.',
        factsUsed: ['Jamie Fox', 'Acme Safety Co provides site safety training and PPE across the USA.'],
      },
      costUsd: 0,
    })

    const msg = await composeFromTemplate(baseInput())
    expect(msg.body).not.toMatch(/\b(tenantId|crmCompanyId|auditRunId)\b/i)
  })
})
