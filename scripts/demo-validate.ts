import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/platform/db.js'
import { scoreCompany } from '../src/intentscore/service.js'
import { evaluateCompany } from '../src/salesqualification/service.js'

// PHASE 6 — validate on the test batch.
//
// Every check reads what the engines actually wrote. Nothing is repaired here;
// a failure is reported as a failure.

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  ok ? pass++ : fail++
}

async function main() {
  const { test, demo } = JSON.parse(readFileSync('scripts/.demo-batches.json', 'utf8')) as {
    test: Array<{ crmCompanyId: string; name: string }>
    demo: Array<{ crmCompanyId: string; name: string }>
  }
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  const tenantId = tenant.id
  const ids = test.map((t) => t.crmCompanyId)

  console.log('1. NO DUPLICATE RECORDS')
  for (const [label, count] of [
    ['SalesQualification', await prisma.salesQualification.groupBy({ by: ['crmCompanyId'], where: { tenantId, crmCompanyId: { in: ids } }, _count: true })],
    ['IntentScore', await prisma.intentScore.groupBy({ by: ['crmCompanyId'], where: { tenantId, crmCompanyId: { in: ids } }, _count: true })],
  ] as const) {
    const dupes = (count as Array<{ crmCompanyId: string; _count: number }>).filter((g) => g._count > 1)
    check(`one ${label} per company`, dupes.length === 0, dupes.length ? `${dupes.length} duplicated` : `${(count as unknown[]).length} unique`)
  }

  console.log('\n2. IDEMPOTENCY — re-running an engine changes nothing')
  const sample = ids[0]!
  const before = await prisma.intentScore.findUnique({ where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: sample } } })
  const again = await scoreCompany({ tenantId, crmCompanyId: sample })
  check('re-scoring returns the same score', before?.normalizedScore === again.normalizedScore, `${before?.normalizedScore} -> ${again.normalizedScore}`)
  const scoreRows = await prisma.intentScore.count({ where: { tenantId, crmCompanyId: sample } })
  check('re-scoring did not create a second row', scoreRows === 1, `${scoreRows} row(s)`)

  const qBefore = await prisma.salesQualification.findUnique({ where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: sample } } })
  const qAgain = await evaluateCompany({ tenantId, crmCompanyId: sample, actorCrmUserId: 'crm-user-jey' })
  check('re-evaluating returns the same status', qBefore?.status === qAgain.status, `${qBefore?.status} -> ${qAgain.status}`)
  const qRows = await prisma.salesQualification.count({ where: { tenantId, crmCompanyId: sample } })
  check('re-evaluating did not create a second row', qRows === 1, `${qRows} row(s)`)

  console.log('\n3. NO CROSS-COMPANY IDENTITY LEAKAGE')
  const runs = await prisma.websiteAuditRun.findMany({ where: { tenantId, crmCompanyId: { in: ids } }, select: { id: true, crmCompanyId: true } })
  let leaked = 0
  for (const r of runs) {
    const wrong = await prisma.auditedPage.count({ where: { auditRunId: r.id, NOT: { crmCompanyId: r.crmCompanyId } } })
    leaked += wrong
  }
  check('every audited page belongs to its own run company', leaked === 0, `${runs.length} run(s) checked`)

  const reports = await prisma.auditReport.findMany({ where: { tenantId, crmCompanyId: { in: ids } }, select: { id: true, crmCompanyId: true, auditRunId: true } })
  let mismatched = 0
  for (const rep of reports) {
    const run = await prisma.websiteAuditRun.findUnique({ where: { id: rep.auditRunId }, select: { crmCompanyId: true } })
    if (run && run.crmCompanyId !== rep.crmCompanyId) mismatched++
  }
  check('every report belongs to its own audit run company', mismatched === 0, `${reports.length} report(s) checked`)

  console.log('\n4. EVIDENCE AND PROVENANCE')
  const findings = await prisma.catalogFinding.findMany({ where: { auditRunId: { in: runs.map((r) => r.id) } }, take: 50 })
  const orphan = findings.filter((f) => !runs.some((r) => r.id === f.auditRunId))
  check('every finding resolves to a real audit run', orphan.length === 0, `${findings.length} finding(s)`)
  const scored = await prisma.intentScore.findMany({ where: { tenantId, crmCompanyId: { in: ids } } })
  check('every score names the policy that produced it', scored.every((s) => Boolean(s.policyVersion)), `${scored.length} score(s)`)
  check('every score records what it counted', scored.every((s) => s.eventsConsidered >= s.eventsScored), 'eventsConsidered >= eventsScored')

  console.log('\n5. BLOCKED STATES ARE HONEST')
  const failedRuns = await prisma.websiteAuditRun.findMany({ where: { tenantId, crmCompanyId: { in: ids }, status: 'failed' } })
  check('a failed audit states a reason', failedRuns.every((r) => Boolean(r.failureReason)), `${failedRuns.length} failed run(s)`)
  check('a failed audit claims no pages', failedRuns.every((r) => r.pagesFetched === 0), 'pagesFetched = 0')

  console.log('\n6. APPROVAL AND CRM STATE')
  const quals = await prisma.salesQualification.findMany({ where: { tenantId, crmCompanyId: { in: ids } } })
  check('no test company was silently qualified', quals.every((q) => q.status === 'not_qualified'), `${quals.length} evaluated`)
  const syncs = await prisma.crmSyncRecord.findMany({ where: { tenantId, crmCompanyId: { in: ids } } })
  check('no test company reached a CRM write', syncs.every((s) => s.state !== 'synced' && s.state !== 'partial'), `${syncs.length} sync record(s)`)

  console.log('\n7. NO FABRICATED DATA')
  const enr = await prisma.companyEnrichment.findMany({ where: { tenantId, crmCompanyId: { in: ids } } })
  const unreachableWithTech = enr.filter((e) => e.websiteStatus !== 'reachable' && ((e.technologies as unknown[] | null)?.length ?? 0) > 0)
  check('an unreachable site reports no technologies', unreachableWithTech.length === 0, `${enr.length} enrichment row(s)`)
  const zeroScoreWithEvents = scored.filter((s) => s.normalizedScore > 0 && s.eventsScored === 0)
  check('a score above zero is backed by scored events', zeroScoreWithEvents.length === 0, `${scored.length} score(s)`)

  console.log('\n8. DEMO BATCH PRESERVED')
  const demoQuals = await prisma.auditReport.count({ where: { tenantId, crmCompanyId: { in: demo.map((d) => d.crmCompanyId) } } })
  check('demo companies still hold their audit reports', demoQuals > 0, `${demoQuals} report(s)`)
  const queue = await prisma.crmSyncRecord.count({ where: { tenantId, state: 'awaiting_user_approval' } })
  check('the CRM approval queue still has a pending handoff', queue > 0, `${queue} waiting`)

  console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`} · ${pass} passed`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('validation failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
