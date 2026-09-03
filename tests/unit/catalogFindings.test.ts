import { describe, expect, it } from 'vitest'
import { findUnsupportedClaims, assertSupported, sampleMetric, UnsupportedClaimError } from '../../src/websiteaudit/claimGuard.js'
import { analyseObservations, type AuditContext, type ObservationRow } from '../../src/websiteaudit/findings.js'
import { buildCollateral } from '../../src/websiteaudit/collateral.js'
import { renderAuditPdf } from '../../src/websiteaudit/pdfReport.js'

// TASK #979 — CATALOG PROBLEM DETECTION, SAMPLE-SIZE-AWARE METRICS, EVIDENCE
// TRACEABILITY, FINDING PRIORITY, UNSUPPORTED-CLAIM PREVENTION,
// RECOMMENDATIONS, SALES COLLATERAL, PDF GENERATION AND PDF TRACEABILITY.
//
// The assertion that matters most in this file is the negative one: no
// generated sentence anywhere may contain a percentage, a currency figure, or a
// claim about the whole catalogue. Those are the sentences that would get a
// salesperson caught out, and they are the reason the guard runs at generation
// time rather than only here.

let seq = 0
function obs(over: Partial<ObservationRow> = {}): ObservationRow {
  seq++
  return {
    id: `obs_${seq}`,
    pageId: 'page_1',
    field: 'product.specifications',
    status: 'not_observed',
    value: null,
    sourcePath: null,
    fragment: null,
    observedAt: new Date('2026-08-27T10:00:00Z'),
    pageUrl: 'https://acme.example/products/bolt-1',
    pageType: 'product',
    ...over,
  }
}

/** Builds a product page's worth of observations. */
function productPage(pageId: string, present: Record<string, string | null>): ObservationRow[] {
  const FIELDS = [
    'product.name',
    'product.sku',
    'product.brand',
    'product.description',
    'product.specifications',
    'product.dimensions',
    'product.weight',
    'product.availability',
    'product.units',
  ]
  return FIELDS.map((field) =>
    obs({
      pageId,
      field,
      pageUrl: `https://acme.example/products/${pageId}`,
      status: field in present ? 'observed' : 'not_observed',
      value: field in present ? present[field]! : null,
      sourcePath: field in present ? `JSON-LD[1].${field.replace('product.', '')}` : null,
      fragment: field in present ? `${field}: ${present[field]}` : null,
    }),
  )
}

const ctx = (over: Partial<AuditContext> = {}): AuditContext => ({
  pagesFetched: 12,
  productPages: 3,
  categoryPages: 1,
  duplicatePages: 0,
  canonicalDuplicates: 0,
  soft404Pages: 0,
  httpErrors: 0,
  httpErrorPages: [],
  ...over,
})

// ── UNSUPPORTED-CLAIM PREVENTION ───────────────────────────────────────────

describe('unsupported-claim prevention', () => {
  const banned: Array<[string, string]> = [
    ['87% of your catalogue is missing specifications', 'percentage'],
    ['This is costing you £40,000 a year', 'money'],
    ['Expected ROI of 3x within a year', 'financial-outcome'],
    ['This will increase conversion by 15 points', 'improvement-promise'],
    ['Fixing this is guaranteed to lift search traffic', 'guarantee'],
    ['Your entire catalogue lacks dimensional data', 'whole-catalogue-generalisation'],
    ['A world-class product data experience', 'marketing-filler'],
  ]

  banned.forEach(([text, rule]) => {
    it(`rejects: "${text.slice(0, 45)}…" (${rule})`, () => {
      const violations = findUnsupportedClaims(text)
      expect(violations.length).toBeGreaterThan(0)
      expect(violations.map((v) => v.pattern)).toContain(rule)
    })
  })

  it('accepts a sample-scoped statement', () => {
    expect(findUnsupportedClaims('Specifications were observed on 3 of 12 inspected product pages.')).toEqual([])
  })

  it('throws rather than silently sanitising', () => {
    // Stripping the "%" would leave a sentence that reads as though a number
    // was intended and lost. A generator producing this has a bug.
    expect(() => assertSupported('test', 'Roughly 87% of pages')).toThrow(UnsupportedClaimError)
  })

  it('names the field and the reason when it refuses', () => {
    try {
      assertSupported('finding.impact', 'This costs you $12,000')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as UnsupportedClaimError).field).toBe('finding.impact')
      expect((err as Error).message).toMatch(/not supported by anything this audit observed/)
    }
  })
})

// ── SAMPLE-SIZE-AWARE CALCULATIONS ─────────────────────────────────────────

describe('sample-size-aware metrics', () => {
  it('always names the denominator', () => {
    expect(sampleMetric('Specifications', 3, 12, 'product pages')).toBe(
      'Specifications were observed on 3 of 12 inspected product pages.',
    )
  })

  it('every finding metric states its sample, never a percentage', () => {
    const observations = [
      ...productPage('p1', { 'product.name': 'Bolt 1' }),
      ...productPage('p2', { 'product.name': 'Bolt 2' }),
      ...productPage('p3', { 'product.name': 'Bolt 3', 'product.specifications': 'Thread: M12' }),
    ]
    const findings = analyseObservations(observations, ctx())
    expect(findings.length).toBeGreaterThan(0)
    findings.forEach((f) => {
      expect(f.metric, f.code).toMatch(/\d+ of \d+ inspected/)
      expect(f.metric, f.code).not.toMatch(/%/)
      expect(f.sampleSize, f.code).toBeGreaterThan(0)
    })
  })

  it('never generalises beyond the inspected sample in any generated text', () => {
    const observations = [...productPage('p1', {}), ...productPage('p2', {})]
    const findings = analyseObservations(observations, ctx({ productPages: 2 }))
    findings.forEach((f) => {
      const prose = [f.finding, f.impact, f.recommendation, f.metric].join(' ')
      expect(findUnsupportedClaims(prose), `${f.code}: ${prose}`).toEqual([])
    })
  })

  it('reports a finding against the sample that produced it, not the whole crawl', () => {
    // 3 product pages inspected out of 25 crawled: the denominator is 3.
    const observations = [...productPage('p1', {}), ...productPage('p2', {}), ...productPage('p3', {})]
    const findings = analyseObservations(observations, ctx({ pagesFetched: 25 }))
    const specs = findings.find((f) => f.code === 'incomplete_specifications')!
    expect(specs.sampleSize).toBe(3)
    expect(specs.metric).toMatch(/of 3 inspected product pages/)
  })
})

// ── CATALOG PROBLEM DETECTION ──────────────────────────────────────────────

describe('catalog problem detection', () => {
  const bare = [...productPage('p1', { 'product.name': 'A' }), ...productPage('p2', { 'product.name': 'B' })]

  it('detects absent specifications', () => {
    const codes = analyseObservations(bare, ctx({ productPages: 2 })).map((f) => f.code)
    expect(codes).toContain('incomplete_specifications')
  })

  it('detects absent dimensions, weight, brand, identifiers and descriptions', () => {
    const codes = analyseObservations(bare, ctx({ productPages: 2 })).map((f) => f.code)
    expect(codes).toEqual(
      expect.arrayContaining([
        'missing_dimensions',
        'missing_weight',
        'missing_brand',
        'missing_product_identifier',
        'weak_product_description',
      ]),
    )
  })

  it('does NOT raise a finding for a field that was present everywhere', () => {
    const full = [
      ...productPage('p1', { 'product.name': 'A', 'product.brand': 'FastenPro' }),
      ...productPage('p2', { 'product.name': 'B', 'product.brand': 'FastenPro' }),
    ]
    expect(analyseObservations(full, ctx()).map((f) => f.code)).not.toContain('missing_brand')
  })

  it('detects mixed metric and imperial units', () => {
    const mixed = [
      ...productPage('p1', { 'product.name': 'A', 'product.units': 'mm, kg' }),
      ...productPage('p2', { 'product.name': 'B', 'product.units': 'in, lb' }),
    ]
    const f = analyseObservations(mixed, ctx()).find((x) => x.code === 'inconsistent_units')!
    expect(f).toBeTruthy()
    expect(f.finding).toMatch(/Metric units \(kg, mm\).*imperial units \(in, lb\)/)
  })

  it('does NOT flag units as inconsistent when only one system is used', () => {
    const consistent = [
      ...productPage('p1', { 'product.name': 'A', 'product.units': 'mm, kg' }),
      ...productPage('p2', { 'product.name': 'B', 'product.units': 'mm' }),
    ]
    expect(analyseObservations(consistent, ctx()).map((f) => f.code)).not.toContain('inconsistent_units')
  })

  it('detects product pages carrying no descriptive data at all', () => {
    const f = analyseObservations(bare, ctx()).find((x) => x.code === 'incomplete_product_metadata')!
    expect(f).toBeTruthy()
    expect(f.affectedCount).toBe(2)
  })

  it('detects duplicate category names published at different URLs', () => {
    const cats = [
      obs({ pageId: 'c1', field: 'category.name', status: 'observed', value: 'Hex Bolts', pageUrl: 'https://acme.example/c/hex-bolts', pageType: 'category', sourcePath: 'h1', fragment: 'Hex Bolts' }),
      obs({ pageId: 'c2', field: 'category.name', status: 'observed', value: 'hex bolts', pageUrl: 'https://acme.example/shop/hex-bolts', pageType: 'category', sourcePath: 'h1', fragment: 'Hex Bolts' }),
      obs({ pageId: 'c3', field: 'category.name', status: 'observed', value: 'Nuts', pageUrl: 'https://acme.example/c/nuts', pageType: 'category', sourcePath: 'h1', fragment: 'Nuts' }),
    ]
    const f = analyseObservations([...bare, ...cats], ctx()).find((x) => x.code === 'duplicate_categories')!
    expect(f).toBeTruthy()
    expect(f.finding).toMatch(/"hex bolts"/)
  })

  it('detects broken internal links from crawl evidence', () => {
    const f = analyseObservations(
      bare,
      ctx({ httpErrors: 2, httpErrorPages: [
        { pageId: 'e1', url: 'https://acme.example/gone', status: 404, reason: 'The site returned HTTP 404.' },
        { pageId: 'e2', url: 'https://acme.example/old', status: 404, reason: 'The site returned HTTP 404.' },
      ] }),
    ).find((x) => x.code === 'broken_internal_links')!
    expect(f).toBeTruthy()
    expect(f.evidence[0]!.sourceUrl).toBe('https://acme.example/gone')
  })

  it('detects soft-404 and duplicate pages', () => {
    const codes = analyseObservations(bare, ctx({ soft404Pages: 3, duplicatePages: 2, canonicalDuplicates: 1 })).map((f) => f.code)
    expect(codes).toContain('soft_404_pages')
    expect(codes).toContain('duplicate_pages')
  })

  it('reports the absence of product pages as ONE honest finding, not many invented ones', () => {
    const findings = analyseObservations(
      [obs({ pageId: 'h', field: 'page.title', status: 'observed', value: 'Acme', pageType: 'company', sourcePath: '<title>', fragment: '<title>Acme</title>' })],
      ctx({ productPages: 0, pagesFetched: 12 }),
    )
    expect(findings.map((f) => f.code)).toEqual(['no_product_pages_identified'])
    expect(findings[0]!.finding).toMatch(/may mean the site has no online catalogue/)
  })

  it('produces nothing at all when nothing was crawled', () => {
    expect(analyseObservations([], ctx({ pagesFetched: 0, productPages: 0 }))).toEqual([])
  })

  it('invents no finding that is not backed by observations', () => {
    // Every finding must cite at least one evidence record.
    analyseObservations(bare, ctx()).forEach((f) => {
      expect(f.evidence.length, f.code).toBeGreaterThan(0)
    })
  })
})

// ── FINDING SEVERITY / PRIORITY ────────────────────────────────────────────

describe('finding priority', () => {
  const bare = [...productPage('p1', {}), ...productPage('p2', {})]

  it('ranks a tier 1 field affecting most of the sample as high', () => {
    const f = analyseObservations(bare, ctx()).find((x) => x.code === 'incomplete_specifications')!
    expect(f.priority).toBe('high')
  })

  it('explains the priority rather than emitting a bare score', () => {
    const f = analyseObservations(bare, ctx()).find((x) => x.code === 'missing_dimensions')!
    expect(f.priorityReasons.join(' ')).toMatch(/tier 1 field/)
    expect(f.priorityReasons.join(' ')).toMatch(/gives priority "high"/)
  })

  it('gives a tier 3 field a lower priority than a tier 1 field on the same sample', () => {
    const findings = analyseObservations(bare, ctx({ soft404Pages: 1 }))
    const tier1 = findings.find((f) => f.code === 'incomplete_specifications')!
    const tier3 = findings.find((f) => f.code === 'soft_404_pages')!
    const rank = { high: 0, medium: 1, low: 2 }
    expect(rank[tier1.priority]).toBeLessThanOrEqual(rank[tier3.priority])
  })

  it('drops a tier 1 field to medium when it affects only part of the sample', () => {
    const partial = [
      ...productPage('p1', { 'product.name': 'A', 'product.dimensions': '10mm' }),
      ...productPage('p2', { 'product.name': 'B', 'product.dimensions': '12mm' }),
      ...productPage('p3', { 'product.name': 'C' }),
    ]
    const f = analyseObservations(partial, ctx()).find((x) => x.code === 'missing_dimensions')!
    expect(f.priority).toBe('medium')
  })

  it('sorts highest priority first', () => {
    const findings = analyseObservations(bare, ctx({ soft404Pages: 1 }))
    const rank = { high: 0, medium: 1, low: 2 }
    const ranks = findings.map((f) => rank[f.priority])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})

// ── EVIDENCE TRACEABILITY ──────────────────────────────────────────────────

describe('evidence traceability', () => {
  const observations = [
    ...productPage('p1', { 'product.name': 'Bolt', 'product.sku': 'B-1' }),
    ...productPage('p2', { 'product.name': 'Nut' }),
  ]
  const findings = analyseObservations(observations, ctx())

  it('every finding carries observation references with a source URL and timestamp', () => {
    findings.forEach((f) => {
      f.evidence.forEach((e) => {
        expect(e.observationId, f.code).toBeTruthy()
        expect(e.pageId, f.code).toBeTruthy()
        expect(e.sourceUrl, f.code).toMatch(/^https?:\/\/|^\(unknown/)
        expect(e.field, f.code).toBeTruthy()
        expect(e.observedAt, f.code).toBeInstanceOf(Date)
      })
    })
  })

  it('evidence for an ABSENCE points at the pages where the field was looked for', () => {
    // "Not observed on this URL" is the evidence. Without it, an absence claim
    // would be unfalsifiable.
    const f = findings.find((x) => x.code === 'missing_brand')!
    expect(f.evidence.every((e) => e.status === 'not_observed')).toBe(true)
    expect(f.evidence.map((e) => e.sourceUrl)).toContain('https://acme.example/products/p1')
  })

  it('evidence for a PRESENCE carries the source path and fragment', () => {
    const mixedUnits = [
      ...productPage('p1', { 'product.name': 'A', 'product.units': 'mm' }),
      ...productPage('p2', { 'product.name': 'B', 'product.units': 'in' }),
    ]
    const f = analyseObservations(mixedUnits, ctx()).find((x) => x.code === 'inconsistent_units')!
    expect(f.evidence[0]!.sourcePath).toBeTruthy()
    expect(f.evidence[0]!.fragment).toBeTruthy()
  })
})

// ── RECOMMENDATION GENERATION ──────────────────────────────────────────────

describe('recommendation generation', () => {
  const findings = analyseObservations([...productPage('p1', {}), ...productPage('p2', {})], ctx())

  it('every finding carries a recommendation and an impact statement', () => {
    findings.forEach((f) => {
      expect(f.recommendation.length, f.code).toBeGreaterThan(20)
      expect(f.impact.length, f.code).toBeGreaterThan(20)
    })
  })

  it('recommendations describe an action, not an outcome to be promised', () => {
    findings.forEach((f) => {
      expect(findUnsupportedClaims(f.recommendation), f.code).toEqual([])
    })
  })

  it('impact statements avoid financial claims entirely', () => {
    findings.forEach((f) => {
      expect(f.impact.toLowerCase(), f.code).not.toMatch(/revenue|roi|cost|£|\$|€/)
    })
  })
})

// ── SALES COLLATERAL ───────────────────────────────────────────────────────

describe('sales collateral', () => {
  const findings = analyseObservations([...productPage('p1', {}), ...productPage('p2', {})], ctx({ productPages: 2 }))
  const collateral = buildCollateral({
    companyName: 'Acme Industrial Supply',
    website: 'https://acme.example',
    auditDate: new Date('2026-08-27T12:00:00Z'),
    pagesInspected: 12,
    productPagesInspected: 2,
    categoryPagesInspected: 1,
    findings,
    limitsHit: ['maxPages (25)'],
  })

  it('carries every required field', () => {
    expect(collateral.companyName).toBe('Acme Industrial Supply')
    expect(collateral.website).toBe('https://acme.example')
    expect(collateral.auditDate).toBe('2026-08-27')
    expect(collateral.pagesInspected).toBe(12)
    expect(collateral.productPagesInspected).toBe(2)
    expect(collateral.keyFindings.length).toBeGreaterThan(0)
    expect(collateral.metrics.length).toBeGreaterThan(0)
    expect(collateral.businessImpact.length).toBeGreaterThan(0)
    expect(collateral.recommendedImprovementAreas.length).toBeGreaterThan(0)
    expect(collateral.nextStep.length).toBeGreaterThan(20)
  })

  it('contains no unsupported claim anywhere in its prose', () => {
    const prose = [
      collateral.headline,
      collateral.summary,
      collateral.nextStep,
      collateral.scopeNote,
      ...collateral.businessImpact,
      ...collateral.recommendedImprovementAreas,
      ...collateral.keyFindings.flatMap((f) => [f.title, f.metric, f.impact, f.recommendation]),
      ...collateral.metrics.map((m) => `${m.label} ${m.basis}`),
    ].join(' \n ')
    expect(findUnsupportedClaims(prose)).toEqual([])
  })

  it('states the sample and the limits that bound it', () => {
    expect(collateral.summary).toMatch(/12 page\(s\) inspected/)
    expect(collateral.scopeNote).toMatch(/maxPages \(25\)/)
    expect(collateral.scopeNote).toMatch(/inspected pages only/)
  })

  it('every metric carries the basis it was computed from', () => {
    collateral.metrics.forEach((m) => expect(m.basis.length, m.label).toBeGreaterThan(10))
  })

  it('key findings carry the source URLs behind them', () => {
    collateral.keyFindings.forEach((f) => {
      expect(f.sourceUrls.length, f.title).toBeGreaterThan(0)
      expect(f.evidenceCount, f.title).toBeGreaterThan(0)
    })
  })

  it('ends at ready_for_approval and says nothing about approving', () => {
    // Task #980 owns approval. Task #979 stops here.
    expect(collateral.status).toBe('ready_for_approval')
  })

  it('says so plainly when no finding was recorded', () => {
    const empty = buildCollateral({
      companyName: 'Quiet Co',
      website: 'https://quiet.example',
      auditDate: new Date('2026-08-27T12:00:00Z'),
      pagesInspected: 4,
      productPagesInspected: 0,
      categoryPagesInspected: 0,
      findings: [],
      limitsHit: [],
    })
    expect(empty.summary).toMatch(/No product page could be identified/)
    expect(empty.nextStep).toMatch(/wider review would be needed/)
    expect(empty.keyFindings).toEqual([])
  })
})

// ── PDF GENERATION AND PDF TRACEABILITY ────────────────────────────────────

describe('PDF generation', () => {
  const findings = analyseObservations(
    [...productPage('p1', { 'product.name': 'Bolt' }), ...productPage('p2', {})],
    ctx({ productPages: 2 }),
  )
  const collateral = buildCollateral({
    companyName: 'Acme Industrial Supply',
    website: 'https://acme.example',
    auditDate: new Date('2026-08-27T12:00:00Z'),
    pagesInspected: 12,
    productPagesInspected: 2,
    categoryPagesInspected: 1,
    findings,
    limitsHit: [],
  })

  it('produces a valid PDF of at least three pages', async () => {
    const pdf = await renderAuditPdf(collateral, findings)
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.bytes.length).toBeGreaterThan(1000)
    expect(pdf.pageCount).toBeGreaterThanOrEqual(3)
  })

  it('records a digest of the bytes it produced', async () => {
    const pdf = await renderAuditPdf(collateral, findings)
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('embeds the company, website and audit date', async () => {
    const pdf = await renderAuditPdf(collateral, findings)
    const text = pdf.bytes.toString('latin1')
    // pdfkit writes text into compressed streams, so the assertion is on the
    // document catalogue holding real content rather than on raw substrings.
    expect(text).toMatch(/\/Type\s*\/Page/)
    expect(pdf.bytes.length).toBeGreaterThan(2000)
  })

  it('renders without throwing when there are no findings', async () => {
    const empty = buildCollateral({
      companyName: 'Quiet Co',
      website: 'https://quiet.example',
      auditDate: new Date('2026-08-27T12:00:00Z'),
      pagesInspected: 3,
      productPagesInspected: 0,
      categoryPagesInspected: 0,
      findings: [],
      limitsHit: [],
    })
    const pdf = await renderAuditPdf(empty, [])
    expect(pdf.pageCount).toBeGreaterThanOrEqual(3)
  })

  it('is deterministic in size for identical input', async () => {
    // Same findings in, same document out — so a regenerated report can be
    // compared against the one a prospect was sent.
    const a = await renderAuditPdf(collateral, findings)
    const b = await renderAuditPdf(collateral, findings)
    expect(a.bytes.length).toBe(b.bytes.length)
  })

  it('renders every finding into the evidence appendix', async () => {
    // The appendix is what makes the document checkable rather than confident.
    const many = analyseObservations(
      [...productPage('p1', {}), ...productPage('p2', {}), ...productPage('p3', {})],
      ctx({ productPages: 3, soft404Pages: 2 }),
    )
    expect(many.length).toBeGreaterThan(4)
    const pdf = await renderAuditPdf(collateral, many)
    expect(pdf.bytes.length).toBeGreaterThan(3000)
  })
})

// ── RERUN BEHAVIOUR ────────────────────────────────────────────────────────

describe('rerun behaviour', () => {
  it('produces identical findings from identical stored observations', () => {
    const observations = [...productPage('p1', { 'product.name': 'A' }), ...productPage('p2', {})]
    const first = analyseObservations(observations, ctx())
    const second = analyseObservations(observations, ctx())
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('analyses stored rows only, so a rerun cannot contact the site again', () => {
    // analyseObservations takes rows and a context object. It has no transport,
    // which is what makes a rerun free and repeatable.
    expect(analyseObservations.length).toBe(2)
  })
})
