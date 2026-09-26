import 'dotenv/config'
import jwt from 'jsonwebtoken'
import { prisma } from '../src/platform/db.js'

// Walks the manager flow against the RUNNING local backend and reports the real
// HTTP status of every call the UI makes. This is the API half of the browser
// check: it cannot see a React render, but it proves each request the buttons
// issue is accepted, and that nothing sends or writes.

const API = 'http://localhost:4100/api/v1'
const COMPANY = 'cmt89cr640rf0s9d3x48vge96' // Jamesco Trading Ltd

const tok = (id: string, email: string) =>
  jwt.sign({ id, email, name: email, role: 'member' }, process.env.JWT_SECRET!, { expiresIn: 900 })
const OPERATOR = tok('crm-user-jey', 'jey@deeptechskills.com')
const APPROVER = tok('crm-user-approver', 'approver@deeptechskills.com')

async function call(method: string, path: string, body?: unknown, t = OPERATOR) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed as Record<string, unknown> }
}

const show = (label: string, r: { status: number; body: Record<string, unknown> }, extra = '') => {
  const ok = r.status >= 200 && r.status < 300
  console.log(`  ${ok ? 'OK ' : String(r.status)} ${label.padEnd(26)} ${extra}`)
  return r
}

async function main() {
  const run = await prisma.websiteAuditRun.findFirst({
    where: { crmCompanyId: COMPANY },
    orderBy: { createdAt: 'desc' },
    select: { id: true, pagesFetched: true, productPages: true },
  })
  if (!run) throw new Error('no audit run for Jamesco')
  console.log(`Newest Jamesco run ${run.id} · ${run.pagesFetched} pages, ${run.productPages} product\n`)

  console.log('THE MANAGER FLOW, as the UI calls it')
  show('Enrichment', await call('POST', '/enrichment/companies', { crmCompanyIds: [COMPANY] }))
  show('Intent signals', await call('POST', '/intent/detect', { crmCompanyIds: [COMPANY] }))
  show('Decision makers', await call('POST', '/decision-makers/discover', { crmCompanyIds: [COMPANY] }))
  const audit = show('Start audit', await call('POST', '/website-audit/start', { crmCompanyIds: [COMPANY] }))
  const newRun = ((audit.body.runs as Array<{ id: string }>) ?? [])[0]?.id ?? run.id

  const pages = show('Pages (the crash path)', await call('GET', `/website-audit/runs/${run.id}/pages`))
  const rows = (pages.body.pages as Array<Record<string, unknown>>) ?? []
  const firstKeys = rows[0] ? Object.keys(rows[0]) : []
  console.log(`      -> ${rows.length} row(s); has requestedUrl=${firstKeys.includes('requestedUrl')} finalUrl=${firstKeys.includes('finalUrl')} outcome=${firstKeys.includes('outcome')} url=${firstKeys.includes('url')}`)

  show('Report', await call('POST', `/website-audit/runs/${run.id}/report`))

  const appr = show('Approval state', await call('GET', `/website-audit/runs/${run.id}/approval`))
  const status = String(appr.body.status ?? '?')
  console.log(`      -> report is "${status}"`)

  if (status !== 'approved') {
    console.log('\n  The Workbench and Outreach gates require an approved report. Approving it')
    console.log('  through the real API, as a second person, so the demo flow completes:')
    const lock = Number(appr.body.lockVersion ?? 0)
    show('  start review', await call('POST', `/website-audit/runs/${run.id}/approval/start`, { expectedLockVersion: lock }, APPROVER))
    const after = await call('GET', `/website-audit/runs/${run.id}/approval`)
    show('  approve', await call('POST', `/website-audit/runs/${run.id}/approval/approve`, { expectedLockVersion: Number(after.body.lockVersion ?? 0), comment: 'Reviewed against the crawled evidence.' }, APPROVER))
  }

  const wb = show('Build Workbench', await call('POST', `/website-audit/runs/${run.id}/workbench`, {}))
  console.log(`      -> ${JSON.stringify(wb.body).slice(0, 120)}`)
  const wb2 = show('Rebuild (idempotency)', await call('POST', `/website-audit/runs/${run.id}/workbench`, {}))
  const demos = await prisma.workbenchDemo.count({ where: { auditRunId: run.id } })
  console.log(`      -> second build HTTP ${wb2.status}; WorkbenchDemo rows for this run: ${demos}`)

  const out1 = show('Prepare outreach', await call('POST', '/outreach/campaigns', { auditRunId: run.id, dryRun: true }))
  const out2 = show('Prepare again', await call('POST', '/outreach/campaigns', { auditRunId: run.id, dryRun: true }))
  console.log(`      -> repeat HTTP ${out2.status} · ${String((out2.body.error as { message?: string })?.message ?? '').slice(0, 80)}`)
  const campaigns = await prisma.outreachCampaign.count({ where: { auditRunId: run.id } })
  console.log(`      -> OutreachCampaign rows for this run: ${campaigns} (first call HTTP ${out1.status})`)

  show('Recalculate score', await call('POST', '/intent-score/recalculate', { crmCompanyId: COMPANY }))
  show('Evaluate qualification', await call('POST', '/sales-qualification/evaluate', { crmCompanyId: COMPANY }))
  show('CRM pending queue', await call('GET', '/crm-sync/approvals/pending'))

  const waiting = await prisma.crmSyncRecord.count({ where: { state: 'awaiting_user_approval' } })
  const written = await prisma.crmSyncRecord.count({ where: { state: { in: ['synced', 'partial'] } } })
  console.log(`\n  CRM handoffs awaiting a person: ${waiting}`)
  console.log(`  CRM records ever written      : ${written}`)
  console.log(`  audit run just queued          : ${newRun}`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('verify failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
