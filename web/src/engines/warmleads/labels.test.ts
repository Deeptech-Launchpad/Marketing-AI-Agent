import { describe, expect, it } from 'vitest'
import { CLASS, FILTERS, STOPPED, statusOf } from './labels'

// Every outcome the backend can write has a word on the screen: nothing is shown as a blank, "undefined" or another status.

describe('Warm Leads labels', () => {
  it('every reason a night can stop for has a sentence', () => {
    for (const reason of ['company_limit', 'gemini_ceiling', 'nothing_to_do', 'repeated_failures', 'error']) expect(STOPPED[reason], reason).toMatch(/\w/)
  })

  it('all eight classifications have their own label, and Failed / Research incomplete / Pending are separate filters', () => {
    expect(Object.keys(CLASS).sort()).toEqual(['active_opportunity', 'cold', 'do_not_contact', 'early_signal', 'existing_customer', 'human_review', 'insufficient_data', 'warm'])
    expect(new Set(Object.values(CLASS).map((c) => c.label)).size).toBe(8)
    const filters = FILTERS.map((f) => f.value)
    for (const f of ['warm', 'early_signal', 'cold', 'insufficient_data', 'existing_customer', 'active_opportunity', 'do_not_contact', 'human_review', 'failed', 'research_incomplete', 'needs_reevaluation', 'pending']) expect(filters, f).toContain(f)
  })

  it('a company held for human review shows its own status, not Warm', () => {
    expect(statusOf({ state: 'evaluated', classification: 'human_review', researchIncomplete: false }).label).toMatch(/^Human review required/)
  })

  it('a company with a kept result and a failed re-check still shows its result, marked for a re-check - never Failed or Cold', () => {
    expect(statusOf({ state: 'needs_reevaluation', classification: 'warm', researchIncomplete: false })).toEqual({ label: 'Warm · re-check due', tone: 'accent' })
    expect(statusOf({ state: 'needs_reevaluation', classification: 'early_signal', researchIncomplete: false }).label).toMatch(/^Early signal/)
  })

  it('incomplete research and a failure are never shown as Cold', () => {
    expect(statusOf({ state: 'needs_reevaluation', classification: null, researchIncomplete: true }).label).toBe('Research incomplete')
    expect(statusOf({ state: 'failed', classification: null, researchIncomplete: false, nextAttemptAt: '2026-11-06T00:00:00Z' }).label).toMatch(/^Failed/)
    expect(statusOf({ state: 'evaluated', classification: 'insufficient_data', researchIncomplete: false }).label).toBe('Not enough data')
  })
})
