import { describe, expect, it } from 'vitest'
import { DEFAULT_QUOTAS, SAMPLE_SIZE, selectSample, seededRandom, type SampleCandidate } from '../../src/warmleads/sample.js'

// The representative test sample: fixed size, fixed seed, covers the cases the
// rule must handle, and says honestly what the CRM could not supply.

const COUNTRIES = ['USA', 'UK', 'Canada', 'Australia', 'South Africa', 'Ireland', 'Malta', 'UAE']
const INDUSTRIES = ['Fasteners', 'Tools', 'Electrical', 'Plumbing', 'Safety', 'Fluid Power', 'Janitorial', 'MRO']

function crm(n: number, over: (i: number) => Partial<SampleCandidate> = () => ({})): SampleCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${String(i).padStart(5, '0')}`,
    name: `Company ${i}`,
    // skewed like the real CRM: most companies are in the first two countries
    country: COUNTRIES[i % 10 < 4 ? 0 : i % 10 < 7 ? 1 : i % COUNTRIES.length]!,
    industry: INDUSTRIES[i % INDUSTRIES.length]!,
    website: 'website' as const,
    customer: false,
    openDeal: false,
    recentReply: false,
    ...over(i),
  }))
}

const richCrm = () =>
  crm(2000, (i) => ({
    // primes, so the rare companies land in every country rather than in one
    customer: i % 401 === 0,
    openDeal: i % 103 === 1,
    recentReply: i % 251 === 2,
    website: i % 151 === 3 ? 'none' : i % 191 === 4 ? 'social_only' : 'website',
  }))

describe('the seeded generator', () => {
  it('gives the same sequence for the same seed and a different one for another', () => {
    const a = seededRandom(20261031)
    const b = seededRandom(20261031)
    const c = seededRandom(7)
    const sa = Array.from({ length: 5 }, a)
    expect(Array.from({ length: 5 }, b)).toEqual(sa)
    expect(Array.from({ length: 5 }, c)).not.toEqual(sa)
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true)
  })
})

describe('selecting the sample', () => {
  it('is repeatable: the same seed picks the same companies, whatever order the CRM lists them in', () => {
    const data = richCrm()
    const a = selectSample(data, { seed: 20261031 })
    const b = selectSample([...data].reverse(), { seed: 20261031 })
    const shuffledOrder = [...data].sort((x, y) => (x.name.length - y.name.length) || (x.id < y.id ? 1 : -1))
    const c = selectSample(shuffledOrder, { seed: 20261031 })
    expect(b.picks.map((p) => p.id)).toEqual(a.picks.map((p) => p.id))
    expect(c.picks.map((p) => p.id)).toEqual(a.picks.map((p) => p.id))
    // and a different seed draws a different sample
    expect(selectSample(data, { seed: 99 }).picks.map((p) => p.id)).not.toEqual(a.picks.map((p) => p.id))
  })

  it('has the asked size, no company twice, and covers every kind it was asked to', () => {
    const r = selectSample(richCrm(), { seed: 20261031 })
    expect(r.size).toBe(SAMPLE_SIZE)
    expect(r.picks).toHaveLength(30)
    expect(new Set(r.picks.map((p) => p.id)).size).toBe(30)
    const filled = Object.fromEntries(r.coverage.map((c) => [c.stratum, c.filled]))
    expect(filled.customer).toBeGreaterThanOrEqual(DEFAULT_QUOTAS.customer)
    expect(filled.open_deal).toBeGreaterThanOrEqual(DEFAULT_QUOTAS.open_deal)
    expect(filled.recent_reply).toBeGreaterThanOrEqual(DEFAULT_QUOTAS.recent_reply)
    expect(filled.no_website).toBeGreaterThanOrEqual(DEFAULT_QUOTAS.no_website)
    expect(r.notes).toEqual([])
    // a pick says what it stands for
    const reply = r.picks.find((p) => p.pickedFor === 'recent_reply')!
    expect(reply.strata).toContain('recent_reply')
  })

  it('spreads over countries and industries instead of mirroring the CRM\'s skew toward its biggest country', () => {
    const r = selectSample(richCrm(), { seed: 20261031 })
    expect(r.countries).toBe(COUNTRIES.length) // every country appears
    expect(r.industries).toBe(INDUSTRIES.length)
    const biggest = Math.max(...COUNTRIES.map((c) => r.picks.filter((p) => p.country === c).length))
    expect(biggest).toBeLessThanOrEqual(6) // 30 picks over 8 countries; a proportional draw would put ~12 in one
  })

  it('treats "South Africa" and "SOUTH AFRICA" as one country', () => {
    const r = selectSample(crm(200, (i) => ({ country: i % 2 ? 'South Africa' : 'SOUTH AFRICA', industry: 'Tools' })), { seed: 1 })
    expect(r.countries).toBe(1)
  })

  it('says plainly what the CRM could not supply, and does not pad it', () => {
    // no company has a recent reply, only one is a customer
    const r = selectSample(crm(500, (i) => ({ customer: i === 7, openDeal: i % 50 === 1 })), { seed: 20261031 })
    expect(r.picks).toHaveLength(30)
    const cov = Object.fromEntries(r.coverage.map((c) => [c.stratum, c]))
    expect(cov.recent_reply).toMatchObject({ filled: 0, available: 0, wanted: 4 })
    expect(cov.customer).toMatchObject({ filled: 1, available: 1, wanted: 3 })
    expect(r.notes.join(' ')).toMatch(/No company in the candidates has a reply from a person in the last 90 days/)
    expect(r.notes.join(' ')).toMatch(/Only 1 of 3 wanted could be included: only 1 candidate\(s\) have an existing customer/)
    // nobody was invented for the empty kinds
    expect(r.picks.filter((p) => p.strata.includes('recent_reply'))).toHaveLength(0)
  })

  it('a company that is both rare and common is spent on the rare kind first', () => {
    // exactly one customer, and that customer also has an open deal and a recent reply
    const r = selectSample(crm(300, (i) => (i === 5 ? { customer: true, openDeal: true, recentReply: true } : {})), { seed: 3 })
    const p = r.picks.find((x) => x.id === 'c00005')!
    expect(p.strata).toEqual(expect.arrayContaining(['customer', 'open_deal', 'recent_reply']))
    expect(r.coverage.find((c) => c.stratum === 'customer')!.filled).toBe(1)
    expect(r.coverage.find((c) => c.stratum === 'recent_reply')!.filled).toBe(1)
  })

  it('a small CRM gives a smaller sample and says so', () => {
    const r = selectSample(crm(12), { seed: 1 })
    expect(r.picks).toHaveLength(12)
    expect(r.notes.join(' ')).toMatch(/Only 12 companies were available for a sample of 30/)
  })
})
