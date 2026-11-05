// WARM LEADS - PILOT READINESS CHECK. Read-only.
//
//   npx tsx scripts/warmleads-pilot-readiness.ts [--tenant <id>]
//
// Reads this process's configuration, the database and the size of the NXT Sales company list (one GET) and prints PASS / FAIL /
// INFO for everything that must be true before an administrator requests the 100-company pilot. It makes no Gemini call, sends no
// email, writes nothing to the database and nothing to NXT Sales, and requests and starts nothing.
//
// Exit code: 0 ready · 1 something stands in the way · 2 error

import { readFileSync } from 'node:fs'
import { env } from '../src/config/env.js'
import { getCrm } from '../src/crm/index.js'
import { withCrmReadOnly } from '../src/crm/nxtSales/httpClient.js'
import { warmLeadsKeyProblem } from '../src/llm/gemini/apiKey.js'
import { prisma } from '../src/platform/db.js'
import { redactDatabaseUrl, parseMemAvailableMb } from '../src/warmleads/isolatedTestSafety.js'
import { evaluateReadiness, type ReadinessSnapshot } from '../src/warmleads/readiness.js'
import { windowOpen } from '../src/warmleads/window.js'

async function main(): Promise<number> {
  const tenantArg = process.argv.includes('--tenant') ? process.argv[process.argv.indexOf('--tenant') + 1] : undefined
  const dbUrl = process.env.MARKETING_DATABASE_URL ?? ''
  console.log(`Database: ${redactDatabaseUrl(dbUrl)}`)
  console.log(`NXT Sales: ${env.NXT_SALES_BASE_URL}  (read-only; ${env.CRM_READ_ONLY ? 'CRM_READ_ONLY=true' : 'writes are not used by this check'})\n`)

  let migrationApplied = false
  try {
    const r = await prisma.$queryRaw<Array<{ t: string | null }>>`SELECT to_regclass('"WarmLeadUsage"')::text AS t`
    migrationApplied = Boolean(r[0]?.t)
  } catch {
    migrationApplied = false
  }

  let tenantId = tenantArg
  if (!tenantId && migrationApplied) {
    const tenants = await prisma.warmLeadSettings.findMany({ select: { tenantId: true } })
    tenantId = tenants.length === 1 ? tenants[0]!.tenantId : undefined
    if (tenants.length > 1) console.log(`More than one tenant has Warm Leads settings (${tenants.map((t) => t.tenantId).join(', ')}); pass --tenant <id>.\n`)
  }
  const settings = migrationApplied && tenantId ? await prisma.warmLeadSettings.findUnique({ where: { tenantId } }) : null
  const pilotRun = migrationApplied && tenantId ? await prisma.warmLeadRun.findFirst({ where: { tenantId, kind: 'pilot' }, orderBy: { createdAt: 'desc' }, select: { status: true } }) : null

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
    workerEnabled: env.WARM_LEADS_WORKER_ENABLED,
    syncSwitchOn: env.WARM_LEADS_SYNC_ENABLED,
    allowLive: env.WARM_LEADS_ALLOW_LIVE,
    crmReadOnlyGlobal: env.CRM_READ_ONLY,
    migrationApplied,
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
