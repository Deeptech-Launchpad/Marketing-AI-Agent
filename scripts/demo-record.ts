import 'dotenv/config'
import { prisma } from '../src/platform/db.js'
import { runWebsiteAudit } from '../src/websiteaudit/audit.js'
import { queueWebsiteAudit } from '../src/websiteaudit/audit.js'
import { buildEnrichedRecord, selectCaseStudyPages } from '../src/websiteaudit/enrichedRecord.js'

// Runs a REAL audit with the new extractor, then builds the enriched record for
// the best product page it found. Everything printed came off the customer's
// own site.

async function main() {
  const crmCompanyId = process.argv[2]!
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })

  console.log(`Auditing ${crmCompanyId} with the image-aware extractor…`)
  const { id: runId } = await queueWebsiteAudit({
    tenantId: tenant.id,
    crmCompanyId,
    requestedByCrmUserId: 'crm-user-jey',
  })
  await runWebsiteAudit(runId)

  const run = await prisma.websiteAuditRun.findUniqueOrThrow({ where: { id: runId } })
  console.log(`  run ${run.id} · ${run.status} · ${run.pagesFetched} pages, ${run.productPages} product\n`)

  const images = await prisma.pageObservation.count({ where: { auditRunId: runId, field: 'product.image', status: 'observed' } })
  console.log(`  product images observed: ${images}`)

  const pageIds = await selectCaseStudyPages(runId, 2)
  console.log(`  case-study pages selected: ${pageIds.length}\n`)

  for (const [i, pageId] of pageIds.entries()) {
    const rec = await buildEnrichedRecord(pageId)
    if (!rec) continue
    console.log(`CASE STUDY 0${i + 1} — ${rec.title.slice(0, 60)}`)
    console.log(`  source : ${rec.sourceUrl}`)
    console.log(`  image  : ${rec.imageUrl ?? '(none published)'}`)
    console.log(`  counts : ${rec.observedCount} observed · ${rec.restructuredCount} restructured · ${rec.absentCount} absent`)
    console.log(`  BEFORE : ${rec.beforeSummary.slice(0, 150)}`)
    console.log(`  AFTER  : ${rec.afterSummary.slice(0, 150)}`)
    console.log(`  KEY    : ${rec.keyTransformation.slice(0, 150)}`)
    console.log('  fields :')
    for (const f of rec.fields) {
      const before = f.before === null ? '(not published)' : f.before.slice(0, 34)
      console.log(`    ${f.label.padEnd(26)} ${f.state.padEnd(13)} ${before}`)
    }
    console.log('')
  }
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error('failed:', e); await prisma.$disconnect(); process.exit(1) })
