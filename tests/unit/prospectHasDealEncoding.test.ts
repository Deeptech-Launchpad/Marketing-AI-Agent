import { describe, expect, it } from 'vitest'
import { buildQuery } from '../../src/crm/nxtSales/httpClient.js'
import { toCompanyParams } from '../../src/crm/nxtSales/mappers.js'
import { FakeCrmAdapter } from '../../src/crm/fake/fakeCrmAdapter.js'

// NXT Sales' buildCompanyWhere() filters on hasDeal === 'yes' / 'no' only. A
// boolean on the wire ("true"/"false") matches neither branch and the filter is
// silently dropped, so the domain boolean must be translated in the adapter.

describe('hasDeal wire encoding', () => {
  it("sends 'no' for hasDeal=false", () => {
    expect(toCompanyParams({ hasDeal: false }).hasDeal).toBe('no')
    expect(buildQuery(toCompanyParams({ hasDeal: false }))).toContain('hasDeal=no')
  })

  it("sends 'yes' for hasDeal=true", () => {
    expect(toCompanyParams({ hasDeal: true }).hasDeal).toBe('yes')
    expect(buildQuery(toCompanyParams({ hasDeal: true }))).toContain('hasDeal=yes')
  })

  it('omits the param when hasDeal is not specified', () => {
    expect('hasDeal' in toCompanyParams({ industries: ['A'] })).toBe(false)
  })
})

describe('fake CRM mirrors the real hasDeal semantics (any deal, any stage)', () => {
  it('hasDeal=true returns exactly the companies with at least one deal', async () => {
    const crm = new FakeCrmAdapter()
    const deals = await crm.exportDeals()
    const withDeals = new Set(deals.filter((d) => d.companyId).map((d) => d.companyId!))
    const yes = await crm.exportCompanies({ hasDeal: true })
    const no = await crm.exportCompanies({ hasDeal: false })
    expect(yes.items.length).toBeGreaterThan(0)
    expect(yes.items.every((c) => withDeals.has(c.id))).toBe(true)
    expect(no.items.some((c) => withDeals.has(c.id))).toBe(false)
    const all = await crm.exportCompanies({})
    expect(yes.items.length + no.items.length).toBe(all.items.length)
  })
})
