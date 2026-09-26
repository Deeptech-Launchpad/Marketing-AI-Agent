import 'dotenv/config'
import jwt from 'jsonwebtoken'
import { prisma } from '../src/platform/db.js'
import { buildWorkbench } from '../src/workbench/builder.js'

// PHASE 5 — leave the demo in a state a manager can walk through.
//
// Two audit reports carry real findings, and both are approved here through the
// real approval API, as a real second person.
//
// Darmanin's Workbench then refuses to build, honestly: its crawl found no
// product page, and a customer-facing before/after needs one. Jamesco's crawl
// found twelve, so its Workbench builds and the before/after can be shown.
// Approving both is what makes the difference visible — one engine output that
// completes, and one that declines for a stated reason.
//
// Nothing here approves a CRM handoff. That queue stays exactly as it is, so the
// human decision at the end of the story remains the manager's to make.

const API = 'http://localhost:4100/api/v1'
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

async function approveAndBuild(tenantId: string, company: string): Promise<void> {
  const report = await prisma.auditReport.findFirst({ where: { companyName: company } })
  if (!report) {
    console.log(`\n${company} · no audit report`)
    return
  }
  console.log(`\n${company} · report ${report.status} · lock ${report.lockVersion}`)

  if (report.status !== 'approved') {
    // The workflow opens a review before a decision can be recorded.
    const started = await call('POST', `/website-audit/runs/${report.auditRunId}/approval/start`, {
      expectedLockVersion: report.lockVersion,
    })
    console.log(`  start review      -> HTTP ${started.status}`)

    const afterStart = await prisma.auditReport.findUniqueOrThrow({ where: { id: report.id } })
    const approved = await call('POST', `/website-audit/runs/${report.auditRunId}/approval/approve`, {
      expectedLockVersion: afterStart.lockVersion,
      comment: 'Findings reviewed against the crawled evidence.',
    })
    console.log(`  approve           -> HTTP ${approved.status}`)
  } else {
    console.log('  already approved  -> skipped')
  }

  const final = await prisma.auditReport.findUniqueOrThrow({ where: { id: report.id } })
  console.log(`  report status     -> ${final.status} (approved revision ${final.approvedRevision ?? '-'})`)

  if (final.status === 'approved') {
    const wb = await buildWorkbench({
      tenantId,
      auditRunId: report.auditRunId,
      requestedByCrmUserId: 'crm-user-approver',
    })
    console.log(`  workbench         -> ${wb.status}${wb.statusReason ? ' · ' + wb.statusReason : ''}`)
  }
}

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })

  for (const company of ['Darmanin Supplies', 'Jamesco Trading Ltd']) {
    await approveAndBuild(tenant.id, company)
  }

  const pending = await prisma.crmSyncRecord.findMany({ where: { state: 'awaiting_user_approval' } })
  console.log(
    `\nCRM approval queue · ${pending.length} handoff(s) waiting: ${pending.map((p) => p.companyName).join(', ') || 'none'}`,
  )

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('prepare failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
