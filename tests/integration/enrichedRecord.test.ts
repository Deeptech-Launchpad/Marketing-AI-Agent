import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// THE ENRICHED RECORD MUST NEVER INVENT A CUSTOMER VALUE.
//
// This is the property the whole customer report rests on. A report that fills
// in a brand the page never published is not a slightly-wrong report — it is a
// document the customer will check, disprove, and then disbelieve entirely.
//
// So the tests below care much less about what the record CONTAINS than about
// what it refuses to contain.

async function ready(): Promise<string | null> {
  if (process.env.CRM_DRIVER !== 'real') return `CRM_DRIVER is "${process.env.CRM_DRIVER}", not "real"`
  try {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    return `marketing database unavailable: ${(err as Error).message}`
  }
  return null
}

const skipReason = await ready()
const describeIfReady = skipReason ? describe.skip : describe
if (skipReason) console.warn(`\n[enrichedRecord] SKIPPED — ${skipReason}\n`)

const PREFIX = `enrich-${Date.now().toString(36)}`
let tenantId = ''
let runId = ''
let richPageId = ''
let emptyPageId = ''
let narrativePageId = ''

async function seedPage(
  id: string,
  url: string,
  observations: Array<{ field: string; value: string | null; method?: string; status?: string }>,
): Promise<string> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const pageId = newId()
  await prisma.auditedPage.create({
    data: {
      id: pageId,
      tenantId,
      auditRunId: runId,
      crmCompanyId: `${PREFIX}-co`,
      requestedUrl: url,
      finalUrl: url,
      httpStatus: 200,
      outcome: 'fetched',
      pageType: 'product',
      fetchedAt: new Date(),
    },
  })
  for (const o of observations) {
    await prisma.pageObservation.create({
      data: {
        id: newId(),
        tenantId,
        auditRunId: runId,
        pageId,
        field: o.field,
        status: o.status ?? (o.value ? 'observed' : 'not_observed'),
        value: o.value,
        method: o.method ?? 'dom_heuristic',
        sourcePath: 'test',
      },
    })
  }
  return pageId
}

beforeAll(async () => {
  if (skipReason) return
  const { prisma, newId } = await import('../../src/platform/db.js')
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  tenantId = tenant.id

  runId = newId()
  await prisma.websiteAuditRun.create({
    data: { id: runId, tenantId, crmCompanyId: `${PREFIX}-co`, requestedByCrmUserId: 'tester', status: 'completed' },
  })

  richPageId = await seedPage(newId(), 'https://acme-supplier.test/product/pump-42/', [
    { field: 'product.name', value: 'ACME Circulation Pump 42' },
    { field: 'product.sku', value: 'ACM-42' },
    { field: 'product.image', value: 'https://acme-supplier.test/img/pump-42.jpg' },
    { field: 'product.price', value: '249.00' },
    // Everything else deliberately unpublished.
    { field: 'product.brand', value: null },
    { field: 'product.availability', value: null },
  ])

  emptyPageId = await seedPage(newId(), 'https://acme-supplier.test/product/blank/', [])

  narrativePageId = await seedPage(newId(), 'https://acme-supplier.test/product/valve/', [
    { field: 'product.name', value: 'ACME Valve' },
    {
      field: 'product.specifications',
      value: 'The valve is rated to 16 bar and suits pipework from 15mm to 28mm in domestic installations.',
      method: 'dom_heuristic',
    },
  ])
})

afterAll(async () => {
  if (skipReason) return
  const { prisma } = await import('../../src/platform/db.js')
  await prisma.websiteAuditRun.deleteMany({ where: { crmCompanyId: `${PREFIX}-co` } })
})

describeIfReady('an absent value is stated, never filled in', () => {
  it('marks unpublished fields absent on both sides', async () => {
    const { buildEnrichedRecord } = await import('../../src/websiteaudit/enrichedRecord.js')
    const rec = (await buildEnrichedRecord(richPageId))!

    const brand = rec.fields.find((f) => f.field === 'product.brand')!
    expect(brand.state).toBe('absent')
    expect(brand.before, 'nothing was published').toBeNull()
    expect(brand.after, 'and nothing may be supplied for it').toBeNull()

    const availability = rec.fields.find((f) => f.field === 'product.availability')!
    expect(availability.after).toBeNull()
  })

  it('carries a published value through verbatim, unchanged', async () => {
    const { buildEnrichedRecord } = await import('../../src/websiteaudit/enrichedRecord.js')
    const rec = (await buildEnrichedRecord(richPageId))!

    const sku = rec.fields.find((f) => f.field === 'product.sku')!
    expect(sku.before).toBe('ACM-42')
    expect(sku.after, 'the AFTER side restructures; it does not rewrite').toBe('ACM-42')
  })

  it('never produces an AFTER value where there was no BEFORE value', async () => {
    const { buildEnrichedRecord } = await import('../../src/websiteaudit/enrichedRecord.js')
    for (const pageId of [richPageId, emptyPageId, narrativePageId]) {
      const rec = (await buildEnrichedRecord(pageId))!
      for (const f of rec.fields) {
        if (f.before === null) {
          expect(f.after, `${f.field} was invented`).toBeNull()
        }
      }
    }
  })

  it('handles a page that published nothing at all', async () => {
    const { buildEnrichedRecord } = await import('../../src/websiteaudit/enrichedRecord.js')
    const rec = (await buildEnrichedRecord(emptyPageId))!
    expect(rec.observedCount).toBe(0)
    expect(rec.imageUrl).toBeNull()
    expect(rec.fields.every((f) => f.state === 'absent')).toBe(true)
    expect(rec.beforeSummary).toMatch(/publishes none of the fields/i)
  })
})

describeIfReady('narrative values are restructured, not rewritten', () => {
  it('flags prose specifications as restructured with the same text', async () => {
    const { buildEnrichedRecord } = await import('../../src/websiteaudit/enrichedRecord.js')
    const rec = (await buildEnrichedRecord(narrativePageId))!
    const specs = rec.fields.find((f) => f.field === 'product.specifications')!

    expect(specs.state).toBe('restructured')
    expect(specs.after, 'the words are the customer’s own').toBe(specs.before)
    expect(rec.keyTransformation).toMatch(/prose|structured/i)
  })

  it('does not call a declared value narrative', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { buildEnrichedRecord } = await import('../../src/websiteaudit/enrichedRecord.js')
    const pageId = await seedPage(newId(), 'https://acme-supplier.test/product/declared/', [
      { field: 'product.specifications', value: 'Pressure: 16 bar | Bore: 15mm', method: 'json_ld' },
    ])
    const rec = (await buildEnrichedRecord(pageId))!
    expect(rec.fields.find((f) => f.field === 'product.specifications')!.state).toBe('observed')
    await prisma.auditedPage.delete({ where: { id: pageId } })
  })
})

describeIfReady('every value is traceable to the customer’s own page', () => {
  it('gives each field the source URL it came from', async () => {
    const { buildEnrichedRecord } = await import('../../src/websiteaudit/enrichedRecord.js')
    const rec = (await buildEnrichedRecord(richPageId))!
    expect(rec.sourceUrl).toBe('https://acme-supplier.test/product/pump-42/')
    for (const f of rec.fields) {
      expect(f.sourceUrl, 'every field names where it was read').toBe(rec.sourceUrl)
    }
  })

  it('uses the image published on that page, and no other', async () => {
    const { buildEnrichedRecord } = await import('../../src/websiteaudit/enrichedRecord.js')
    const rec = (await buildEnrichedRecord(richPageId))!
    expect(rec.imageUrl).toBe('https://acme-supplier.test/img/pump-42.jpg')
    expect(rec.imageUrl).toContain('acme-supplier.test')
  })

  it('keeps the record tied to its own company and run', async () => {
    const { buildEnrichedRecord } = await import('../../src/websiteaudit/enrichedRecord.js')
    const rec = (await buildEnrichedRecord(richPageId))!
    expect(rec.crmCompanyId).toBe(`${PREFIX}-co`)
    expect(rec.auditRunId).toBe(runId)
  })
})

describeIfReady('case study selection prefers pages that prove the point', () => {
  it('ranks a page with an image and a name above an empty one', async () => {
    const { selectCaseStudyPages } = await import('../../src/websiteaudit/enrichedRecord.js')
    const picked = await selectCaseStudyPages(runId, 2)
    expect(picked[0], 'the richest page leads').toBe(richPageId)
    expect(picked, 'a page with nothing observed is not worth showing').not.toContain(emptyPageId)
  })

  it('only ever draws from the run it was asked about', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { selectCaseStudyPages } = await import('../../src/websiteaudit/enrichedRecord.js')

    const otherRun = newId()
    await prisma.websiteAuditRun.create({
      data: { id: otherRun, tenantId, crmCompanyId: `${PREFIX}-other`, requestedByCrmUserId: 'tester', status: 'completed' },
    })
    const picked = await selectCaseStudyPages(otherRun, 2)
    expect(picked, 'another run contributes nothing').toEqual([])
    await prisma.websiteAuditRun.delete({ where: { id: otherRun } })
  })
})
