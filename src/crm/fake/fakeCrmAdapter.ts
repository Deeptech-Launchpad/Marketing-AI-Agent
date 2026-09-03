import type { CrmPort } from '../crmPort.js'
import type {
  CrmActivity,
  CrmCompany,
  CrmCompanyQuery,
  CrmCustomFieldDef,
  CrmDeal,
  CrmDealStats,
  CrmDropdownField,
  CrmDropdownOption,
  CrmEmailSummary,
  CrmPage,
  CrmUser,
} from '../types.js'

// Deterministic in-memory CRM. Used by tests and by CRM_DRIVER=fake, so the
// orchestrator can be developed and exercised end to end with no network, no
// cost, and no dependency on a live NXT Sales instance.
//
// The dataset is deliberately shaped like the real one: infrastructure-adjacent
// industries win more often than the rest, so ICP derivation has something true
// to find rather than noise.

const INDUSTRIES = [
  'Infrastructure & Construction',
  'Industrial Equipment',
  'Plumbing & PVF (Pipe, Valve, Fitting)',
  'Retail & Apparel',
  'Food & Beverage',
]
const COUNTRIES = ['United States', 'United Kingdom', 'Canada', 'Australia']
const CMS = ['Magento', 'Shopify', 'WooCommerce', 'BigCommerce']

function makeCompanies(): CrmCompany[] {
  const out: CrmCompany[] = []
  for (let i = 1; i <= 120; i++) {
    // Each attribute is driven by a DIFFERENT divisor so the facets stay
    // independent. The first version of this fixture derived country, cms and
    // dealCount all from `i % 4`, which silently made "on Magento" and "has an
    // open deal" the same predicate — so a perfectly reasonable segment
    // (Magento + no existing deal) resolved to zero companies by construction
    // and looked like an orchestrator bug rather than a fixture artefact.
    const industry = INDUSTRIES[i % INDUSTRIES.length]!
    const country = COUNTRIES[Math.floor(i / 5) % COUNTRIES.length]!
    const cms = CMS[Math.floor(i / 2) % CMS.length]!
    out.push({
      id: `co_${String(i).padStart(3, '0')}`,
      name: `Fixture Company ${i}`,
      email: `contact${i}@fixture-${i}.example`,
      emails: [`contact${i}@fixture-${i}.example`],
      phone: null,
      domain: `fixture-${i}.example`,
      industry,
      country,
      cms,
      leadStatus: i % 7 === 0 ? 'Qualified' : 'New',
      status: 'Lead',
      remarks: null,
      notes: null,
      endPdpUrl: `https://fixture-${i}.example/product/sample`,
      contactPersons: [`Contact Person ${i}`],
      linkedProfiles: [`https://www.linkedin.com/company/fixture-${i}`],
      ownerId: `usr_${(i % 3) + 1}`,
      ownerName: `Owner ${(i % 3) + 1}`,
      dealCount: i % 3 === 0 ? 1 : 0,
      createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 200))).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 5, 1 + (i % 20))).toISOString(),
    })
  }
  return out
}

function makeDeals(companies: CrmCompany[]): CrmDeal[] {
  const out: CrmDeal[] = []
  let n = 0
  for (const co of companies) {
    if (co.dealCount === 0) continue
    n++
    // Infrastructure-adjacent verticals win ~2/3 of the time; everything else
    // wins ~1/3. That asymmetry is what the ICP deriver should discover.
    const favoured =
      co.industry === 'Infrastructure & Construction' ||
      co.industry === 'Industrial Equipment' ||
      co.industry === 'Plumbing & PVF (Pipe, Valve, Fitting)'
    const won = favoured ? n % 3 !== 0 : n % 3 === 0
    out.push({
      id: `deal_${String(n).padStart(3, '0')}`,
      title: `${co.name} — catalog enrichment`,
      value: 12_000 + (n % 7) * 3_000,
      currency: 'USD',
      stage: won ? 'Won' : n % 5 === 0 ? 'Lost' : 'Discussion',
      companyId: co.id,
      companyName: co.name,
      ownerId: co.ownerId,
      country: co.country,
      clientType: 'ecommerce',
      serviceRequirement: 'Product Data Enrichment',
      opportunityType: 'New Business',
      strategicImportance: favoured ? 'High' : 'Medium',
      expectedOutcome: 'Catalog completeness',
      poc: n % 4 === 0,
      proposalShared: n % 3 === 0,
      openDate: new Date(Date.UTC(2026, n % 8, 5)).toISOString(),
      createdAt: new Date(Date.UTC(2026, n % 8, 6)).toISOString(),
    })
  }
  // One deal with no company link — mirrors NXT Sales' nullable Deal.companyId,
  // which the ICP deriver must count separately rather than silently drop.
  out.push({
    id: 'deal_orphan',
    title: 'Unlinked opportunity',
    value: 9_000,
    currency: 'USD',
    stage: 'Won',
    companyId: null,
    companyName: 'Unknown',
    ownerId: 'usr_1',
    country: null,
    clientType: null,
    serviceRequirement: null,
    opportunityType: null,
    strategicImportance: null,
    expectedOutcome: null,
    poc: false,
    proposalShared: false,
    openDate: new Date(Date.UTC(2026, 3, 1)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 3, 2)).toISOString(),
  })
  return out
}

export class FakeCrmAdapter implements CrmPort {
  readonly name = 'fake'
  private readonly companies = makeCompanies()
  private readonly deals = makeDeals(this.companies)

  private filter(q: CrmCompanyQuery): CrmCompany[] {
    return this.companies.filter((c) => {
      if (q.industries?.length && !q.industries.includes(c.industry ?? '')) return false
      if (q.countries?.length && !q.countries.includes(c.country ?? '')) return false
      if (q.cmsValues?.length && !q.cmsValues.includes(c.cms ?? '')) return false
      if (q.leadStatuses?.length && !q.leadStatuses.includes(c.leadStatus ?? '')) return false
      if (q.hasDeal === true && c.dealCount === 0) return false
      if (q.hasDeal === false && c.dealCount > 0) return false
      if (q.search && !c.name.toLowerCase().includes(q.search.toLowerCase())) return false
      return true
    })
  }

  async searchCompanies(q: CrmCompanyQuery): Promise<CrmPage<CrmCompany>> {
    const all = this.filter(q)
    const limit = q.limit ?? 100
    const page = q.page ?? 1
    return {
      items: all.slice((page - 1) * limit, page * limit),
      total: all.length,
      truncated: false,
    }
  }

  async exportCompanies(q: CrmCompanyQuery): Promise<CrmPage<CrmCompany>> {
    const all = this.filter(q)
    return { items: all, total: all.length, truncated: false }
  }

  async getCompany(id: string): Promise<CrmCompany | null> {
    return this.companies.find((c) => c.id === id) ?? null
  }

  async listDeals(params: { companyId?: string } = {}): Promise<CrmDeal[]> {
    if (params.companyId) return this.deals.filter((d) => d.companyId === params.companyId)
    return this.deals
  }

  async exportDeals(): Promise<CrmDeal[]> {
    return this.deals
  }

  async getDealStats(): Promise<CrmDealStats> {
    const won = this.deals.filter((d) => d.stage === 'Won').length
    const lost = this.deals.filter((d) => d.stage === 'Lost').length
    const stages = new Map<string, number>()
    for (const d of this.deals) stages.set(d.stage, (stages.get(d.stage) ?? 0) + 1)
    return {
      totalDeals: this.deals.length,
      activeDeals: this.deals.length - won - lost,
      wonDeals: won,
      lostDeals: lost,
      totalValue: this.deals.reduce((s, d) => s + d.value, 0),
      dealsWithoutCompany: this.deals.filter((d) => !d.companyId).length,
      stageBreakdown: [...stages.entries()].map(([stage, count]) => ({ stage, count })),
    }
  }

  async getEmailSummary(companyId: string): Promise<CrmEmailSummary> {
    const co = await this.getCompany(companyId)
    if (!co) return { ok: false, threadCount: 0, messageCount: 0, lastContactAt: null, threads: [] }
    return {
      ok: true,
      threadCount: 1,
      messageCount: 2,
      lastContactAt: new Date(Date.UTC(2026, 6, 1)).toISOString(),
      threads: [
        {
          subject: `Intro — ${co.name}`,
          messageCount: 2,
          lastAt: new Date(Date.UTC(2026, 6, 1)).toISOString(),
          lastDirection: 'inbound',
          excerpts: [
            {
              direction: 'outbound',
              at: new Date(Date.UTC(2026, 5, 28)).toISOString(),
              text: 'Reaching out about your product catalog data.',
            },
            {
              direction: 'inbound',
              at: new Date(Date.UTC(2026, 6, 1)).toISOString(),
              text: 'Interesting — send over some detail on specification coverage.',
            },
          ],
        },
      ],
    }
  }

  async listActivities(params: { companyId: string }): Promise<CrmActivity[]> {
    return [
      {
        id: `act_${params.companyId}`,
        type: 'email',
        companyId: params.companyId,
        subject: 'Intro',
        direction: 'outbound',
        // Deliberately old, so recent-contact suppression does not swallow the
        // whole fixture audience in tests.
        createdAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
      },
    ]
  }

  async getDropdownFields(): Promise<CrmDropdownField[]> {
    return [
      { fieldKey: 'company.industry', label: 'Industry', group: 'Company' },
      { fieldKey: 'company.country', label: 'Country', group: 'Company' },
      { fieldKey: 'company.leadStatus', label: 'Lead Status', group: 'Company' },
      { fieldKey: 'company.cms', label: 'CMS', group: 'Company' },
    ]
  }

  async getDropdownOptions(fieldKey: string): Promise<CrmDropdownOption[]> {
    const map: Record<string, string[]> = {
      'company.industry': INDUSTRIES,
      'company.country': COUNTRIES,
      'company.cms': CMS,
      'company.leadStatus': ['New', 'Qualified', 'Unqualified'],
    }
    return (map[fieldKey] ?? []).map((v) => ({ value: v, label: v }))
  }

  async getCustomFieldDefs(): Promise<CrmCustomFieldDef[]> {
    return []
  }

  async listUsers(): Promise<CrmUser[]> {
    return [
      { id: 'usr_1', name: 'Owner 1', email: 'owner1@example.com', role: 'admin' },
      { id: 'usr_2', name: 'Owner 2', email: 'owner2@example.com', role: 'member' },
      { id: 'usr_3', name: 'Owner 3', email: 'owner3@example.com', role: 'member' },
    ]
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}
