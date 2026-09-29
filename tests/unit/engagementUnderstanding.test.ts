import { describe, expect, it } from 'vitest'
import { buildUnderstanding, type UnderstandingSignalRow } from '../../src/understanding/service.js'

// COMBINED ENGAGEMENT VIEW (2026-09-24 restructure) — Intent Source,
// Engagement and Qualification, side by side.
//
// The one thing every test here checks for, one way or another: the raw
// numbers Intent Score's and Sales Qualification's own locked screens
// withhold (IntentScoring.tsx, Qualification.tsx) must never reach this
// endpoint's response either, even though it reads the same rows they do.

const signal = (over: Partial<UnderstandingSignalRow> = {}): UnderstandingSignalRow => ({
  id: 'sig1',
  eventFingerprint: 'fp1',
  crmCompanyId: 'co_1',
  observedAt: new Date('2026-09-01T00:00:00.000Z'),
  detectedAt: new Date('2026-09-01T00:00:00.000Z'),
  confidence: 'high',
  status: 'active',
  // A non-job signal: job postings are not intent signals (2026-09-28), so a
  // hiring row would now be withheld before it could be counted.
  signalType: 'platform_detected',
  signalCategory: 'technology',
  summary: 'The website runs on nopCommerce',
  sourceUrl: 'https://acme.test/',
  ...over,
})

describe('what the combined view withholds', () => {
  it('never returns the raw normalizedScore, rawScore or threshold FIELDS, only a level and a status', () => {
    const out = buildUnderstanding(
      'co_1',
      [signal()],
      { level: 'HIGH', policyStatus: 'provisional' },
      { status: 'qualified_unassigned' },
    )
    // As JSON keys, not as English prose — the disclaimers legitimately use
    // the word "threshold" to explain what is withheld and why.
    const json = JSON.stringify(out)
    expect(json).not.toMatch(/"normalizedScore"|"rawScore"|"threshold"\s*:/i)
    expect(out.engagement).toEqual({ level: 'HIGH', policyStatus: 'provisional' })
    expect(out.qualification).toEqual({ status: 'qualified_unassigned' })
  })

  it('never returns the qualification reason, which states the score and threshold inline', () => {
    const out = buildUnderstanding('co_1', [], { level: 'HIGH', policyStatus: 'provisional' }, { status: 'qualified' })
    // Everything sent, not just a named field: `reason` must not slip in
    // through a spread if this function is ever changed carelessly.
    expect(Object.keys(out.qualification ?? {})).toEqual(['status'])
  })

  it('never returns a bare number like 100 or 70 anywhere in the response', () => {
    const out = buildUnderstanding('co_1', [signal()], { level: 'HIGH', policyStatus: 'provisional' }, { status: 'qualified' })
    expect(JSON.stringify(out)).not.toMatch(/\b(100|70)\b/)
  })
})

describe('what the combined view shows honestly when data is missing', () => {
  it('returns null for engagement and qualification, not zeros or a guess', () => {
    const out = buildUnderstanding('co_1', [], null, null)
    expect(out.engagement).toBeNull()
    expect(out.qualification).toBeNull()
    expect(out.disclaimers.some((d) => /no engagement score/i.test(d))).toBe(true)
    expect(out.disclaimers.some((d) => /no qualification/i.test(d))).toBe(true)
  })

  it('counts only ACTIVE signals, not ones a later run withdrew', () => {
    // Status is recomputed at read time (presentSignal), never trusted from a
    // stale stored value — so a signal reads as inactive only when a later
    // observation actually superseded it.
    const out = buildUnderstanding(
      'co_1',
      [signal({ id: 's1' }), signal({ id: 's2', eventFingerprint: 'fp2', metadata: { supersededBy: 'later-event' } })],
      null,
      null,
    )
    expect(out.intentSource.count).toBe(1)
    expect(out.intentSource.signals[0]!.id).toBe('s1')
  })

  it('groups signals by category and caps the listed sample at 5', () => {
    const many = Array.from({ length: 8 }, (_, i) => signal({ id: `s${i}`, eventFingerprint: `fp${i}` }))
    const out = buildUnderstanding('co_1', many, null, null)
    expect(out.intentSource.count).toBe(8)
    expect(out.intentSource.signals).toHaveLength(5)
    expect(out.intentSource.byCategory).toEqual({ technology: 8 })
  })

  it('never counts a job posting as an intent signal', () => {
    const out = buildUnderstanding(
      'co_1',
      [signal({ id: 's1' }), signal({ id: 'job', eventFingerprint: 'fpj', signalType: 'careers_page_role', signalCategory: 'hiring' })],
      null,
      null,
    )
    expect(out.intentSource.count).toBe(1)
    expect(out.intentSource.byCategory).toEqual({ technology: 1 })
  })
})

describe('every disclaimer states the combination discipline plainly', () => {
  it('always says the three are shown side by side, not combined into one number', () => {
    const out = buildUnderstanding('co_1', [], { level: 'LOW', policyStatus: 'provisional' }, { status: 'not_qualified' })
    expect(out.disclaimers[0]).toMatch(/side by side, not combined into one number/i)
  })
})
