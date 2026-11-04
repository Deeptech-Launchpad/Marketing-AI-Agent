// SAFETY CHECKS FOR THE ISOLATED 30-COMPANY WARM-LEAD TEST (2026-11-03). Pure: no I/O.
//
// The test reads the live CRM and spends Gemini calls on a shared server, so it
// refuses to start unless EVERY check below passes, and says which one failed.
// The runner (scripts/warmleads-isolated-test.ts) gathers a snapshot of the real
// settings and the machine and hands it to evaluateSafetyChecks; nothing here
// can be argued with at run time.

export const MIN_START_AVAILABLE_MB = 4096 // do not start below 4 GB available
export const MIN_RUN_AVAILABLE_MB = 3072 // stop safely below 3 GB available
export const CGROUP_MEMORY_BYTES = 1_610_612_736 // 1.5 GiB
export const CGROUP_CPU_QUOTA_PCT = 100 // one core
export const GEMINI_CEILING = 60
export const RESEARCH_COMPANY_CAP = 15
export const SAMPLE_COMPANIES = 30
export const TEST_DATABASE = 'marketing_warmtest'
/** A token for the CRM may live at most this long, and must have at least this long left when the run starts. */
export const TOKEN_MAX_SECONDS = 6 * 3600
export const TOKEN_MIN_SECONDS_AT_START = 90 * 60

/** Settings that carry the ability to send an email or reach another service as the company. None may be present. */
export const SENDING_CREDENTIALS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'BULK_SMTP_HOST', 'BULK_SMTP_USER', 'BULK_SMTP_PASS', 'APIFY_TOKEN', 'APOLLO_API_KEY', 'HUNTER_API_KEY', 'ZOOMINFO_PASSWORD', 'ZOOMINFO_CLIENT_ID', 'ROCKETREACH_API_KEY', 'LINKEDIN_ACCESS_TOKEN', 'VERIFALIA_PASSWORD', 'ENGAGEMENT_WEBHOOK_SECRET'] as const

/** MemAvailable from /proc/meminfo, in MB. */
export function parseMemAvailableMb(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo)
  return m ? Math.floor(Number(m[1]) / 1024) : null
}

export function memoryVerdict(availableMb: number | null, phase: 'start' | 'run'): { ok: boolean; minMb: number } {
  const minMb = phase === 'start' ? MIN_START_AVAILABLE_MB : MIN_RUN_AVAILABLE_MB
  return { ok: availableMb !== null && availableMb >= minMb, minMb }
}

/** Whether `now` is inside 11 PM – 6 AM Asia/Kolkata. */
export function istWindowOpen(now: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now)) % 24
  return hour >= 23 || hour < 6
}

/** Seconds left on a JWT, read from its payload without verifying it (no secret involved); null when unreadable. */
export function tokenSecondsRemaining(jwt: string, now: Date = new Date()): number | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }).exp
    return typeof exp === 'number' ? Math.floor(exp - now.getTime() / 1000) : null
  } catch {
    return null
  }
}

/** A secret shown as its length only. */
export const redactSecret = (v: string | undefined): string => (v ? `<redacted, ${v.length} chars>` : '<not set>')

/** A database URL without its password. */
export function redactDatabaseUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.password) u.password = '<redacted>'
    return u.toString().replace('%3Credacted%3E', '<redacted>')
  } catch {
    return '<unreadable>'
  }
}

export interface SafetySnapshot {
  env: {
    CRM_READ_ONLY: boolean
    CRM_WRITE_ENABLED: boolean
    CRM_WRITE_ALLOW_LIVE: boolean
    WARM_LEADS_SYNC_ENABLED: boolean
    WARM_LEADS_ALLOW_LIVE: boolean
    BULK_EMAIL_ENABLED: boolean
    DM_AUTO_DISCOVER_ENABLED: boolean
    INTENT_MONITOR_ENABLED: boolean
    OUTREACH_EMAIL_MODE: string
    BULK_SEND_VIA: string
    GEMINI_CALL_CEILING: number
    WARM_LEADS_DEEP_MAX_PER_RUN: number
    WARM_LEADS_REPLY_PROBE_CAP: number
    WARM_LEADS_SAMPLE_SEED: number
    NXT_SALES_MAX_CONCURRENCY: number
    GEMINI_MAX_CONCURRENCY: number
    PUBLIC_RESEARCH_ENABLED: boolean
  }
  /** MARKETING_DATABASE_URL as given. */
  databaseUrl: string
  /** The pool size the client will really use (after pooledDatabaseUrl). */
  dbPoolSize: number | null
  /** Names from SENDING_CREDENTIALS that are set to a non-empty value. */
  sendingCredentialsPresent: string[]
  staticTokenSet: boolean
  tokenSecondsRemaining: number | null
  availableMb: number | null
  cgroup: { memoryMaxBytes: number | null; cpuQuotaPct: number | null }
  /** The database the connection really reports, once connected (null before). */
  connectedDatabase: string | null
  /** Is the clock inside the allowed window, and is the window being enforced? */
  windowOpen: boolean
  windowEnforced: boolean
  canaries: {
    /** The hardened reader is the code that loaded: port rule, NAT64/198.18 ranges, pinned lookup. */
    hardenedReader: boolean
    /** read-only mode refuses every write method and unlisted path, with no request made. */
    readOnlyGuard: boolean
    /** The Gemini ceiling is active and nothing has been spent yet. */
    ceilingActive: boolean
  }
}

export interface SafetyCheck {
  name: string
  ok: boolean
  detail: string
}

export function evaluateSafetyChecks(s: SafetySnapshot): SafetyCheck[] {
  const out: SafetyCheck[] = []
  const check = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail })
  const e = s.env

  // CRM: read-only
  check('CRM read-only mode is on', e.CRM_READ_ONLY === true, `CRM_READ_ONLY=${e.CRM_READ_ONLY}`)
  check('every CRM and warm-lead write switch is off', !e.CRM_WRITE_ENABLED && !e.CRM_WRITE_ALLOW_LIVE && !e.WARM_LEADS_SYNC_ENABLED && !e.WARM_LEADS_ALLOW_LIVE, `CRM_WRITE_ENABLED=${e.CRM_WRITE_ENABLED} CRM_WRITE_ALLOW_LIVE=${e.CRM_WRITE_ALLOW_LIVE} WARM_LEADS_SYNC_ENABLED=${e.WARM_LEADS_SYNC_ENABLED} WARM_LEADS_ALLOW_LIVE=${e.WARM_LEADS_ALLOW_LIVE}`)
  check('the transport refuses writes and unlisted paths', s.canaries.readOnlyGuard, 'POST/PUT/PATCH/DELETE/HEAD, other origins, redirects and unlisted endpoints are refused before any request')
  check('no shared JWT_SECRET is needed: a short-lived token is used', s.staticTokenSet, s.staticTokenSet ? 'NXT_SALES_STATIC_TOKEN is set' : 'NXT_SALES_STATIC_TOKEN is not set')
  check(
    'the CRM token is short-lived and still valid',
    s.tokenSecondsRemaining !== null && s.tokenSecondsRemaining >= TOKEN_MIN_SECONDS_AT_START && s.tokenSecondsRemaining <= TOKEN_MAX_SECONDS,
    s.tokenSecondsRemaining === null ? 'expiry unreadable' : `${Math.round(s.tokenSecondsRemaining / 60)} minutes left (allowed ${TOKEN_MIN_SECONDS_AT_START / 60}–${TOKEN_MAX_SECONDS / 60})`,
  )

  // Mail, campaigns, scheduled work
  check('email sending and campaigns are off', !e.BULK_EMAIL_ENABLED && e.OUTREACH_EMAIL_MODE === 'off' && e.BULK_SEND_VIA === 'smtp', `BULK_EMAIL_ENABLED=${e.BULK_EMAIL_ENABLED} OUTREACH_EMAIL_MODE=${e.OUTREACH_EMAIL_MODE} BULK_SEND_VIA=${e.BULK_SEND_VIA}`)
  check('scheduled jobs are off', !e.DM_AUTO_DISCOVER_ENABLED && !e.INTENT_MONITOR_ENABLED, `DM_AUTO_DISCOVER_ENABLED=${e.DM_AUTO_DISCOVER_ENABLED} INTENT_MONITOR_ENABLED=${e.INTENT_MONITOR_ENABLED}`)
  check('no sending or third-party credentials are present', s.sendingCredentialsPresent.length === 0, s.sendingCredentialsPresent.length ? `present: ${s.sendingCredentialsPresent.join(', ')}` : `none of ${SENDING_CREDENTIALS.length} checked names is set`)

  // Database isolation
  let host = ''
  let dbName = ''
  try {
    const u = new URL(s.databaseUrl)
    host = u.hostname
    dbName = u.pathname.replace(/^\//, '')
  } catch {
    /* unreadable stays empty and fails below */
  }
  check('the database is the isolated test database on this server', dbName === TEST_DATABASE && (host === '127.0.0.1' || host === 'localhost'), `database=${dbName || '?'} host=${host || '?'}`)
  check('the connection really reports the test database', s.connectedDatabase === TEST_DATABASE, `current_database()=${s.connectedDatabase ?? 'not connected yet'}`)
  check('database pool is 3 connections', s.dbPoolSize === 3, `pool=${s.dbPoolSize ?? '?'}`)

  // Limits
  check('Gemini call ceiling is 60 and nothing is spent yet', e.GEMINI_CALL_CEILING === GEMINI_CEILING && s.canaries.ceilingActive, `GEMINI_CALL_CEILING=${e.GEMINI_CALL_CEILING}`)
  check('research cap is 15 companies and web research is on', e.WARM_LEADS_DEEP_MAX_PER_RUN === RESEARCH_COMPANY_CAP && e.PUBLIC_RESEARCH_ENABLED === true, `WARM_LEADS_DEEP_MAX_PER_RUN=${e.WARM_LEADS_DEEP_MAX_PER_RUN} PUBLIC_RESEARCH_ENABLED=${e.PUBLIC_RESEARCH_ENABLED}`)
  check('CRM concurrency is 2', e.NXT_SALES_MAX_CONCURRENCY === 2, `NXT_SALES_MAX_CONCURRENCY=${e.NXT_SALES_MAX_CONCURRENCY}`)
  check('Gemini concurrency is at most 2', e.GEMINI_MAX_CONCURRENCY <= 2, `GEMINI_MAX_CONCURRENCY=${e.GEMINI_MAX_CONCURRENCY}`)
  check('the fixed sample seed is unchanged', e.WARM_LEADS_SAMPLE_SEED === 20261031, `WARM_LEADS_SAMPLE_SEED=${e.WARM_LEADS_SAMPLE_SEED}`)

  // The machine
  const mem = memoryVerdict(s.availableMb, 'start')
  check('at least 4 GB of memory is available to start', mem.ok, `${s.availableMb ?? '?'} MB available (need ${mem.minMb})`)
  check('the 1.5 GB memory limit is in force', s.cgroup.memoryMaxBytes === CGROUP_MEMORY_BYTES, `memory.max=${s.cgroup.memoryMaxBytes ?? 'none'}`)
  check('the CPU quota is 100% of one core', s.cgroup.cpuQuotaPct === CGROUP_CPU_QUOTA_PCT, `cpu quota=${s.cgroup.cpuQuotaPct ?? 'none'}%`)

  // The code
  check('the SSRF-hardened reader is the code that loaded', s.canaries.hardenedReader, 'ports 80/443 only, NAT64 and 198.18.0.0/15 blocked, pinned lookup present')

  // The window
  check('inside the 11 PM – 6 AM IST window', !s.windowEnforced || s.windowOpen, s.windowEnforced ? (s.windowOpen ? 'inside the window' : 'outside the window') : 'window not enforced for this check')
  return out
}

/** The runner starts only when every check passes. */
export const allPass = (checks: SafetyCheck[]): boolean => checks.every((c) => c.ok)
