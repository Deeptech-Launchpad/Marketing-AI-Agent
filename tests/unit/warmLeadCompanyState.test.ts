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

  it('a COMPLETED Cold replaces a Warm - NXT Sales receives the Cold result in its place (every class is sent since 2026-11-26)', () => {
    const p = applyOutcome(warm(), done('cold', { score: 5 }))
    expect(p).toMatchObject({ state: 'evaluated', classification: 'cold', currentEvaluationId: 'ev-new' })
    expect(syncAction({ classification: p.classification, currentEvaluationId: p.currentEvaluationId, syncedEvaluationId: 'ev-warm', syncedClassification: 'warm' })).toBe('put')
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
  it('sends EVERY class it does not hold yet (owner 2026-11-26: each lead shows its signals in NXT Sales); a company with no result is not sent', () => {
    for (const k of ['warm', 'early_signal', 'cold', 'insufficient_data', 'existing_customer', 'active_opportunity', 'do_not_contact', 'human_review']) expect(syncAction(c(k, 'e1', null)), k).toBe('put')
    expect(syncAction(c(null, null, null))).toBe('none')
    expect(syncAction(c('something_new', 'e1', null))).toBe('none') // only the known classes
  })
  it('a class change WITHOUT a new evaluation is sent too (refusal -> human review), and nothing is re-sent once NXT Sales holds the class', () => {
    expect(syncAction({ classification: 'human_review', currentEvaluationId: 'e1', syncedEvaluationId: 'e1', syncedClassification: 'warm' })).toBe('put')
    expect(syncAction({ classification: 'human_review', currentEvaluationId: 'e1', syncedEvaluationId: 'e1', syncedClassification: 'human_review' })).toBe('none')
  })
  it('review 2 - a refusal seen by an evaluation that could not finish still pulls a listed Warm / Early Signal company into human review', () => {
    const listed = (c: CompanySnapshot) => ({ classification: 'human_review', currentEvaluationId: c.currentEvaluationId, syncedEvaluationId: c.currentEvaluationId })
    // the website could not be read (failed), research was cut short, or there was too little data: each keeps the earlier result - as human review
    for (const o of [failed(), done('insufficient_data'), done('cold', { researchIncomplete: true, deferredByCeiling: true })]) {
      const withRefusal = { ...o, refusal: true } as Outcome
      for (const before of [warm(), early()]) {
        const p = applyOutcome(before, withRefusal)
        expect(p, JSON.stringify(o)).toMatchObject({ classification: 'human_review', currentEvaluationId: before.currentEvaluationId, score: before.score })
        expect(p.summary).toMatch(/^Human review required/)
        expect(p.state).toBe('needs_reevaluation') // still due for a re-check
        // NXT Sales held the Warm / Early Signal; the class changed with the same evaluation, so it is sent again as human review
        expect(syncAction({ classification: p.classification, currentEvaluationId: p.currentEvaluationId, syncedEvaluationId: before.currentEvaluationId, syncedClassification: before.classification })).toBe('put')
        void listed
      }
      // without a refusal the earlier result is kept as it was
      expect(applyOutcome(warm(), o).classification).toBe('warm')
    }
    // a company with no earlier Warm / Early Signal is unaffected
    expect(applyOutcome(none(), { ...failed(), refusal: true })).toMatchObject({ classification: null, state: 'failed' })
  })

  it('a company held for human review is sent AS human review (not as the earlier Warm) when a refusal puts it there', () => {
    expect(DEFINITIVE.has('human_review')).toBe(true) // it replaces the earlier Warm: the refusal is the newest word
    const p = applyOutcome(warm(), done('human_review'))
    expect(p).toMatchObject({ classification: 'human_review', state: 'evaluated' })
    expect(syncAction({ classification: p.classification, currentEvaluationId: p.currentEvaluationId, syncedEvaluationId: 'ev-warm', syncedClassification: 'warm' })).toBe('put')
  })
  it('a later result of another class replaces the held one; a company that has no current result any more is withdrawn', () => {
    expect(syncAction(c('cold', 'e3', 'e1'))).toBe('put')
    expect(syncAction(c('do_not_contact', 'e3', 'e1'))).toBe('put')
    expect(syncAction(c(null, null, 'e1'))).toBe('delete')
  })
  it('a Warm company whose re-check failed is NOT withdrawn (its result is unchanged)', () => {
    const p = applyOutcome(warm(), failed())
    expect(syncAction({ classification: p.classification, currentEvaluationId: p.currentEvaluationId, syncedEvaluationId: 'ev-warm' })).toBe('none')
  })
})
