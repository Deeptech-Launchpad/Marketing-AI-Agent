import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// WHAT THIS COMPANY SELLS MUST BE READ FROM THIS COMPANY'S SITE.
//
// The customer report devotes a page to the customer's own sectors. Every
// defect this file guards against was found in a real run against a real
// site, and each one would have printed something false in a document going
// to a customer:
//
//   · "SERVICES Archives"      — a WordPress page title, not a category
//   · "HIRE OF ECG MACHINE"    — a product name listed as a sector
//   · "SERVICES" + "Services"  — one category counted as two
//
// The last group is the one that matters most: a sector read from another
// company's run would be a different company's catalogue on this customer's
// report.

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
if (skipReason) console.warn(`\n[sectorAnalysis] SKIPPED — ${skipReason}\n`)

const PREFIX = `sector-${Date.now().toString(36)}`
let tenantId = ''
let runId = ''
let otherRunId = ''

async function seedPage(
  run: string,
  company: string,
  url: string,
  pageType: string,
  observations: Array<{ field: string; value: string | null }>,
): Promise<string> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const pageId = newId()
  await prisma.auditedPage.create({
    data: {
      id: pageId,
      tenantId,
      auditRunId: run,
      crmCompanyId: company,
      requestedUrl: url,
      finalUrl: url,
      httpStatus: 200,
      outcome: 'fetched',
      pageType,
      fetchedAt: new Date(),
    },
  })
  for (const o of observations) {
    await prisma.pageObservation.create({
      data: {
        id: newId(),
        tenantId,
        auditRunId: run,
        pageId,
        field: o.field,
        status: o.value ? 'observed' : 'not_observed',
        value: o.value,
        method: 'dom_heuristic',
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

  // A WordPress category page, titled the way WordPress titles them.
  await seedPage(runId, `${PREFIX}-co`, 'https://acme.test/category/services/', 'category', [
    { field: 'category.name', value: 'SERVICES Archives - ACME Supplier Ltd' },
  ])

  // The same category reached again, spelled differently.
  await seedPage(runId, `${PREFIX}-co`, 'https://acme.test/services/', 'category', [
    { field: 'category.name', value: 'Services' },
  ])

  // A product whose breadcrumb DOES name a category.
  await seedPage(runId, `${PREFIX}-co`, 'https://acme.test/product/pump-42/', 'product', [
    { field: 'page.breadcrumbs', value: 'Home > Shop > Pumps > ACME Circulation Pump 42' },
    { field: 'product.name', value: 'ACME Circulation Pump 42' },
    { field: 'product.sku', value: 'ACM-42' },
  ])

  // A product whose breadcrumb names NO category — the trail is Home/Shop and
  // then the product itself.
  await seedPage(runId, `${PREFIX}-co`, 'https://acme.test/product/ecg/', 'product', [
    { field: 'page.breadcrumbs', value: 'Home > Shop > HIRE OF ECG MACHINE 100L' },
    { field: 'product.name', value: 'HIRE OF ECG MACHINE 100L' },
  ])

  // A DIFFERENT company, audited separately. Nothing here may ever appear on
  // the run above's report.
  otherRunId = newId()
  await prisma.websiteAuditRun.create({
    data: { id: otherRunId, tenantId, crmCompanyId: `${PREFIX}-other`, requestedByCrmUserId: 'tester', status: 'completed' },
  })
  await seedPage(otherRunId, `${PREFIX}-other`, 'https://rival.test/category/bathrooms/', 'category', [
    { field: 'category.name', value: 'Bathroom Suites' },
  ])
})

afterAll(async () => {
  if (skipReason) return
  const { prisma } = await import('../../src/platform/db.js')
  await prisma.websiteAuditRun.deleteMany({
    where: { crmCompanyId: { in: [`${PREFIX}-co`, `${PREFIX}-other`] } },
  })
})

describeIfReady('a sector name is what the site calls it', () => {
  it('strips the "Archives" page-title suffix WordPress adds', async () => {
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')
    const names = (await analyseSectors(runId)).sectors.map((s) => s.name)
    expect(names, 'a page title is not a category name').not.toContain('SERVICES Archives')
    expect(names.some((n) => /^services$/i.test(n)), `got ${JSON.stringify(names)}`).toBe(true)
  })

  it('strips the site name a category page appends to its title', async () => {
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')
    for (const name of (await analyseSectors(runId)).sectors.map((s) => s.name)) {
      expect(name, 'the merchant name is not one of its own sectors').not.toContain('ACME Supplier Ltd')
    }
  })

  it('counts one category once, however the site spells it', async () => {
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')
    const services = (await analyseSectors(runId)).sectors.filter((s) => /^services$/i.test(s.name))
    expect(services, '"SERVICES" and "Services" are one sector').toHaveLength(1)
    expect(services[0]!.pageCount, 'and both pages count toward it').toBe(2)
  })
})

describeIfReady('a product is never listed as a sector', () => {
  it('takes the category a product sits in, not the product', async () => {
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')
    const names = (await analyseSectors(runId)).sectors.map((s) => s.name)
    expect(names).toContain('Pumps')
    expect(names).not.toContain('ACME Circulation Pump 42')
  })

  it('yields nothing when a product breadcrumb names no category at all', async () => {
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')
    const names = (await analyseSectors(runId)).sectors.map((s) => s.name)
    expect(names, 'Home > Shop > <product> names no category').not.toContain('HIRE OF ECG MACHINE 100L')
    for (const n of names) expect(n).not.toMatch(/ECG/i)
  })
})

describeIfReady('one company, one catalogue', () => {
  it('never reads a sector from another company run', async () => {
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')
    const mine = await analyseSectors(runId)
    expect(
      mine.sectors.map((s) => s.name),
      'the rival sells bathrooms; this customer does not',
    ).not.toContain('Bathroom Suites')
    for (const s of mine.sectors) {
      for (const url of s.evidenceUrls) {
        expect(url, 'evidence must come from the audited site').not.toContain('rival.test')
      }
    }
  })

  it('reports the other run own sector when asked about that run', async () => {
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')
    expect((await analyseSectors(otherRunId)).sectors.map((s) => s.name)).toEqual(['Bathroom Suites'])
  })

  it('says plainly when a site published nothing to categorise by', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')
    const bare = newId()
    await prisma.websiteAuditRun.create({
      data: { id: bare, tenantId, crmCompanyId: `${PREFIX}-co`, requestedByCrmUserId: 'tester', status: 'completed' },
    })
    const result = await analyseSectors(bare)
    expect(result.sectors).toEqual([])
    expect(result.note, 'no generic sector copy may stand in').toMatch(/no category names or breadcrumb navigation/i)
  })
})

describeIfReady('the gaps quoted are measured, not asserted', () => {
  it('counts published fields out of the product pages actually inspected', async () => {
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')
    const result = await analyseSectors(runId)
    expect(result.productPagesInspected, 'two product pages were seeded').toBe(2)

    const sku = result.catalogueGaps.find((g) => g.field === 'product.sku')!
    expect(sku.published, 'exactly one of the two published a SKU').toBe(1)
    expect(sku.sample).toBe(2)

    for (const g of result.catalogueGaps) {
      expect(g.published, `${g.field} cannot exceed the sample`).toBeLessThanOrEqual(g.sample)
    }
  })
})
