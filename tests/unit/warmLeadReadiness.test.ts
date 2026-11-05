import { describe, expect, it } from 'vitest'
import { evaluateReadiness, type ReadinessSnapshot } from '../../src/warmleads/readiness.js'

// The pilot readiness checklist: pure, so each way of not being ready is pinned.

const good = (over: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => ({
  geminiKeyProblem: null,
  workerEnabled: false,
  syncSwitchOn: false,
  allowLive: false,
  crmReadOnlyGlobal: false,
  migrationApplied: true,
  settings: { paused: true, pilotSize: 100, pilotGeminiCeiling: 1200, dailyCompanyLimit: 25, dailyGeminiCeiling: 300, approvedMaxCompanies: 25, approvedMaxCeiling: 300, pilotApprovedAt: null, syncEnabled: false },
  pilotRunStatus: null,
  crm: { ok: true, total: 15137 },
  availableMb: 9000,
  minAvailableMb: 4096,
  windowOpenNow: false,
  ...over,
})
const failing = (s: ReadinessSnapshot) => evaluateReadiness(s).checks.filter((c) => c.status === 'fail').map((c) => c.id)

describe('pilot readiness', () => {
  it('the safe default state is ready, and says the worker switch and window are only information', () => {
    const r = evaluateReadiness(good())
    expect(r.ready).toBe(true)
    expect(failing(good())).toEqual([])
    expect(r.checks.find((c) => c.id === 'worker_flag')).toMatchObject({ status: 'info' })
    expect(r.checks.find((c) => c.id === 'crm')!.detail).toMatch(/15,137 companies/)
  })

  it('a missing dedicated Gemini key, missing tables or an unreadable CRM each stop it', () => {
    expect(failing(good({ geminiKeyProblem: 'Warm Leads has no Gemini key of its own' }))).toEqual(['gemini_key'])
    expect(failing(good({ migrationApplied: false }))).toContain('migration')
    expect(failing(good({ crm: { ok: false, total: null, error: 'connect ECONNREFUSED' } }))).toEqual(['crm'])
    expect(failing(good({ crm: { ok: true, total: 40 } }))).toEqual(['crm'])
  })

  it('anything that could send, write or run on its own stops it', () => {
    expect(failing(good({ syncSwitchOn: true }))).toEqual(['sync_off'])
    expect(failing(good({ settings: { ...good().settings!, syncEnabled: true } }))).toEqual(['sync_off'])
    expect(failing(good({ allowLive: true }))).toEqual(['live_write'])
    expect(failing(good({ settings: { ...good().settings!, paused: false } }))).toEqual(['paused'])
  })

  it('limits above the approved ones stop it: pilot 100 / 1,200, daily 25 / 300, never a 100-a-day tier', () => {
    const base = good().settings!
    expect(failing(good({ settings: { ...base, pilotSize: 150 } }))).toEqual(['pilot_limits'])
    expect(failing(good({ settings: { ...base, pilotGeminiCeiling: 2000 } }))).toEqual(['pilot_limits'])
    expect(failing(good({ settings: { ...base, dailyCompanyLimit: 50 } }))).toEqual(['daily_limits'])
    expect(failing(good({ settings: { ...base, approvedMaxCeiling: 600 } }))).toEqual(['daily_limits'])
    expect(failing(good({ settings: { ...base, dailyCompanyLimit: 100, dailyGeminiCeiling: 1000 } }))).toEqual(['daily_limits'])
  })

  it('not enough memory stops it; where memory cannot be measured it is only information', () => {
    expect(failing(good({ availableMb: 2000 }))).toEqual(['memory'])
    expect(evaluateReadiness(good({ availableMb: null })).checks.find((c) => c.id === 'memory')!.status).toBe('info')
  })

  it('no settings row yet is fine (it is created, paused, on first use); a pilot that failed may be requested again', () => {
    expect(evaluateReadiness(good({ settings: null })).ready).toBe(true)
    expect(evaluateReadiness(good({ pilotRunStatus: 'failed' })).ready).toBe(true)
    expect(evaluateReadiness(good({ pilotRunStatus: 'completed' })).checks.find((c) => c.id === 'pilot_state')!.status).toBe('info')
  })
})
