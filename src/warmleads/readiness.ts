// WARM LEADS - IS THE PILOT READY TO BE REQUESTED? Pure: no I/O.
//
// The runner (scripts/warmleads-pilot-readiness.ts) reads the configuration, the database and the CRM's size (reads only: no
// Gemini call, no write, no email) and hands a snapshot to evaluateReadiness. Every check says PASS, FAIL or INFO, and why.
// "Ready" means: nothing stands in the way of an administrator requesting the 100-company pilot. It does not request or
// start anything, and it does not decide that the pilot may start - that is the administrator's approval.
//
// A check passes only when the thing it names was actually READ and found right. Something that could not be read (the database,
// the tenant, the model driver) is a FAIL, never a pass by default.

export const PILOT_SIZE = 100
export const PILOT_GEMINI_CEILING = 1200
/** The most a normal night may be set to before a reviewed scale-up (never above 50 / 600). */
export const DAILY_COMPANIES = 25
export const DAILY_GEMINI_CEILING = 300

/**
 * Which tenant's settings were read.
 *   ok         exactly the tenant that was asked for, or the only tenant that has Warm Leads settings
 *   none       no tenant has opened Warm Leads yet (the settings row is created, paused, on first use)
 *   ambiguous  several tenants have settings and none was named: nothing can be said about any of them
 *   unknown    a tenant was named and has no Warm Leads settings: it does not exist, or the id is wrong
 */
export type TenantState = 'ok' | 'none' | 'ambiguous' | 'unknown'

/**
 * Which tenant the check is about, from what was asked (`--tenant`) and the tenants that have Warm Leads settings.
 * Nothing is reported for a tenant that was not identified: several tenants and no name, or a name that matches none, is not "ready".
 */
export function resolveTenant(asked: string | undefined, tenants: string[]): { tenantId?: string; state: TenantState; detail: string } {
  if (asked) {
    if (tenants.includes(asked)) return { tenantId: asked, state: 'ok', detail: `tenant ${asked} (named with --tenant)` }
    return { state: 'unknown', detail: `--tenant ${asked} has no Warm Leads settings (the id is wrong, or that tenant never opened Warm Leads). ${tenants.length ? `Tenants with settings: ${tenants.join(', ')}.` : 'No tenant has settings yet.'}` }
  }
  if (tenants.length === 1) return { tenantId: tenants[0], state: 'ok', detail: `tenant ${tenants[0]} (the only one with Warm Leads settings)` }
  if (tenants.length > 1) return { state: 'ambiguous', detail: `${tenants.length} tenants have Warm Leads settings (${tenants.join(', ')}) and none was named. Run again with --tenant <id>` }
  return { state: 'none', detail: 'no tenant has opened Warm Leads yet' }
}

export interface ReadinessSnapshot {
  /** A sentence about the dedicated Gemini key (never the key); null = usable. */
  geminiKeyProblem: string | null
  /** The model driver: only "real" makes Gemini calls, so only "real" can be ready for a pilot. */
  llmDriver: string
  /** The CRM driver: only "real" reads NXT Sales; a fake one reads fixtures, so its company count proves nothing. */
  crmDriver: string
  /** WARM_LEADS_RECORD_OPT_OUTS: whether opt-outs are written to the shared suppression list. Must be off until the pilot has been reviewed. */
  recordOptOuts: boolean
  /** WARM_LEADS_OPT_OUT_FINGERPRINT_KEY is set (32+ characters): without it an opt-out proposal cannot be approved. */
  fingerprintKeyConfigured: boolean
  /** Our own domains are known from server-side configuration (WARM_LEADS_OWN_DOMAINS and the configured sender addresses): without them NO proposal is made. */
  ownDomainsConfigured: boolean
  workerEnabled: boolean
  syncSwitchOn: boolean
  allowLive: boolean
  crmReadOnlyGlobal: boolean
  /** The database could be queried at all. When it could not, nothing below it was read. */
  databaseOk: boolean
  databaseError?: string
  /** The permanent module's tables exist (migration 20261104100000_warm_leads_permanent). Meaningful only when databaseOk. */
  migrationApplied: boolean
  tenant: { state: TenantState; detail: string }
  settings: null | {
    paused: boolean
    pilotSize: number
    pilotGeminiCeiling: number
    dailyCompanyLimit: number
    dailyGeminiCeiling: number
    approvedMaxCompanies: number
    approvedMaxCeiling: number
    pilotApprovedAt: Date | null
    syncEnabled: boolean
  }
  /** Status of the latest pilot run, or null when none was requested. */
  pilotRunStatus: string | null
  crm: { ok: boolean; total: number | null; error?: string }
  /** Available memory in MB; null where it cannot be measured (not Linux). */
  availableMb: number | null
  minAvailableMb: number
  windowOpenNow: boolean
}

export interface Check {
  id: string
  label: string
  status: 'pass' | 'fail' | 'info'
  detail: string
}

export function evaluateReadiness(s: ReadinessSnapshot): { checks: Check[]; ready: boolean } {
  const checks: Check[] = []
  const add = (id: string, label: string, status: Check['status'], detail: string) => checks.push({ id, label, status, detail })

  add('database', 'The database can be reached', s.databaseOk ? 'pass' : 'fail', s.databaseOk ? 'reachable' : `the database could not be queried${s.databaseError ? `: ${s.databaseError}` : ''}. Nothing that depends on it was checked`)
  if (s.databaseOk) {
    add('migration', 'Database tables of the permanent module', s.migrationApplied ? 'pass' : 'fail', s.migrationApplied ? 'present' : 'migration 20261104100000_warm_leads_permanent is not applied')
  }

  add('gemini_key', 'Warm Leads has its own Gemini key', s.geminiKeyProblem ? 'fail' : 'pass', s.geminiKeyProblem ?? 'set, and different from the shared key (never used for anything else)')
  add('llm_driver', 'The model driver is the real one', s.llmDriver === 'real' ? 'pass' : 'fail', s.llmDriver === 'real' ? 'LLM_DRIVER=real' : `LLM_DRIVER=${s.llmDriver}: no Gemini request would be made, so the key above proves nothing`)

  add('crm_driver', 'The CRM driver is the real one', s.crmDriver === 'real' ? 'pass' : 'fail', s.crmDriver === 'real' ? 'CRM_DRIVER=real' : `CRM_DRIVER=${s.crmDriver}: the company list would come from test fixtures, not from NXT Sales`)

  const syncOff = !s.syncSwitchOn && !(s.settings?.syncEnabled ?? false)
  add('sync_off', 'Nothing is sent to NXT Sales', syncOff ? 'pass' : 'fail', syncOff ? 'WARM_LEADS_SYNC_ENABLED is off and sending is not approved' : 'sending to NXT Sales is switched on: it stays off until the pilot is reviewed and you approve it')

  const pilotApproved = Boolean(s.settings?.pilotApprovedAt)
  add(
    'record_opt_outs',
    'Opt-outs are only proposed (dry run), not written to the suppression list',
    !s.recordOptOuts ? 'pass' : pilotApproved ? 'info' : 'fail',
    !s.recordOptOuts
      ? 'WARM_LEADS_RECORD_OPT_OUTS is off: each evaluation lists the masked address it proposes and writes nothing'
      : pilotApproved
        ? 'WARM_LEADS_RECORD_OPT_OUTS is on: explicit opt-outs found in replies are proposed and an administrator approves each one before it is added to the shared suppression list (nothing is added automatically)'
        : 'WARM_LEADS_RECORD_OPT_OUTS is on before the pilot was reviewed and approved: it must stay off for the pilot',
  )
  // Approving a proposal needs the dedicated fingerprint key; proposing one needs to know which domains are ours. Both fail closed in the code; this says so before it matters.
  add(
    'opt_out_key',
    'The opt-out fingerprint key is set (a dedicated key - never JWT_SECRET)',
    s.fingerprintKeyConfigured ? 'pass' : s.recordOptOuts ? 'fail' : 'info',
    s.fingerprintKeyConfigured ? 'WARM_LEADS_OPT_OUT_FINGERPRINT_KEY is set' : s.recordOptOuts ? 'recording is on but WARM_LEADS_OPT_OUT_FINGERPRINT_KEY is not set: no proposal can be approved' : 'WARM_LEADS_OPT_OUT_FINGERPRINT_KEY is not set: proposals are listed but cannot be approved until it is',
  )
  add(
    'own_domains',
    'Our own domains are configured (server side) for the opt-out sender check',
    s.ownDomainsConfigured ? 'pass' : s.recordOptOuts ? 'fail' : 'info',
    s.ownDomainsConfigured ? 'own domains are known from server-side configuration' : 'no own domain is configured (WARM_LEADS_OWN_DOMAINS or a configured sender address): ownership is unknown, so NO opt-out proposal is made - every opt-out is listed as "not recorded"',
  )

  add('live_write', 'Writing to the live NXT Sales is not allowed', s.allowLive ? 'fail' : 'pass', s.allowLive ? 'WARM_LEADS_ALLOW_LIVE is on' : 'WARM_LEADS_ALLOW_LIVE is off')

  if (s.crmReadOnlyGlobal) add('crm_read_only', 'Global CRM read-only switch', 'info', 'CRM_READ_ONLY=true: the whole platform is read-only towards NXT Sales (compatible with the pilot)')

  // WHICH tenant: no settings are reported for a tenant that was not identified. An unknown or ambiguous tenant is a FAIL.
  if (s.databaseOk && s.migrationApplied) {
    add('tenant', 'The tenant that was checked', s.tenant.state === 'ok' ? 'pass' : 'fail', s.tenant.state === 'none' ? `${s.tenant.detail}: Warm Leads setup has not been completed for any tenant, so nothing (pause, limits, sync, model driver) was checked for a tenant` : s.tenant.detail)
  }

  if (!s.settings) {
    if (s.tenant.state === 'none') {
      if (s.databaseOk && s.migrationApplied) add('settings', 'Controls', 'fail', 'no Warm Leads settings row yet (it is created, paused, the first time an administrator opens the Warm Leads screen): setup is not complete, so the controls were not checked')
    } else if (s.databaseOk && s.migrationApplied) add('settings', 'Controls', 'fail', 'the controls (paused, limits, sending) could not be read for any tenant, so none of them was checked')
  } else {
    const pilotActive = s.pilotRunStatus === 'queued' || s.pilotRunStatus === 'running'
    if (pilotActive) add('paused', 'Processing is paused', 'info', s.settings.paused ? 'paused, and the pilot is already requested: it runs only while processing is started' : 'NOT paused, and a pilot is queued or running (that is expected while it runs)')
    else add('paused', 'Processing is paused', s.settings.paused ? 'pass' : 'fail', s.settings.paused ? 'paused (nothing runs until an administrator presses Start)' : 'NOT paused: the worker would start as soon as it is switched on')
    const numbers = [s.settings.pilotSize, s.settings.pilotGeminiCeiling, s.settings.dailyCompanyLimit, s.settings.dailyGeminiCeiling, s.settings.approvedMaxCompanies, s.settings.approvedMaxCeiling]
    if (numbers.some((n) => !Number.isFinite(n) || n < 0)) add('settings_values', 'The limits are numbers', 'fail', 'a limit is missing, not a number or negative')
    const over = s.settings.pilotSize > PILOT_SIZE || s.settings.pilotGeminiCeiling > PILOT_GEMINI_CEILING
    const under = s.settings.pilotSize < PILOT_SIZE || s.settings.pilotGeminiCeiling < PILOT_GEMINI_CEILING
    add(
      'pilot_limits',
      `Pilot limits are at most ${PILOT_SIZE} companies / ${PILOT_GEMINI_CEILING.toLocaleString('en-US')} Gemini calls`,
      over ? 'fail' : under ? 'info' : 'pass',
      `${s.settings.pilotSize} companies / ${s.settings.pilotGeminiCeiling.toLocaleString('en-US')} calls${under && !over ? ' (below the standard pilot: allowed, but the sample will be smaller)' : ''}`,
    )
    const dailyOk = s.settings.dailyCompanyLimit <= DAILY_COMPANIES && s.settings.dailyGeminiCeiling <= DAILY_GEMINI_CEILING && s.settings.approvedMaxCompanies <= DAILY_COMPANIES && s.settings.approvedMaxCeiling <= DAILY_GEMINI_CEILING
    add('daily_limits', `Daily limits are at most ${DAILY_COMPANIES} companies / ${DAILY_GEMINI_CEILING} calls`, dailyOk ? 'pass' : 'fail', `${s.settings.dailyCompanyLimit} / ${s.settings.dailyGeminiCeiling} (approved maximum ${s.settings.approvedMaxCompanies} / ${s.settings.approvedMaxCeiling})`)
    add('daily_off', 'Daily processing has not been approved', s.settings.pilotApprovedAt ? 'info' : 'pass', s.settings.pilotApprovedAt ? 'the pilot was already approved: daily processing can be started by an administrator' : 'no: it cannot start before the pilot is reviewed and approved')
  }

  const pilotState = s.pilotRunStatus
  add('pilot_state', 'The pilot', pilotState === null || pilotState === 'failed' ? 'pass' : 'info', pilotState === null ? 'not requested yet' : pilotState === 'failed' ? 'the last attempt failed and can be requested again' : `already ${pilotState}`)

  if (!s.crm.ok) add('crm', 'NXT Sales company list can be read', 'fail', s.crm.error ?? 'the company list could not be read')
  else if (!Number.isFinite(s.crm.total ?? Number.NaN)) add('crm', 'NXT Sales company list can be read', 'fail', 'NXT Sales did not report how many companies it holds')
  else if ((s.crm.total ?? 0) < PILOT_SIZE) add('crm', 'NXT Sales company list can be read', 'fail', `${s.crm.total ?? 0} companies: fewer than the ${PILOT_SIZE} the pilot needs`)
  else add('crm', 'NXT Sales company list can be read', 'pass', `${(s.crm.total ?? 0).toLocaleString('en-US')} companies (read-only request)`)

  if (s.availableMb === null) add('memory', 'Memory', 'info', 'not measurable on this machine; the server enforces it')
  else add('memory', `At least ${s.minAvailableMb} MB available`, s.availableMb >= s.minAvailableMb ? 'pass' : 'fail', `${s.availableMb} MB available now`)

  add('worker_flag', 'The Warm Leads worker switch', 'info', s.workerEnabled ? 'WARM_LEADS_WORKER_ENABLED is on' : 'WARM_LEADS_WORKER_ENABLED is off: switch it on only when you approve starting the pilot')
  add('window', 'Processing window', 'info', s.windowOpenNow ? 'open now (11 PM to 6 AM Asia/Kolkata by default)' : 'closed now: the worker only evaluates inside its window')

  return { checks, ready: checks.every((c) => c.status !== 'fail') }
}
