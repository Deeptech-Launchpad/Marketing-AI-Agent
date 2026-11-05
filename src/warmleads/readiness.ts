// WARM LEADS - IS THE PILOT READY TO BE REQUESTED? Pure: no I/O.
//
// The runner (scripts/warmleads-pilot-readiness.ts) reads the configuration, the database and the CRM's size (reads only: no
// Gemini call, no write, no email) and hands a snapshot to evaluateReadiness. Every check says PASS, FAIL or INFO, and why.
// "Ready" means: nothing stands in the way of an administrator requesting the 100-company pilot. It does not request or
// start anything, and it does not decide that the pilot may start - that is the administrator's approval.

export const PILOT_SIZE = 100
export const PILOT_GEMINI_CEILING = 1200
/** The most a normal night may be set to before a reviewed scale-up (never above 50 / 600). */
export const DAILY_COMPANIES = 25
export const DAILY_GEMINI_CEILING = 300

export interface ReadinessSnapshot {
  /** A sentence about the dedicated Gemini key (never the key); null = usable. */
  geminiKeyProblem: string | null
  workerEnabled: boolean
  syncSwitchOn: boolean
  allowLive: boolean
  crmReadOnlyGlobal: boolean
  /** The permanent module's tables exist (migration 20261104100000_warm_leads_permanent). */
  migrationApplied: boolean
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

  add('migration', 'Database tables of the permanent module', s.migrationApplied ? 'pass' : 'fail', s.migrationApplied ? 'present' : 'migration 20261104100000_warm_leads_permanent is not applied')

  add('gemini_key', 'Warm Leads has its own Gemini key', s.geminiKeyProblem ? 'fail' : 'pass', s.geminiKeyProblem ?? 'set, and different from the shared key (never used for anything else)')

  const syncOff = !s.syncSwitchOn && !(s.settings?.syncEnabled ?? false)
  add('sync_off', 'Nothing is sent to NXT Sales', syncOff ? 'pass' : 'fail', syncOff ? 'WARM_LEADS_SYNC_ENABLED is off and sending is not approved' : 'sending to NXT Sales is switched on: it stays off until the pilot is reviewed and you approve it')

  add('live_write', 'Writing to the live NXT Sales is not allowed', s.allowLive ? 'fail' : 'pass', s.allowLive ? 'WARM_LEADS_ALLOW_LIVE is on' : 'WARM_LEADS_ALLOW_LIVE is off')

  if (s.crmReadOnlyGlobal) add('crm_read_only', 'Global CRM read-only switch', 'info', 'CRM_READ_ONLY=true: the whole platform is read-only towards NXT Sales (compatible with the pilot)')

  if (!s.settings) {
    add('settings', 'Controls', 'info', 'no Warm Leads settings row yet: it is created, paused, the first time the Warm Leads screen is opened')
  } else {
    add('paused', 'Processing is paused', s.settings.paused ? 'pass' : 'fail', s.settings.paused ? 'paused (nothing runs until an administrator presses Start)' : 'NOT paused: the worker would start as soon as it is switched on')
    const pilotOk = s.settings.pilotSize === PILOT_SIZE && s.settings.pilotGeminiCeiling === PILOT_GEMINI_CEILING
    add('pilot_limits', `Pilot limits are ${PILOT_SIZE} companies / ${PILOT_GEMINI_CEILING.toLocaleString('en-US')} Gemini calls`, pilotOk ? 'pass' : 'fail', `${s.settings.pilotSize} companies / ${s.settings.pilotGeminiCeiling.toLocaleString('en-US')} calls`)
    const dailyOk = s.settings.dailyCompanyLimit <= DAILY_COMPANIES && s.settings.dailyGeminiCeiling <= DAILY_GEMINI_CEILING && s.settings.approvedMaxCompanies <= DAILY_COMPANIES && s.settings.approvedMaxCeiling <= DAILY_GEMINI_CEILING
    add('daily_limits', `Daily limits are at most ${DAILY_COMPANIES} companies / ${DAILY_GEMINI_CEILING} calls`, dailyOk ? 'pass' : 'fail', `${s.settings.dailyCompanyLimit} / ${s.settings.dailyGeminiCeiling} (approved maximum ${s.settings.approvedMaxCompanies} / ${s.settings.approvedMaxCeiling})`)
    add('daily_off', 'Daily processing has not been approved', s.settings.pilotApprovedAt ? 'info' : 'pass', s.settings.pilotApprovedAt ? 'the pilot was already approved: daily processing can be started by an administrator' : 'no: it cannot start before the pilot is reviewed and approved')
  }

  const pilotState = s.pilotRunStatus
  add('pilot_state', 'The pilot', pilotState === null || pilotState === 'failed' ? 'pass' : 'info', pilotState === null ? 'not requested yet' : pilotState === 'failed' ? 'the last attempt failed and can be requested again' : `already ${pilotState}`)

  if (!s.crm.ok) add('crm', 'NXT Sales company list can be read', 'fail', s.crm.error ?? 'the company list could not be read')
  else if ((s.crm.total ?? 0) < PILOT_SIZE) add('crm', 'NXT Sales company list can be read', 'fail', `${s.crm.total ?? 0} companies: fewer than the ${PILOT_SIZE} the pilot needs`)
  else add('crm', 'NXT Sales company list can be read', 'pass', `${(s.crm.total ?? 0).toLocaleString('en-US')} companies (read-only request)`)

  if (s.availableMb === null) add('memory', 'Memory', 'info', 'not measurable on this machine; the server enforces it')
  else add('memory', `At least ${s.minAvailableMb} MB available`, s.availableMb >= s.minAvailableMb ? 'pass' : 'fail', `${s.availableMb} MB available now`)

  add('worker_flag', 'The Warm Leads worker switch', 'info', s.workerEnabled ? 'WARM_LEADS_WORKER_ENABLED is on' : 'WARM_LEADS_WORKER_ENABLED is off: switch it on only when you approve starting the pilot')
  add('window', 'Processing window', 'info', s.windowOpenNow ? 'open now (11 PM to 6 AM Asia/Kolkata by default)' : 'closed now: the worker only evaluates inside its window')

  return { checks, ready: checks.every((c) => c.status !== 'fail') }
}
