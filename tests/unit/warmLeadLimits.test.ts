import { describe, expect, it } from 'vitest'
import { checkLimitUpdate, checkScaleApproval, checkWindow, DEEP_RESEARCH_CALL_ESTIMATE, PILOT_GEMINI_CEILING, PILOT_SIZE, START_DAILY_CEILING, START_DAILY_COMPANIES } from '../../src/warmleads/limits.js'

const start = { approvedMaxCompanies: 25, approvedMaxCeiling: 300 }

describe('the approved starting limits', () => {
  it('are the values the owner approved', () => {
    expect([PILOT_SIZE, PILOT_GEMINI_CEILING, START_DAILY_COMPANIES, START_DAILY_CEILING]).toEqual([100, 1200, 25, 300])
    expect(DEEP_RESEARCH_CALL_ESTIMATE).toBeGreaterThan(0)
  })
})

describe('changing the daily limits', () => {
  it('may lower, or stay at, what is approved', () => {
    expect(checkLimitUpdate(start, { dailyCompanyLimit: 10, dailyGeminiCeiling: 100, retryShare: 10 })).toEqual({ ok: true, value: { dailyCompanyLimit: 10, dailyGeminiCeiling: 100, retryShare: 10 } })
    expect(checkLimitUpdate(start, { dailyCompanyLimit: 25, dailyGeminiCeiling: 300 }).ok).toBe(true)
    expect(checkLimitUpdate(start, { dailyGeminiCeiling: 0 }).ok).toBe(true) // no Gemini research at all
  })
  it('cannot go above what was approved - 26 companies or 301 calls are refused', () => {
    expect(checkLimitUpdate(start, { dailyCompanyLimit: 26 })).toMatchObject({ ok: false })
    expect(checkLimitUpdate(start, { dailyGeminiCeiling: 301 })).toMatchObject({ ok: false })
    expect(checkLimitUpdate({ approvedMaxCompanies: 50, approvedMaxCeiling: 600 }, { dailyCompanyLimit: 50, dailyGeminiCeiling: 600 }).ok).toBe(true)
    expect(checkLimitUpdate({ approvedMaxCompanies: 50, approvedMaxCeiling: 600 }, { dailyCompanyLimit: 51 }).ok).toBe(false)
  })
  it('rejects nonsense', () => {
    for (const u of [{ dailyCompanyLimit: 0 }, { dailyCompanyLimit: 2.5 }, { dailyGeminiCeiling: -1 }, { retryShare: 51 }, { retryShare: -1 }, { dailyCompanyLimit: Number.NaN }]) {
      expect(checkLimitUpdate(start, u).ok, JSON.stringify(u)).toBe(false)
    }
  })
})

describe('approving a higher level', () => {
  const ok = { ...start, pilotApproved: true }
  it('needs the approved pilot', () => {
    expect(checkScaleApproval({ ...start, pilotApproved: false }, 50)).toMatchObject({ ok: false })
  })
  it('offers 25 -> 50 and nothing above: a 100-a-day tier does not exist', () => {
    expect(checkScaleApproval(ok, 50)).toEqual({ ok: true, value: { companies: 50, ceiling: 600 } })
    expect(checkScaleApproval(ok, 100)).toMatchObject({ ok: false })
    expect(checkScaleApproval({ approvedMaxCompanies: 50, approvedMaxCeiling: 600, pilotApproved: true }, 100)).toMatchObject({ ok: false })
  })
  it('never allows a daily limit above 50 companies / 600 calls, even after the 50 level is approved', () => {
    const fifty = { approvedMaxCompanies: 50, approvedMaxCeiling: 600 }
    expect(checkLimitUpdate(fifty, { dailyCompanyLimit: 50, dailyGeminiCeiling: 600 })).toMatchObject({ ok: true })
    expect(checkLimitUpdate(fifty, { dailyCompanyLimit: 100 })).toMatchObject({ ok: false })
    expect(checkLimitUpdate(fifty, { dailyGeminiCeiling: 1200 })).toMatchObject({ ok: false })
  })
  it('refuses a level already approved, and any other number', () => {
    expect(checkScaleApproval({ approvedMaxCompanies: 50, approvedMaxCeiling: 600, pilotApproved: true }, 50)).toMatchObject({ ok: false })
    expect(checkScaleApproval(ok, 75)).toMatchObject({ ok: false })
  })
})

describe('the window setting', () => {
  it('accepts a valid window and trims it', () => {
    expect(checkWindow({ start: ' 23:00', end: '06:00 ', timezone: 'Asia/Kolkata' })).toEqual({ ok: true, value: { start: '23:00', end: '06:00', timezone: 'Asia/Kolkata' } })
  })
  it('refuses a bad time or zone', () => {
    expect(checkWindow({ start: '24:30', end: '06:00', timezone: 'Asia/Kolkata' }).ok).toBe(false)
    expect(checkWindow({ start: '23:00', end: '06:00', timezone: 'nowhere' }).ok).toBe(false)
  })
})
