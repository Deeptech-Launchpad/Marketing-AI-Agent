import { describe, expect, it } from 'vitest'
import { evaluateReadiness, resolveTenant, type ReadinessSnapshot } from '../../src/warmleads/readiness.js'

// The pilot readiness checklist: pure, so each way of not being ready is pinned.

const good = (over: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => ({
  geminiKeyProblem: null,
  llmDriver: 'real',
  crmDriver: 'real',
  recordOptOuts: false,
  fingerprintKeyConfigured: true,
  ownDomainsConfigured: true,
  workerEnabled: false,
  syncSwitchOn: false,
  allowLive: false,
  crmReadOnlyGlobal: false,
  databaseOk: true,
  migrationApplied: true,
  tenant: { state: 'ok', detail: 'tenant t1 (the only one with Warm Leads settings)' },
  settings: { paused: true, pilotSize: 100, pilotGeminiCeiling: 1200, dailyCompanyLimit: 25, dailyGeminiCeiling: 300, approvedMaxCompanies: 25, approvedMaxCeiling: 300, pilotApprovedAt: null, syncEnabled: false },
  pilotRunStatus: null,
  crm: { ok: true, total: 15137 },
  availableMb: 9000,
  minAvailableMb: 4096,
  windowOpenNow: false,
  ...over,
})
const failing = (s: ReadinessSnapshot) => evaluateReadiness(s).checks.filter((c) => c.status === 'fail').map((c) => c.id)
const check = (s: ReadinessSnapshot, id: string) => evaluateReadiness(s).checks.find((c) => c.id === id)

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

  it('a pilot set BELOW the standard 100 / 1,200 is safe: information, not a failure', () => {
    const base = good().settings!
    const lower = good({ settings: { ...base, pilotSize: 80 } })
    expect(failing(lower)).toEqual([])
    expect(check(lower, 'pilot_limits')).toMatchObject({ status: 'info' })
    expect(check(lower, 'pilot_limits')!.detail).toMatch(/80 companies/)
  })

  it('not enough memory stops it; where memory cannot be measured it is only information', () => {
    expect(failing(good({ availableMb: 2000 }))).toEqual(['memory'])
    expect(evaluateReadiness(good({ availableMb: null })).checks.find((c) => c.id === 'memory')!.status).toBe('info')
  })

  it('a tenant that has NOT completed Warm Leads setup (no settings row) is NOT ready: nothing about it was checked; a pilot that failed may be requested again', () => {
    const fresh = good({ settings: null, tenant: { state: 'none', detail: 'no tenant has opened Warm Leads yet' } })
    const r = evaluateReadiness(fresh)
    expect(r.ready).toBe(false)
    expect(r.checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual(expect.arrayContaining(['tenant', 'settings']))
    expect(evaluateReadiness(good({ pilotRunStatus: 'failed' })).ready).toBe(true)
    expect(evaluateReadiness(good({ pilotRunStatus: 'completed' })).checks.find((c) => c.id === 'pilot_state')!.status).toBe('info')
  })
})

describe('review fixes - a check that was not actually made is never a pass', () => {
  it('M9 - several tenants and none named: NOT ready (it used to print READY having read nothing)', () => {
    const s = good({ settings: null, tenant: { state: 'ambiguous', detail: '2 tenants have Warm Leads settings (a, b) and none was named. Run again with --tenant <id>' } })
    const r = evaluateReadiness(s)
    expect(r.ready).toBe(false)
    expect(failing(s)).toContain('tenant')
    expect(check(s, 'tenant')!.detail).toMatch(/--tenant/)
    expect(failing(s)).toContain('settings') // the controls were not read for anyone
  })

  it('M9 - which tenant: one tenant is used, several need a name, a name that matches none is unknown', () => {
    expect(resolveTenant(undefined, ['a'])).toMatchObject({ tenantId: 'a', state: 'ok' })
    expect(resolveTenant('b', ['a', 'b'])).toMatchObject({ tenantId: 'b', state: 'ok' })
    expect(resolveTenant(undefined, ['a', 'b'])).toMatchObject({ state: 'ambiguous' })
    expect(resolveTenant('x', ['a', 'b'])).toMatchObject({ state: 'unknown' })
    expect(resolveTenant('x', [])).toMatchObject({ state: 'unknown' })
    expect(resolveTenant(undefined, [])).toMatchObject({ state: 'none' })
    expect(resolveTenant('tenant-one', ['tenant-one', 'tenant-two']).detail).not.toContain('tenant-two') // does not wander into the others
  })

  it('M9 - a tenant that was named but has no settings (a typo): NOT ready', () => {
    const s = good({ settings: null, tenant: { state: 'unknown', detail: '--tenant tt has no Warm Leads settings' } })
    expect(evaluateReadiness(s).ready).toBe(false)
    expect(failing(s)).toContain('tenant')
  })

  it('an unreachable database is reported as that, not as "migration not applied"', () => {
    const s = good({ databaseOk: false, databaseError: 'connect ECONNREFUSED 127.0.0.1:5432', migrationApplied: false, settings: null, tenant: { state: 'none', detail: 'the database was not read' } })
    const r = evaluateReadiness(s)
    expect(r.ready).toBe(false)
    expect(failing(s)).toEqual(['database'])
    expect(check(s, 'database')!.detail).toMatch(/ECONNREFUSED/)
    expect(r.checks.some((c) => c.id === 'migration')).toBe(false)
    expect(r.checks.some((c) => c.id === 'tenant')).toBe(false)
  })

  it('a fake model driver is not a pass: it makes no Gemini request, so the key check proves nothing', () => {
    const s = good({ llmDriver: 'fake' })
    expect(failing(s)).toEqual(['llm_driver'])
    expect(check(s, 'llm_driver')!.detail).toMatch(/LLM_DRIVER=fake/)
  })

  it('second review - a fake CRM driver, a CRM that reports no count, and limits that are not numbers are not a pass', () => {
    const fake = good({ crmDriver: 'fake' })
    expect(failing(fake)).toEqual(['crm_driver'])
    expect(check(fake, 'crm_driver')!.detail).toMatch(/fixtures/)
    expect(failing(good({ crm: { ok: true, total: Number.NaN } }))).toEqual(['crm'])
    const base = good().settings!
    expect(failing(good({ settings: { ...base, pilotSize: Number.NaN } }))).toContain('settings_values')
    expect(failing(good({ settings: { ...base, dailyCompanyLimit: -5 } }))).toContain('settings_values')
  })

  it('opt-out recording must be OFF (dry run) until the pilot is approved; afterwards it is information', () => {
    expect(check(good(), 'record_opt_outs')).toMatchObject({ status: 'pass' })
    const early = good({ recordOptOuts: true })
    expect(failing(early)).toEqual(['record_opt_outs'])
    expect(check(early, 'record_opt_outs')!.detail).toMatch(/must stay off for the pilot/)
    const approved = good({ recordOptOuts: true, settings: { ...good().settings!, pilotApprovedAt: new Date('2026-11-06') } })
    expect(check(approved, 'record_opt_outs')).toMatchObject({ status: 'info' })
  })

  it('the opt-out fingerprint key and our own domains: only information while recording is off; a FAIL once recording is on without them', () => {
    // recording OFF (the default): a missing key / missing domains is information - proposals are listed but cannot be approved / are not made
    const off = good({ fingerprintKeyConfigured: false, ownDomainsConfigured: false })
    expect(check(off, 'opt_out_key')).toMatchObject({ status: 'info' })
    expect(check(off, 'own_domains')).toMatchObject({ status: 'info' })
    expect(check(off, 'own_domains')!.detail).toMatch(/NO opt-out proposal is made/)
    expect(evaluateReadiness(off).ready).toBe(true)
    // recording ON after the pilot is approved: both are required
    const approvedOn = (over: Partial<ReadinessSnapshot>) => good({ recordOptOuts: true, settings: { ...good().settings!, pilotApprovedAt: new Date('2026-11-06') }, ...over })
    expect(failing(approvedOn({ fingerprintKeyConfigured: false }))).toEqual(['opt_out_key'])
    expect(check(approvedOn({ fingerprintKeyConfigured: false }), 'opt_out_key')!.detail).toMatch(/no proposal can be approved/)
    expect(failing(approvedOn({ ownDomainsConfigured: false }))).toEqual(['own_domains'])
    expect(failing(approvedOn({}))).toEqual([])
    expect(check(approvedOn({}), 'opt_out_key')).toMatchObject({ status: 'pass' })
    expect(check(approvedOn({}), 'own_domains')).toMatchObject({ status: 'pass' })
  })

  it('"paused" is not a failure while the requested pilot is queued or running', () => {
    const running = good({ pilotRunStatus: 'running', settings: { ...good().settings!, paused: false } })
    expect(check(running, 'paused')).toMatchObject({ status: 'info' })
    expect(failing(running)).toEqual([])
    // but with no pilot in progress, an unpaused system still stops it
    expect(failing(good({ settings: { ...good().settings!, paused: false } }))).toEqual(['paused'])
  })
})
