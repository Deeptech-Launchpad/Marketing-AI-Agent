import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  countriesMatching,
  exactMatch,
  industriesMatching,
  readCrmCompany,
  resetIndustryVocabulary,
  searchCrmCompanies,
} from '../../src/crm/companySearch.js'
import type { CrmPort } from '../../src/crm/crmPort.js'
import type { CrmCompany, CrmCompanyQuery } from '../../src/crm/types.js'

// LOOKING A COMPANY UP IN THE CUSTOMER'S OWN CRM.
//
// The picker offered only companies this platform had already worked on, so a
// company sitting in NXT Sales could not be selected at all. Two readings are
// now asked for — the name, and the industry the words name — and the tests
// below are mostly about the second one not turning into a guess.

const VOCAB = [
  'Medical Devices & Supplies',
  'Plumbing & PVF (Pipe, Valve, Fitting)',
  'Dental Supplies',
  'Fasteners & Hardwares',
]

/** The CRM writes its countries in capitals, and holds "UK", not "United Kingdom". */
const COUNTRIES = ['USA', 'UK', 'MALTA', 'SOUTH AFRICA', 'IRELAND']

const company = (id: string, name: string, industry: string | null): CrmCompany =>
  ({
    id,
    name,
    email: null,
    emails: [],
    phone: null,
    domain: `https://${id}.test/`,
    industry,
    country: 'Malta',
    cms: null,
    leadStatus: null,
    status: null,
    linkedProfiles: [],
  }) as unknown as CrmCompany

/** A CRM that records what it was asked, and can be told to fail. */
function crmStub(opts: { byName?: CrmCompany[]; byIndustry?: CrmCompany[]; vocabFails?: boolean } = {}) {
  const queries: CrmCompanyQuery[] = []
  let vocabReads = 0
  const port = {
    searchCompanies: async (q: CrmCompanyQuery) => {
      queries.push(q)
      const items = q.industries?.length ? (opts.byIndustry ?? []) : (opts.byName ?? [])
      return { items, total: items.length, truncated: false }
    },
    getDropdownOptions: async (fieldKey: string) => {
      vocabReads++
      if (opts.vocabFails) throw new Error('NXT Sales 503 on dropdown options')
      const values = fieldKey === 'company.country' ? COUNTRIES : VOCAB
      return values.map((value) => ({ value, label: value }))
    },
  } as unknown as CrmPort
  return { port, queries, reads: () => vocabReads }
}

beforeEach(() => {
  resetIndustryVocabulary()
  vi.restoreAllMocks()
})

describe('matching typed words to CRM industries', () => {
  it('finds an industry the word is part of', () => {
    expect(industriesMatching('medical', VOCAB)).toContain('Medical Devices & Supplies')
  })

  it('finds an industry whose word is part of a longer phrase', () => {
    expect(industriesMatching('medical supplies wholesaler', VOCAB)).toContain('Medical Devices & Supplies')
  })

  it('ignores punctuation and case, as the CRM writes its own values', () => {
    expect(industriesMatching('PLUMBING & pvf', VOCAB)).toContain('Plumbing & PVF (Pipe, Valve, Fitting)')
  })

  it('invents nothing for a word the CRM does not use', () => {
    // "hospital" is a related idea, and relatedness is exactly what this must
    // not do: the CRM's vocabulary is the whole vocabulary.
    expect(industriesMatching('hospital', VOCAB)).toEqual([])
  })

  it('is not dragged in by short common words', () => {
    expect(industriesMatching('and co ltd', VOCAB)).toEqual([])
  })

  it('puts the industry the query names outright first', () => {
    // "dental supplies" IS one of the industries; it also shares the word
    // "supplies" with another. The one it names comes first.
    const hits = industriesMatching('dental supplies', VOCAB)
    expect(hits[0]).toBe('Dental Supplies')
    expect(hits).toContain('Medical Devices & Supplies')
  })
})

describe('searching the CRM for a company', () => {
  it('returns name matches, labelled as such', async () => {
    const crm = crmStub({ byName: [company('c1', 'Aaka Scientific', 'Medical Devices & Supplies')] })
    const out = await searchCrmCompanies(crm.port, 'Aaka', 10)
    expect(out.companies).toHaveLength(1)
    expect(out.companies[0]).toMatchObject({ crmCompanyId: 'c1', companyName: 'Aaka Scientific', matchedOn: 'name' })
  })

  it('offers the industry companies when the words name an industry', async () => {
    const crm = crmStub({
      byName: [],
      byIndustry: [company('c2', 'Star Medical', 'Medical Devices & Supplies')],
    })
    const out = await searchCrmCompanies(crm.port, 'ACO Medical', 10)
    expect(out.industries).toEqual(['Medical Devices & Supplies'])
    expect(out.companies[0]).toMatchObject({ crmCompanyId: 'c2', matchedOn: 'industry' })
  })

  it('reports a company once, under the stronger reason', async () => {
    const both = company('c3', 'Star Medical', 'Medical Devices & Supplies')
    const crm = crmStub({ byName: [both], byIndustry: [both] })
    const out = await searchCrmCompanies(crm.port, 'medical', 10)
    expect(out.companies).toHaveLength(1)
    expect(out.companies[0]!.matchedOn).toBe('name')
  })

  it('asks the CRM for nothing at all on a one-character query', async () => {
    const crm = crmStub({ byName: [company('c1', 'A', null)] })
    const out = await searchCrmCompanies(crm.port, 'a', 10)
    expect(out.companies).toEqual([])
    expect(crm.queries).toEqual([])
  })

  it('reads each vocabulary once and keeps it, rather than per keystroke', async () => {
    const crm = crmStub({ byName: [] })
    await searchCrmCompanies(crm.port, 'medical', 10)
    await searchCrmCompanies(crm.port, 'medic', 10)
    await searchCrmCompanies(crm.port, 'med', 10)
    // Industries and countries: two reads in total, not two per search.
    expect(crm.reads()).toBe(2)
  })

  it('says so when the industry list could not be read, and still searches by name', async () => {
    const crm = crmStub({ byName: [company('c1', 'Aaka Scientific', null)], vocabFails: true })
    const out = await searchCrmCompanies(crm.port, 'Aaka', 10)
    expect(out.industryReadError).toMatch(/503/)
    expect(out.companies).toHaveLength(1)
    expect(out.industries).toEqual([])
  })

  it('does not remember a failed industry read as "no industries"', async () => {
    const failing = crmStub({ byName: [], vocabFails: true })
    await searchCrmCompanies(failing.port, 'medical', 10)
    const working = crmStub({ byName: [], byIndustry: [company('c2', 'Star Medical', null)] })
    const out = await searchCrmCompanies(working.port, 'medical', 10)
    expect(out.industries).toEqual(['Medical Devices & Supplies'])
  })

  it('never asks the CRM for more than the caller wanted', async () => {
    const many = Array.from({ length: 30 }, (_, i) => company(`c${i}`, `Company ${i}`, null))
    const crm = crmStub({ byName: many })
    const out = await searchCrmCompanies(crm.port, 'company', 5)
    expect(out.companies).toHaveLength(5)
    expect(crm.queries.every((q) => q.limit === 5)).toBe(true)
    expect(out.truncated).toBe(true)
  })

  it('carries the CRM record own facts and fills in nothing', async () => {
    const crm = crmStub({ byName: [company('c1', 'Aaka Scientific', 'Medical Devices & Supplies')] })
    const out = await searchCrmCompanies(crm.port, 'Aaka', 10)
    expect(out.companies[0]).toMatchObject({
      website: 'https://c1.test/',
      industry: 'Medical Devices & Supplies',
      country: 'Malta',
    })
  })
})

// A COUNTRY NAMED IN THE SAME BREATH NARROWS THE INDUSTRY.
//
// "Industrial suppliers in Malta" is one request, not two: answering it with
// every industrial supplier on earth would be a wrong answer dressed as a
// generous one.
describe('matching typed words to CRM countries', () => {
  it('finds a country the phrase names', () => {
    expect(countriesMatching('industrial suppliers in Malta', COUNTRIES)).toEqual(['MALTA'])
  })

  it('finds a country written in several words', () => {
    expect(countriesMatching('hardware shops in south africa', COUNTRIES)).toEqual(['SOUTH AFRICA'])
  })

  it('claims no country the CRM spells differently', () => {
    // The CRM holds "UK". "United Kingdom" is the same place and a different
    // string, and inventing that equivalence is how a filter starts lying.
    expect(countriesMatching('plumbing suppliers in United Kingdom', COUNTRIES)).toEqual([])
  })

  it('is not fooled by a country name buried inside a word', () => {
    expect(countriesMatching('ukulele makers', COUNTRIES)).toEqual([])
  })

  it('narrows the industry search rather than standing on its own', async () => {
    const crm = crmStub({ byName: [], byIndustry: [company('c9', 'Attard Supplies', 'Dental Supplies')] })
    await searchCrmCompanies(crm.port, 'dental supplies in Malta', 10)
    const filtered = crm.queries.find((q) => q.industries?.length)
    expect(filtered?.countries).toEqual(['MALTA'])
  })

  it('does not filter by country alone, which would return a whole country', async () => {
    const crm = crmStub({ byName: [company('c1', 'Some Co', null)] })
    const out = await searchCrmCompanies(crm.port, 'Malta', 10)
    expect(crm.queries.every((q) => !q.countries)).toBe(true)
    expect(out.countries).toEqual([])
  })
})

// "IS THIS COMPANY IN THE CRM?" — A QUESTION WITH A YES OR NO ANSWER.
describe('the company a name names exactly', () => {
  const hit = (companyName: string) => ({
    crmCompanyId: companyName.toLowerCase().replace(/\W/g, ''),
    companyName,
    website: null,
    industry: null,
    country: null,
    matchedOn: 'name' as const,
  })

  it('picks out the record that carries the name', () => {
    const found = exactMatch('ACO Medical Supply', [hit('ACO Medical Supplies Ltd'), hit('ACO Medical Supply')])
    expect(found?.companyName).toBe('ACO Medical Supply')
  })

  it('ignores case and punctuation, as people type neither reliably', () => {
    expect(exactMatch('b&m limited', [hit('B&M Limited')])?.companyName).toBe('B&M Limited')
  })

  it('chooses nothing when two records carry the same name', () => {
    // Which of the two was meant is not something this can know.
    expect(exactMatch('Star Medical', [hit('Star Medical'), { ...hit('Star Medical'), crmCompanyId: 'other' }])).toBeNull()
  })

  it('chooses nothing on a near miss', () => {
    expect(exactMatch('ACO Medical Supply', [hit('ACO Medical Supplies Ltd')])).toBeNull()
  })
})

describe('reading one company from the CRM', () => {
  it('carries the record own values, and says when there is no website', async () => {
    const record = {
      ...company('c1', 'B&M Limited', 'Plumbing & PVF (Pipe, Valve, Fitting)'),
      domain: null,
      contactPersons: ['Joseph Borg - Director'],
      ownerName: 'Jency Karunanidhi',
      endPdpUrl: null,
      dealCount: 0,
      createdAt: '2026-01-04T00:00:00.000Z',
    }
    const port = { getCompany: async () => record } as never
    const out = await readCrmCompany(port, 'c1')
    expect(out).toMatchObject({
      crmCompanyId: 'c1',
      companyName: 'B&M Limited',
      website: null,
      contactPersons: ['Joseph Borg - Director'],
      ownerName: 'Jency Karunanidhi',
    })
    expect(out!.websiteNote, 'a blank must say why it is blank').toBeTruthy()
  })

  it('answers nothing for a company the CRM does not hold', async () => {
    const port = { getCompany: async () => null } as never
    expect(await readCrmCompany(port, 'missing')).toBeNull()
  })
})
