import { beforeEach, describe, expect, it, vi } from 'vitest'

// THE AUDIT ASSISTANT IS GROUNDED, AND ITS OUTPUT IS CHECKED AFTER THE FACT.
//
// A prompt asking a model to stay inside the audit is a hope. These tests pin
// what actually holds regardless of what the model returns:
//
//   · it is handed THIS audit, and only this audit;
//   · a proposed report edit that trips the claim guard, states a figure the
//     audit does not contain, or fails the revision schema is BLOCKED;
//   · a draft with an unsupported figure is still returned, but flagged;
//   · unchanged wording is never proposed as an edit;
//   · it has no write path — applying an edit is a separate human action.

const generate = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate }) }))

const db = {
  auditReport: { findFirst: vi.fn() },
  auditReportRevision: { findFirst: vi.fn() },
  websiteAuditRun: { findFirstOrThrow: vi.fn() },
  catalogFinding: { findMany: vi.fn() },
}
vi.mock('../../src/platform/db.js', () => ({ prisma: db }))

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

vi.mock('../../src/websiteaudit/customerView.js', () => ({
  buildCustomerView: async () => ({
    companyName: 'Northwind Fasteners',
    website: 'https://northwind.test/',
    auditDate: '2026-09-01',
    pagesInspected: 15,
    productPagesInspected: 12,
    scopeNote: 'Every figure describes the inspected pages only.',
    productEvidence: { state: 'product_page', headline: '12 product pages were read in full' },
    caseStudies: [],
    recommendedSchema: { determined: false, categoryLabel: 'General product record', attributes: [] },
    proposedContent: null,
    illustrativeExamples: mockExamples,
  }),
}))

const mockExamples: Record<string, { value: string; kind: string }> = {}

const { askReportAssistant, ungroundedFigures } = await import('../../src/websiteaudit/reportAssistant.js')

const CURRENT = {
  headline: 'Product Data Health Check',
  summary: 'This review covers 15 page(s), of which 12 were product pages.',
  nextStep: 'Review these findings against the pages cited.',
}

/** The model returns this; every field is then checked by the service. */
const modelSays = (over: Record<string, unknown>) => {
  generate.mockResolvedValue({
    data: { reply: 'Grounded reply.', drafts: [], proposedEdit: null, citations: ['A4'], ...over },
    model: 'test-model',
  })
}

const ask = (message = 'question') =>
  askReportAssistant({ tenantId: 't1', auditRunId: 'run_1', message, history: [] })

beforeEach(() => {
  vi.clearAllMocks()
  db.auditReport.findFirst.mockResolvedValue({ id: 'rep_1', status: 'ready_for_approval', currentRevision: 1, collateral: CURRENT })
  db.auditReportRevision.findFirst.mockResolvedValue({ content: CURRENT })
  db.websiteAuditRun.findFirstOrThrow.mockResolvedValue({ id: 'run_1', productPages: 12 })
  db.catalogFinding.findMany.mockResolvedValue([
    {
      code: 'missing_dimensions',
      title: 'Dimensions not published',
      priority: 'high',
      affectedCount: 9,
      sampleSize: 12,
      sampleUnit: 'product pages',
      finding: 'Not found on 9 of the 12 inspected product pages',
      recommendation: 'Publish dimensions as named fields.',
    },
  ])
  modelSays({})
})

describe('it is handed this audit and nothing else', () => {
  it('passes the audit document, the conversation and the request to the model', async () => {
    await ask('What did you find?')
    const vars = generate.mock.calls[0]![0].variables as Record<string, string>
    expect(generate.mock.calls[0]![0].promptKey).toBe('report.assistant')
    expect(vars.auditDocument).toContain('Northwind Fasteners')
    expect(vars.auditDocument).toContain('missing_dimensions')
    expect(vars.auditDocument).toContain('9 of 12 product pages')
    expect(vars.message).toBe('What did you find?')
  })

  it('refuses when the run has no report to discuss', async () => {
    db.auditReport.findFirst.mockResolvedValue(null)
    await expect(ask()).rejects.toThrow(/no audit report/i)
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('a proposed report edit is checked before it is offered', () => {
  it('offers a clean edit, carrying only the fields that change and their current wording', async () => {
    modelSays({
      proposedEdit: {
        changeReason: 'Lead with the most important finding.',
        headline: CURRENT.headline, // unchanged — must not be proposed
        summary: 'Dimensions were not found on 9 of the 12 inspected product pages.',
        nextStep: null,
      },
    })
    const answer = await ask()
    expect(answer.proposedEdit).not.toBeNull()
    expect(answer.proposedEdit!.blocked).toBe(false)
    expect(Object.keys(answer.proposedEdit!.edit)).toEqual(['summary'])
    expect(answer.proposedEdit!.current.summary).toBe(CURRENT.summary)
  })

  it('blocks an edit that promises money or ROI', async () => {
    modelSays({
      proposedEdit: {
        changeReason: 'Make it more persuasive.',
        headline: null,
        summary: 'Fixing this will increase revenue by 20% and deliver strong ROI.',
        nextStep: null,
      },
    })
    const answer = await ask()
    expect(answer.proposedEdit!.blocked).toBe(true)
    expect(answer.proposedEdit!.blockedReasons.join(' ')).toMatch(/percentage|financial|ROI|revenue/i)
  })

  it('blocks an edit stating a figure the audit does not contain', async () => {
    modelSays({
      proposedEdit: {
        changeReason: 'Sharpen the number.',
        headline: null,
        summary: 'Dimensions were missing on 11 of the 40 product pages reviewed.',
        nextStep: null,
      },
    })
    const answer = await ask()
    expect(answer.proposedEdit!.blocked).toBe(true)
    expect(answer.proposedEdit!.blockedReasons.join(' ')).toMatch(/"11"|"40"/)
  })

  it('blocks an edit the revision schema would refuse', async () => {
    modelSays({
      proposedEdit: { changeReason: 'Shorter headline please.', headline: 'Hi', summary: null, nextStep: null },
    })
    const answer = await ask()
    expect(answer.proposedEdit!.blocked).toBe(true)
  })

  it('proposes nothing when every field is unchanged', async () => {
    modelSays({
      proposedEdit: { changeReason: 'No change needed here.', headline: CURRENT.headline, summary: null, nextStep: null },
    })
    const answer = await ask()
    expect(answer.proposedEdit).toBeNull()
  })
})

describe('drafts are returned, and flagged when they go beyond the audit', () => {
  it('flags a figure in a draft the audit does not contain, without hiding the draft', async () => {
    modelSays({
      drafts: [{ kind: 'product_description', title: 'Description', content: 'Rated to 90 degrees and 12 product pages.' }],
    })
    const answer = await ask()
    expect(answer.drafts).toHaveLength(1)
    expect(answer.drafts[0]!.ungroundedFigures).toEqual(['90'])
  })

  it('flags an unsupported claim in a draft', async () => {
    modelSays({
      drafts: [{ kind: 'customer_email', title: 'Email', content: 'We guarantee you will rank first on Google.' }],
    })
    const answer = await ask()
    expect(answer.drafts[0]!.claimViolations.length).toBeGreaterThan(0)
  })

  it('flags an example value used without an example label, and passes it when labelled', async () => {
    mockExamples['product.weight'] = { value: '2.4 kg', kind: 'sample' }
    try {
      modelSays({
        drafts: [
          { kind: 'spec_table', title: 'Unlabelled', content: 'Weight: 2.4 kg\nPages read: 12' },
          { kind: 'spec_table', title: 'Labelled', content: 'Weight: 2.4 kg (example)\nPages read: 12' },
        ],
      })
      const answer = await ask()
      const [unlabelled, labelled] = answer.drafts
      expect(unlabelled!.claimViolations.map((v) => [v.pattern, v.match])).toEqual([['unlabelled-example', '2.4']])
      expect(labelled!.claimViolations).toEqual([])
      expect(labelled!.ungroundedFigures).toEqual([])
    } finally {
      delete mockExamples['product.weight']
    }
  })

  it('blocks a report edit that states an example value as though it were a finding', async () => {
    mockExamples['product.weight'] = { value: '2.4 kg', kind: 'sample' }
    try {
      modelSays({
        proposedEdit: {
          changeReason: 'Add the weight.',
          headline: null,
          summary: 'The audited product weighs 2.4 kg, which is not published on 9 of 12 pages.',
          nextStep: null,
        },
      })
      const answer = await ask()
      expect(answer.proposedEdit!.blocked).toBe(true)
      expect(answer.proposedEdit!.blockedReasons.join(' ')).toMatch(/"2.4"/)
    } finally {
      delete mockExamples['product.weight']
    }
  })

  it('surfaces a claim-guard hit in the reply itself', async () => {
    modelSays({ reply: 'This is costing you sales every day.' })
    const answer = await ask()
    expect(answer.warnings.length).toBeGreaterThan(0)
  })
})

describe('the figure check', () => {
  it('passes figures copied from the audit and flags the rest', () => {
    const doc = JSON.stringify({ scope: '9 of 12 product pages', pages: 15 })
    expect(ungroundedFigures('Missing on 9 of 12 pages across 15 read.', doc)).toEqual([])
    expect(ungroundedFigures('Missing on 30 pages.', doc)).toEqual(['30'])
  })
})

describe('it has no write path', () => {
  it('never touches a revision, an approval or a report status', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/websiteaudit/reportAssistant.ts', 'utf8')
    expect(src).not.toMatch(/\.(create|update|upsert|delete)(Many)?\(/)
    expect(src).not.toMatch(/reviseReport|transition\(/)
  })
})
