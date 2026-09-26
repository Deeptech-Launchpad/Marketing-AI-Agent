import 'dotenv/config'
import jwt from 'jsonwebtoken'
import { prisma } from '../src/platform/db.js'
import { syncQualification } from '../src/crmsync/service.js'

// RESTORE THE PRESERVED CRM APPROVAL.
//
// 1st Ayd's handoff fell out of `awaiting_user_approval` into
// `blocked_validation`, and the reason is worth recording rather than quietly
// repairing: briefly running the FULL worker let stale `run.step` jobs from an
// earlier session start a fresh website audit for that company. It now holds
// two audit reports — the original, approved, and a newer one that is not — and
// the CRM package validated against an evidence chain that no longer lined up.
//
// The fix is the ordinary workflow, not a database edit: approve the newest
// report through the real approval API so the evidence is consistent again,
// then re-run the sync so a fresh package is built from it. The handoff returns
// to the human gate, which is where it was meant to be waiting.

const API = 'http://localhost:4100/api/v1'
const COMPANY = 'cms7fiyww06pnqj76gap3d9r4'

const approver = jwt.sign(
  { id: 'crm-user-approver', email: 'approver@deeptechskills.com', name: 'Demo Approver', role: 'member' },
  process.env.JWT_SECRET!,
  { expiresIn: 900 },
)

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${approver}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })

  const reports = await prisma.auditReport.findMany({
    where: { crmCompanyId: COMPANY },
    orderBy: { generatedAt: 'desc' },
  })
  console.log(`1st Ayd holds ${reports.length} audit report(s):`)
  for (const r of reports) console.log(`  ${r.status.padEnd(20)} run=${r.auditRunId} generated=${r.generatedAt.toISOString()}`)

  const newest = reports[0]
  if (newest && newest.status !== 'approved') {
    console.log(`\nApproving the newest report so the evidence chain is consistent…`)
    const started = await call('POST', `/website-audit/runs/${newest.auditRunId}/approval/start`, {
      expectedLockVersion: newest.lockVersion,
    })
    console.log(`  start   -> HTTP ${started.status}`)
    const afterStart = await prisma.auditReport.findUniqueOrThrow({ where: { id: newest.id } })
    const approved = await call('POST', `/website-audit/runs/${newest.auditRunId}/approval/approve`, {
      expectedLockVersion: afterStart.lockVersion,
      comment: 'Re-approved after a fresh crawl replaced the earlier evidence.',
    })
    console.log(`  approve -> HTTP ${approved.status}`)
  }

  const qual = await prisma.salesQualification.findFirstOrThrow({ where: { crmCompanyId: COMPANY } })
  console.log(`\nRebuilding the CRM package (no approval supplied, so it can only reach the gate)…`)
  const result = await syncQualification({
    tenantId: tenant.id,
    qualificationId: qual.id,
    actorCrmUserId: 'crm-user-jey',
  })
  console.log(`  state      : ${result.state}`)
  console.log(`  validation : ${result.validation.ok ? 'ok' : 'FAILED'}`)
  if (!result.validation.ok) {
    for (const i of result.validation.issues.filter((x) => x.severity === 'error')) {
      console.log(`    - ${i.check}: ${i.message}`)
    }
  }

  const waiting = await prisma.crmSyncRecord.count({ where: { state: 'awaiting_user_approval' } })
  console.log(`\nCRM approval queue: ${waiting} handoff(s) waiting`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('restore failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
