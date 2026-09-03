import { describe, expect, it } from 'vitest'
import { buildCollateral, type CollateralExample } from '../../src/websiteaudit/collateral.js'
import {
  buildBusinessPain,
  buildBusinessValue,
  buildDiscoverabilityNotes,
} from '../../src/websiteaudit/businessCase.js'
import { buildComparison, type PeerAudit } from '../../src/websiteaudit/comparison.js'
import { findUnsupportedClaims } from '../../src/websiteaudit/claimGuard.js'
import type { CatalogFinding, FindingEvidence } from '../../src/websiteaudit/findings.js'

// PHASE 6 — customer / courier report and the business-value layer.
//
// The rule under test throughout: the report may be persuasive, but every
// sentence in it has to survive the claim guard, and the customer variant has
// to withhold what the sales conversation is for.

const ev = (over: Partial<FindingEvidence> = {}): FindingEvidence => ({
  observationId: 'obs_1',
  pageId: 'pg_1',
  sourceUrl: 'https://1stayd.com/product/degreaser-5l',
  field: 'product.specifications',
  status: 'missing',
  value: null,
  sourcePath: 'main > .spec-table',
  fragment: '<div class="spec-table"></div>',
  observedAt: new Date('2026-08-27T00:00:00Z'),
  ...over,
})

const finding = (over: Partial<CatalogFinding> = {}): CatalogFinding => ({
  code: 'incomplete_specifications',
  title: 'Incomplete technical specifications',
  category: 'specifications',
  priority: 'high',
  priorityReasons: ['tier 1 field'],
  affectedCount: 9,
  observedCount: 3,
  sampleSize: 12,
  sampleUnit: 'product pages',
  metric: '3 of 12 inspected product pages carried a specification block.',
  finding: 'Specifications were not consistently present on the inspected product pages',
  impact: 'Buyers cannot compare products on specification.',
  recommendation: 'Hold specifications as named attributes per product family.',
  evidence: [ev(), ev({ observationId: 'obs_2', sourceUrl: 'https://1stayd.com/product/wipes-100' })],
  ...over,
})

const baseInput = {
  companyName: '1st Ayd',
  website: 'https://1stayd.com',
  auditDate: new Date('2026-08-27T00:00:00Z'),
  pagesInspected: 15,
  productPagesInspected: 12,
  categoryPagesInspected: 3,
  limitsHit: ['the 15-page cap'],
}

const example = (url: string): CollateralExample => ({
  productUrl: url,
  productName: 'Industrial Degreaser 5L',
  fields: [
    {
      field: 'product.sku',
      label: 'Product identifier',
      before: 'DEG-5L',
      after: 'DEG-5L',
      delta: 'unchanged',
      headline: false,
      provenance: {
        kind: 'unchanged',
        sourceObservationId: 'obs_9',
        sourceField: 'product.sku',
        sourceUrl: url,
        sourcePath: 'main .sku',
        sourceFragment: '<span class="sku">DEG-5L</span>',
        rule: 'Present and already usable; carried across untouched.',
      },
    },
    {
      field: 'product.category',
      label: 'Category',
      before: null,
      after: 'Cleaning Chemicals',
      delta: 'added',
      headline: true,
      provenance: {
        kind: 'derived',
        sourceObservationId: 'obs_10',
        sourceField: 'page.breadcrumbs',
        sourceUrl: url,
        sourcePath: 'nav.breadcrumb',
        sourceFragment: 'Home > Cleaning Chemicals > Degreasers',
        rule: 'Taken from the breadcrumb trail already published on the page.',
      },
    },
  ],
})

// ── 1. BUSINESS PAIN ───────────────────────────────────────────────────────

describe('business pain analysis', () => {
  it('turns a finding into the five-part reading', () => {
    const p = buildBusinessPain(finding())
    expect(p.findingCode).toBe('incomplete_specifications')
    for (const part of [p.observation, p.businessPain, p.whyItMatters, p.potentialOpportunity, p.recommendedDirection]) {
      expect(part.length).toBeGreaterThan(20)
    }
  })

  it('carries the finding\'s own sample-scoped numbers into the observation', () => {
    const p = buildBusinessPain(finding())
    expect(p.observation).toMatch(/3 of 12 inspected product pages/)
  })

  it('never states a guaranteed or financial outcome', () => {
    const codes = [
      'incomplete_specifications', 'missing_dimensions', 'missing_brand', 'weak_product_description',
      'no_product_structured_data', 'inconsistent_units', 'duplicate_pages', 'no_product_pages_identified',
    ]
    for (const code of codes) {
      const p = buildBusinessPain(finding({ code }))
      const all = [p.businessPain, p.whyItMatters, p.potentialOpportunity, p.recommendedDirection].join(' ')
      expect(findUnsupportedClaims(all), code).toEqual([])
    }
  })

  it('falls back to the category when a code has no written interpretation', () => {
    const p = buildBusinessPain(finding({ code: 'some_new_code', category: 'attributes' }))
    expect(p.businessPain).toMatch(/attributes were not consistently present/i)
  })

  it('uses tentative language rather than asserting the customer\'s experience', () => {
    const p = buildBusinessPain(finding())
    expect(`${p.businessPain} ${p.potentialOpportunity}`).toMatch(/\bmay\b|\bcan\b|\blets\b/)
  })
})

// ── 2. BUSINESS VALUE ──────────────────────────────────────────────────────

describe('business value layer', () => {
  const value = (findings: CatalogFinding[], hasDemo = false) =>
    buildBusinessValue({
      companyName: '1st Ayd',
      findings,
      pains: findings.map(buildBusinessPain),
      pagesInspected: 15,
      productPagesInspected: 12,
      hasWorkbenchDemo: hasDemo,
    })

  it('produces all six sections plus the financial note', () => {
    const v = value([finding()])
    for (const s of [v.whatWeObserved, v.whyThisMatters, v.whereThePainMayAppear, v.howAltiusNxtCanHelp, v.improvedExperience, v.nextStep, v.financialNote]) {
      expect(s.length).toBeGreaterThan(30)
    }
  })

  it('marks financial analysis as not quantified, in those words', () => {
    expect(value([finding()]).financialNote).toMatch(/Potential opportunity — not quantified in this audit/)
  })

  it('names the company and uses the real counts', () => {
    const v = value([finding()])
    expect(v.whatWeObserved).toContain('1st Ayd')
    expect(v.whatWeObserved).toMatch(/15 page\(s\)/)
    expect(v.whatWeObserved).toMatch(/12 of them product pages/)
  })

  it('reads honestly when nothing was found', () => {
    const v = value([])
    expect(v.whatWeObserved).toMatch(/no product-data finding/)
    expect(v.whereThePainMayAppear).toMatch(/No pain was evident/)
  })

  it('mentions the worked example only when one exists', () => {
    expect(value([finding()], true).improvedExperience).toMatch(/available/)
    expect(value([finding()], false).improvedExperience).not.toMatch(/A worked example from one of/)
  })

  it('passes the claim guard in every section', () => {
    const v = value([finding()])
    for (const [k, s] of Object.entries(v)) {
      expect(findUnsupportedClaims(s), k).toEqual([])
    }
  })
})

// ── 3. SEO / AEO / GEO ─────────────────────────────────────────────────────

describe('discoverability notes', () => {
  it('produces notes only for findings that were actually recorded', () => {
    expect(buildDiscoverabilityNotes([])).toEqual([])
    const notes = buildDiscoverabilityNotes([finding({ code: 'no_product_structured_data' })])
    expect(notes.map((n) => n.lens).sort()).toEqual(['aeo', 'geo', 'seo'])
    for (const n of notes) expect(n.findingCode).toBe('no_product_structured_data')
  })

  it('anchors every note to the finding\'s own counts', () => {
    const notes = buildDiscoverabilityNotes([finding({ code: 'weak_product_description' })])
    expect(notes[0]!.observation).toMatch(/3 of 12 inspected product pages/)
  })

  it('never claims a ranking or a visibility position', () => {
    const codes = ['no_product_structured_data', 'weak_product_description', 'incomplete_specifications', 'duplicate_pages', 'broken_internal_links', 'soft_404_pages', 'incomplete_product_metadata']
    for (const code of codes) {
      for (const n of buildDiscoverabilityNotes([finding({ code })])) {
        expect(findUnsupportedClaims(n.consideration), `${code}/${n.lens}`).toEqual([])
      }
    }
  })

  it('blocks a ranking claim if one were ever written', () => {
    const v = findUnsupportedClaims('This will improve your search ranking.')
    expect(v.map((x) => x.pattern)).toContain('ranking-claim')
  })

  it('still allows the sentence that denies a ranking claim', () => {
    expect(findUnsupportedClaims('Figures describe the inspected pages only and are not a ranking.')).toEqual([])
  })
})

// ── 4. THE CUSTOMER REPORT WITHHOLDS ───────────────────────────────────────

describe('customer report — what it shows and what it holds back', () => {
  const many = [
    finding(),
    finding({ code: 'missing_brand', category: 'identifiers', title: 'Brand not stated', priority: 'high' }),
    finding({ code: 'missing_dimensions', category: 'attributes', title: 'Dimensions absent', priority: 'medium' }),
    finding({ code: 'duplicate_pages', category: 'structure', title: 'Duplicate pages', priority: 'low' }),
    finding({ code: 'missing_weight', category: 'attributes', title: 'Weight absent', priority: 'low' }),
  ]
  const examples = [example('https://1stayd.com/p/1'), example('https://1stayd.com/p/2'), example('https://1stayd.com/p/3'), example('https://1stayd.com/p/4'), example('https://1stayd.com/p/5')]

  it('limits the customer report to the configured sample count', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: many, examples, sampleCount: 3 })
    expect(c.examples).toHaveLength(3)
    const internal = buildCollateral({ ...baseInput, audience: 'internal', findings: many, examples })
    expect(internal.examples).toHaveLength(5)
  })

  it('honours a different configured sample count', () => {
    expect(buildCollateral({ ...baseInput, audience: 'customer', findings: many, examples, sampleCount: 2 }).examples).toHaveLength(2)
    expect(buildCollateral({ ...baseInput, audience: 'customer', findings: many, examples, sampleCount: 5 }).examples).toHaveLength(5)
  })

  it('says more was found without itemising it', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: many, examples, sampleCount: 2 })
    expect(c.withheldNote).toMatch(/Additional affected pages were observed in the inspected sample/)
    // The count is safe; the list is not.
    expect(c.withheldNote).not.toMatch(/https?:\/\//)
  })

  it('withholds the remediation methodology from the customer', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: many })
    expect(c.keyFindings.every((f) => f.recommendation === '')).toBe(true)
    expect(c.recommendedImprovementAreas).toEqual([])

    const internal = buildCollateral({ ...baseInput, audience: 'internal', findings: many })
    expect(internal.keyFindings.some((f) => f.recommendation.length > 10)).toBe(true)
    expect(internal.recommendedImprovementAreas.length).toBeGreaterThan(0)
  })

  it('does not leak a full SKU or page list', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: many, examples, sampleCount: 2 })
    const urls = JSON.stringify(c).match(/https:\/\/1stayd\.com\/p\/\d/g) ?? []
    expect(new Set(urls).size).toBeLessThanOrEqual(2)
  })

  it('keeps the scope disclaimer on the artifact itself', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: many })
    expect(c.scopeNote).toMatch(/inspected pages only/)
    expect(c.scopeNote).toMatch(/not be read as a measure of the whole catalogue/)
  })

  it('carries the call to action', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: many, ctaUrl: 'https://cal.example/altiusnxt' })
    expect(c.cta.label).toMatch(/15-minute/i)
    expect(c.cta.url).toBe('https://cal.example/altiusnxt')
  })

  it('reports the CTA as absent rather than inventing a link', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: many, ctaUrl: null })
    expect(c.cta.url).toBeNull()
  })

  it('passes the claim guard across the whole rendered object', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: many, examples })
    const prose = [c.headline, c.summary, c.nextStep, c.scopeNote, c.withheldNote ?? '', ...c.businessImpact,
      ...Object.values(c.businessValue), ...c.businessPain.flatMap((p) => [p.businessPain, p.whyItMatters, p.potentialOpportunity, p.recommendedDirection])]
    for (const t of prose) expect(findUnsupportedClaims(t), t.slice(0, 60)).toEqual([])
  })
})

// ── 5. BEFORE / AFTER PROVENANCE ───────────────────────────────────────────

describe('before/after provenance', () => {
  it('gives every AFTER value a documented origin', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: [finding()], examples: [example('https://1stayd.com/p/1')] })
    for (const f of c.examples.flatMap((e) => e.fields)) {
      if (f.after === null) continue
      expect(f.provenance.rule.length, f.field).toBeGreaterThan(10)
      // Anything not simply carried across must name the observation it came from.
      if (f.provenance.kind !== 'not_present') {
        expect(f.provenance.sourceObservationId, f.field).toBeTruthy()
        expect(f.provenance.sourceUrl, f.field).toBeTruthy()
      }
    }
  })

  it('records a derived value against the field it was derived from', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: [finding()], examples: [example('https://1stayd.com/p/1')] })
    const derived = c.examples[0]!.fields.find((f) => f.provenance.kind === 'derived')!
    expect(derived.after).toBe('Cleaning Chemicals')
    expect(derived.provenance.sourceField).toBe('page.breadcrumbs')
    expect(derived.provenance.sourceFragment).toContain('Cleaning Chemicals')
  })
})

// ── 6. PEER COMPARISON ─────────────────────────────────────────────────────

describe('peer comparison', () => {
  const peer: PeerAudit = {
    label: 'A comparable distributor',
    auditDate: new Date('2026-08-20T00:00:00Z'),
    productPagesInspected: 10,
    findings: [
      finding({
        code: 'incomplete_specifications',
        observedCount: 9,
        sampleSize: 10,
        evidence: [ev({ sourceUrl: 'https://peer.example/p/1', observationId: 'peer_obs_1' })],
      }),
    ],
  }

  it('says so plainly when there is no peer', () => {
    const c = buildComparison({ prospectLabel: '1st Ayd', prospectProductPages: 12, prospectFindings: [finding()], peer: null, maxRows: 4 })
    expect(c.available).toBe(false)
    if (!c.available) expect(c.message).toBe('Comparable evidence not available for this audit.')
  })

  it('refuses to compare when one side had no product page', () => {
    const c = buildComparison({ prospectLabel: '1st Ayd', prospectProductPages: 0, prospectFindings: [finding()], peer, maxRows: 4 })
    expect(c.available).toBe(false)
  })

  it('compares only fields measured on both sides, and cites both', () => {
    const c = buildComparison({ prospectLabel: '1st Ayd', prospectProductPages: 12, prospectFindings: [finding()], peer, maxRows: 4 })
    expect(c.available).toBe(true)
    if (!c.available) return
    expect(c.rows).toHaveLength(1)
    const row = c.rows[0]!
    expect(row.field).toBe('product.specifications')
    expect(row.prospect).toMatch(/3 of 12/)
    expect(row.peer).toMatch(/9 of 10/)
    expect(row.advantage).toBe('peer')
    expect(row.prospectEvidence.length).toBeGreaterThan(0)
    expect(row.peerEvidence.length).toBeGreaterThan(0)
  })

  it('drops a field only one side was measured on', () => {
    const onlyMine = finding({ code: 'missing_weight', evidence: [ev({ field: 'product.weight' })] })
    const c = buildComparison({ prospectLabel: '1st Ayd', prospectProductPages: 12, prospectFindings: [finding(), onlyMine], peer, maxRows: 4 })
    if (!c.available) throw new Error('expected a comparison')
    expect(c.rows.map((r) => r.field)).toEqual(['product.specifications'])
  })

  it('never produces a ranking or a score', () => {
    const c = buildComparison({ prospectLabel: '1st Ayd', prospectProductPages: 12, prospectFindings: [finding()], peer, maxRows: 4 })
    if (!c.available) throw new Error('expected a comparison')
    expect(findUnsupportedClaims(c.summary)).toEqual([])
    expect(c.methodNote).toMatch(/not a ranking/)
    expect(JSON.stringify(c)).not.toMatch(/score/i)
  })

  it('defaults to "not available" when the caller supplies nothing', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: [finding()] })
    expect(c.comparison.available).toBe(false)
    if (!c.comparison.available) expect(c.comparison.message).toBe('Comparable evidence not available for this audit.')
  })
})

// ── 7. EDGE CASES REQUIRED BY THE BRIEF ────────────────────────────────────

describe('edge cases', () => {
  it('handles a company with no product pages', () => {
    const c = buildCollateral({
      ...baseInput,
      audience: 'customer',
      productPagesInspected: 0,
      findings: [finding({ code: 'no_product_pages_identified', category: 'structure', sampleUnit: 'pages', sampleSize: 15, observedCount: 0 })],
    })
    expect(c.summary).toMatch(/No product page could be identified/)
    expect(c.businessValue.whatWeObserved).toMatch(/0 of them product pages/)
    expect(findUnsupportedClaims(c.summary)).toEqual([])
  })

  it('handles an audit that recorded nothing', () => {
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: [] })
    expect(c.keyFindings).toEqual([])
    expect(c.businessPain).toEqual([])
    expect(c.discoverability).toEqual([])
    expect(c.withheldNote).toBeNull()
    expect(c.nextStep).toMatch(/No product-data gap was recorded/)
  })

  it('handles multiple findings and keeps the configured highlight count', () => {
    const many = Array.from({ length: 8 }, (_, i) => finding({ code: `code_${i}`, title: `Finding ${i}` }))
    const c = buildCollateral({ ...baseInput, audience: 'customer', findings: many })
    expect(c.keyFindings.length).toBeLessThanOrEqual(4)
    expect(c.businessPain.length).toBe(c.keyFindings.length)
    expect(c.withheldNote).toMatch(/strongest of 8 findings/)
  })
})
