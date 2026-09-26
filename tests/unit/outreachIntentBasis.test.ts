import { describe, expect, it, vi, beforeEach } from 'vitest'

// OUTREACH'S DEFAULT GATE (2026-09-24 restructure): DECISION MAKERS + INTENT
// SIGNALS, NOT AN APPROVED AUDIT.
//
// Website Audit / Audit Report / Human Approval are locked and will not
// produce new approvals, so createCampaign's default path (no auditRunId
// given) is createCampaignFromIntent. It requires BOTH a completed Decision
// Maker run with a shortlisted candidate AND at least one active intent
// signal — neither substitutes for the other — and names precisely which is
// missing when it refuses. The LEGACY auditRunId path is untouched by any of
// this; see tests/unit/outreach.test.ts and tests/integration/outreach.test.ts
// for its own coverage.

const db = {
  decisionMakerRun: { findFirst: vi.fn() },
  decisionMakerCandidate: { findFirst: vi.fn() },
  intentSignal: { findMany: vi.fn() },
  discoveredCompany: { findFirst: vi.fn() },
  outreachCampaign: { create: vi.fn() },
  outreachSequenceStep: { create: vi.fn() },
  outreachTemplate: { findFirst: vi.fn() },
  outreachAction: { create: vi.fn() },
  outreachMessage: { create: vi.fn() },
}
vi.mock('../../src/platform/db.js', () => ({
  prisma: db,
  newId: () => 'id_' + Math.random().toString(36).slice(2, 10),
}))

const crm = { getCompany: vi.fn() }
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => crm }))

const audit = vi.fn()
vi.mock('../../src/platform/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

vi.mock('../../src/engagement/adapters/outreachAdapter.js', () => ({ syncOutreachActions: vi.fn() }))

const composeFromTemplate = vi.fn()
vi.mock('../../src/outreach/personalize.js', () => ({
  composeMessage: vi.fn(),
  composeFromTemplate: (...a: unknown[]) => composeFromTemplate(...a),
}))

const { createCampaign } = await import('../../src/outreach/engine.js')

const CRM_COMPANY_ID = 'co_1'

const INPUT = {
  tenantId: 't1',
  crmCompanyId: CRM_COMPANY_ID,
  requestedByCrmUserId: 'u1',
  dryRun: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  crm.getCompany.mockResolvedValue({ id: CRM_COMPANY_ID, name: 'Acme Safety Co', domain: 'acmesafety.test' })
  db.discoveredCompany.findFirst.mockResolvedValue(null) // a CRM company unless a test says otherwise
  db.outreachTemplate.findFirst.mockResolvedValue(null) // no templates configured, in these gate tests
  db.outreachCampaign.create.mockResolvedValue({})
  db.outreachSequenceStep.create.mockResolvedValue({ id: 'step1' })
  db.outreachAction.create.mockResolvedValue({})
  db.outreachMessage.create.mockResolvedValue({})
})

describe('the gate refuses with no completed decision-maker run', () => {
  it('names exactly what is missing: the decision-maker run', async () => {
    db.decisionMakerRun.findFirst.mockResolvedValue(null)
    db.intentSignal.findMany.mockResolvedValue([{ id: 's1', summary: 'x', sourceUrl: null }])

    await expect(createCampaign(INPUT)).rejects.toThrow(/no completed decision maker discovery run/i)
    // Refused before ever creating a campaign row.
    expect(db.outreachCampaign.create).not.toHaveBeenCalled()
  })
})

describe('the gate refuses with no active intent signal', () => {
  it('names exactly what is missing: the intent signal, when a decision-maker run exists', async () => {
    db.decisionMakerRun.findFirst.mockResolvedValue({ id: 'dm1' })
    db.decisionMakerCandidate.findFirst.mockResolvedValue({
      id: 'cand1', fullName: 'Jamie Fox', rawTitle: 'Purchasing Manager', email: null, profileUrl: null,
    })
    db.intentSignal.findMany.mockResolvedValue([])

    await expect(createCampaign(INPUT)).rejects.toThrow(/no active intent signal/i)
    expect(db.outreachCampaign.create).not.toHaveBeenCalled()
  })
})

describe('the gate is satisfied only when both conditions hold', () => {
  beforeEach(() => {
    db.decisionMakerRun.findFirst.mockResolvedValue({ id: 'dm1' })
    db.decisionMakerCandidate.findFirst.mockResolvedValue({
      id: 'cand1', fullName: 'Jamie Fox', rawTitle: 'Purchasing Manager', email: null, profileUrl: null,
    })
    db.intentSignal.findMany.mockResolvedValue([{ id: 's1', summary: 'Careers page mentions a buyer role', sourceUrl: null }])
  })

  it('creates the campaign with no audit basis and no discoveredCompanyId when the company is a real CRM company', async () => {
    await createCampaign(INPUT)

    expect(db.outreachCampaign.create).toHaveBeenCalledTimes(1)
    const data = db.outreachCampaign.create.mock.calls[0]![0].data
    expect(data.crmCompanyId).toBe(CRM_COMPANY_ID)
    expect(data.discoveredCompanyId).toBeNull()
    expect(data.auditRunId).toBeUndefined()
    expect(data.auditReportId).toBeUndefined()
  })

  it('marks every step blocked_no_template when no OutreachTemplate is configured, and creates no message rows', async () => {
    const result = await createCampaign(INPUT)

    expect(result.actions.length).toBeGreaterThan(0)
    for (const a of result.actions) {
      expect(a.status).toBe('blocked_no_template')
    }
    expect(db.outreachMessage.create).not.toHaveBeenCalled()
    expect(composeFromTemplate).not.toHaveBeenCalled()
  })

  it('composes from the active template when one exists for a channel', async () => {
    db.outreachTemplate.findFirst.mockResolvedValue({
      id: 'tmpl1', key: 'email.intro', version: 'v1', subjectRaw: 'Hi', bodyRaw: 'Hello there',
    })
    composeFromTemplate.mockResolvedValue({
      channel: 'email', templateKey: 'email.intro', templateVersion: 'v1',
      subject: 'Hi Jamie', body: 'Hello Jamie', blocks: {}, ctaUrl: null, workbenchUrl: null,
      evidence: [{ kind: 'outreach_template', referenceId: 'tmpl1', summary: 'x', sourceUrl: null }],
      length: 11,
    })

    await createCampaign(INPUT)

    expect(composeFromTemplate).toHaveBeenCalled()
    const call = composeFromTemplate.mock.calls[0]![0] as { intentSignals: unknown[]; template: { id: string } }
    expect(call.template.id).toBe('tmpl1')
    expect(call.intentSignals).toHaveLength(1)
  })

  it('requires crmCompanyId when no auditRunId is given', async () => {
    await expect(createCampaign({ tenantId: 't1', requestedByCrmUserId: 'u1' })).rejects.toThrow(/crmCompanyId is required/i)
  })

  it('reads company facts from DiscoveredCompany, not the CRM, when discoveredCompanyId is set', async () => {
    db.discoveredCompany.findFirst.mockResolvedValue({
      id: 'disc_1', companyName: 'Acme Safety Co', domain: 'acmesafety.test', websiteUrl: 'https://acmesafety.test/', websiteSummary: 'A safety company.',
    })

    await createCampaign({ ...INPUT, crmCompanyId: 'disc_1', discoveredCompanyId: 'disc_1' })

    expect(crm.getCompany).not.toHaveBeenCalled()
    const data = db.outreachCampaign.create.mock.calls[0]![0].data
    expect(data.discoveredCompanyId).toBe('disc_1')
    expect(data.companyName).toBe('Acme Safety Co')
  })

  // What actually broke: the Outreach screen sends only the company in context,
  // which for a company found by "Find New Company" IS its DiscoveredCompany
  // id. It used to be looked up in NXT Sales and refused as not found.
  it('recognises a discovered company from its id alone, without being told', async () => {
    db.discoveredCompany.findFirst.mockResolvedValue({
      id: 'disc_2', companyName: 'Magid Glove & Safety', domain: null, websiteUrl: 'https://www.magidglove.com/about', websiteSummary: 'Makes safety gloves.',
    })

    await createCampaign({ ...INPUT, crmCompanyId: 'disc_2' })

    expect(crm.getCompany).not.toHaveBeenCalled()
    const data = db.outreachCampaign.create.mock.calls[0]![0].data
    expect(data.crmCompanyId).toBe('disc_2')
    expect(data.discoveredCompanyId).toBe('disc_2')
    expect(data.companyDomain).toBe('magidglove.com')
  })
})
