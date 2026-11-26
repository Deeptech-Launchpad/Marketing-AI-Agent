import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isZone, ZONE_LABELS, ZONES, zoneOf } from '../../src/warmleads/zones.js'
import { reasonsForCrm } from '../../src/warmleads/reasonsPublic.js'

// ZONES (owner 2026-11-26): the ~15,000 NXT Sales companies are worked through one region at a time, from each company's country.

describe('zoneOf: a country to its zone, never guessed', () => {
  it('the six zones, from names, ISO codes and common spellings', () => {
    const cases: Array<[string, string]> = [
      ['India', 'india'], ['IN', 'india'], ['IND', 'india'], ['india ', 'india'],
      ['United Arab Emirates', 'middle_east'], ['UAE', 'middle_east'], ['U.A.E.', 'middle_east'], ['Saudi Arabia', 'middle_east'], ['KSA', 'middle_east'], ['Qatar', 'middle_east'], ['Oman', 'middle_east'],
      ['United Kingdom', 'europe'], ['UK', 'europe'], ['GB', 'europe'], ['Germany', 'europe'], ['The Netherlands', 'europe'], ['Türkiye', 'middle_east'],
      ['United States', 'north_america'], ['USA', 'north_america'], ['U.S.A.', 'north_america'], ['United States of America', 'north_america'], ['Canada', 'north_america'], ['Mexico', 'north_america'],
      ['Singapore', 'asia_pacific'], ['Australia', 'asia_pacific'], ['Japan', 'asia_pacific'], ['Sri Lanka', 'asia_pacific'], ['Bangladesh', 'asia_pacific'],
      ['Brazil', 'rest_of_world'], ['South Africa', 'rest_of_world'], ['Nigeria', 'rest_of_world'], ['Côte', 'unknown'],
    ]
    for (const [country, zone] of cases) expect(zoneOf(country), country).toBe(zone)
  })

  it('a city or office note around the country still finds it ("Mumbai, India", "Dubai - UAE")', () => {
    expect(zoneOf('Mumbai, India')).toBe('india')
    expect(zoneOf('Dubai - UAE')).toBe('middle_east')
    expect(zoneOf('Head office (Germany)')).toBe('europe')
  })

  it('empty, unknown or nonsense is "unknown", and a short word inside a phrase is never taken as a country code', () => {
    for (const v of [null, undefined, '', '   ', '-', 'N/A', 'Atlantis', '12345', 'made in']) expect(zoneOf(v as string | null), String(v)).toBe('unknown')
  })

  it('every zone has a label; isZone accepts only the known zones', () => {
    for (const z of ZONES) expect(ZONE_LABELS[z]).toBeTruthy()
    expect(isZone('india')).toBe(true)
    for (const v of ['India', 'mars', '', null, 3]) expect(isZone(v)).toBe(false)
  })
})

describe('what NXT Sales may see of a company\'s reasons', () => {
  it('the private opt-out lines are left out, "contact opted out" is kept without any address, and the fingerprint never goes', () => {
    const out = reasonsForCrm([
      { signal: 'contact_opt_out', summary: 'A contact opted out', evidence: '1 opt-out message(s); r***@acme.example, s***@acme.example' },
      { signal: 'opt_out_proposal', summary: 'r***@acme.example is PROPOSED', evidence: 'NXT activity act_1 · fp 0123456789abcdef · key 89abcdef' },
      { signal: 'opt_out_not_recorded', summary: 'x', evidence: 'NXT activity act_2' },
      { signal: 'opt_out_omitted', summary: 'x', evidence: 'omitted proposals: 3' },
      { signal: 'reconsent_candidate', summary: 'x', evidence: 'x' },
      { signal: 'news', summary: 'New warehouse', evidence: 'press release', sourceUrl: 'https://news.example/a' },
    ]) as Array<{ signal: string; evidence: string }>
    expect(out.map((r) => r.signal)).toEqual(['contact_opt_out', 'news'])
    const text = JSON.stringify(out)
    for (const s of ['@acme.example', 'act_1', 'act_2', '0123456789abcdef', '89abcdef', 'PROPOSED']) expect(text, s).not.toContain(s)
    expect(out[0]!.evidence).toMatch(/asked not to receive marketing email/)
  })

  it('anything that is not a list is returned as it is', () => {
    expect(reasonsForCrm(null)).toBeNull()
    expect(reasonsForCrm('x' as never)).toBe('x')
  })
})

describe('new companies come only from the chosen zone (SOURCE SCAN of the claim query)', () => {
  it('the pending claim filters on the zone, and retries are not limited by it', () => {
    const src = fs.readFileSync(path.resolve('src/warmleads/companies.ts'), 'utf8')
    const pending = src.slice(src.indexOf("kind === 'pending'"), src.indexOf(': await prisma.$queryRaw<ClaimedRow[]>`', src.indexOf("kind === 'pending'") + 20))
    expect(pending).toMatch(/AND \(\$\{anyZone\} OR "zone" = \$\{zone \?\? ''\}\)/)
    const retry = src.slice(src.indexOf("\"state\" IN ('failed', 'needs_reevaluation')") - 300, src.indexOf("\"state\" IN ('failed', 'needs_reevaluation')") + 300)
    expect(retry).not.toMatch(/"zone"/)
  })
  it('the worker passes the admin\'s zone, read at every claim', () => {
    const src = fs.readFileSync(path.resolve('src/warmleads/workerLoop.ts'), 'utf8')
    expect(src).toMatch(/select: \{ activeZone: true \}/)
    expect(src).toMatch(/isZone\(s\?\.activeZone\) \? s\.activeZone : null/)
  })
})
