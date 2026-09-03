import { describe, expect, it } from 'vitest'
import {
  JOB_BOARDS,
  boardAvailability,
  boardsFor,
  normalizeCountry,
} from '../../src/intent/jobBoards.js'
import {
  detectBusinessSignals,
  detectInternational,
  detectMarketplace,
  detectProductCount,
  detectRfp,
  type DetectorContext,
  type PageEvidence,
} from '../../src/intent/businessSignals.js'

// Team Answer, Sections D.1 and D.6 — multi-source intent collection.
//
// Two rules are under test throughout:
//   "Do NOT depend on one signal provider."
//   "Every signal must be evidence-backed. Never create intent from speculation."

const ctx: DetectorContext = { crmCompanyId: 'co_1', provider: 'test', homeDomain: 'acme-industrial.com' }
const page = (over: Partial<PageEvidence>): PageEvidence => ({
  url: 'https://acme-industrial.com/about',
  text: '',
  observedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
})

// ── 1. REGIONAL BOARD COVERAGE ─────────────────────────────────────────────

describe('job board registry — every named board is registered', () => {
  it('registers each source the Team Answer names', () => {
    const ids = JOB_BOARDS.map((b) => b.id).sort()
    expect(ids).toEqual(
      ['bayt', 'careers24', 'gulftalent', 'indeed', 'jobsdb', 'jobstreet', 'linkedin', 'pnet', 'seek'].sort(),
    )
  })

  it('routes each confirmed geography to its regional boards', () => {
    const idsFor = (c: string) => boardsFor(normalizeCountry(c)).map((x) => x.board.id)
    expect(idsFor('Australia')).toContain('seek')
    expect(idsFor('New Zealand')).toContain('seek')
    expect(idsFor('South Africa')).toEqual(expect.arrayContaining(['pnet', 'careers24']))
    expect(idsFor('UAE')).toEqual(expect.arrayContaining(['bayt', 'gulftalent']))
    expect(idsFor('Singapore')).toEqual(expect.arrayContaining(['jobstreet', 'jobsdb']))
    // Global boards reach everywhere, including countries with no local board.
    expect(idsFor('Malta')).toEqual(expect.arrayContaining(['indeed', 'linkedin']))
  })

  it('does not search a region a company is not in', () => {
    const za = boardsFor(normalizeCountry('South Africa')).map((x) => x.board.id)
    expect(za).not.toContain('seek')
    expect(za).not.toContain('jobstreet')
  })

  it('normalises the country spellings the CRM actually holds', () => {
    expect(normalizeCountry('USA')).toBe('US')
    expect(normalizeCountry('United States')).toBe('US')
    expect(normalizeCountry('U.A.E.')).toBe('AE')
    expect(normalizeCountry('Dubai')).toBe('AE')
    expect(normalizeCountry('England')).toBe('GB')
    expect(normalizeCountry('Narnia')).toBeNull()
  })

  it('falls back to global boards only when the country is unknown', () => {
    const ids = boardsFor(null).map((x) => x.board.id)
    expect(ids).toEqual(['indeed', 'linkedin'])
  })
})

// ── 2. THE LINKEDIN CONFLICT ───────────────────────────────────────────────

describe('LinkedIn is registered and refused', () => {
  it('blocks LinkedIn collection on policy, not on configuration', () => {
    const board = JOB_BOARDS.find((b) => b.id === 'linkedin')!
    const a = boardAvailability(board, 'US')
    expect(a.status).toBe('blocked_by_policy')
    // The distinction matters: a missing key is a purchase, a policy block is not.
    expect(a.status).not.toBe('not_configured')
    if (a.status === 'blocked_by_policy') {
      expect(a.reason).toMatch(/official LinkedIn API access/)
      expect(a.reason).toMatch(/third-party/)
    }
  })

  it('separates "not configured" from "no hiring activity"', () => {
    const seek = JOB_BOARDS.find((b) => b.id === 'seek')!
    const a = boardAvailability(seek, 'AU')
    expect(a.status).toBe('not_configured')
    if (a.status === 'not_configured') expect(a.reason).toMatch(/No signal is inferred from its absence/)
  })

  it('marks a board that does not serve the country as not_applicable', () => {
    const seek = JOB_BOARDS.find((b) => b.id === 'seek')!
    expect(boardAvailability(seek, 'ZA').status).toBe('not_applicable')
  })
})

// ── 3. MARKETPLACE ─────────────────────────────────────────────────────────

describe('marketplace expansion', () => {
  it('detects a marketplace storefront and quotes the evidence', () => {
    const out = detectMarketplace(
      page({ text: 'Buy direct or shop on Amazon for next-day delivery on 4,000 lines.' }),
      ctx,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.signalType).toBe('marketplace_presence')
    expect(out[0]!.evidence).toMatch(/shop on Amazon/i)
    expect(out[0]!.metadata!.marketplace).toBe('Amazon')
  })

  it('finds several marketplaces separately', () => {
    const out = detectMarketplace(
      page({ text: 'Our eBay store and our Amazon storefront both carry the full range.' }),
      ctx,
    )
    expect(out.map((s) => s.metadata!.marketplace).sort()).toEqual(['Amazon', 'eBay'])
  })

  it('does not fire on a passing mention', () => {
    expect(detectMarketplace(page({ text: 'We compete with Amazon on price.' }), ctx)).toHaveLength(0)
    expect(detectMarketplace(page({ text: 'The Amazon rainforest.' }), ctx)).toHaveLength(0)
  })

  it('does not claim the presence is new', () => {
    const out = detectMarketplace(page({ text: 'Sold on Amazon.' }), ctx)
    expect(out[0]!.summary).not.toMatch(/new|recently|began/i)
  })
})

// ── 4. RFP / TENDER ────────────────────────────────────────────────────────

describe('RFP and tender activity', () => {
  it('fires only when procurement language AND an in-scope system are both present', () => {
    const both = detectRfp(
      page({ text: 'Request for Proposal: supply and implementation of a product information management system.' }),
      ctx,
    )
    expect(both).toHaveLength(1)
    expect(both[0]!.metadata!.system).toMatch(/product information management/i)
  })

  it('ignores procurement for something unrelated', () => {
    expect(detectRfp(page({ text: 'Invitation to tender for warehouse racking and forklifts.' }), ctx)).toHaveLength(0)
  })

  it('ignores an ordinary page that merely mentions a catalogue system', () => {
    expect(
      detectRfp(page({ text: 'Our catalog management platform makes ordering easy.' }), ctx),
    ).toHaveLength(0)
  })

  it('quotes both halves of the evidence', () => {
    const out = detectRfp(page({ text: 'RFQ issued for a new ecommerce platform this quarter.' }), ctx)
    expect(out[0]!.evidence).toMatch(/RFQ/i)
    expect(out[0]!.evidence).toMatch(/ecommerce platform/i)
  })
})

// ── 5. INTERNATIONAL EXPANSION ─────────────────────────────────────────────

describe('international expansion', () => {
  it('treats two or more hreflang locales as the strongest evidence', () => {
    const out = detectInternational(
      page({
        html:
          '<link rel="alternate" hreflang="en-gb" href="https://x.co.uk/"/>' +
          '<link rel="alternate" hreflang="en-au" href="https://x.com.au/"/>' +
          '<link rel="alternate" hreflang="x-default" href="https://x.com/"/>',
      }),
      ctx,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.metadata!.strength).toBe('hreflang_declared')
    expect(out[0]!.metadata!.locales).toEqual(['en-au', 'en-gb'])
  })

  it('does not treat a single locale as expansion', () => {
    expect(
      detectInternational(page({ html: '<link rel="alternate" hreflang="en-gb" href="https://x.co.uk/"/>' }), ctx),
    ).toHaveLength(0)
  })

  it('ignores the company\'s own domain when counting country sites', () => {
    const out = detectInternational(
      page({ html: '<a href="https://acme-industrial.com">home</a><a href="https://shop.acme-industrial.com">shop</a>' }),
      ctx,
    )
    expect(out).toHaveLength(0)
  })

  it('marks the link-based fallback as weaker than a declaration', () => {
    const out = detectInternational(
      page({ html: '<a href="https://other.co.uk/x">UK</a> <a href="https://other.com.au/y">AU</a>' }),
      ctx,
    )
    expect(out[0]!.metadata!.strength).toBe('weaker_than_hreflang')
    expect(out[0]!.interpretation).toMatch(/weaker evidence/)
  })
})

// ── 6. CATALOGUE SIZE ──────────────────────────────────────────────────────

describe('product count', () => {
  it('reports a stated count as a neutral measurement, not as growth', () => {
    const out = detectProductCount(page({ text: 'Over 12,000 products in stock.' }), ctx)
    expect(out).toHaveLength(1)
    expect(out[0]!.polarity).toBe('neutral')
    expect(out[0]!.metadata!.productCount).toBe(12000)
    expect(out[0]!.summary).not.toMatch(/growth|increase/i)
  })

  it('ignores counts too small to indicate catalogue complexity', () => {
    expect(detectProductCount(page({ text: '12 products available.' }), ctx)).toHaveLength(0)
  })
})

// ── 7. NOTHING FROM NOTHING ────────────────────────────────────────────────

describe('the no-speculation rule', () => {
  it('produces no signal at all from an ordinary page', () => {
    const out = detectBusinessSignals(
      page({ text: 'Acme Industrial has supplied fasteners to the trade since 1974. Contact us for a quote.' }),
      ctx,
    )
    expect(out).toEqual([])
  })

  it('gives every signal it does produce a non-empty quote and a source', () => {
    const out = detectBusinessSignals(
      page({
        text: 'Shop on Amazon. Request for Proposal for a PIM system. Over 8,000 products.',
        html: '<link rel="alternate" hreflang="en-gb" href="a"/><link rel="alternate" hreflang="fr-ca" href="b"/>',
      }),
      ctx,
    )
    expect(out.length).toBeGreaterThanOrEqual(3)
    for (const s of out) {
      expect(s.evidence.trim().length, s.signalType).toBeGreaterThan(0)
      expect(s.sourceUrl, s.signalType).toBeTruthy()
      expect(s.provider, s.signalType).toBe('test')
      expect(s.crmCompanyId, s.signalType).toBe('co_1')
    }
  })
})
