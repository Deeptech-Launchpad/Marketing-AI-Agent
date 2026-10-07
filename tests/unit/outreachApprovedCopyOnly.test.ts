import { beforeEach, describe, expect, it, vi } from 'vitest'

// AN OUTREACH EMAIL IS THE APPROVED COPY AND NOTHING ELSE (2026-09-30).
//
// Sales asked for two things to go: the one AI-written line that used to be
// inserted between two approved paragraphs, and the product page URL at the
// end of Versions 1–3. What is left is Sales's own wording with its
// placeholders filled.
//
// The model still runs, for one job only: choosing WHICH short word fills
// [Product]. Real analysed product names are things like "DEWALT DPG22 Type II
// Class E Safety Helmet" and, on one company, a URL fragment — dropped raw
// into "who carries [Product] near me" they read like nonsense. So the model
// proposes a short term, and it is kept only if the company's own verified
// product data contains it word for word.
//
// The mock below is deliberately hostile: it returns an invented term AND a
// written sentence every time. Nothing it returns may reach the body.

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/db.js', () => ({ prisma: {} }))
vi.mock('../../src/config/env.js', () => ({ env: { OUTREACH_SEQUENCE_TIMEZONE: 'America/New_York' } }))
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

const generate = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate }) }))

const { composeStage } = await import('../../src/outreach/salesSequence/compose.js')
const { templateFor, STAGE_TEMPLATES } = await import('../../src/outreach/salesSequence/templates.js')

const AI_SENTENCE = 'With Central Cleaning distributing cleaning materials, ensuring your catalogue is discoverable is critical.'

const facts = (over: Record<string, unknown> = {}) => ({
  crmCompanyId: 'c1',
  discoveredCompanyId: 'd1',
  companyName: 'Central Cleaning Pty Ltd',
  companyDomain: 'centralcleaning.com.au',
  companySummary: null,
  decisionMaker: { id: 'dm1', fullName: 'Joe Camilleri', title: 'Director', email: 'joe@centralcleaning.com.au', profileUrl: null },
  product: {
    name: 'DEWALT DPG22 Type II Class E Safety Helmet',
    url: 'https://www.centralcleaning.com.au/products/dpg22',
    category: 'Home > Head Protection > Safety Helmets',
    description: null,
    gaps: [],
  },
  productPageUrl: 'https://www.centralcleaning.com.au/products/dpg22',
  signals: [{ id: 's1', category: 'hiring', summary: 'Hiring an ecommerce manager', observedAt: null, sourceUrl: null }],
  facts: [{ id: 'company.name', label: 'Company', value: 'Central Cleaning Pty Ltd', source: 'Prospects', sourceUrl: null }],
  ...over,
})

const compose = (v: 'v1' | 'v2' | 'v3' = 'v1', over: Record<string, unknown> = {}) =>
  composeStage({
    template: templateFor('initial', v),
    facts: facts(over) as never,
    sender: { firstName: 'Mani', fullName: 'Mani', email: 'mani@altius.test', companyName: 'AltiusNxt', signature: '' },
    inputs: {},
    initialSubject: null,
    tenantId: 't1',
  })

beforeEach(() => {
  generate.mockReset()
  generate.mockResolvedValue({
    model: 'test-model',
    data: {
      // Not in any verified source — must be thrown away.
      productTerm: 'premium janitorial supplies',
      productCategoryTerm: 'facility management',
      // Must never appear in the body, whatever it says.
      line: { text: AI_SENTENCE, factIds: ['company.name'] },
    },
  })
})

describe('nothing the model writes reaches the email', () => {
  it('never inserts the AI sentence, however confidently it is returned', async () => {
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const r = await compose(v)
      expect(r.body, v).not.toContain(AI_SENTENCE)
      expect(r.body, v).not.toContain('With Central Cleaning distributing')
    }
  })

  it('reports no AI line at all, so the reviewer is not told to look for one', async () => {
    const r = await compose()
    expect(r.aiLine.status).toBe('not_offered')
    expect(r.aiLine.text).toBeNull()
    expect(r.aiLine.reason).toMatch(/switched off/i)
  })

  it('claims no signal was used, because none can be', async () => {
    const r = await compose()
    expect(r.signalsUsed).toEqual([])
    // Still listed as considered: a reviewer may want to know what was there.
    expect(r.signalsConsidered).toEqual(['s1'])
  })

  it('throws away a product term the company’s own data does not contain', async () => {
    const r = await compose()
    expect(r.body).not.toContain('premium janitorial supplies')
    expect(r.body).not.toContain('facility management')
  })

  // 2026-10-07: no model is called at all. [Product] is the product's own name.
  it('calls no model, and nothing a model could write reaches the email', async () => {
    generate.mockResolvedValue({
      model: 'test-model',
      data: { productTerm: 'Safety Helmets', productCategoryTerm: null, line: { text: AI_SENTENCE, factIds: [] } },
    })
    const r = await compose()
    expect(generate).not.toHaveBeenCalled()
    expect(r.body).not.toContain(AI_SENTENCE)
    expect(r.model).toBeNull()
  })

  it('leaves [Product] visibly unfilled rather than guessing, when no product was analysed', async () => {
    const r = await compose('v1', { product: null, productPageUrl: null })
    expect(r.unresolved).toContain('product')
    expect(r.body).toContain('[Product]')
  })
})

describe('the company and the product fill themselves', () => {
  it('puts the company name everywhere the approved copy names the company', async () => {
    const r = await compose()
    expect(r.subject).toContain('Central Cleaning')
    expect(r.body).toContain('Central Cleaning')
    expect(r.body).not.toContain('[Company]')
    expect(r.resolution.find((x) => x.placeholder === 'company')).toMatchObject({ factId: 'company.name' })
  })

  it('puts the product name exactly as the product page states it', async () => {
    const r = await compose()
    expect(r.subject).toContain('DEWALT DPG22 Type II Class E Safety Helmet')
    expect(r.body).toContain('DEWALT DPG22 Type II Class E Safety Helmet')
    expect(r.body).not.toContain('[Product]')
    expect(r.resolution.find((x) => x.placeholder === 'product')).toMatchObject({ factId: 'product.name' })
  })

  it('uses what Sales typed for the product instead, when they typed one', async () => {
    const r = await composeStage({
      template: templateFor('initial', 'v1'),
      facts: facts() as never,
      sender: { firstName: 'Mani', fullName: 'Mani', email: 'mani@altius.test', companyName: 'AltiusNxt', signature: '' },
      inputs: { product: 'safety helmets' },
      initialSubject: null,
      tenantId: 't1',
    })
    expect(r.body).toContain('safety helmets')
    expect(r.body).not.toContain('DEWALT DPG22')
  })

  it('records where each filled value came from, so a reviewer can check it', async () => {
    const r = await compose()
    const sources = Object.fromEntries(r.resolution.map((x) => [x.placeholder, x.source]))
    expect(sources.company).toBe('Company record')
    expect(String(sources.product)).toMatch(/product page|Entered by Sales|category/i)
  })
})

describe('the approved sentences survive untouched', () => {
  it('keeps every approved sentence of each version, with only placeholders changed', async () => {
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const r = await compose(v)
      const approved = templateFor('initial', v).body
      // Every approved line that carries no placeholder must appear verbatim.
      const plain = approved
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 25 && !l.includes('[') && !l.includes('product page I checked'))
      for (const line of plain) expect(r.body, `${v}: ${line.slice(0, 40)}`).toContain(line)
    }
  })

  it('carries no URL, and no leftover placeholder token, in any stage', async () => {
    for (const t of STAGE_TEMPLATES) {
      const r = await composeStage({
        template: t,
        facts: facts() as never,
        sender: { firstName: 'Mani', fullName: 'Mani', email: 'm@a.test', companyName: 'AltiusNxt', signature: '' },
        inputs: {},
        initialSubject: 'A subject',
        tenantId: 't1',
      })
      expect(r.body, t.pdfRef).not.toContain('[Product page URL]')
      expect(r.body, t.pdfRef).not.toContain('product page I checked')
      // The expo stages legitimately carry a registration URL of our own; the
      // ban is on this company's product page appearing in the email.
      expect(r.body, t.pdfRef).not.toContain('centralcleaning.com.au/products')
    }
  })

  // 2026-10-07: the sender section is the sender's name (the approved sign-off)
  // and their email on the line below — nothing else, and no shared signature.
  it('ends with the sender’s name and email, and nothing else', async () => {
    const r = await composeStage({
      template: templateFor('initial', 'v1'),
      facts: facts() as never,
      sender: { firstName: 'Mani', fullName: 'Mani Kandan', email: 'mani@altius.test', companyName: 'AltiusNxt', signature: 'AltiusNxt | altiusnxt.com' },
      inputs: {},
      initialSubject: null,
      tenantId: 't1',
    })
    expect(r.body.trimEnd().endsWith('\nMani\nmani@altius.test')).toBe(true)
    expect(r.body).not.toContain('altiusnxt.com')
  })
})
