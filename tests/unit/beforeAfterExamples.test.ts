import { beforeEach, describe, expect, it, vi } from 'vitest'

// PHASE 6 — the before/after loader.
//
// The loader reads stored Workbench comparison rows; prisma is mocked so the
// SELECTION and REFUSAL rules can be tested directly, which is where the
// behaviour lives. Whether prisma can reach a database is not what these
// assertions are about.

const findFirst = vi.fn()
vi.mock('../../src/platform/db.js', () => ({
  prisma: { workbenchDemo: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}))

const { loadBeforeAfterExamples } = await import('../../src/websiteaudit/examples.js')

const row = (over: Record<string, unknown> = {}) => ({
  field: 'product.category',
  label: 'Category',
  position: 0,
  beforeValue: null,
  afterValue: 'Nitrile Disposable Gloves',
  delta: 'added',
  headline: true,
  transformKind: 'derived',
  sourceObservationId: 'obs_1',
  sourceField: 'page.breadcrumbs',
  sourceUrl: 'https://1stayd.com/p/gloves',
  sourcePath: 'nav.breadcrumb',
  sourceFragment: 'Home > SAFETY &amp; PPE > Nitrile Disposable Gloves',
  transformRule: 'Derived from the breadcrumb trail ("Home > SAFETY &amp; PPE") published on this page.',
  ...over,
})

const demo = (over: Record<string, unknown> = {}) => ({
  status: 'ready',
  statusReason: null,
  productPageUrl: 'https://1stayd.com/p/gloves',
  websiteUrl: 'https://1stayd.com',
  productName: '8 mil Orange Nitrile Gloves',
  fields: [row()],
  ...over,
})

beforeEach(() => findFirst.mockReset())

describe('loading stored before/after comparisons', () => {
  it('returns the stored comparison with its provenance intact', async () => {
    findFirst.mockResolvedValue(demo())
    const r = await loadBeforeAfterExamples('t1', 'run1')
    expect(r.examples).toHaveLength(1)
    const f = r.examples[0]!.fields[0]!
    expect(f.after).toBe('Nitrile Disposable Gloves')
    expect(f.provenance.kind).toBe('derived')
    expect(f.provenance.sourceObservationId).toBe('obs_1')
    expect(f.provenance.rule).toContain('breadcrumb')
  })

  it('decodes HTML entities so they never reach a customer document', async () => {
    findFirst.mockResolvedValue(demo())
    const r = await loadBeforeAfterExamples('t1', 'run1')
    const f = r.examples[0]!.fields[0]!
    expect(f.provenance.rule).toContain('SAFETY & PPE')
    expect(f.provenance.rule).not.toContain('&amp;')
  })

  it('drops an AFTER value that cannot be traced to an observation', async () => {
    findFirst.mockResolvedValue(demo({ fields: [row({ sourceObservationId: null })] }))
    const r = await loadBeforeAfterExamples('t1', 'run1')
    expect(r.examples).toHaveLength(0)
    expect(r.untraceableFields).toBe(1)
    expect(r.reason).toMatch(/could not be traced to an observation and were withheld/)
  })

  it('excludes fields where nothing changed, and says how many', async () => {
    findFirst.mockResolvedValue(
      demo({ fields: [row(), row({ delta: 'unchanged' }), row({ delta: 'still_absent' })] }),
    )
    const r = await loadBeforeAfterExamples('t1', 'run1')
    expect(r.examples[0]!.fields).toHaveLength(1)
    expect(r.unchangedFields).toBe(2)
  })

  it('honours the field cap', async () => {
    findFirst.mockResolvedValue(demo({ fields: [row(), row({ field: 'a' }), row({ field: 'b' }), row({ field: 'c' })] }))
    const r = await loadBeforeAfterExamples('t1', 'run1', { maxFieldsPerExample: 2 })
    expect(r.examples[0]!.fields).toHaveLength(2)
  })
})

describe('degrading honestly', () => {
  it('states why when no Workbench comparison exists', async () => {
    findFirst.mockResolvedValue(null)
    const r = await loadBeforeAfterExamples('t1', 'run1')
    expect(r.examples).toEqual([])
    expect(r.reason).toMatch(/No Workbench comparison has been built/)
  })

  it('states why when the site had no product page', async () => {
    findFirst.mockResolvedValue(demo({ status: 'no_product_page', fields: [] }))
    const r = await loadBeforeAfterExamples('t1', 'run1')
    expect(r.examples).toEqual([])
    expect(r.reason).toMatch(/No product page could be identified/)
  })

  it('carries the reason through when the comparison failed', async () => {
    findFirst.mockResolvedValue(demo({ status: 'failed', statusReason: 'render timed out', fields: [] }))
    const r = await loadBeforeAfterExamples('t1', 'run1')
    expect(r.reason).toMatch(/render timed out/)
  })

  it('says so when the comparison changed nothing', async () => {
    findFirst.mockResolvedValue(demo({ fields: [row({ delta: 'unchanged' })] }))
    const r = await loadBeforeAfterExamples('t1', 'run1')
    expect(r.examples).toEqual([])
    expect(r.reason).toMatch(/changed nothing/)
  })

  it('never invents a product page url', async () => {
    findFirst.mockResolvedValue(demo({ productPageUrl: null, websiteUrl: null }))
    const r = await loadBeforeAfterExamples('t1', 'run1')
    expect(r.examples[0]!.productUrl).toBe('')
  })
})
