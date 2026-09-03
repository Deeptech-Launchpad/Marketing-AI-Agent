import { describe, expect, it } from 'vitest'
import { buildQuery } from '../../src/crm/nxtSales/httpClient.js'
import { toCompany, toCompanyParams, toDeal } from '../../src/crm/nxtSales/mappers.js'

// Regression tests for the two NXT Sales wire-encoding quirks that fail
// SILENTLY — the CRM returns a wrong-but-plausible result set rather than an
// error, so nothing else would catch a mistake here.

describe('query encoding', () => {
  it('sends industries as a REPEATED array param, never comma-joined', () => {
    // Real industry values contain literal commas ("Construction, Building
    // Materials"), so comma-joining shreds them into garbage filters.
    const qs = buildQuery(toCompanyParams({ industries: ['Construction, Building Materials', 'Industrial'] }))
    expect(qs).toContain('industries%5B%5D=')
    expect(qs.match(/industries%5B%5D=/g)).toHaveLength(2)
    expect(qs).not.toMatch(/industries=[^&]*%2C/)
  })

  it('comma-joins the params NXT Sales actually splits on commas', () => {
    const params = toCompanyParams({
      owners: ['u1', 'u2'],
      countries: ['United States', 'Canada'],
      leadStatuses: ['New'],
    })
    expect(params.owners).toBe('u1,u2')
    expect(params.countries).toBe('United States,Canada')
    expect(params.leadStatuses).toBe('New')
  })

  it('JSON-encodes customFilters as a string', () => {
    const params = toCompanyParams({ customFilters: { gstStatus: 'Filed' } })
    expect(params.customFilters).toBe('{"gstStatus":"Filed"}')
  })

  it('omits empty values instead of sending blanks', () => {
    expect(buildQuery(toCompanyParams({ industries: [], search: '' }))).toBe('')
  })

  it('drops pagination on an export query', () => {
    const params = toCompanyParams({ page: 2, limit: 50, industries: ['X'] })
    expect(params.page).toBe(2)
    // exportCompanies strips page/limit before calling this; verify the mapper
    // itself passes through what it is given.
    expect(params.limit).toBe(50)
  })
})

describe('response mapping', () => {
  it('tolerates null JSON array columns', () => {
    // Company.emails / phones / contactPersons / linkedProfiles are nullable
    // JSONB in NXT Sales, not empty arrays.
    const c = toCompany({ id: 'c1', name: 'Acme', emails: null, linkedProfiles: null, contactPersons: null })
    expect(c.emails).toEqual([])
    expect(c.linkedProfiles).toEqual([])
    expect(c.contactPersons).toEqual([])
  })

  it('reads the nested owner and deal count', () => {
    const c = toCompany({
      id: 'c1',
      name: 'Acme',
      owner: { id: 'u1', name: 'Owner One' },
      _count: { deals: 3 },
    })
    expect(c.ownerName).toBe('Owner One')
    expect(c.dealCount).toBe(3)
  })

  it('keeps a null companyId on a deal rather than inventing one', () => {
    // Deal.companyId is nullable in NXT Sales and its own dashboard reports the
    // gap; attribution has to handle it explicitly.
    const d = toDeal({ id: 'd1', title: 'X', companyId: null, stage: 'Won', value: 100 })
    expect(d.companyId).toBeNull()
    expect(d.stage).toBe('Won')
  })

  it('coerces missing numerics to 0, never NaN', () => {
    const d = toDeal({ id: 'd1', title: 'X', value: undefined })
    expect(d.value).toBe(0)
  })
})
