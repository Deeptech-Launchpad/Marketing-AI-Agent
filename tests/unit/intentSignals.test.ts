import { describe, expect, it } from 'vitest'
import { scoreConfidence, scoreFreshness, signalStatus } from '../../src/intent/confidence.js'
import { eventFingerprint, type IntentSignalDraft } from '../../src/intent/types.js'

// Stage 3's core rules. These are deterministic on purpose: a confidence label
// produced by a model reads like a measurement and is actually a vibe, and it
// cannot be tested. These can.

function draft(over: Partial<IntentSignalDraft> = {}): IntentSignalDraft {
  return {
    crmCompanyId: 'co_1',
    signalType: 'relevant_job_posting',
    signalCategory: 'hiring',
    summary: 'Hiring: "Product Data Manager"',
    interpretation: 'May indicate investment in product data operations.',
    evidence: 'Job title: Product Data Manager | Posted: 2026-08-20 | URL: https://example.com/j/1',
    sourceUrl: 'https://example.com/j/1',
    sourceType: 'job_board',
    observedAt: new Date(),
    polarity: 'positive',
    provider: 'apify_jobs',
    ...over,
  }
}

describe('confidence — deterministic, evidence-quality only', () => {
  it('rates a company own-site declaration higher than a third-party board', () => {
    const own = scoreConfidence(draft({ sourceType: 'company_website' })).confidence
    const board = scoreConfidence(draft({ sourceType: 'job_board' })).confidence
    expect(own).toBe('high')
    expect(board).toBe('medium')
  })

  it('treats the CRM as high without needing a URL', () => {
    const r = scoreConfidence(draft({ sourceType: 'crm_record', sourceUrl: null }))
    expect(r.confidence).toBe('high')
    expect(r.reasons.join(' ')).not.toMatch(/No source URL/)
  })

  it('demotes evidence that cannot be re-checked', () => {
    // A claim with no URL from a third party cannot be independently verified.
    const r = scoreConfidence(draft({ sourceUrl: null }))
    expect(r.confidence).toBe('low')
    expect(r.reasons.join(' ')).toMatch(/cannot be independently re-checked/i)
  })

  it('demotes an undated signal, because intent is about NOW', () => {
    const r = scoreConfidence(draft({ sourceType: 'company_website', observedAt: null }))
    expect(r.confidence).toBe('medium')
    expect(r.reasons.join(' ')).toMatch(/no date/i)
  })

  it('demotes evidence too short to inspect', () => {
    expect(scoreConfidence(draft({ sourceType: 'company_website', evidence: 'x' })).confidence).toBe('medium')
  })

  it('never promotes: a weak source cannot become strong', () => {
    const r = scoreConfidence(
      draft({ sourceType: 'third_party', evidence: 'A'.repeat(500), observedAt: new Date() }),
    )
    expect(r.confidence).toBe('low')
  })

  it('always explains itself', () => {
    expect(scoreConfidence(draft()).reasons.length).toBeGreaterThan(0)
  })
})

describe('freshness — age of the EVENT, not of our observation', () => {
  const now = new Date('2026-08-27T00:00:00Z')
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)

  it('classifies fresh, aging and stale by configured thresholds', () => {
    expect(scoreFreshness(daysAgo(5), now).freshness).toBe('fresh')
    expect(scoreFreshness(daysAgo(60), now).freshness).toBe('aging')
    expect(scoreFreshness(daysAgo(400), now).freshness).toBe('stale')
  })

  it('reports unknown when the source gave no date', () => {
    const r = scoreFreshness(null, now)
    expect(r.freshness).toBe('unknown')
    expect(r.ageDays).toBeNull()
  })

  it('treats a future date as unknown rather than extremely fresh', () => {
    // A future posting date means the source is wrong or was misparsed.
    expect(scoreFreshness(new Date(now.getTime() + 5 * 86_400_000), now).freshness).toBe('unknown')
  })

  it('reports the age so freshness can be recalculated later', () => {
    expect(scoreFreshness(daysAgo(45), now).ageDays).toBe(45)
  })

  it('handles an invalid date without throwing', () => {
    expect(scoreFreshness(new Date('nonsense'), now).freshness).toBe('unknown')
  })
})

describe('signal status', () => {
  it('expires a stale signal however good its evidence is', () => {
    expect(signalStatus('high', 'stale')).toBe('expired')
  })

  it('marks undated or low-confidence signals weak, not active', () => {
    expect(signalStatus('high', 'unknown')).toBe('weak')
    expect(signalStatus('low', 'fresh')).toBe('weak')
  })

  it('only a fresh, well-evidenced signal is active', () => {
    expect(signalStatus('high', 'fresh')).toBe('active')
    expect(signalStatus('medium', 'aging')).toBe('active')
  })
})

describe('event fingerprint — deduplication by EVENT, not by report', () => {
  const fp = (subject: string, category: 'hiring' | 'news' = 'hiring', company = 'co_1') =>
    eventFingerprint({ crmCompanyId: company, signalCategory: category, subject })

  it('collapses the same role described in different word order', () => {
    // The same hire seen on a careers page and a job board must be ONE event,
    // or a company with press coverage looks more interested than one without.
    expect(fp('Product Data Manager')).toBe(fp('Manager, Product Data'))
  })

  it('ignores punctuation and casing differences', () => {
    expect(fp('product-data manager')).toBe(fp('Product Data   Manager!'))
  })

  it('keeps genuinely different roles apart', () => {
    expect(fp('Product Data Manager')).not.toBe(fp('Warehouse Operative'))
  })

  it('scopes to the company: the same role at two companies is two events', () => {
    expect(fp('Product Data Manager', 'hiring', 'co_1')).not.toBe(
      fp('Product Data Manager', 'hiring', 'co_2'),
    )
  })

  it('scopes to the category', () => {
    expect(fp('Acquisition of Widget Co', 'news')).not.toBe(fp('Acquisition of Widget Co', 'hiring'))
  })

  it('is stable across calls', () => {
    expect(fp('Product Data Manager')).toBe(fp('Product Data Manager'))
  })
})

describe('polarity — negative signals must be supported, not invented', () => {
  it('carries a negative polarity through unchanged', () => {
    const d = draft({
      signalType: 'suppressed',
      signalCategory: 'crm',
      sourceType: 'crm_record',
      polarity: 'negative',
      evidence: 'Suppression entry (domain = acme.example): customer asked not to be contacted',
    })
    expect(d.polarity).toBe('negative')
    expect(scoreConfidence(d).confidence).toBe('high')
  })

  it('allows a neutral signal that describes our own activity', () => {
    const d = draft({ signalType: 'recent_outbound_only', polarity: 'neutral', sourceType: 'crm_record' })
    expect(d.polarity).toBe('neutral')
  })
})
