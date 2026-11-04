import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmCompany } from '../../src/crm/types.js'

// Findings from the independent review of the pilot sample, each with its own test:
//   - a company listed twice by the live CRM (offset paging) must give the same sample whichever copy came first, and be picked once;
//   - industries are balanced together with countries (country alone left whole industries out);
//   - what the build knew about its own bias (list cut off, emails unreadable, repeated records) is said in the notes;
//   - the pilot is exactly what the sample picked, never silently fewer.
// The CRM is a fake; nothing touches a network or database.

const crmState = vi.hoisted(() => ({
  companies: [] as unknown[],
  failEmails: false,
}))

vi.mock('../../src/platform/db.js', () => ({ prisma: {}, newId: () => 'id' }))
vi.mock('../../src/crm/index.js', () => ({
  getCrm: () => ({
    searchCompanies: async (q: { page?: number; limit?: number; lastActivity?: string }) => {
      const limit = q.limit ?? 500
      const page = q.page ?? 1
      const pool = q.lastActivity ? crmState.companies.slice(0, 60) : crmState.companies
      return { items: pool.slice((page - 1) * limit, page * limit), total: pool.length }
    },
    exportDeals: async () => [],
    listActivities: async () => {
      if (crmState.failEmails) throw new Error('NXT Sales did not answer')
      return []
    },
  }),
}))

const { buildSample, dedupeById, selectSample } = await import('../../src/warmleads/sample.js')

const company = (i: number, over: Partial<CrmCompany> = {}): CrmCompany =>
  ({
    id: `c${String(i).padStart(5, '0')}`,
    name: `Company ${i}`,
    email: null,
    emails: [],
    phone: null,
    domain: `company${i}.example`,
    industry: `Industry ${i % 8}`,
    country: `Country ${i % 12}`,
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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as CrmCompany

beforeEach(() => {
  crmState.failEmails = false
  crmState.companies = Array.from({ length: 400 }, (_, i) => company(i))
})

describe('a company that the CRM lists twice', () => {
  it('keeps one copy, chosen without regard to listing order', () => {
    const old = company(7, { country: 'Old Country', updatedAt: '2026-01-01T00:00:00Z' })
    const fresh = company(7, { country: 'New Country', updatedAt: '2026-06-01T00:00:00Z' })
    const a = dedupeById([old, company(1), fresh])
    const b = dedupeById([fresh, company(1), old])
    expect(a).toHaveLength(2)
    expect(a.find((c) => c.id === 'c00007')!.country).toBe('New Country')
    expect(b.find((c) => c.id === 'c00007')!.country).toBe('New Country')
    // identical timestamps: the tie is broken by content, not by position
    const x = company(9, { country: 'A' })
    const y = company(9, { country: 'B' })
    expect(dedupeById([x, y])[0]!.country).toBe(dedupeById([y, x])[0]!.country)
  })

  it('buildSample gives the same 100 picks whatever copy came first, each company once, and says it ignored the repeats', async () => {
    const base = Array.from({ length: 400 }, (_, i) => company(i))
    const dup = [company(5, { country: 'Somewhere Else', updatedAt: '2025-01-01T00:00:00Z' }), company(250, { industry: 'Other', updatedAt: '2025-01-01T00:00:00Z' })]

    crmState.companies = [...dup, ...base]
    const one = await buildSample({ seed: 20261031, size: 100 })
    crmState.companies = [...base, ...dup]
    const two = await buildSample({ seed: 20261031, size: 100 })
    crmState.companies = [...base].reverse().concat(dup)
    const three = await buildSample({ seed: 20261031, size: 100 })

    const ids = (r: typeof one) => r.sample.picks.map((p) => p.id)
    expect(ids(one)).toHaveLength(100)
    expect(new Set(ids(one)).size).toBe(100)
    expect(ids(two)).toEqual(ids(one))
    expect(ids(three)).toEqual(ids(one))
    expect(one.sample.notes.join(' ')).toMatch(/2 repeated company record/)
    expect(one.sample.pool.companies).toBe(400) // the repeats are not counted as companies
  })
})

describe('the sample is exactly the asked size', () => {
  it('100 usable companies give exactly 100; a CRM with fewer gives all of them and says so', async () => {
    crmState.companies = Array.from({ length: 100 }, (_, i) => company(i))
    const exact = await buildSample({ seed: 1, size: 100 })
    expect(exact.sample.picks).toHaveLength(100)
    expect(exact.sample.notes.join(' ')).not.toMatch(/Only \d+ companies were available/)

    crmState.companies = Array.from({ length: 60 }, (_, i) => company(i))
    const few = await buildSample({ seed: 1, size: 100 })
    expect(few.sample.picks).toHaveLength(60)
    expect(few.sample.notes.join(' ')).toMatch(/Only 60 companies were available for a sample of 100/)
  })

  it('companies with no name are never picked', async () => {
    crmState.companies = [...Array.from({ length: 150 }, (_, i) => company(i)), company(900, { name: '   ' }), company(901, { name: '' })]
    const r = await buildSample({ seed: 3, size: 100 })
    expect(r.sample.picks.map((p) => p.id)).not.toContain('c00900')
    expect(r.sample.picks.map((p) => p.id)).not.toContain('c00901')
  })
})

describe('what the build knows about its own bias is reported', () => {
  it('emails that could not be read are named, not silently treated as "no reply"', async () => {
    crmState.failEmails = true
    const r = await buildSample({ seed: 20261031, size: 100 })
    expect(r.sample.pool.emailReadFailures).toBeGreaterThan(0)
    expect(r.sample.notes.join(' ')).toMatch(/emails of \d+ companies could not be read/)
  })

  it('a company list that was cut off is named', async () => {
    // 20,100 companies: the reader stops after its page limit and says the list was cut off.
    crmState.companies = Array.from({ length: 20_100 }, (_, i) => company(i))
    const r = await buildSample({ seed: 20261031, size: 100 })
    expect(r.sample.pool.listTruncated).toBe(true)
    expect(r.sample.notes.join(' ')).toMatch(/list was cut off/)
  })
})

describe('industries are covered as well as countries', () => {
  // The review's own example: plenty of countries that all share one industry, and one country with many industries.
  const candidates = [
    ...Array.from({ length: 200 }, (_, i) => ({ id: `a${String(i).padStart(3, '0')}`, name: `A${i}`, country: `Country ${i % 40}`, industry: 'Only', website: 'website' as const, customer: false, openDeal: false, recentReply: false })),
    ...Array.from({ length: 200 }, (_, i) => ({ id: `b${String(i).padStart(3, '0')}`, name: `B${i}`, country: 'One Country', industry: `Industry ${i % 20}`, website: 'website' as const, customer: false, openDeal: false, recentReply: false })),
  ]

  it('no longer leaves most industries out when countries are plentiful', () => {
    const r = selectSample(candidates, { seed: 20261031, size: 100 })
    expect(r.picks).toHaveLength(100)
    // before the change this picked 41 countries but only 4 industries
    expect(r.industries).toBeGreaterThanOrEqual(15)
    expect(r.countries).toBeGreaterThanOrEqual(20)
  })

  it('is still repeatable and still has no duplicate', () => {
    const a = selectSample(candidates, { seed: 20261031, size: 100 })
    const b = selectSample([...candidates].reverse(), { seed: 20261031, size: 100 })
    expect(b.picks.map((p) => p.id)).toEqual(a.picks.map((p) => p.id))
    expect(new Set(a.picks.map((p) => p.id)).size).toBe(100)
  })
})
