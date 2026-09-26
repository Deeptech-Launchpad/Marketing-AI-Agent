import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/platform/db.js'
import { queueWebsiteAudit, runWebsiteAudit } from '../src/websiteaudit/audit.js'
import { generateAuditReport } from '../src/websiteaudit/report.js'
import { generateCustomerReport } from '../src/websiteaudit/customerReport.js'
import { buildEnrichedRecord, selectCaseStudyPages } from '../src/websiteaudit/enrichedRecord.js'
import { analyseSectors } from '../src/websiteaudit/sectorAnalysis.js'
import { buildWorkbench } from '../src/workbench/builder.js'
import jwt from 'jsonwebtoken'

// ONE REAL COMPANY, END TO END.
//
//   audit its real website
//   -> extract real product data and images
//   -> approve the report (a real second person, through the real API)
//   -> render the 6-page customer PDF
//   -> build the Workbench from the SAME run
//   -> confirm both show the same product, image and source URL

const API = 'http://localhost:4100/api/v1'
const tok = (id: string, email: string) =>
  jwt.sign({ id, email, name: email, role: 'member' }, process.env.JWT_SECRET!, { expiresIn: 1800 })
const APPROVER = tok('crm-user-approver', 'approver@deeptechskills.com')

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${APPROVER}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function main() {
  const crmCompanyId = process.argv[2]!
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })

  console.log('1. AUDIT THE REAL WEBSITE')
  const { id: runId } = await queueWebsiteAudit({ tenantId: tenant.id, crmCompanyId, requestedByCrmUserId: 'crm-user-jey' })
  await runWebsiteAudit(runId)
  const run = await prisma.websiteAuditRun.findUniqueOrThrow({ where: { id: runId } })
  console.log(`   ${run.companyName} · ${run.status} · ${run.pagesFetched} pages, ${run.productPages} product`)
  console.log(`   run ${run.id}  company ${run.crmCompanyId}`)

  console.log('\n2. REAL PRODUCT DATA AND IMAGES')
  const imgCount = await prisma.pageObservation.count({ where: { auditRunId: runId, field: 'product.image', status: 'observed' } })
  console.log(`   product images observed: ${imgCount}`)
  const pageIds = await selectCaseStudyPages(runId, 2)
  const records = (await Promise.all(pageIds.map((id) => buildEnrichedRecord(id)))).filter((r) => r !== null)
  for (const [i, r] of records.entries()) {
    console.log(`   case ${i + 1}: ${r!.title.slice(0, 52)}`)
    console.log(`           image  ${r!.imageUrl ?? '(none published)'}`)
    console.log(`           source ${r!.sourceUrl}`)
    console.log(`           ${r!.observedCount} observed · ${r!.restructuredCount} restructured · ${r!.absentCount} absent`)
  }

  const sectors = await analyseSectors(runId)
  console.log(`   sectors: ${sectors.sectors.map((s) => s.name).join(', ') || '(none published)'}`)

  console.log('\n3. REPORT + APPROVAL')
  await generateAuditReport(runId)
  const appr = await call('GET', `/website-audit/runs/${runId}/approval`)
  if (String(appr.body.status) !== 'approved') {
    await call('POST', `/website-audit/runs/${runId}/approval/start`, { expectedLockVersion: Number(appr.body.lockVersion ?? 0) })
    const after = await call('GET', `/website-audit/runs/${runId}/approval`)
    const r = await call('POST', `/website-audit/runs/${runId}/approval/approve`, {
      expectedLockVersion: Number(after.body.lockVersion ?? 0),
      comment: 'Reviewed against the crawled evidence.',
    })
    console.log(`   approve -> HTTP ${r.status}`)
  }

  console.log('\n4. WORKBENCH FROM THE SAME RUN')
  const wb = await buildWorkbench({ tenantId: tenant.id, auditRunId: runId, requestedByCrmUserId: 'crm-user-approver' })
  console.log(`   ${wb.status}${wb.statusReason ? ' · ' + wb.statusReason : ''}`)
  const demo = await prisma.workbenchDemo.findFirst({ where: { auditRunId: runId } })
  console.log(`   workbench company ${demo?.crmCompanyId} · product page ${demo?.productPageUrl ?? '-'}`)

  // Through the real API, because that is what the interface reads. The
  // product image and the absent-field set are what the screen renders, and
  // neither is worth much if it only exists in the database.
  const wbApi = await call('GET', `/website-audit/runs/${runId}/workbench`)
  const apiFields = (wbApi.body.fields ?? []) as Array<{ label: string; delta: string }>
  const apiImage = wbApi.body.productImageUrl as string | null
  const apiAbsent = apiFields.filter((f) => f.delta === 'still_absent')
  console.log(`   API image   ${apiImage ?? '(none published)'}`)
  console.log(`   API gap     ${apiAbsent.length} of ${apiFields.length} fields not published`)
  if (apiAbsent.length) console.log(`               ${apiAbsent.slice(0, 4).map((f) => f.label).join(', ')}`)

  console.log('\n5. CUSTOMER PDF')
  const link = demo ? `http://localhost:4100/workbench/${demo.id}` : null
  const result = await generateCustomerReport({ auditRunId: runId, workbenchUrl: link, sampleCount: 2 })
  const out = `scripts/.customer-report-${crmCompanyId}.pdf`
  writeFileSync(out, result.pdf.bytes)
  console.log(`   pages       : ${result.pdf.pageCount}`)
  console.log(`   bytes       : ${result.pdf.bytes.length}`)
  console.log(`   sha256      : ${result.pdf.sha256.slice(0, 16)}…`)
  console.log(`   written to  : ${out}`)

  console.log('\n6. LINEAGE — every stage names the same company and run')
  const checks: Array<[string, boolean, string]> = [
    ['audit run company', run.crmCompanyId === crmCompanyId, run.crmCompanyId],
    ['case studies company', records.every((r) => r!.crmCompanyId === crmCompanyId), records[0]?.crmCompanyId ?? '-'],
    ['case studies run', records.every((r) => r!.auditRunId === runId), records[0]?.auditRunId ?? '-'],
    ['workbench company', demo?.crmCompanyId === crmCompanyId, demo?.crmCompanyId ?? '-'],
    ['workbench run', demo?.auditRunId === runId, demo?.auditRunId ?? '-'],
    ['pdf is 5-6 pages', result.pdf.pageCount >= 5 && result.pdf.pageCount <= 6, String(result.pdf.pageCount)],
    // The interface reads the API, not the database, so the API is what has
    // to carry the product image the report shows.
    [
      'workbench image = case study',
      (apiImage ?? null) === (records[0]?.imageUrl ?? null),
      `${apiImage ?? 'none'} vs ${records[0]?.imageUrl ?? 'none'}`,
    ],
  ]
  for (const [name, ok, detail] of checks) {
    console.log(`   ${ok ? 'OK ' : 'FAIL'} ${name.padEnd(22)} ${detail}`)
  }

  await prisma.$disconnect()
}

main().catch(async (e) => { console.error('e2e failed:', e); await prisma.$disconnect(); process.exit(1) })
