import { beforeEach, describe, expect, it, vi } from 'vitest'

// NEW LEADS INTO NXT SALES (2026-09-29).
//
// The live CRM decides what is a duplicate — checked again at the moment of
// adding, and its own 409 honoured — so a company is never created twice. A
// new company carries Lead Source "Marketing AI Agent" and is owned by the
// person who added it. Decision makers are merged into the company's contact
// lists, never replacing anything and never taking an email another company
// holds. Every write needs the write switches; nothing is written blind.

type Row = Record<string, any>
const db: Record<string, Row[]> = { discoveredCompany: [], decisionMakerRun: [], decisionMakerCandidate: [] }
const match = (r: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(r, w))
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(r[k])
      if ('lt' in v) return r[k] instanceof Date && r[k] < v.lt
      return true
    }
    return (r[k] ?? null) === v
  })
const model = (t: string) => ({
  findFirst: vi.fn(async ({ where }: Row) => db[t]!.find((r) => match(r, where)) ?? null),
  findMany: vi.fn(async ({ where }: Row) => db[t]!.filter((r) => match(r, where))),
  update: vi.fn(async ({ where, data }: Row) => Object.assign(db[t]!.find((r) => r.id === where.id)!, data)),
  updateMany: vi.fn(async ({ where, data }: Row) => {
    const rows = db[t]!.filter((r) => match(r, where))
    rows.forEach((r) => Object.assign(r, data))
    return { count: rows.length }
  }),
})
const prisma = { discoveredCompany: model('discoveredCompany'), decisionMakerRun: model('decisionMakerRun'), decisionMakerCandidate: model('decisionMakerCandidate') }
vi.mock('../../src/platform/db.js', () => ({ prisma }))

const env = {
  CRM_DRIVER: 'real',
  CRM_WRITE_ENABLED: true,
  CRM_WRITE_ALLOW_LIVE: false,
  NXT_SALES_BASE_URL: 'http://localhost:4000',
  NXT_SALES_SERVICE_USER_ID: 'svc',
  NXT_SALES_LIVE_SERVICE_USER_ID: '',
  CRM_LEAD_SOURCE_FIELD: 'leadSource',
  CRM_LEAD_SOURCE_VALUE: 'Marketing AI Agent',
}
vi.mock('../../src/config/env.js', () => ({ env }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
const audit = vi.fn()
vi.mock('../../src/platform/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

// The CRM, as the tests say it is.
type Co = { id: string; name: string; domain: string | null; email: string | null; emails: string[]; contactPersons: string[]; linkedProfiles: string[] }
let crmCompanies: Co[] = []
const full = (c: Partial<Co> & { id: string; name: string }): Co => ({ domain: null, email: null, emails: [], contactPersons: [], linkedProfiles: [], ...c })
let crmUsers = [{ id: 'user-7', name: 'Sam', email: 'sam@x.test', role: 'member' }]
const getCrm = () => ({
  listUsers: vi.fn(async () => crmUsers),
  getCompany: vi.fn(async (id: string) => crmCompanies.find((c) => c.id === id) ?? null),
  searchCompanies: vi.fn(async ({ search }: { search: string }) => ({
    items: crmCompanies.filter((c) => `${c.name} ${c.domain ?? ''}`.toLowerCase().includes(search.toLowerCase())),
    total: 0,
    truncated: false,
  })),
})
vi.mock('../../src/crm/index.js', () => ({ getCrm }))

const crmGet = vi.fn()
const crmPost = vi.fn()
const crmPut = vi.fn()
vi.mock('../../src/crm/nxtSales/httpClient.js', () => ({ crmGet: (...a: unknown[]) => crmGet(...a), crmPost: (...a: unknown[]) => crmPost(...a), crmPut: (...a: unknown[]) => crmPut(...a) }))

const lead = await import('../../src/crm/leads/leadWrite.js')
const { findCompanyInCrm } = await import('../../src/crm/leads/crmDuplicates.js')
const { UpstreamError } = await import('../../src/platform/errors.js')

const actor = { tenantId: 't1', crmUserId: 'user-7' }
const discovered = (over: Row = {}) => ({
  id: 'd1',
  tenantId: 't1',
  companyName: 'Acme Supply Co.',
  domain: 'acmesupply.com',
  websiteUrl: 'https://www.acmesupply.com/',
  productPageUrl: 'https://www.acmesupply.com/products/hard-hat-x200',
  crmCompanyId: null,
  status: 'candidate',
  crmCheckedAt: null,
  crmMatchedOn: null,
  crmCheckNote: null,
  crmCreateStartedAt: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(env, { CRM_DRIVER: 'real', CRM_WRITE_ENABLED: true, CRM_WRITE_ALLOW_LIVE: false, NXT_SALES_BASE_URL: 'http://localhost:4000', CRM_LEAD_SOURCE_FIELD: 'leadSource', CRM_LEAD_SOURCE_VALUE: 'Marketing AI Agent' })
  crmCompanies = []
  crmUsers = [{ id: 'user-7', name: 'Sam', email: 'sam@x.test', role: 'member' }]
  db.discoveredCompany = [discovered()]
  db.decisionMakerRun = [{ id: 'run1', tenantId: 't1', crmCompanyId: 'd1', status: 'completed' }]
  db.decisionMakerCandidate = [
    { id: 'cand1', tenantId: 't1', dmRunId: 'run1', crmCompanyId: 'd1', outcome: 'shortlisted', companyMatch: 'verified', rank: 1, fullName: 'Jane Smith', rawTitle: 'Head of eCommerce', email: 'jane.smith@acmesupply.com', profileUrl: 'https://www.linkedin.com/in/jane-smith-123' },
  ]
  crmGet.mockResolvedValue({ isDuplicate: false, existing: null })
  crmPost.mockImplementation(async (path: string) => (path === '/api/companies/email-conflicts' ? { conflicts: [] } : { id: 'crm-new', name: 'Acme Supply Co.' }))
  crmPut.mockResolvedValue({ ok: true })
})

describe('is it already in NXT Sales?', () => {
  it('uses the CRM’s own duplicate rule first', async () => {
    crmCompanies = [full({ id: 'c9', name: 'ACME SUPPLY CO.', domain: 'https://acmesupply.com' })]
    crmGet.mockResolvedValue({ isDuplicate: true, existing: { id: 'c9', name: 'ACME SUPPLY CO.' } })
    const r = await findCompanyInCrm({ name: 'Acme Supply Co.', website: 'https://www.acmesupply.com/' })
    expect(r).toEqual({ status: 'found', match: { id: 'c9', name: 'ACME SUPPLY CO.', matchedOn: 'domain' } })
  })

  it('finds the same company under another subdomain or spelling of its website', async () => {
    crmCompanies = [full({ id: 'c2', name: 'Acme', domain: 'shop.acmesupply.com' })]
    const r = await findCompanyInCrm({ name: 'Acme Supply Co.', website: 'https://www.acmesupply.com' })
    expect(r).toMatchObject({ status: 'found', match: { id: 'c2', matchedOn: 'domain' } })
  })

  it('finds the same name once punctuation and legal endings are ignored', async () => {
    crmCompanies = [full({ id: 'c3', name: 'Acme Supply, Inc.', domain: null })]
    const r = await findCompanyInCrm({ name: 'ACME Supply LLC', website: null })
    expect(r).toMatchObject({ status: 'found', match: { id: 'c3', matchedOn: 'name' } })
  })

  it('says not found only when every check ran', async () => {
    crmCompanies = [full({ id: 'c4', name: 'Beta Electric', domain: 'beta-electric.com' })]
    expect(await findCompanyInCrm({ name: 'Acme Supply Co.', website: 'https://acmesupply.com' })).toEqual({ status: 'not_found' })
  })

  // Three traps seen in real data (2026-09-29).
  it('never treats two social-media pages as the same website', async () => {
    crmCompanies = [full({ id: 'c5', name: 'Mallia Tools', domain: 'https://www.facebook.com/malliatools' })]
    expect(await findCompanyInCrm({ name: 'CNW Electrical Ipswich', website: 'https://www.facebook.com/cnwelectrical' })).toEqual({ status: 'not_found' })
  })

  it('flags the same name with a DIFFERENT website — not linked, for a person to decide', async () => {
    crmCompanies = [full({ id: 'c6', name: 'Ideal Electrical', domain: 'idealelectrical.co.za' })]
    const r = await findCompanyInCrm({ name: 'Ideal Electrical', website: 'https://idealelectrical.com' })
    expect(r).toMatchObject({ status: 'name_conflict', match: { id: 'c6' } })
  })

  it('checks and adds with the VERIFIED domain, not a page the company was merely read from', async () => {
    db.discoveredCompany = [discovered({ domain: 'ampere.com.au', websiteUrl: 'https://www.omegapower.com.au/brands/ampere' })]
    crmCompanies = [full({ id: 'c8', name: 'Omega Power', domain: 'omegapower.com.au' })]
    const [r] = await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(r).toMatchObject({ outcome: 'created' })
    expect(crmPost.mock.calls.find(([p]) => p === '/api/companies')![1]).toMatchObject({ domain: 'ampere.com.au' })
  })

  it('never reads "could not check" as "new"', async () => {
    crmGet.mockRejectedValue(new Error('NXT Sales unreachable'))
    expect(await findCompanyInCrm({ name: 'Acme Supply Co.', website: 'https://acmesupply.com' })).toMatchObject({ status: 'unreachable' })
  })
})

describe('adding a company to NXT Sales', () => {
  it('creates a genuinely new company with its Lead Source, owned by the person adding it, with its verified decision maker', async () => {
    const [r] = await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(r).toEqual({ id: 'd1', outcome: 'created', crmCompanyId: 'crm-new' })
    const create = crmPost.mock.calls.find(([p]) => p === '/api/companies')!
    expect(create[1]).toEqual({
      name: 'Acme Supply Co.',
      domain: 'acmesupply.com',
      endPdpUrl: 'https://www.acmesupply.com/products/hard-hat-x200',
      ownerId: 'user-7',
      contactPersons: ['Jane Smith - Head of eCommerce'],
      linkedProfiles: ['https://www.linkedin.com/in/jane-smith-123'],
      emails: ['jane.smith@acmesupply.com'],
      customFields: { leadSource: 'Marketing AI Agent' },
    })
    expect(db.discoveredCompany[0]).toMatchObject({ crmCompanyId: 'crm-new', status: 'matched_to_crm', crmMatchedOn: 'created', crmCreatedByCrmUserId: 'user-7', crmCreateStartedAt: null })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'crm.company_created' }))
  })

  it('links, and never creates, a company the CRM already holds', async () => {
    crmCompanies = [full({ id: 'c9', name: 'Acme Supply Co', domain: 'acmesupply.com' })]
    const [r] = await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(r).toMatchObject({ outcome: 'already_in_crm', crmCompanyId: 'c9', matchedOn: 'domain' })
    expect(crmPost.mock.calls.some(([p]) => p === '/api/companies')).toBe(false)
    expect(db.discoveredCompany[0]).toMatchObject({ crmCompanyId: 'c9', status: 'matched_to_crm' })
  })

  it('honours the CRM’s own 409 on create: linked, not duplicated', async () => {
    crmPost.mockImplementation(async (path: string) => {
      if (path === '/api/companies/email-conflicts') return { conflicts: [] }
      throw new UpstreamError('NXT Sales 409 on POST /api/companies.', { retryable: false, details: { status: 409, body: JSON.stringify({ existing: { id: 'c77', name: 'Acme' } }) } })
    })
    const [r] = await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(r).toMatchObject({ outcome: 'already_in_crm', crmCompanyId: 'c77', matchedOn: 'crm_rule' })
    expect(db.discoveredCompany[0]!.crmCompanyId).toBe('c77')
  })

  it('adds nothing on a same-name, different-website conflict', async () => {
    crmCompanies = [full({ id: 'c6', name: 'Acme Supply Co.', domain: 'acme-supply.de' })]
    const [r] = await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(r).toMatchObject({ outcome: 'name_conflict' })
    expect(crmPost.mock.calls.some(([p]) => p === '/api/companies')).toBe(false)
    expect(db.discoveredCompany[0]).toMatchObject({ crmCompanyId: null, crmMatchedOn: 'name_conflict' })
  })

  it('does not add anything when NXT Sales cannot be checked', async () => {
    crmGet.mockRejectedValue(new Error('NXT Sales unreachable'))
    const [r] = await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(r).toMatchObject({ outcome: 'error' })
    expect(crmPost).not.toHaveBeenCalled()
  })

  it('a create that timed out is reported as uncertain and keeps its claim, so a second click cannot create twice', async () => {
    crmPost.mockImplementation(async (path: string) => {
      if (path === '/api/companies/email-conflicts') return { conflicts: [] }
      throw new UpstreamError('NXT Sales timed out on POST /api/companies.', { retryable: false, details: { timedOut: true } })
    })
    const [r] = await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(r).toMatchObject({ outcome: 'uncertain' })
    expect(db.discoveredCompany[0]!.crmCreateStartedAt).toBeInstanceOf(Date)
    crmPost.mockClear()
    const [again] = await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(again).toMatchObject({ outcome: 'in_progress' })
    expect(crmPost.mock.calls.some(([p]) => p === '/api/companies')).toBe(false)
  })

  it('never writes an email another NXT Sales company already holds, nor a shared mailbox', async () => {
    crmPost.mockImplementation(async (path: string) =>
      path === '/api/companies/email-conflicts' ? { conflicts: [{ email: 'jane.smith@acmesupply.com', companies: [{ id: 'x' }] }] } : { id: 'crm-new' },
    )
    await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(crmPost.mock.calls.find(([p]) => p === '/api/companies')![1]).not.toHaveProperty('emails')

    db.discoveredCompany = [discovered()]
    db.decisionMakerCandidate[0]!.email = 'sales@acmesupply.com'
    crmPost.mockClear()
    crmPost.mockImplementation(async (path: string) => (path === '/api/companies/email-conflicts' ? { conflicts: [] } : { id: 'crm-new' }))
    await lead.addDiscoveredCompaniesToCrm(actor, ['d1'])
    expect(crmPost.mock.calls.find(([p]) => p === '/api/companies')![1]).not.toHaveProperty('emails')
  })

  it('refuses everything while writing is off, or without the Lead Source field', async () => {
    env.CRM_WRITE_ENABLED = false
    await expect(lead.addDiscoveredCompaniesToCrm(actor, ['d1'])).rejects.toThrow(/CRM_WRITE_ENABLED=false/)
    env.CRM_WRITE_ENABLED = true
    env.CRM_LEAD_SOURCE_FIELD = ''
    await expect(lead.addDiscoveredCompaniesToCrm(actor, ['d1'])).rejects.toThrow(/Lead Source field is not set up/)
    expect(crmPost).not.toHaveBeenCalled()
  })

  it('refuses, before anything is sent, when the person adding it is not a user of this NXT Sales', async () => {
    crmUsers = []
    await expect(lead.addDiscoveredCompaniesToCrm(actor, ['d1'])).rejects.toThrow(/not a user in this NXT Sales/)
    expect(crmPost).not.toHaveBeenCalled()
  })

  it('refuses the live CRM without its own switch', async () => {
    env.NXT_SALES_BASE_URL = 'https://crm.example.com'
    expect(lead.leadWriteStatus()).toMatchObject({ canWrite: false, target: 'live' })
    await expect(lead.addDiscoveredCompaniesToCrm(actor, ['d1'])).rejects.toThrow(/CRM_WRITE_ALLOW_LIVE/)
  })
})

describe('the create body guard', () => {
  it('allows an owner only as the person adding it, and requires the Lead Source', () => {
    const ok = { name: 'A', ownerId: 'user-7', customFields: { leadSource: 'Marketing AI Agent' } }
    expect(() => lead.assertCreatable(ok, 'user-7', 'leadSource', 'Marketing AI Agent')).not.toThrow()
    expect(() => lead.assertCreatable({ ...ok, ownerId: 'someone-else' }, 'user-7', 'leadSource', 'Marketing AI Agent')).toThrow(/owner/)
    expect(() => lead.assertCreatable({ ...ok, customFields: {} }, 'user-7', 'leadSource', 'Marketing AI Agent')).toThrow(/Lead Source/)
    expect(() => lead.assertCreatable({ ...ok, dealValue: 5 }, 'user-7', 'leadSource', 'Marketing AI Agent')).toThrow()
  })
})

describe('adding a decision maker to a company in NXT Sales', () => {
  beforeEach(() => {
    db.discoveredCompany = [discovered({ crmCompanyId: 'c1', status: 'matched_to_crm' })]
    crmCompanies = [full({ id: 'c1', name: 'Acme Supply Co.', domain: 'acmesupply.com', email: 'info@acmesupply.com', emails: ['info@acmesupply.com'], contactPersons: ['Lloyd Robertson - Managing Director'] })]
  })

  it('merges name and role, LinkedIn and work email — keeping everything already there, primary email first', async () => {
    const r = await lead.addDecisionMakerToCrm(actor, 'cand1')
    expect(r).toEqual({ outcome: 'added', crmCompanyId: 'c1', added: ['name', 'LinkedIn', 'email'] })
    expect(crmPut).toHaveBeenCalledWith('/api/companies/c1', {
      contactPersons: ['Lloyd Robertson - Managing Director', 'Jane Smith - Head of eCommerce'],
      linkedProfiles: ['https://www.linkedin.com/in/jane-smith-123'],
      emails: ['info@acmesupply.com', 'jane.smith@acmesupply.com'],
    })
  })

  it('writes nothing when the person is already on the record', async () => {
    crmCompanies[0]!.contactPersons.push('Jane Smith - eCommerce')
    crmCompanies[0]!.linkedProfiles.push('https://www.linkedin.com/in/jane-smith-123/')
    crmCompanies[0]!.emails.push('jane.smith@acmesupply.com')
    expect(await lead.addDecisionMakerToCrm(actor, 'cand1')).toEqual({ outcome: 'already_up_to_date', crmCompanyId: 'c1' })
    expect(crmPut).not.toHaveBeenCalled()
  })

  it('refuses a company that is not in NXT Sales yet, and a person who is not verified', async () => {
    db.discoveredCompany[0]!.crmCompanyId = null
    await expect(lead.addDecisionMakerToCrm(actor, 'cand1')).rejects.toThrow(/not in NXT Sales yet/)
    db.discoveredCompany[0]!.crmCompanyId = 'c1'
    db.decisionMakerCandidate[0]!.companyMatch = 'unverified'
    await expect(lead.addDecisionMakerToCrm(actor, 'cand1')).rejects.toThrow(/verified/)
    expect(crmPut).not.toHaveBeenCalled()
  })
})
