import { describe, expect, it } from 'vitest'
import { applyOutcome, DEFINITIVE, MAX_AUTO_ATTEMPTS, nextAttemptAfterFailure, syncAction, type CompanySnapshot, type Outcome } from '../../src/warmleads/companyState.js'

const NOW = new Date('2026-11-05T01:00:00Z')
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000)

const none = (attempts = 1): CompanySnapshot => ({ attempts, currentEvaluationId: null, classification: null, score: null, confidence: null, summary: null, evaluatedAt: null })
const warm = (attempts = 1): CompanySnapshot => ({ attempts, currentEvaluationId: 'ev-warm', classification: 'warm', score: 62, confidence: 'high', summary: 'warm', evaluatedAt: new Date('2026-10-01T00:00:00Z') })
const early = (): CompanySnapshot => ({ ...warm(), currentEvaluationId: 'ev-early', classification: 'early_signal', score: 35 })

const done = (classification: string, extra: Partial<Extract<Outcome, { kind: 'classified' }>> = {}): Outcome => ({
  kind: 'classified',
  evaluationId: 'ev-new',
  classification: classification as never,
  score: 20,
  confidence: 'medium',
  summary: `new ${classification}`,
  researchIncomplete: false,
  deferredByCeiling: false,
  now: NOW,
  ...extra,
})
const failed = (error = 'The website could not be read.'): Outcome => ({ kind: 'failed', evaluationId: 'ev-new', error, now: NOW })

describe('a completed evaluation replaces the current result', () => {
  it('a first Warm is stored as evaluated', () => {
    const p = applyOutcome(none(), done('warm', { score: 55 }))
    expect(p).toMatchObject({ state: 'evaluated', classification: 'warm', score: 55, currentEvaluationId: 'ev-new', attempts: 0, nextAttemptAt: null, lastError: null, researchIncomplete: false })
  })

  it('a COMPLETED Cold replaces a Warm - the company leaves the Warm Leads list', () => {
    const p = applyOutcome(warm(), done('cold', { score: 5 }))
    expect(p).toMatchObject({ state: 'evaluated', classification: 'cold', currentEvaluationId: 'ev-new' })
    expect(syncAction({ classification: p.classification, currentEvaluationId: p.currentEvaluationId, syncedEvaluationId: 'ev-warm' })).toBe('delete')
  })

  it('every definitive result replaces', () => {
    for (const c of DEFINITIVE) expect(applyOutcome(warm(), done(c)).classification).toBe(c)
  })
})

describe('a failed evaluation never downgrades a valid result', () => {
  it('a Warm company stays Warm, is marked for re-evaluation, and keeps its evidence', () => {
    const p = applyOutcome(warm(2), failed())
    expect(p).toMatchObject({ state: 'needs_reevaluation', classification: 'warm', score: 62, currentEvaluationId: 'ev-warm', lastEvaluationId: 'ev-new' })
    expect(p.nextAttemptAt).toEqual(day(3)) // second failure -> 3 days
    expect(p.lastError).toMatch(/website could not be read/)
  })

  it('a company with no result is simply failed, and retried on a backoff', () => {
    expect(applyOutcome(none(1), failed())).toMatchObject({ state: 'failed', classification: null, nextAttemptAt: day(1) })
    expect(applyOutcome(none(3), failed())).toMatchObject({ state: 'failed', nextAttemptAt: null }) // automatic attempts used up: waits for an admin
  })

  it('the backoff is 1, 3, 7 days and then stops', () => {
    expect(nextAttemptAfterFailure(1, NOW)).toEqual(day(1))
    expect(nextAttemptAfterFailure(2, NOW)).toEqual(day(3))
    expect(nextAttemptAfterFailure(3, NOW)).toBeNull()
    expect(MAX_AUTO_ATTEMPTS).toBe(3)
  })
})

describe('incomplete research is never final and never Cold', () => {
  it('a company with no result is "needs re-evaluation, research incomplete" - not Cold, not insufficient', () => {
    const p = applyOutcome(none(1), done('insufficient_data', { researchIncomplete: true }))
    expect(p).toMatchObject({ state: 'needs_reevaluation', classification: null, researchIncomplete: true })
  })

  it('a Warm company that is re-checked and cut short keeps Warm', () => {
    const p = applyOutcome(warm(), done('insufficient_data', { researchIncomplete: true }))
    expect(p).toMatchObject({ state: 'needs_reevaluation', classification: 'warm', currentEvaluationId: 'ev-warm', researchIncomplete: true })
  })

  it('a ceiling deferral costs the company no attempt and is due again straight away', () => {
    const p = applyOutcome(none(1), done('insufficient_data', { researchIncomplete: true, deferredByCeiling: true }))
    expect(p.attempts).toBe(0)
    expect(p.nextAttemptAt).toEqual(NOW)
    expect(p.lastError).toMatch(/Gemini call limit/)
  })

  it('even a result that says Cold is not stored when the research was incomplete', () => {
    const p = applyOutcome(none(1), done('cold', { researchIncomplete: true }))
    expect(p.classification).toBeNull()
    expect(p.state).toBe('needs_reevaluation')
  })
})

describe('"not enough data" never erases a Warm or Early Signal', () => {
  it('a complete insufficient_data result keeps Warm / Early Signal and asks for a re-check', () => {
    for (const prev of [warm(), early()]) {
      const p = applyOutcome(prev, done('insufficient_data'))
      expect(p.classification).toBe(prev.classification)
      expect(p.currentEvaluationId).toBe(prev.currentEvaluationId)
      expect(p.state).toBe('needs_reevaluation')
    }
  })
  it('it does replace nothing, or a weaker result', () => {
    expect(applyOutcome(none(), done('insufficient_data'))).toMatchObject({ state: 'evaluated', classification: 'insufficient_data' })
    const cold: CompanySnapshot = { ...warm(), classification: 'cold', currentEvaluationId: 'ev-cold' }
    expect(applyOutcome(cold, done('insufficient_data')).classification).toBe('insufficient_data')
  })
})

describe('what NXT Sales must hold', () => {
  const c = (classification: string | null, current: string | null, synced: string | null) => ({ classification, currentEvaluationId: current, syncedEvaluationId: synced })
  it('puts a Warm / Early Signal it does not hold yet, or holds an older evaluation of', () => {
    expect(syncAction(c('warm', 'e1', null))).toBe('put')
    expect(syncAction(c('early_signal', 'e2', 'e1'))).toBe('put')
  })
  it('does nothing when it already holds the current evaluation (idempotent)', () => {
    expect(syncAction(c('warm', 'e1', 'e1'))).toBe('none')
  })
  it('never sends cold, insufficient, customer, opportunity or do-not-contact', () => {
    for (const k of ['cold', 'insufficient_data', 'existing_customer', 'active_opportunity', 'do_not_contact', null]) expect(syncAction(c(k, 'e1', null))).toBe('none')
  })
  it('withdraws a company that is no longer Warm / Early Signal but is still listed', () => {
    expect(syncAction(c('cold', 'e3', 'e1'))).toBe('delete')
    expect(syncAction(c('do_not_contact', 'e3', 'e1'))).toBe('delete')
  })
  it('a Warm company whose re-check failed is NOT withdrawn (its result is unchanged)', () => {
    const p = applyOutcome(warm(), failed())
    expect(syncAction({ classification: p.classification, currentEvaluationId: p.currentEvaluationId, syncedEvaluationId: 'ev-warm' })).toBe('none')
  })
})
