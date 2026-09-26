import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// THE CUSTOMER VIEW IS WHAT BOTH SCREENS RENDER.
//
// The Audit Report and the AI Workbench used to assemble their own idea of
// what to show, which is how they drifted apart from the PDF — one grew real
// products and images while the others still listed findings and run ids.
//
// Now all three read this. Which makes it the single place where two
// properties have to hold:
//
//   · it describes ONE company, and can never reach another's evidence
//   · it is available BEFORE approval, because approval governs publication
//     and not whether a colleague may look at the work
//
// The second is the fix for a screen that rendered a bare warning box for
// every run awaiting review.

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
if (skipReason) console.warn(`\n[customerView] SKIPPED — ${skipReason}\n`)

const PREFIX = `cview-${Date.now().toString(36)}`
const MINE = `${PREFIX}-mine`
const OTHER = `${PREFIX}-other`

let tenantId = ''
let myRun = ''
let otherRun = ''
let unapprovedRun = ''

async function seedRun(
  company: string,
  status: string,
  products: Array<{ url: string; observations: Array<{ field: string; value: string | null }> }>,
): Promise<string> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const runId = newId()
  await prisma.websiteAuditRun.create({
    data: {
      id: runId,
      tenantId,
      crmCompanyId: company,
      requestedByCrmUserId: 'tester',
      status: 'completed',
      companyName: company === MINE ? 'Mine Ltd' : 'Rival Ltd',
      startUrl: company === MINE ? 'https://mine.test' : 'https://rival.test',
      pagesFetched: products.length,
      productPages: products.length,
      categoryPages: 0,
    },
  })

  for (const p of products) {
    const pageId = newId()
    await prisma.auditedPage.create({
      data: {
        id: pageId,
        tenantId,
        auditRunId: runId,
        crmCompanyId: company,
        requestedUrl: p.url,
        finalUrl: p.url,
        httpStatus: 200,
        outcome: 'fetched',
        pageType: 'product',
        fetchedAt: new Date(),
      },
    })
    for (const o of p.observations) {
      await prisma.pageObservation.create({
        data: {
          id: newId(),
          tenantId,
          auditRunId: runId,
          pageId,
          field: o.field,
          status: o.value ? 'observed' : 'not_observed',
          value: o.value,
          method: 'dom_heuristic',
          sourcePath: 'test',
        },
      })
    }
  }

  await prisma.auditReport.create({
    data: {
      id: newId(),
      tenantId,
      auditRunId: runId,
      crmCompanyId: company,
      companyName: company === MINE ? 'Mine Ltd' : 'Rival Ltd',
      websiteUrl: company === MINE ? 'https://mine.test' : 'https://rival.test',
      auditDate: new Date(),
      pagesInspected: products.length,
      productPagesInspected: products.length,
      status,
      collateral: {
        headline: `Product Data Health Check — ${company === MINE ? 'Mine Ltd' : 'Rival Ltd'}`,
        summary: 'A summary a reviewer approved.',
        scopeNote: 'Scope: every figure describes the inspected pages only.',
        businessImpact: ['Products become filterable.'],
        nextStep: 'A fifteen-minute walkthrough.',
        cta: { label: 'Book a 15-minute walkthrough', url: null },
      },
    },
  })
  return runId
}

beforeAll(async () => {
  if (skipReason) return
  const { prisma } = await import('../../src/platform/db.js')
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  tenantId = tenant.id

  myRun = await seedRun(MINE, 'approved', [
    {
      url: 'https://mine.test/product/pump-42/',
      observations: [
        { field: 'product.name', value: 'MINE Circulation Pump 42' },
        { field: 'product.sku', value: 'MIN-42' },
        { field: 'product.image', value: 'https://mine.test/img/pump-42.jpg' },
        { field: 'product.brand', value: null },
        { field: 'product.availability', value: null },
      ],
    },
    {
      url: 'https://mine.test/product/valve-7/',
      observations: [
        { field: 'product.name', value: 'MINE Valve 7' },
        { field: 'product.image', value: 'https://mine.test/img/valve-7.jpg' },
        { field: 'product.brand', value: null },
      ],
    },
  ])

  otherRun = await seedRun(OTHER, 'approved', [
    {
      url: 'https://rival.test/product/bath/',
      observations: [
        { field: 'product.name', value: 'RIVAL Bath Suite' },
        { field: 'product.image', value: 'https://rival.test/img/bath.jpg' },
      ],
    },
  ])

  unapprovedRun = await seedRun(MINE, 'ready_for_approval', [
    {
      url: 'https://mine.test/product/hose/',
      observations: [
        { field: 'product.name', value: 'MINE Hose 3m' },
        { field: 'product.image', value: 'https://mine.test/img/hose.jpg' },
      ],
    },
  ])
})

afterAll(async () => {
  if (skipReason) return
  const { prisma } = await import('../../src/platform/db.js')
  await prisma.auditReport.deleteMany({ where: { crmCompanyId: { in: [MINE, OTHER] } } })
  await prisma.websiteAuditRun.deleteMany({ where: { crmCompanyId: { in: [MINE, OTHER] } } })
})

describeIfReady('one company, one story', () => {
  it('describes the company the run belongs to', async () => {
    const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')
    const v = await buildCustomerView(tenantId, myRun)

    expect(v.crmCompanyId).toBe(MINE)
    expect(v.auditRunId).toBe(myRun)
    expect(v.companyName).toBe('Mine Ltd')
    expect(v.website).toBe('https://mine.test')
  })

  it('never reaches another company’s products, images or URLs', async () => {
    const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')
    const v = await buildCustomerView(tenantId, myRun)

    const blob = JSON.stringify(v)
    expect(blob, 'the rival must appear nowhere in this story').not.toContain('rival.test')
    expect(blob).not.toContain('RIVAL')
    expect(blob).not.toContain('Rival Ltd')

    for (const c of v.caseStudies) {
      expect(c.crmCompanyId).toBe(MINE)
      expect(c.auditRunId).toBe(myRun)
      expect(new URL(c.sourceUrl).hostname).toBe('mine.test')
      if (c.imageUrl) expect(new URL(c.imageUrl).hostname).toBe('mine.test')
    }
  })

  it('gives the other run its own story when asked about it', async () => {
    const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')
    const v = await buildCustomerView(tenantId, otherRun)
    expect(v.crmCompanyId).toBe(OTHER)
    expect(JSON.stringify(v)).not.toContain('mine.test')
  })
})

describeIfReady('approval governs publication, not visibility', () => {
  it('builds the story for a report still awaiting approval', async () => {
    const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')
    const v = await buildCustomerView(tenantId, unapprovedRun)

    // This is the whole fix: a preview exists, and it is honestly labelled.
    expect(v.reportStatus).toBe('ready_for_approval')
    expect(v.approved, 'it may be shown, but not published').toBe(false)
    expect(v.caseStudies.length, 'and it is a real story, not an empty shell').toBeGreaterThan(0)
  })

  it('marks an approved report as approved', async () => {
    const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')
    expect((await buildCustomerView(tenantId, myRun)).approved).toBe(true)
  })

  it('refuses a run with no report at all', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')
    const bare = newId()
    await prisma.websiteAuditRun.create({
      data: { id: bare, tenantId, crmCompanyId: MINE, requestedByCrmUserId: 'tester', status: 'completed' },
    })
    await expect(buildCustomerView(tenantId, bare)).rejects.toThrow(/no customer view|No report/i)
  })
})

describeIfReady('nothing in the story is invented', () => {
  it('never carries an AFTER value where there was no BEFORE value', async () => {
    const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')
    const v = await buildCustomerView(tenantId, myRun)

    for (const c of v.caseStudies) {
      for (const f of c.fields) {
        if (f.before === null) {
          expect(f.after, `${c.title} / ${f.field} was never published`).toBeNull()
          expect(f.state).toBe('absent')
        }
      }
    }
  })

  it('states each gap against the sample it was measured on', async () => {
    const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')
    const v = await buildCustomerView(tenantId, myRun)

    expect(v.gaps.length).toBeGreaterThan(0)
    for (const g of v.gaps) {
      expect(g.published).toBeLessThan(g.sample)
      expect(g.sample, 'two product pages were seeded').toBe(2)
      expect(g.statement, 'a gap is stated, never implied').toMatch(/inspected product page/i)
    }

    const brand = v.gaps.find((g) => g.field === 'product.brand')
    expect(brand, 'brand was published on neither page').toBeTruthy()
    expect(brand!.published).toBe(0)
  })

  it('carries the reviewer’s approved wording rather than recomposing it', async () => {
    const { buildCustomerView } = await import('../../src/websiteaudit/customerView.js')
    const v = await buildCustomerView(tenantId, myRun)
    expect(v.summary).toBe('A summary a reviewer approved.')
    expect(v.nextStep).toBe('A fifteen-minute walkthrough.')
    expect(v.ctaLabel).toBe('Book a 15-minute walkthrough')
  })
})
