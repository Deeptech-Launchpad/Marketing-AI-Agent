import { describe, expect, it } from 'vitest'
import { deriveIcpEvidence, formatEvidence, INSUFFICIENT_ICP_STATEMENT } from '../../src/campaign/icpDeriver.js'
import type { CrmPort } from '../../src/crm/crmPort.js'
import type { CrmCompany, CrmDeal } from '../../src/crm/types.js'

// The sufficiency verdict exists because the real CRM could not support an ICP
// and the old code produced a confident one anyway. These tests pin both sides:
// that thin evidence is refused, and that adequate evidence is still accepted.

function company(id: string, industry: string, country = 'United States'): CrmCompany {
  return {
    id,
    name: `Co ${id}`,
    email: null,
    emails: [],
    phone: null,
    domain: `${id}.example`,
    industry,
    country,
    cms: 'Magento',
    leadStatus: 'New',
    status: 'Lead',
    remarks: null,
    notes: null,
    endPdpUrl: null,
    contactPersons: [],
    linkedProfiles: [],
    ownerId: 'u1',
    ownerName: 'Owner',
    dealCount: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

function deal(id: string, companyId: string | null, stage: string): CrmDeal {
  return {
    id,
    title: `Deal ${id}`,
    value: 1000,
    currency: 'USD',
    stage,
    companyId,
    companyName: null,
    ownerId: 'u1',
    country: null,
    clientType: null,
    serviceRequirement: null,
    opportunityType: null,
    strategicImportance: null,
    expectedOutcome: null,
    poc: false,
    proposalShared: false,
    openDate: null,
    createdAt: new Date(0).toISOString(),
  }
}

function stubCrm(companies: CrmCompany[], deals: CrmDeal[]): CrmPort {
  return {
    name: 'stub',
    exportDeals: async () => deals,
    exportCompanies: async () => ({ items: companies, total: companies.length, truncated: false }),
  } as unknown as CrmPort
}

describe('ICP sufficiency — INSUFFICIENT', () => {
  it('refuses an ICP when no industry facet reaches the sample floor', async () => {
    // Mirrors the real NXT Sales shape: a handful of decided deals spread thin.
    const companies = ['a', 'b', 'c', 'd'].map((x, i) => company(x, `Industry ${i}`))
    const deals = [
      deal('1', 'a', 'Won'),
      deal('2', 'b', 'Lost'),
      deal('3', 'c', 'Lost'),
      deal('4', 'd', 'Lost'),
      ...Array.from({ length: 40 }, (_, i) => deal(`o${i}`, 'a', 'Discussion')),
    ]

    const ev = await deriveIcpEvidence(stubCrm(companies, deals))

    expect(ev.sufficiency.sufficient).toBe(false)
    expect(ev.sufficiency.statement).toBe(INSUFFICIENT_ICP_STATEMENT)
    expect(ev.byIndustry).toHaveLength(0)
    expect(ev.sufficiency.reasons.join(' ')).toMatch(/no industry has at least 3 decided/i)
  })

  it('does not count decided deals that link to no company', async () => {
    const companies = [company('a', 'Widgets')]
    const deals = [
      deal('1', 'a', 'Won'),
      deal('2', 'a', 'Lost'),
      deal('3', 'a', 'Lost'),
      // 20 decided but UNLINKED deals must not rescue the verdict.
      ...Array.from({ length: 20 }, (_, i) => deal(`u${i}`, null, 'Won')),
    ]

    const ev = await deriveIcpEvidence(stubCrm(companies, deals))

    expect(ev.dealsWithoutCompany).toBe(20)
    expect(ev.sufficiency.linkedDecidedDeals).toBe(3)
    expect(ev.sufficiency.sufficient).toBe(false)
    expect(ev.sufficiency.reasons.join(' ')).toMatch(/decided deals are linked to a company/i)
  })

  it('withholds the facet tables so the model cannot reason from noise', async () => {
    const companies = [company('a', 'Widgets')]
    const deals = [deal('1', 'a', 'Won'), deal('2', 'a', 'Lost')]

    const text = formatEvidence(await deriveIcpEvidence(stubCrm(companies, deals)))

    expect(text).toContain('INSUFFICIENT')
    expect(text).toContain(INSUFFICIENT_ICP_STATEMENT)
    expect(text).toContain('Do NOT infer an ideal customer profile')
    expect(text).not.toContain('By industry:')
  })
})

describe('ICP sufficiency — SUFFICIENT', () => {
  it('accepts an ICP when a facet clears the floor and the base is large enough', async () => {
    const companies = Array.from({ length: 12 }, (_, i) => company(`c${i}`, 'Infrastructure'))
    const deals = companies.map((c, i) => deal(`d${i}`, c.id, i % 3 === 0 ? 'Lost' : 'Won'))

    const ev = await deriveIcpEvidence(stubCrm(companies, deals))

    expect(ev.sufficiency.sufficient).toBe(true)
    expect(ev.sufficiency.statement).not.toBe(INSUFFICIENT_ICP_STATEMENT)
    expect(ev.byIndustry.length).toBeGreaterThan(0)
    expect(ev.byIndustry[0]!.value).toBe('Infrastructure')
    expect(formatEvidence(ev)).toContain('By industry:')
  })

  it('computes win rate over DECIDED deals only, ignoring open pipeline', async () => {
    const companies = Array.from({ length: 12 }, (_, i) => company(`c${i}`, 'Infrastructure'))
    const deals = [
      ...companies.map((c, i) => deal(`d${i}`, c.id, i < 9 ? 'Won' : 'Lost')),
      // An active pipeline must not drag the win rate down.
      ...Array.from({ length: 50 }, (_, i) => deal(`open${i}`, 'c0', 'Discussion')),
    ]

    const ev = await deriveIcpEvidence(stubCrm(companies, deals))
    expect(ev.byIndustry[0]!.winRate).toBeCloseTo(9 / 12, 5)
  })
})
