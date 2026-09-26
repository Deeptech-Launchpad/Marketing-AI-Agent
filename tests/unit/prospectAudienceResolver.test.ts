import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmActivity, CrmCompany, CrmCompanyQuery, CrmDeal } from '../../src/crm/types.js'

// Audience resolution as Stage 1 uses it: open-deal handling, ranking on real
// record signals, and recent-contact checks applied to the ranked shortlist.

const members: Array<Record<string, unknown>> = []
const snapshots: Array<Record<string, unknown>> = []
const tx = {
  audienceSnapshot: { create: async ({ data }: { data: Record<string, unknown> }) => void snapshots.push(data) },
  audienceMember: {
    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => void members.push(...data),
  },
}
const db = {
  suppressionEntry: { findMany: async () => [] },
  $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
}
let idSeq = 0
vi.mock('../../src/platform/db.js', () => ({ prisma: db, newId: () => `id_${++idSeq}` }))

const { resolveAudience, score } = await import('../../src/campaign/audienceResolver.js')

function company(id: string, over: Partial<CrmCompany> = {}): CrmCompany {
  return {
    id,
    name: `Company ${id}`,
    email: null,
    emails: [],
    phone: null,
    domain: null,
    industry: 'Dental Supplies',
    country: 'PORTUGAL',
    cms: null,
    leadStatus: null,
    status: null,
    remarks: null,
    notes: null,
    endPdpUrl: null,
    contactPersons: [],
    linkedProfiles: [],
    ownerId: null,
    ownerName: null,
    dealCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function deal(companyId: string, stage: string): CrmDeal {
  return {
    id: `d_${companyId}_${stage}`,
    title: 't',
    value: 1,
    currency: 'USD',
    stage,
    companyId,
    companyName: null,
    ownerId: null,
    country: null,
    clientType: null,
    serviceRequirement: null,
    opportunityType: null,
    strategicImportance: null,
    expectedOutcome: null,
    poc: false,
    proposalShared: false,
    openDate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function fakeCrm(opts: { companies: CrmCompany[]; deals?: CrmDeal[]; contacted?: Set<string> }) {
  const activityCalls: string[] = []
  const crm = {
    exportCompanies: async (_q: CrmCompanyQuery) => ({
      items: opts.companies,
      total: opts.companies.length,
      truncated: false,
    }),
    exportDeals: vi.fn(async () => opts.deals ?? []),
    listActivities: async ({ companyId }: { companyId: string }): Promise<CrmActivity[]> => {
      activityCalls.push(companyId)
      const recent = opts.contacted?.has(companyId)
      return [
        {
          id: `a_${companyId}`,
          type: 'email',
          companyId,
          subject: null,
          direction: 'outbound',
          createdAt: recent ? new Date().toISOString() : '2020-01-01T00:00:00.000Z',
        },
      ]
    },
  }
  return { crm: crm as never, activityCalls, exportDeals: crm.exportDeals }
}

const run = (crm: never, query: CrmCompanyQuery, extra: { limit?: number; includeOpenDeals?: boolean } = {}) =>
  resolveAudience({ tenantId: 't1', segmentId: 's1', query, crm, ...extra })

beforeEach(() => {
  members.length = 0
  snapshots.length = 0
})

describe('includeExistingOpportunities is honoured', () => {
  const companies = [company('a1'), company('a2'), company('a3')]
  const deals = [deal('a1', 'Discussion'), deal('a2', 'Won')]

  it('suppresses companies with an OPEN deal by default (won deals are not open)', async () => {
    const { crm } = fakeCrm({ companies, deals })
    const r = await run(crm, { industries: ['Dental Supplies'] })
    expect(r.totalSuppressed).toBe(1)
    expect(members.map((m) => m.crmCompanyId).sort()).toEqual(['a2', 'a3'])
  })

  it('keeps open-deal companies when the requester asked for existing opportunities', async () => {
    const { crm, exportDeals } = fakeCrm({ companies, deals })
    const r = await run(crm, { industries: ['Dental Supplies'] }, { includeOpenDeals: true })
    expect(r.totalSuppressed).toBe(0)
    expect(members.map((m) => m.crmCompanyId).sort()).toEqual(['a1', 'a2', 'a3'])
    expect(exportDeals).not.toHaveBeenCalled()
    expect(String(members[0]!.includeReason)).not.toMatch(/no open opportunity/)
  })
})

describe('ranking uses evidence on the record, not the alphabet', () => {
  it('ranks a record with website, product page and contacts above a bare one', async () => {
    const bare = company('b1', { name: 'Aardvark Marine Parts', industry: 'Marine Equipment', country: 'NORWAY' })
    const rich = company('b2', {
      name: 'Zephyr Marine Parts',
      industry: 'Marine Equipment',
      country: 'NORWAY',
      domain: 'zephyr.example',
      endPdpUrl: 'https://zephyr.example/p/1',
      contactPersons: ['Jane Doe'],
    })
    const { crm } = fakeCrm({ companies: [bare, rich] })
    await run(crm, { industries: ['Marine Equipment'] })
    expect(members.map((m) => m.crmCompanyId)).toEqual(['b2', 'b1'])
    expect(members[0]!.score as number).toBeGreaterThan(members[1]!.score as number)
    expect(String(members[0]!.includeReason)).toMatch(/website/)
  })

  it('matches industry and country case-insensitively, as the CRM does', () => {
    const c = company('c1', { industry: 'dental supplies', country: 'Portugal' })
    const exact = company('c2', { industry: 'Dental Supplies', country: 'PORTUGAL' })
    const q = { industries: ['Dental Supplies'], countries: ['PORTUGAL'] }
    expect(score(c, q)).toBe(score(exact, q))
    expect(score(c, q)).toBe(5)
  })
})

describe('recent-contact exclusion applies to the ranked shortlist', () => {
  it('checks the top-ranked companies even when they sit deep in CRM order, and tops up', async () => {
    // 1,200 bare records first in CRM order, then five strong ones at the end.
    const bare = Array.from({ length: 1200 }, (_, i) => company(`x${i}`, { name: `Bare ${String(i).padStart(4, '0')}` }))
    const strong = Array.from({ length: 5 }, (_, i) =>
      company(`s${i}`, { name: `Strong ${i}`, domain: `s${i}.example`, endPdpUrl: `https://s${i}.example/p` }),
    )
    // Two of the strongest were contacted recently.
    const contacted = new Set(['s0', 's1'])
    const { crm, activityCalls } = fakeCrm({ companies: [...bare, ...strong], contacted })

    const r = await run(crm, {}, { limit: 4 })

    const ids = members.map((m) => m.crmCompanyId)
    expect(ids).toHaveLength(4)
    expect(ids).not.toContain('s0')
    expect(ids).not.toContain('s1')
    expect(ids.slice(0, 3)).toEqual(['s2', 's3', 's4'])
    expect(r.totalSuppressed).toBe(2)
    expect(r.truncated).toBe(true)
    // Only the shortlist and its replacements were looked up, not the first 1,000 in CRM order.
    expect(activityCalls.length).toBeLessThanOrEqual(10)
    expect(activityCalls).toContain('s0')
  })

  it('is not truncated when every eligible company fit under the cap', async () => {
    const { crm } = fakeCrm({ companies: [company('k1'), company('k2')], contacted: new Set(['k2']) })
    const r = await run(crm, {}, { limit: 5 })
    expect(r.totalIncluded).toBe(1)
    expect(r.totalSuppressed).toBe(1)
    expect(r.truncated).toBe(false)
  })
})
