// WARM LEADS - PILOT READINESS CHECK. Read-only.
//
//   npx tsx scripts/warmleads-pilot-readiness.ts [--tenant <id>]
//
// Reads this process's configuration, the database and the size of the NXT Sales company list (one GET) and prints PASS / FAIL /
// INFO for everything that must be true before an administrator requests the 100-company pilot. It makes no Gemini call, sends no
// email, writes nothing to the database and nothing to NXT Sales, and requests and starts nothing.
//
// With several tenants, --tenant is required; a tenant that has no Warm Leads settings is reported as FAIL, never as ready.
//
// Exit code: 0 ready · 1 something stands in the way · 2 error

import { readFileSync } from 'node:fs'
import { env } from '../src/config/env.js'
import { getCrm } from '../src/crm/index.js'
import { withCrmReadOnly } from '../src/crm/nxtSales/httpClient.js'
import { warmLeadsKeyProblem } from '../src/llm/gemini/apiKey.js'
import { prisma } from '../src/platform/db.js'
import { redactDatabaseUrl, parseMemAvailableMb } from '../src/warmleads/isolatedTestSafety.js'
import { fingerprintKeyConfigured, trustedOwnDomains } from '../src/warmleads/optOut.js'
import { evaluateReadiness, resolveTenant, type ReadinessSnapshot, type TenantState } from '../src/warmleads/readiness.js'
import { windowOpen } from '../src/warmleads/window.js'

/** The address of the CRM without anything that could be a credential: scheme, host and port only. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return '(unreadable address)'
  }
}

async function main(): Promise<number> {
  // --tenant <id>. Any other spelling (--tenant=<id>, a missing value) is refused: a tenant that was named must be the one checked.
  const args = process.argv.slice(2)
  const at = args.indexOf('--tenant')
  if (args.some((a) => a.startsWith('--tenant=')) || (at >= 0 && (!args[at + 1] || args[at + 1]!.startsWith('--')))) {
    console.error('Usage: npx tsx scripts/warmleads-pilot-readiness.ts [--tenant <id>]   (write the id after a space: --tenant=<id> is not accepted)')
    return 2
  }
  const tenantArg = at >= 0 ? args[at + 1] : undefined
  const dbUrl = process.env.MARKETING_DATABASE_URL ?? ''
  console.log(`Database: ${redactDatabaseUrl(dbUrl)}`)
  console.log(`NXT Sales: ${originOf(env.NXT_SALES_BASE_URL)}  (read-only; ${env.CRM_READ_ONLY ? 'CRM_READ_ONLY=true' : 'writes are not used by this check'})\n`)

  // 1. Can the database be queried at all? ("the tables are missing" and "the database is down" are different problems.)
  let databaseOk = false
  let databaseError: string | undefined
  let migrationApplied = false
  try {
    const r = await prisma.$queryRaw<Array<{ t: string | null }>>`SELECT to_regclass('"WarmLeadUsage"')::text AS t`
    databaseOk = true
    migrationApplied = Boolean(r[0]?.t)
  } catch (err) {
    databaseError = (err as Error).message.split('\n')[0]!.slice(0, 160)
  }

  // 2. WHICH tenant. Nothing is read for a tenant that was not identified.
  let tenantId: string | undefined
  let tenant: { state: TenantState; detail: string } = { state: 'none', detail: 'the database was not read' }
  if (databaseOk && migrationApplied) {
    const tenants = (await prisma.warmLeadSettings.findMany({ select: { tenantId: true } })).map((t) => t.tenantId)
    const resolved = resolveTenant(tenantArg, tenants)
    tenantId = resolved.tenantId
    tenant = { state: resolved.state, detail: resolved.detail }
  }
  const settings = tenantId ? await prisma.warmLeadSettings.findUnique({ where: { tenantId } }) : null
  const pilotRun = tenantId ? await prisma.warmLeadRun.findFirst({ where: { tenantId, kind: 'pilot' }, orderBy: { createdAt: 'desc' }, select: { status: true } }) : null

  let crm: ReadinessSnapshot['crm']
  try {
    const page = await withCrmReadOnly(() => getCrm().searchCompanies({ page: 1, limit: 1 }))
    crm = { ok: true, total: page.total }
  } catch (err) {
    crm = { ok: false, total: null, error: (err as Error).message.slice(0, 200) }
  }

  let availableMb: number | null = null
  if (process.platform === 'linux') {
    try {
      availableMb = parseMemAvailableMb(readFileSync('/proc/meminfo', 'utf8'))
    } catch {
      availableMb = 0
    }
  }

  const snapshot: ReadinessSnapshot = {
    geminiKeyProblem: warmLeadsKeyProblem(),
    llmDriver: env.LLM_DRIVER,
    crmDriver: env.CRM_DRIVER,
    recordOptOuts: env.WARM_LEADS_RECORD_OPT_OUTS,
    fingerprintKeyConfigured: fingerprintKeyConfigured(),
    ownDomainsConfigured: trustedOwnDomains().length > 0,
    workerEnabled: env.WARM_LEADS_WORKER_ENABLED,
    syncSwitchOn: env.WARM_LEADS_SYNC_ENABLED,
    allowLive: env.WARM_LEADS_ALLOW_LIVE,
    crmReadOnlyGlobal: env.CRM_READ_ONLY,
    databaseOk,
    databaseError,
    migrationApplied,
    tenant,
    settings: settings
      ? {
          paused: settings.paused,
          pilotSize: settings.pilotSize,
          pilotGeminiCeiling: settings.pilotGeminiCeiling,
          dailyCompanyLimit: settings.dailyCompanyLimit,
          dailyGeminiCeiling: settings.dailyGeminiCeiling,
          approvedMaxCompanies: settings.approvedMaxCompanies,
          approvedMaxCeiling: settings.approvedMaxCeiling,
          pilotApprovedAt: settings.pilotApprovedAt,
          syncEnabled: settings.syncEnabled,
        }
      : null,
    pilotRunStatus: pilotRun?.status ?? null,
    crm,
    availableMb,
    minAvailableMb: env.WARM_LEADS_MIN_AVAILABLE_MB + 1024,
    windowOpenNow: windowOpen(new Date(), { start: settings?.windowStart ?? '23:00', end: settings?.windowEnd ?? '06:00', timezone: settings?.timezone ?? 'Asia/Kolkata' }),
  }

  const { checks, ready } = evaluateReadiness(snapshot)
  for (const c of checks) console.log(`${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'INFO'}  ${c.label}: ${c.detail}`)
  console.log(`\n${ready ? 'READY' : 'NOT READY'}: ${ready ? 'an administrator may request the pilot from the Warm Leads screen. Nothing has been requested or started.' : 'fix the FAIL lines first.'}`)
  return ready ? 0 : 1
}

main()
  .then(async (code) => {
    await prisma.$disconnect()
    process.exit(code)
  })
  .catch(async (err) => {
    console.error('Readiness check failed to run:', (err as Error).message)
    await prisma.$disconnect().catch(() => undefined)
    process.exit(2)
  })
