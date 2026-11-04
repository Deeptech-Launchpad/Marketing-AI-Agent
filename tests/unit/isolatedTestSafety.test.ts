import { describe, expect, it } from 'vitest'
import {
  allPass,
  CGROUP_MEMORY_BYTES,
  evaluateSafetyChecks,
  istWindowOpen,
  memoryVerdict,
  parseMemAvailableMb,
  redactDatabaseUrl,
  redactSecret,
  tokenSecondsRemaining,
  type SafetySnapshot,
} from '../../src/warmleads/isolatedTestSafety.js'

// The isolated test starts only when EVERY check passes. A single failing
// field must fail the one check that names it.

const jwtExpiringIn = (seconds: number, now = new Date('2026-11-03T18:00:00Z')) =>
  `h.${Buffer.from(JSON.stringify({ id: 'svc', exp: Math.floor(now.getTime() / 1000) + seconds })).toString('base64url')}.s`

const GOOD: SafetySnapshot = {
  env: {
    CRM_READ_ONLY: true,
    CRM_WRITE_ENABLED: false,
    CRM_WRITE_ALLOW_LIVE: false,
    WARM_LEADS_SYNC_ENABLED: false,
    WARM_LEADS_ALLOW_LIVE: false,
    BULK_EMAIL_ENABLED: false,
    DM_AUTO_DISCOVER_ENABLED: false,
    INTENT_MONITOR_ENABLED: false,
    OUTREACH_EMAIL_MODE: 'off',
    BULK_SEND_VIA: 'smtp',
    GEMINI_CALL_CEILING: 60,
    WARM_LEADS_DEEP_MAX_PER_RUN: 15,
    WARM_LEADS_REPLY_PROBE_CAP: 600,
    WARM_LEADS_SAMPLE_SEED: 20261031,
    NXT_SALES_MAX_CONCURRENCY: 2,
    GEMINI_MAX_CONCURRENCY: 2,
    PUBLIC_RESEARCH_ENABLED: true,
  },
  databaseUrl: 'postgresql://warmtest_user:secret@127.0.0.1:5433/marketing_warmtest?schema=marketing',
  dbPoolSize: 3,
  sendingCredentialsPresent: [],
  staticTokenSet: true,
  tokenSecondsRemaining: 3 * 3600,
  availableMb: 8000,
  cgroup: { memoryMaxBytes: CGROUP_MEMORY_BYTES, cpuQuotaPct: 100 },
  connectedDatabase: 'marketing_warmtest',
  windowOpen: true,
  windowEnforced: true,
  canaries: { hardenedReader: true, readOnlyGuard: true, ceilingActive: true },
}
const clone = (): SafetySnapshot => JSON.parse(JSON.stringify(GOOD))

describe('the memory rules', () => {
  it('reads MemAvailable from /proc/meminfo', () => {
    expect(parseMemAvailableMb('MemTotal:       32867840 kB\nMemFree:          892000 kB\nMemAvailable:    8411136 kB\nBuffers: 1 kB')).toBe(8214)
    expect(parseMemAvailableMb('nothing here')).toBeNull()
  })
  it('start needs 4 GB, a running test must stop below 3 GB', () => {
    expect(memoryVerdict(4096, 'start').ok).toBe(true)
    expect(memoryVerdict(4095, 'start').ok).toBe(false)
    expect(memoryVerdict(3072, 'run').ok).toBe(true)
    expect(memoryVerdict(3071, 'run').ok).toBe(false)
    expect(memoryVerdict(null, 'start').ok).toBe(false) // unknown is not safe
    expect(memoryVerdict(null, 'run').ok).toBe(false)
  })
})

describe('the execution window (11 PM – 6 AM Asia/Kolkata)', () => {
  it('opens at 23:00 IST and closes at 06:00 IST', () => {
    const at = (iso: string) => istWindowOpen(new Date(iso))
    expect(at('2026-11-03T17:29:59Z')).toBe(false) // 22:59:59 IST
    expect(at('2026-11-03T17:30:00Z')).toBe(true) // 23:00 IST
    expect(at('2026-11-03T20:00:00Z')).toBe(true) // 01:30 IST
    expect(at('2026-11-04T00:29:59Z')).toBe(true) // 05:59:59 IST
    expect(at('2026-11-04T00:30:00Z')).toBe(false) // 06:00 IST
    expect(at('2026-11-04T06:00:00Z')).toBe(false) // 11:30 IST
    expect(at('2026-11-04T12:00:00Z')).toBe(false) // 17:30 IST
  })
})

describe('the token', () => {
  it('reads the expiry without any secret', () => {
    const now = new Date('2026-11-03T18:00:00Z')
    expect(tokenSecondsRemaining(jwtExpiringIn(3600, now), now)).toBe(3600)
    expect(tokenSecondsRemaining(jwtExpiringIn(-10, now), now)).toBe(-10)
    expect(tokenSecondsRemaining('garbage', now)).toBeNull()
    expect(tokenSecondsRemaining('a.b.c', now)).toBeNull()
    expect(tokenSecondsRemaining(`h.${Buffer.from('{}').toString('base64url')}.s`, now)).toBeNull()
  })
})

describe('redaction', () => {
  it('shows a secret as its length only and a database URL without its password', () => {
    expect(redactSecret('abcdefgh')).toBe('<redacted, 8 chars>')
    expect(redactSecret('')).toBe('<not set>')
    const r = redactDatabaseUrl('postgresql://user:hunter2@127.0.0.1:5433/db?schema=marketing')
    expect(r).not.toContain('hunter2')
    expect(r).toContain('<redacted>')
    expect(r).toContain('127.0.0.1:5433/db')
  })
})

describe('the safety checks', () => {
  it('pass on the approved configuration', () => {
    const checks = evaluateSafetyChecks(GOOD)
    expect(checks.filter((c) => !c.ok)).toEqual([])
    expect(allPass(checks)).toBe(true)
    expect(checks.length).toBeGreaterThanOrEqual(20)
  })

  // [description, change to make, the check that must fail]
  const failures: Array<[string, (s: SafetySnapshot) => void, RegExp]> = [
    ['read-only mode off', (s) => (s.env.CRM_READ_ONLY = false), /read-only mode is on/],
    ['CRM_WRITE_ENABLED on', (s) => (s.env.CRM_WRITE_ENABLED = true), /write switch is off/],
    ['CRM_WRITE_ALLOW_LIVE on', (s) => (s.env.CRM_WRITE_ALLOW_LIVE = true), /write switch is off/],
    ['warm-lead sync on', (s) => (s.env.WARM_LEADS_SYNC_ENABLED = true), /write switch is off/],
    ['warm-lead live sync on', (s) => (s.env.WARM_LEADS_ALLOW_LIVE = true), /write switch is off/],
    ['transport guard does not block', (s) => (s.canaries.readOnlyGuard = false), /refuses writes/],
    ['no static token (would need JWT_SECRET)', (s) => (s.staticTokenSet = false), /JWT_SECRET is needed/],
    ['token expiry unreadable', (s) => (s.tokenSecondsRemaining = null), /short-lived/],
    ['token too long-lived (8 h)', (s) => (s.tokenSecondsRemaining = 8 * 3600), /short-lived/],
    ['token nearly expired (30 min)', (s) => (s.tokenSecondsRemaining = 30 * 60), /short-lived/],
    ['bulk email on', (s) => (s.env.BULK_EMAIL_ENABLED = true), /email sending and campaigns are off/],
    ['outreach test mode', (s) => (s.env.OUTREACH_EMAIL_MODE = 'test'), /email sending and campaigns are off/],
    ['bulk send via the CRM', (s) => (s.env.BULK_SEND_VIA = 'crm'), /email sending and campaigns are off/],
    ['auto decision-maker discovery on', (s) => (s.env.DM_AUTO_DISCOVER_ENABLED = true), /scheduled jobs are off/],
    ['intent monitor on', (s) => (s.env.INTENT_MONITOR_ENABLED = true), /scheduled jobs are off/],
    ['SMTP credentials present', (s) => (s.sendingCredentialsPresent = ['SMTP_PASS']), /no sending or third-party credentials/],
    ['production database name', (s) => (s.databaseUrl = 'postgresql://u:p@127.0.0.1:5433/marketing_agent?schema=marketing'), /isolated test database/],
    ['remote database host', (s) => (s.databaseUrl = 'postgresql://u:p@db.example.com:5432/marketing_warmtest'), /isolated test database/],
    ['unreadable database URL', (s) => (s.databaseUrl = 'nope'), /isolated test database/],
    ['connected to another database', (s) => (s.connectedDatabase = 'marketing_agent'), /really reports/],
    ['not connected yet', (s) => (s.connectedDatabase = null), /really reports/],
    ['pool of 5', (s) => (s.dbPoolSize = 5), /pool is 3/],
    ['no Gemini ceiling', (s) => (s.env.GEMINI_CALL_CEILING = 0), /ceiling is 60/],
    ['Gemini ceiling 100', (s) => (s.env.GEMINI_CALL_CEILING = 100), /ceiling is 60/],
    ['ceiling already spent', (s) => (s.canaries.ceilingActive = false), /ceiling is 60/],
    ['research cap 10', (s) => (s.env.WARM_LEADS_DEEP_MAX_PER_RUN = 10), /research cap is 15/],
    ['research cap 20', (s) => (s.env.WARM_LEADS_DEEP_MAX_PER_RUN = 20), /research cap is 15/],
    ['web research off', (s) => (s.env.PUBLIC_RESEARCH_ENABLED = false), /research cap is 15/],
    ['CRM concurrency 4', (s) => (s.env.NXT_SALES_MAX_CONCURRENCY = 4), /CRM concurrency is 2/],
    ['Gemini concurrency 4', (s) => (s.env.GEMINI_MAX_CONCURRENCY = 4), /Gemini concurrency/],
    ['another sample seed', (s) => (s.env.WARM_LEADS_SAMPLE_SEED = 7), /seed is unchanged/],
    ['4095 MB available', (s) => (s.availableMb = 4095), /4 GB of memory/],
    ['memory unknown', (s) => (s.availableMb = null), /4 GB of memory/],
    ['no memory limit', (s) => (s.cgroup.memoryMaxBytes = null), /1.5 GB memory limit/],
    ['2 GB memory limit', (s) => (s.cgroup.memoryMaxBytes = 2 * 1024 ** 3), /1.5 GB memory limit/],
    ['CPU quota 200%', (s) => (s.cgroup.cpuQuotaPct = 200), /CPU quota/],
    ['no CPU quota', (s) => (s.cgroup.cpuQuotaPct = null), /CPU quota/],
    ['hardened reader not loaded', (s) => (s.canaries.hardenedReader = false), /SSRF-hardened reader/],
    ['outside the window', (s) => (s.windowOpen = false), /11 PM/],
  ]
  for (const [name, change, expected] of failures) {
    it(`fails when: ${name}`, () => {
      const s = clone()
      change(s)
      const checks = evaluateSafetyChecks(s)
      const failed = checks.filter((c) => !c.ok)
      expect(failed.length, name).toBeGreaterThanOrEqual(1)
      expect(failed.some((c) => expected.test(c.name)), `${name}: expected a failing check matching ${expected}, got ${failed.map((c) => c.name).join(' | ')}`).toBe(true)
      expect(allPass(checks)).toBe(false)
    })
  }

  it('the window can be switched off only for a check that says so (not for the real run)', () => {
    const s = clone()
    s.windowOpen = false
    s.windowEnforced = false
    expect(allPass(evaluateSafetyChecks(s))).toBe(true)
    s.windowEnforced = true
    expect(allPass(evaluateSafetyChecks(s))).toBe(false)
  })
})
