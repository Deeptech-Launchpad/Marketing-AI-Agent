import { describe, expect, it } from 'vitest'
import { applyFallbackPolicy, matchRole } from '../../src/decisionmakers/roleTaxonomy.js'
import { isSufficient, providerNames } from '../../src/decisionmakers/discovery.js'
import type { ScoredCandidate } from '../../src/decisionmakers/types.js'

// Team Answer, Sections A.3, E.1–E.5 — the confirmed buyer and provider policy.
//
// These tests exist to stop the business rules drifting back. Each one names
// the decision it protects, so a future change that breaks it has to argue
// with the decision rather than with the assertion.

// ── 1. THE APPROVED BUYER TIERS ────────────────────────────────────────────

describe('buyer policy — the confirmed P1/P2/P3 tiers', () => {
  it('puts every named direct buyer in P1', () => {
    for (const title of [
      'Ecommerce Manager',
      'Catalog Manager',
      'Product Data Manager',
      'Digital Commerce Manager',
      'Merchandising Manager',
      'Category Manager',
    ]) {
      const m = matchRole(title)
      expect(m?.priority, title).toBe(1)
      expect(m?.isFallback, title).toBe(false)
    }
  })

  it('puts every named strong influencer in P2', () => {
    for (const title of [
      'IT Manager',
      'Business Systems Manager',
      'Product Manager',
      'Digital Product Manager',
      'Marketing Operations Manager',
      'Data Analytics Manager',
    ]) {
      const m = matchRole(title)
      expect(m?.priority, title).toBe(2)
      expect(m?.isFallback, title).toBe(false)
    }
  })

  it('marks the executive sponsors as fallback, never as buyers', () => {
    for (const title of ['Owner', 'Founder', 'General Manager', 'Managing Director', 'VP Sales', 'VP Marketing']) {
      const m = matchRole(title)
      expect(m?.priority, title).toBe(3)
      expect(m?.isFallback, title).toBe(true)
    }
  })

  it('reads the ways About pages write Founder as the founder fallback', () => {
    for (const title of ['founding entrepreneur', 'Founding Director', 'Co-Founder', 'cofounder', 'Founding Partner']) {
      const m = matchRole(title)
      expect(m?.matchedFunction, title).toBe('founder')
      expect(m?.isFallback, title).toBe(true)
      expect(m?.seniority, title).toBe('c_level')
    }
  })

  it('does not treat a founding member of a team as the company founder', () => {
    expect(matchRole('Founding Engineer')).toBeNull()
    expect(matchRole('founding member')).toBeNull()
  })

  it('still refuses a senior title with no relevant function', () => {
    // The rule that survived the retiering: seniority ranks, it never qualifies.
    expect(matchRole('Chief Financial Officer')).toBeNull()
    expect(matchRole('VP of Human Resources')).toBeNull()
    expect(matchRole('Director of Facilities')).toBeNull()
    expect(matchRole('Director')).toBeNull()
  })

  it('does not promote a vice president to C-level via the word "president"', () => {
    expect(matchRole('VP Ecommerce')?.seniority).toBe('vp')
    expect(matchRole('President')?.seniority).toBe('c_level')
  })
})

// ── 2. THE FALLBACK IS A COMPANY DECISION ──────────────────────────────────

describe('fallback policy — Owner/GM only where no specialist exists', () => {
  const c = (title: string) => ({ title, role: matchRole(title) })
  const roleOf = (x: { role: ReturnType<typeof matchRole> }) => x.role

  it('suppresses the sponsor when the company has a specialist', () => {
    const d = applyFallbackPolicy([c('Product Data Manager'), c('Managing Director'), c('VP Sales')], roleOf)
    expect(d.fallbackUsed).toBe(false)
    expect(d.eligible.map((x) => x.title)).toEqual(['Product Data Manager'])
    expect(d.suppressed).toHaveLength(2)
    expect(d.reason).toMatch(/specialist role\(s\) were found/)
  })

  it('uses the sponsor at a small company with no specialist', () => {
    const d = applyFallbackPolicy([c('Managing Director'), c('Owner')], roleOf)
    expect(d.fallbackUsed).toBe(true)
    expect(d.eligible).toHaveLength(2)
    expect(d.suppressed).toHaveLength(0)
  })

  it('reports honestly when there is nobody at all', () => {
    const d = applyFallbackPolicy([c('Director of Facilities')], roleOf)
    expect(d.fallbackUsed).toBe(false)
    expect(d.reason).toMatch(/No specialist role and no executive-sponsor fallback/)
  })

  it('keeps a P2 influencer as a specialist, so it blocks the fallback', () => {
    // An IT Manager is a real influencer under the approved policy, so a
    // company that has one does not need the Owner.
    const d = applyFallbackPolicy([c('IT Manager'), c('Owner')], roleOf)
    expect(d.fallbackUsed).toBe(false)
    expect(d.eligible.map((x) => x.title)).toEqual(['IT Manager'])
  })
})

// ── 3. THE APPROVED PROVIDER ORDER AND ESCALATION ──────────────────────────

describe('provider chain — approved order and automatic escalation', () => {
  it('runs the approved order: CRM-held data first, paid sources next, AI search last', () => {
    const names = providerNames()
    const at = (n: string) => names.findIndex((x) => x.includes(n))

    // Sections E.4/E.5: what the CRM already holds costs nothing and is used
    // before anything is bought.
    expect(at('crm')).toBeLessThan(at('apollo'))
    expect(at('linkedin')).toBeLessThan(at('apollo'))

    // Section A.3: Apollo -> ZoomInfo -> RocketReach.
    expect(at('apollo')).toBeLessThan(at('zoominfo'))
    expect(at('zoominfo')).toBeLessThan(at('rocketreach'))

    // "AI-assisted web search as a last resort" — mechanically last.
    //
    // Matched on the exact name rather than a substring: there are now two
    // web-shaped sources, and `includes('web')` found the first of them. The
    // company's own site is read before the open web is searched, because a
    // company is the authority on its own staff and a trade article is not.
    expect(names.indexOf('company_website')).toBeLessThan(names.indexOf('public_web_research'))
    expect(names[names.length - 1]).toBe('public_web_research')
  })

  const candidate = (over: Partial<ScoredCandidate>): ScoredCandidate =>
    ({
      identityKey: 'k',
      fullName: 'A Person',
      rawTitle: 'Ecommerce Manager',
      normalizedTitle: 'ecommerce manager',
      roleGroup: 'Ecommerce',
      rolePriority: 1,
      roleIsFallback: false,
      seniority: 'manager',
      statedCompany: 'Acme',
      profileUrl: null,
      email: 'a@acme.com',
      phone: null,
      location: null,
      companyMatch: 'verified',
      companyMatchReasons: [],
      confidence: 'high',
      confidenceReasons: [],
      corroboratingProviders: ['apollo'],
      contactability: 'contactable',
      rankScore: 80,
      rankReasons: [],
      evidence: [],
      ...over,
    }) as ScoredCandidate

  // WHAT THIS PREDICATE IS NOW. It used to gate the provider chain, and that
  // made it a CRM-first-stop: a company whose NXT Sales record named one buyer
  // never reached Apollo, Hunter or the open web. Every provider runs now, and
  // this reads the FINISHED result — "did the run find someone worth acting
  // on" — rather than deciding whether to keep looking.
  it('is satisfied by a matched, relevant, reachable specialist', () => {
    expect(isSufficient([candidate({})])).toBe(true)
  })

  it('is not satisfied when the person cannot be placed at the company', () => {
    expect(isSufficient([candidate({ companyMatch: 'unverified' })])).toBe(false)
  })

  it('is not satisfied when the only match is the executive fallback', () => {
    // Falling back is what you do when the sources came back empty. It does
    // not make the run a success.
    expect(isSufficient([candidate({ rolePriority: 3, roleIsFallback: true })])).toBe(false)
  })

  it('is not satisfied when there is no way to make contact', () => {
    expect(isSufficient([candidate({ contactability: 'none', email: null })])).toBe(false)
  })

  it('is not satisfied on thin evidence', () => {
    expect(isSufficient([candidate({ confidence: 'low' })])).toBe(false)
  })

  it('does not let seniority alone count as a result', () => {
    // A senior person with no relevant function is not a decision maker for
    // product data, whatever their title says.
    expect(isSufficient([candidate({ rolePriority: null, roleIsFallback: false, seniority: 'c_level' })])).toBe(false)
  })

  it('accepts a P2 influencer as sufficient', () => {
    expect(isSufficient([candidate({ rolePriority: 2, roleGroup: 'IT' })])).toBe(true)
  })
})
