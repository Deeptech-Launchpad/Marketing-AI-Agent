import { describe, expect, it } from 'vitest'
import { isJobSignal } from '../../src/intent/jobSignals.js'
import { presentSignals } from '../../src/intent/signalView.js'

// JOB POSTINGS ARE NOT INTENT SIGNALS — whichever source met them — and every
// other signal is left exactly as it was.

describe('job postings are not intent signals', () => {
  it('recognises every hiring signal the sources produce, and nothing else', () => {
    for (const signalType of ['careers_page_role', 'relevant_job_posting', 'public_job_posting', 'external_hiring', 'social_post_hiring']) {
      expect(isJobSignal({ signalType, signalCategory: 'business' }), signalType).toBe(true)
    }
    expect(isJobSignal({ signalType: 'anything', signalCategory: 'hiring' })).toBe(true)
    for (const signalType of ['platform_detected', 'external_expansion', 'community_question', 'public_business_activity', 'social_post_expansion', 'open_opportunity']) {
      expect(isJobSignal({ signalType, signalCategory: 'business' }), signalType).toBe(false)
    }
  })

  it('keeps hiring signals stored by earlier runs off every screen, and leaves the rest untouched', () => {
    const row = (id: string, signalType: string, signalCategory: string) => ({
      id,
      eventFingerprint: id,
      crmCompanyId: 'c1',
      observedAt: null,
      detectedAt: new Date('2026-09-20T00:00:00Z'),
      confidence: 'medium',
      status: 'active',
      signalType,
      signalCategory,
    })
    const shown = presentSignals([
      row('a', 'careers_page_role', 'hiring'),
      row('b', 'relevant_job_posting', 'hiring'),
      row('c', 'social_post_hiring', 'business'),
      row('d', 'platform_detected', 'technology'),
      row('e', 'external_expansion', 'business'),
    ])
    expect(shown.map((s) => s.id).sort()).toEqual(['d', 'e'])
  })
})
