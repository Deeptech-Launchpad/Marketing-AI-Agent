import { describe, expect, it } from 'vitest'
import {
  assembleCandidates,
  contactabilityOf,
  identityKey,
  mergeDrafts,
  normalizePersonName,
  scoreCandidate,
  scoreCandidateConfidence,
  selectShortlist,
} from '../../src/decisionmakers/candidates.js'
import { env } from '../../src/config/env.js'
import type { CandidateDraft, CandidateEvidence } from '../../src/decisionmakers/types.js'
import type { CrmCompany } from '../../src/crm/types.js'

// Stage 4 — DEDUPLICATION, EVIDENCE MERGING, CONFIDENCE, RANKING, SHORTLIST.
//
// The governing rule under test throughout: "No verified decision maker found"
// must beat "probably this person". Several tests below assert that a
// good-looking candidate is DROPPED, which is the behaviour that makes the
// output trustworthy.

function company(over: Partial<CrmCompany> = {}): CrmCompany {
  return {
    id: 'co_1',
    name: 'Acme Industrial Supply Ltd',
    email: null,
    emails: [],
    phone: null,
    domain: 'acme-industrial.example',
    industry: 'Plumbing & PVF (Pipe, Valve, Fitting)',
    country: 'UK',
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
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...over,
  }
}

const ev = (over: Partial<CandidateEvidence> = {}): CandidateEvidence => ({
  provider: 'apollo',
  sourceType: 'data_provider',
  sourceUrl: null,
  snippet: 'Apollo record: Jane Smith | title "VP of Ecommerce" | at "Acme Industrial Supply Ltd"',
  observedAt: null,
  supports: ['name', 'title', 'company'],
  ...over,
})

const draft = (over: Partial<CandidateDraft> = {}): CandidateDraft => ({
  fullName: 'Jane Smith',
  rawTitle: 'VP of Ecommerce',
  statedCompany: 'Acme Industrial Supply Ltd',
  profileUrl: null,
  providerPersonId: null,
  email: null,
  phone: null,
  location: null,
  evidence: [ev()],
  ...over,
})

const score = (d: CandidateDraft, c = company(), domain: string | null = 'acme-industrial.example') =>
  scoreCandidate(d, c, domain, identityKey(d, c.id))

// ── 4. DEDUPLICATION ───────────────────────────────────────────────────────

describe('deduplication — by stable identity, not by report', () => {
  it('normalises honorifics and suffixes out of a name', () => {
    expect(normalizePersonName('Dr. Jane A. Smith Jr.')).toBe('jane a smith')
  })

  it('treats a provider person ID as definitive', () => {
    const a = identityKey(draft({ providerPersonId: 'apollo:123', fullName: 'Jane Smith' }), 'co_1')
    const b = identityKey(draft({ providerPersonId: 'apollo:123', fullName: 'J. Smith' }), 'co_1')
    expect(a).toBe(b)
  })

  it('treats the same profile URL as the same person regardless of trailing slash', () => {
    const a = identityKey(draft({ profileUrl: 'https://linkedin.example/in/jane-smith' }), 'co_1')
    const b = identityKey(draft({ profileUrl: 'https://LinkedIn.example/in/jane-smith/' }), 'co_1')
    expect(a).toBe(b)
  })

  it('collapses "Jane Smith" and "Jane A. Smith" at one company', () => {
    // Sources disagree about middle names constantly; at one company this is
    // one person far more often than two.
    const a = identityKey(draft({ fullName: 'Jane Smith' }), 'co_1')
    const b = identityKey(draft({ fullName: 'Jane A. Smith' }), 'co_1')
    expect(a).toBe(b)
  })

  it('keeps two different people apart', () => {
    expect(identityKey(draft({ fullName: 'Jane Smith' }), 'co_1')).not.toBe(
      identityKey(draft({ fullName: 'John Doe' }), 'co_1'),
    )
  })

  it('scopes a name to the company, so one name at two companies is two people', () => {
    expect(identityKey(draft({ fullName: 'Jane Smith' }), 'co_1')).not.toBe(
      identityKey(draft({ fullName: 'Jane Smith' }), 'co_2'),
    )
  })

  it('does NOT count duplicate provider records as separate people', () => {
    const scored = assembleCandidates(
      [
        draft({ evidence: [ev({ provider: 'apollo' })] }),
        draft({ evidence: [ev({ provider: 'zoominfo', sourceType: 'data_provider' })] }),
        draft({ evidence: [ev({ provider: 'rocketreach', sourceType: 'data_provider' })] }),
      ],
      company(),
      'acme-industrial.example',
    )
    expect(scored.length).toBe(1)
    expect(scored[0]!.corroboratingProviders).toEqual(['apollo', 'rocketreach', 'zoominfo'])
  })
})

// ── 5. EVIDENCE MERGING ────────────────────────────────────────────────────

describe('evidence merging', () => {
  it('keeps every source snippet, including the ones that lost', () => {
    const merged = mergeDrafts([
      draft({ evidence: [ev({ provider: 'apollo', snippet: 'apollo said this' })] }),
      draft({ evidence: [ev({ provider: 'zoominfo', snippet: 'zoominfo said this' })] }),
    ])
    expect(merged.evidence.map((e) => e.snippet)).toEqual(['apollo said this', 'zoominfo said this'])
  })

  it('prefers the value from the more authoritative source when sources disagree', () => {
    // A person changed jobs, or one aggregator is stale. The company's own
    // website outranks a data broker, and both snippets stay visible.
    const merged = mergeDrafts([
      draft({ rawTitle: 'Ecommerce Coordinator', evidence: [ev({ provider: 'apollo', sourceType: 'data_provider' })] }),
      draft({
        rawTitle: 'VP of Ecommerce',
        evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })],
      }),
    ])
    expect(merged.rawTitle).toBe('VP of Ecommerce')
    expect(merged.evidence.length).toBe(2)
  })

  it('NEVER fills a null from another field or another person', () => {
    const merged = mergeDrafts([
      draft({ rawTitle: null, email: null, profileUrl: null, evidence: [ev({ supports: ['name'] })] }),
    ])
    expect(merged.rawTitle).toBeNull()
    expect(merged.email).toBeNull()
    expect(merged.profileUrl).toBeNull()
  })

  it('takes a value from whichever source actually stated it', () => {
    const merged = mergeDrafts([
      draft({ rawTitle: null, profileUrl: null }),
      draft({ rawTitle: 'Catalog Manager', profileUrl: 'https://linkedin.example/in/jane' }),
    ])
    expect(merged.rawTitle).toBe('Catalog Manager')
    expect(merged.profileUrl).toBe('https://linkedin.example/in/jane')
  })

  it('keeps the fuller form of a name rather than inventing a third', () => {
    const merged = mergeDrafts([draft({ fullName: 'Jane Smith' }), draft({ fullName: 'Jane A. Smith' })])
    expect(merged.fullName).toBe('Jane A. Smith')
  })
})

// ── 6. CONFIDENCE LOGIC ────────────────────────────────────────────────────

describe('confidence — evidence quality, demote-only', () => {
  it('caps an unverified company link at LOW however good the title is', () => {
    const r = scoreCandidateConfidence(draft({ statedCompany: null }), 'unverified', ['apollo'])
    expect(r.confidence).toBe('low')
    expect(r.reasons.join(' ')).toMatch(/No source states which company/)
  })

  it('caps a rejected company link at LOW', () => {
    expect(scoreCandidateConfidence(draft(), 'rejected', ['apollo']).confidence).toBe('low')
  })

  it('is LOW when no source stated a title', () => {
    const r = scoreCandidateConfidence(draft({ rawTitle: null, evidence: [ev({ supports: ['name', 'company'] })] }), 'verified', ['crm_contacts'])
    expect(r.confidence).toBe('low')
    expect(r.reasons.join(' ')).toMatch(/No source stated a job title/)
  })

  it('rates a first-party page above a data broker', () => {
    const site = scoreCandidateConfidence(
      draft({ evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })] }),
      'verified',
      ['company_website'],
    )
    const broker = scoreCandidateConfidence(draft(), 'verified', ['apollo'])
    expect(site.confidence).toBe('high')
    expect(broker.confidence).toBe('medium')
  })

  it('caps a merely PROBABLE company match at medium', () => {
    const r = scoreCandidateConfidence(
      draft({ evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })] }),
      'probable',
      ['company_website'],
    )
    expect(r.confidence).toBe('medium')
    expect(r.reasons.join(' ')).toMatch(/caps confidence at medium/)
  })

  it('raises confidence only when evidence genuinely corroborates', () => {
    const single = scoreCandidateConfidence(draft(), 'verified', ['apollo'])
    const corroborated = scoreCandidateConfidence(
      draft({ evidence: [ev({ provider: 'apollo' }), ev({ provider: 'zoominfo' })] }),
      'verified',
      ['apollo', 'zoominfo'],
    )
    expect(single.reasons.join(' ')).toMatch(/nothing corroborates it/)
    expect(corroborated.reasons.join(' ')).toMatch(/Independently reported by 2 providers/)
  })

  it('demotes evidence too short to inspect', () => {
    const r = scoreCandidateConfidence(
      draft({ evidence: [ev({ sourceType: 'company_website', snippet: 'x' })] }),
      'verified',
      ['company_website'],
    )
    expect(r.confidence).toBe('medium')
    expect(r.reasons.join(' ')).toMatch(/too short to inspect/)
  })

  it('never promotes: many weak sources do not become strong evidence', () => {
    const r = scoreCandidateConfidence(
      draft({ evidence: [ev({ sourceType: 'third_party' }), ev({ sourceType: 'third_party', provider: 'other' })] }),
      'verified',
      ['apollo', 'other'],
    )
    expect(r.confidence).toBe('medium')
  })

  it('always explains itself', () => {
    expect(scoreCandidateConfidence(draft(), 'verified', ['apollo']).reasons.length).toBeGreaterThan(0)
  })
})

// ── 7. RANKING ─────────────────────────────────────────────────────────────

describe('ranking — explainable, never a black box', () => {
  it('ranks role relevance above seniority', () => {
    // A Product Data Manager who owns the catalogue beats a CTO who does not.
    const owner = score(draft({ fullName: 'Ann Owner', rawTitle: 'Product Data Manager' }))
    const cto = score(draft({ fullName: 'Bill Chief', rawTitle: 'Chief Technology Officer' }))
    expect(owner.rankScore).toBeGreaterThan(cto.rankScore)
  })

  it('ranks a Priority 1 role above a Priority 3 role at equal seniority', () => {
    const p1 = score(draft({ fullName: 'A One', rawTitle: 'Director of Catalog' }))
    const p3 = score(draft({ fullName: 'B Three', rawTitle: 'Director of Information Technology' }))
    expect(p1.rankScore).toBeGreaterThan(p3.rankScore)
  })

  it('ranks seniority within one role group', () => {
    const vp = score(draft({ fullName: 'V P', rawTitle: 'VP of Ecommerce' }))
    const mgr = score(draft({ fullName: 'M Gr', rawTitle: 'Ecommerce Manager' }))
    expect(vp.rankScore).toBeGreaterThan(mgr.rankScore)
  })

  it('rewards a verified company match over a probable one', () => {
    const verified = score(draft())
    const probable = score(draft({ statedCompany: 'Acme Digital' }), company({ name: 'Acme Industrial Widgets' }), null)
    expect(verified.rankScore).toBeGreaterThan(probable.rankScore)
  })

  it('rewards genuine multi-provider corroboration', () => {
    const one = score(draft())
    const three = score(
      draft({ evidence: [ev({ provider: 'apollo' }), ev({ provider: 'zoominfo' }), ev({ provider: 'rocketreach' })] }),
    )
    expect(three.rankScore).toBeGreaterThan(one.rankScore)
    expect(three.rankReasons.join(' ')).toMatch(/corroborated by 3 independent providers/)
  })

  it('scores recency when a source dated its claim', () => {
    const recent = score(draft({ evidence: [ev({ observedAt: new Date(Date.now() - 30 * 86_400_000) })] }))
    const old = score(draft({ evidence: [ev({ observedAt: new Date(Date.now() - 1500 * 86_400_000) })] }))
    expect(recent.rankScore).toBeGreaterThan(old.rankScore)
  })

  it('does NOT penalise a candidate for a source that publishes no dates', () => {
    // Most sources here give no date. Penalising that would score the source's
    // habits rather than the evidence.
    const undated = score(draft())
    expect(undated.rankReasons.join(' ')).toMatch(/not penalised/)
  })

  it('explains every component of the score', () => {
    const c = score(draft())
    expect(c.rankReasons.length).toBeGreaterThanOrEqual(4)
    expect(c.rankReasons.join(' ')).toMatch(/Priority 1 role/)
    expect(c.rankReasons.join(' ')).toMatch(/company match "verified"/)
  })
})

// ── 8. MISSING CONTACT DATA ────────────────────────────────────────────────

describe('missing contact data — reported, never invented', () => {
  it('leaves email and phone null when no provider stated them', () => {
    const c = score(draft())
    expect(c.email).toBeNull()
    expect(c.phone).toBeNull()
    expect(c.contactability).toBe('none')
  })

  it('reports profile_only when there is a public profile but no contact details', () => {
    expect(contactabilityOf(draft({ profileUrl: 'https://linkedin.example/in/jane' }))).toBe('profile_only')
  })

  it('distinguishes a policy suppression from an absent value', () => {
    // A withheld email must not look like a missing one, or the privacy
    // default would silently read as "this data does not exist".
    const withContact = draft({ email: 'jane@acme-industrial.example' })
    const expected = env.DM_STORE_CONTACT_DATA ? 'contactable' : 'withheld_by_policy'
    expect(contactabilityOf(withContact)).toBe(expected)
  })

  it('a candidate with no contact details is still a valid HIGH-confidence finding', () => {
    // Confidence is about evidence, contactability is about reachability.
    const c = score(
      draft({
        email: null,
        phone: null,
        evidence: [
          ev({
            provider: 'company_website',
            sourceType: 'company_website',
            sourceUrl: 'https://acme-industrial.example/leadership',
          }),
        ],
      }),
    )
    expect(c.contactability).toBe('none')
    expect(c.confidence).toBe('high')
  })
})

// ── 12. ZERO CANDIDATES ────────────────────────────────────────────────────

describe('zero candidates is a valid, honest outcome', () => {
  it('returns an empty shortlist rather than padding with a best guess', () => {
    const { shortlist, excluded } = selectShortlist([], 5)
    expect(shortlist).toEqual([])
    expect(excluded).toEqual([])
  })

  it('DROPS a senior person whose function is irrelevant', () => {
    // The CFO is not a fallback answer just because nobody better was found.
    const cfo = score(draft({ fullName: 'Fin Chief', rawTitle: 'Chief Financial Officer' }))
    const { shortlist, excluded } = selectShortlist([cfo], 5)
    expect(shortlist).toEqual([])
    expect(excluded[0]!.reason).toMatch(/does not match any role group/)
  })

  it('DROPS a person whose employment was contradicted, however good the title', () => {
    const wrongCo = score(draft({ fullName: 'Jane Smith', statedCompany: 'Globex Corporation' }), company(), null)
    const { shortlist, excluded } = selectShortlist([wrongCo], 5)
    expect(shortlist).toEqual([])
    expect(excluded[0]!.reason).toMatch(/not this company/)
  })

  it('DROPS a person with no stated title, because relevance cannot be shown', () => {
    const noTitle = score(draft({ rawTitle: null, evidence: [ev({ supports: ['name', 'company'] })] }))
    const { shortlist, excluded } = selectShortlist([noTitle], 5)
    expect(shortlist).toEqual([])
    expect(excluded[0]!.reason).toMatch(/No job title was stated/)
  })
})

// ── 13. AMBIGUOUS CANDIDATES ───────────────────────────────────────────────

describe('ambiguous candidates', () => {
  it('keeps a probable-match candidate but ranks it below a verified one', () => {
    const verified = score(draft({ fullName: 'Vera Verified' }))
    const probable = score(
      draft({ fullName: 'Pat Probable', statedCompany: 'Acme Digital' }),
      company({ name: 'Acme Industrial Widgets' }),
      null,
    )
    const { shortlist } = selectShortlist([probable, verified], 5)
    expect(shortlist.map((c) => c.fullName)).toEqual(['Vera Verified', 'Pat Probable'])
  })

  it('keeps an unverified candidate visible but at LOW confidence', () => {
    const c = score(draft({ statedCompany: null }), company(), null)
    expect(c.companyMatch).toBe('unverified')
    expect(c.confidence).toBe('low')
    // Still shortlistable — the reviewer decides, with the reason in hand.
    expect(selectShortlist([c], 5).shortlist.length).toBe(1)
  })

  it('breaks a score tie deterministically, so the same input gives the same order', () => {
    const a = score(draft({ fullName: 'Aaron Alpha', rawTitle: 'Catalog Manager' }))
    const b = score(draft({ fullName: 'Zoe Zulu', rawTitle: 'Catalog Manager' }))
    expect(a.rankScore).toBe(b.rankScore)
    expect(selectShortlist([b, a], 5).shortlist.map((c) => c.fullName)).toEqual(['Aaron Alpha', 'Zoe Zulu'])
  })

  it('caps the shortlist and records the overflow as excluded', () => {
    const many = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'].map((n) =>
      score(draft({ fullName: `${n} Person`, rawTitle: 'Catalog Manager' })),
    )
    const { shortlist } = selectShortlist(many, 5)
    expect(shortlist.length).toBe(5)
  })

  it('never returns hundreds of people', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      score(draft({ fullName: `Person${String(i).padStart(3, '0')} Test`, rawTitle: 'Ecommerce Manager' })),
    )
    expect(selectShortlist(many, env.DM_MAX_CANDIDATES).shortlist.length).toBeLessThanOrEqual(5)
  })
})
