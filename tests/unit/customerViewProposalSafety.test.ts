import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// THE SUGGESTION BOX MUST NOT BE ABLE TO DESTROY THE EVIDENCE.
//
// `proposedContent` is ONE OPTIONAL BLOCK of the customer view. Everything
// else in that view is the customer's own observed evidence: their products,
// their fields, their gaps, the categories their own site named.
//
// A false positive inside the proposal's fact-guard threw, and because the
// call was unguarded the exception propagated out of buildCustomerView — so
// the Workbench screen errored and the Audit Report could not be generated,
// for a company whose audit was perfectly good. The proposal is the least
// important thing in the view and it was able to withhold all the rest.
//
// `proposedContent: null` was already a supported, rendered state, reached
// whenever a page publishes too little to compose from. A failure now lands in
// that same state — and is LOGGED, because a proposal that cannot be built is
// a real defect worth fixing. It is simply not a reason to hide the
// customer's own data.

const sampleWebsiteShell = vi.fn()
const sampleTheme = vi.fn()
vi.mock('../../src/workbench/websiteShell.js', () => ({ sampleWebsiteShell }))
vi.mock('../../src/workbench/themeExtractor.js', () => ({ sampleTheme }))

const db = {
  websiteAuditRun: { findFirst: vi.fn(), update: vi.fn() },
  auditReport: { findFirst: vi.fn() },
  auditReportRevision: { findFirst: vi.fn() },
  catalogFinding: { findMany: vi.fn() },
  pageObservation: { findMany: vi.fn() },
}
vi.mock('../../src/platform/db.js', () => ({ prisma: db, newId: () => 'id_1' }))

const errorLog = vi.fn()
vi.mock('../../src/platform/logger.js', () => ({
  logger: { error: errorLog, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => ({ error: errorLog, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}))

const HERO = {
  crmCompanyId: 'co_1',
  auditRunId: 'run_1',
  pageId: 'p1',
  sourceUrl: 'https://acme.test/p/1',
  pageContext: { pageTitle: 'A Product', siteName: 'Acme', breadcrumbs: null, host: 'acme.test' },
  title: 'A Product',
  imageUrl: null,
  fields: [],
}
vi.mock('../../src/websiteaudit/enrichedRecord.js', () => ({
  selectCaseStudyPages: async () => ['p1'],
  buildEnrichedRecord: async () => HERO,
}))
vi.mock('../../src/websiteaudit/sectorAnalysis.js', () => ({
  analyseSectors: async () => ({ sectors: [], productPagesInspected: 1, catalogueGaps: [], note: 'n/a' }),
}))
vi.mock('../../src/websiteaudit/recommendedSchema.js', () => ({
  buildRecommendedSchema: () => ({ determined: true, categoryLabel: 'Cleaning & hygiene products', attributes: [] }),
}))
vi.mock('../../src/websiteaudit/productEvidence.js', () => ({
  loadProductEvidence: async () => ({
    state: 'product_page',
    stateCode: 'D',
    tier: 1,
    tierLabel: 'Their own product page',
    headline: '1 product page was read in full',
    detail: 'detail',
    entries: [],
    counts: { linked: 0, named: 0, image_alt: 0 },
  }),
}))

/** Controls whether the proposal builder succeeds this test. */
let proposalBehaviour: () => unknown = () => ({ overview: 'ok', bullets: [], openQuestions: [], supportedBy: [], note: '' })
vi.mock('../../src/workbench/proposedContent.js', () => ({
  buildProposedContent: () => proposalBehaviour(),
}))

const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')

/** One audit run, as the row reads before any page context is captured. */
const RUN_ROW = {
  id: 'run_1',
  tenantId: 't1',
  crmCompanyId: 'co_1',
  companyName: 'A Company',
  startUrl: 'https://acme.test/',
  pagesFetched: 15,
  productPages: 14,
  categoryPages: 1,
  completedAt: new Date('2026-09-01T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  websiteShell: null,
  pageTheme: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  sampleWebsiteShell.mockResolvedValue({
    captured: true,
    reason: null,
    siteName: 'Acme Supplies',
    host: 'acme.test',
    logoUrl: 'https://acme.test/logo.png',
    nav: [{ label: 'Shop', href: 'https://acme.test/shop' }],
    footerLinks: [],
    footerText: '© 2026 Acme Supplies',
    social: [],
    utility: [],
    hasSearch: true,
    notCaptured: [],
    sourceUrl: 'https://acme.test/p/1',
    logoAlt: 'Acme Supplies',
  })
  sampleTheme.mockResolvedValue({ source: 'live_sample', reason: null, primary: '#0055aa' })
  proposalBehaviour = () => ({ overview: 'ok', bullets: [], openQuestions: [], supportedBy: [], note: '' })
  db.websiteAuditRun.findFirst.mockResolvedValue({ ...RUN_ROW })
  db.auditReport.findFirst.mockResolvedValue({
    id: 'rep_1',
    status: 'ready_for_approval',
    currentRevision: 1,
    collateral: { headline: 'Product Data Health Check', summary: 'A summary.' },
  })
  db.auditReportRevision.findFirst.mockResolvedValue(null)
  db.catalogFinding.findMany.mockResolvedValue([])
  db.pageObservation.findMany.mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())

describe('a proposal that cannot be built', () => {
  it('does not take the customer view down with it', async () => {
    proposalBehaviour = () => {
      throw new Error('Proposed content stated "71803 in", which does not appear in anything this page published.')
    }

    const view = await buildCustomerView('t1', 'run_1')

    expect(view.proposedContent).toBeNull()
    // Everything the customer actually cares about survives.
    expect(view.companyName).toBe('A Company')
    expect(view.caseStudies).toHaveLength(1)
    expect(view.caseStudies[0]!.title).toBe('A Product')
    expect(view.productEvidence.stateCode).toBe('D')
    expect(view.pagesInspected).toBe(15)
    expect(view.productPagesInspected).toBe(14)
  })

  it('logs the reason rather than swallowing it', async () => {
    proposalBehaviour = () => {
      throw new Error('some genuine defect')
    }

    await buildCustomerView('t1', 'run_1')

    expect(errorLog).toHaveBeenCalledTimes(1)
    const [fields, message] = errorLog.mock.calls[0] as [Record<string, unknown>, string]
    expect(fields.auditRunId).toBe('run_1')
    expect(fields.sourceUrl).toBe('https://acme.test/p/1')
    expect(fields.err).toContain('some genuine defect')
    expect(message).toMatch(/proposed content could not be built/i)
  })

  it('still returns the proposal when it builds cleanly', async () => {
    const view = await buildCustomerView('t1', 'run_1')
    expect(view.proposedContent).not.toBeNull()
    expect(errorLog).not.toHaveBeenCalled()
  })
})

describe('the existing null behaviour is unchanged', () => {
  it('is null, and silent, when there is no product to compose from', async () => {
    const mod = await import('../../src/websiteaudit/enrichedRecord.js')
    vi.spyOn(mod, 'selectCaseStudyPages').mockResolvedValue([])

    const view = await buildCustomerView('t1', 'run_1')

    expect(view.caseStudies).toEqual([])
    expect(view.proposedContent).toBeNull()
    // No product, no attempt, nothing to report.
    expect(errorLog).not.toHaveBeenCalled()
  })
})

// ── THE CUSTOMER'S OWN PAGE, NOT A CARD WITH THEIR DATA IN IT ─────────────
//
// The Workbench's whole claim is "this is YOUR page, and this is the same page
// done properly". It could only make the first half once a report was approved
// AND somebody had pressed Build, because that is where the shell and theme
// were captured. Every other company — most of them — opened on a neutral card
// for a website this platform had already read in full.
//
// The shell describes the CUSTOMER'S SITE, not our demonstration of it, so it
// now belongs to the run that read that site. These pin the three things that
// makes true: it is captured, it is captured ONCE, and a company with no
// product page is never given one it does not have.

describe('the page context travels with the audit run', () => {
  it('captures the hero page’s furniture and remembers it', async () => {
    const view = await buildCustomerView('t1', 'run_1')

    expect(sampleWebsiteShell).toHaveBeenCalledWith('https://acme.test/p/1')
    expect(sampleTheme).toHaveBeenCalledWith('https://acme.test/p/1')
    expect(view.websiteShell?.siteName).toBe('Acme Supplies')
    expect(view.pageTheme?.source).toBe('live_sample')

    // Written back, so the next view costs nothing.
    expect(db.websiteAuditRun.update).toHaveBeenCalledTimes(1)
    const wrote = db.websiteAuditRun.update.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(wrote.data.websiteShell).toBeTruthy()
    expect(wrote.data.pageTheme).toBeTruthy()
  })

  it('serves a cached context without fetching the site again', async () => {
    db.websiteAuditRun.findFirst.mockResolvedValue({
      ...RUN_ROW,
      websiteShell: { captured: true, siteName: 'Already Known', reason: null },
      pageTheme: { source: 'live_sample', primary: '#123456' },
    })

    const view = await buildCustomerView('t1', 'run_1')

    expect(view.websiteShell?.siteName).toBe('Already Known')
    expect(sampleWebsiteShell).not.toHaveBeenCalled()
    expect(sampleTheme).not.toHaveBeenCalled()
    expect(db.websiteAuditRun.update).not.toHaveBeenCalled()
  })

  it('samples nothing when the run found no product page', async () => {
    const mod = await import('../../src/websiteaudit/enrichedRecord.js')
    vi.spyOn(mod, 'selectCaseStudyPages').mockResolvedValue([])

    const view = await buildCustomerView('t1', 'run_1')

    // No page to sample, so nothing is sampled and nothing is invented.
    expect(view.websiteShell).toBeNull()
    expect(view.pageTheme).toBeNull()
    expect(sampleWebsiteShell).not.toHaveBeenCalled()
    // Nothing is written either, so a later run that DOES find a page still captures.
    expect(db.websiteAuditRun.update).not.toHaveBeenCalled()
  })

  it('does not let a sampling failure cost the customer their evidence', async () => {
    sampleWebsiteShell.mockRejectedValue(new Error('that address is not publicly reachable'))

    const view = await buildCustomerView('t1', 'run_1')

    // Presentation degrades; the evidence does not.
    expect(view.websiteShell).toBeNull()
    expect(view.caseStudies).toHaveLength(1)
    expect(view.productEvidence.stateCode).toBe('D')
  })
})
