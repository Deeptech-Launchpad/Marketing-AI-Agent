import { describe, expect, it } from 'vitest'
import {
  buildScorecard,
  buildRemediation,
  NO_SUBJECT_SCORECARD,
  type ScorecardInput,
} from '../../src/websiteaudit/discoverabilityScore.js'
import type { EnrichedRecord, RecordField } from '../../src/websiteaudit/enrichedRecord.js'

// THE NUMBER ON THE FRONT OF THE REPORT.
//
// A score is only allowed on a customer's desk if they can ask what produced
// it and be handed a fact about their own page. So every check here is a rule
// over an observation, and these tests are the proof that the rule and the
// observation are actually connected — that the score moves when the page
// changes and does not move when it does not.

const f = (over: Partial<RecordField> & { field: string; label: string }): RecordField => ({
  group: 'identity',
  before: null,
  after: null,
  state: 'absent',
  method: null,
  sourcePath: null,
  sourceUrl: 'https://acme.test/p/1',
  derivedAttributes: [],
  recommendation: null,
  ...over,
})

const observed = (field: string, label: string, value: string): RecordField =>
  f({ field, label, before: value, after: value, state: 'observed' })

const record = (over: Partial<EnrichedRecord> = {}): EnrichedRecord => ({
  crmCompanyId: 'c1',
  auditRunId: 'r1',
  pageId: 'p1',
  sourceUrl: 'https://acme.test/p/1',
  pageContext: { pageTitle: null, siteName: 'Acme', breadcrumbs: null, host: 'acme.test' },
  title: 'Pump 42',
  imageUrl: null,
  fields: [observed('product.name', 'Product name', 'Pump 42')],
  observedCount: 1,
  restructuredCount: 0,
  absentCount: 0,
  derivedAttributeCount: 0,
  beforeSummary: 'b',
  afterSummary: 'a',
  keyTransformation: 'k',
  ...over,
})

const input = (over: Partial<ScorecardInput> = {}): ScorecardInput => ({
  page: {
    httpStatus: 200,
    finalUrl: 'https://acme.test/p/1',
    canonicalUrl: 'https://acme.test/p/1',
    wordCount: 400,
    outcome: 'fetched',
  },
  structuredDataTypes: [],
  breadcrumbs: null,
  record: record(),
  productPagesInspected: 10,
  siblingProductLinks: 9,
  ...over,
})

const check = (sc: ReturnType<typeof buildScorecard>, ref: string) =>
  sc.pillars.flatMap((p) => p.checks).find((c) => c.ref === ref)!

describe('every check is decided by something the crawler saw', () => {
  it('passes crawler access for a page that answered, and fails one that did not', () => {
    expect(check(buildScorecard(input()), 'A1').status).toBe('pass')
    const blocked = buildScorecard(
      input({ page: { httpStatus: 403, finalUrl: null, canonicalUrl: null, wordCount: 0, outcome: 'blocked' } }),
    )
    expect(check(blocked, 'A1').status).toBe('critical_fail')
    expect(check(blocked, 'A1').finding).toContain('403')
  })

  it('reads structured data from the @type values, not from a guess', () => {
    expect(check(buildScorecard(input()), 'A3').status).toBe('critical_fail')
    expect(check(buildScorecard(input({ structuredDataTypes: ['Product', 'Offer'] })), 'A3').status).toBe('pass')
    // Structured data that describes something other than the product is a
    // real distinction, and it is neither a pass nor a critical failure.
    expect(check(buildScorecard(input({ structuredDataTypes: ['WebSite', 'Organization'] })), 'A3').status).toBe('partial')
  })

  it('grades identifier resolution on which identifiers exist', () => {
    const both = record({
      fields: [observed('product.mpn', 'MPN', '011493'), observed('product.gtin', 'GTIN', '5012345678900')],
    })
    const onlyMpn = record({ fields: [observed('product.mpn', 'MPN', '011493')] })
    expect(check(buildScorecard(input({ record: both })), 'A4').status).toBe('pass')
    expect(check(buildScorecard(input({ record: onlyMpn })), 'A4').status).toBe('partial')
    expect(check(buildScorecard(input()), 'A4').status).toBe('fail')
  })

  it('counts breadcrumb depth rather than its presence alone', () => {
    expect(check(buildScorecard(input({ breadcrumbs: 'Home > Pumps > Circulation' })), 'B3').status).toBe('pass')
    expect(check(buildScorecard(input({ breadcrumbs: 'Home' })), 'B3').status).toBe('partial')
    expect(check(buildScorecard(input()), 'B3').status).toBe('fail')
  })

  // The distinction the whole report rests on: a comma-delimited feed string
  // is not prose, however long it is.
  it('tells a specification string apart from a description', () => {
    const specString = record({
      fields: [
        observed(
          'product.description',
          'Description',
          'Pump 42, Series 1960, Imperial, 3/4-10 Thread, 8 in Length, Alloy Steel, Grade 3A',
        ),
      ],
    })
    const prose = record({
      fields: [
        observed(
          'product.description',
          'Description',
          'A circulation pump for closed heating systems. The cast iron body suits hot water up to 110C. Not suitable for potable water.',
        ),
      ],
    })
    expect(check(buildScorecard(input({ record: specString })), 'B4').status).toBe('fail')
    expect(check(buildScorecard(input({ record: prose })), 'B4').status).toBe('pass')
  })

  it('treats a gated price as a critical commercial failure', () => {
    expect(check(buildScorecard(input()), 'C3').status).toBe('critical_fail')
    const priced = record({
      fields: [observed('product.price', 'Price', '14.20'), observed('product.availability', 'Availability', 'In stock')],
    })
    expect(check(buildScorecard(input({ record: priced })), 'C3').status).toBe('pass')
  })

  // A stored "0" is what a catalogue writes when it has no price to publish.
  it('does not accept a zero price as a published price', () => {
    const zero = record({ fields: [observed('product.price', 'Price', '0')] })
    expect(check(buildScorecard(input({ record: zero })), 'C3').status).toBe('critical_fail')
  })
})

describe('the two checks this platform cannot run', () => {
  it('reports them as not assessed, never as zero', () => {
    const sc = buildScorecard(input())
    expect(check(sc, 'A5').status).toBe('not_assessed')
    expect(check(sc, 'C5').status).toBe('not_assessed')
    expect(sc.notAssessed.map((n) => n.ref)).toEqual(['A5', 'C5'])
  })

  it('leaves them out of the denominator entirely', () => {
    const sc = buildScorecard(input())
    expect(sc.assessedCount).toBe(13)
    expect(sc.pillars.find((p) => p.key === 'find')!.assessedCount).toBe(4)
    expect(sc.pillars.find((p) => p.key === 'understand')!.assessedCount).toBe(5)
  })

  // The bug this prevents: a perfect page scoring 87 because two unrun checks
  // were averaged in as failures.
  it('scores a page that passes everything it was graded on as 100', () => {
    const perfect = record({
      fields: [
        observed('product.name', 'Product name', 'Pump 42'),
        observed('product.brand', 'Brand', 'ACME'),
        observed('product.sku', 'SKU', 'ACM-42'),
        observed('product.mpn', 'MPN', '011493'),
        observed('product.gtin', 'GTIN', '5012345678900'),
        observed('product.dimensions', 'Dimensions', '200 x 120 mm'),
        observed('product.weight', 'Weight', '4.2 kg'),
        observed('product.units', 'Units', 'each'),
        observed('product.price', 'Price', '14.20'),
        observed('product.availability', 'Availability', 'In stock'),
        observed('product.documents', 'Documents', 'datasheet.pdf'),
        observed(
          'product.description',
          'Description',
          'A circulation pump for closed heating systems. The cast iron body suits hot water up to 110C. Not suitable for potable water.',
        ),
      ],
      observedCount: 12,
      derivedAttributeCount: 3,
      absentCount: 0,
    })
    const sc = buildScorecard(
      input({ record: perfect, structuredDataTypes: ['Product', 'Offer'], breadcrumbs: 'Home > Pumps > Circulation' }),
    )
    expect(sc.overall).toBe(100)
  })
})

describe('the roadmap is a consequence of the scorecard', () => {
  it('proposes fixes only for checks that actually failed', () => {
    const sc = buildScorecard(input())
    const fixes = buildRemediation(sc)
    expect(fixes.length).toBeGreaterThan(0)
    const failedRefs = sc.pillars
      .flatMap((p) => p.checks)
      .filter((c) => c.status === 'fail' || c.status === 'critical_fail' || c.status === 'partial')
      .map((c) => c.ref)
    for (const fix of fixes) {
      expect(failedRefs, fix.title).toContain(fix.addresses[0])
    }
  })

  it('carries the failing check’s own finding as the stated gap', () => {
    const sc = buildScorecard(input())
    const fixes = buildRemediation(sc)
    const c3 = check(sc, 'C3')
    const priceFix = fixes.find((x) => x.addresses.includes('C3'))
    if (priceFix) expect(priceFix.currentGap).toBe(c3.finding)
  })

  it('proposes nothing for a page that passed everything', () => {
    const perfect = record({
      fields: [
        observed('product.name', 'Product name', 'Pump 42'),
        observed('product.mpn', 'MPN', '011493'),
        observed('product.gtin', 'GTIN', '5012345678900'),
        observed('product.dimensions', 'Dimensions', '200 x 120 mm'),
        observed('product.price', 'Price', '14.20'),
        observed('product.availability', 'Availability', 'In stock'),
        observed('product.documents', 'Documents', 'datasheet.pdf'),
        observed(
          'product.description',
          'Description',
          'A circulation pump for closed heating systems. The cast iron body suits hot water up to 110C. Not suitable for potable water.',
        ),
      ],
      observedCount: 8,
      derivedAttributeCount: 3,
    })
    const sc = buildScorecard(
      input({ record: perfect, structuredDataTypes: ['Product'], breadcrumbs: 'Home > Pumps > Circulation' }),
    )
    expect(buildRemediation(sc)).toEqual([])
  })
})

describe('the verdict names which pillar failed', () => {
  it('says findable-but-not-recommended when only recommendation is weak', () => {
    const strong = record({
      fields: [
        observed('product.mpn', 'MPN', '011493'),
        observed('product.gtin', 'GTIN', '5012345678900'),
        observed('product.dimensions', 'Dimensions', '200 mm'),
        observed(
          'product.description',
          'Description',
          'A circulation pump for closed systems. Cast iron body. Not for potable water.',
        ),
      ],
      derivedAttributeCount: 2,
    })
    const sc = buildScorecard(
      input({ record: strong, structuredDataTypes: ['Product'], breadcrumbs: 'Home > Pumps > Circulation' }),
    )
    expect(sc.verdict).toBe('FINDABLE, NOT RECOMMENDED')
  })

  it('says not findable when the crawl itself failed', () => {
    const sc = buildScorecard(
      input({ page: { httpStatus: null, finalUrl: null, canonicalUrl: null, wordCount: 0, outcome: 'unreachable' } }),
    )
    expect(sc.verdict).toBe('NOT RELIABLY FINDABLE')
  })
})

// ── The scorecard for a run with no auditable product page ────────────────
//
// This constant had NO coverage at all, which is exactly how it came to hold
// two fields that contradicted each other: fifteen checks marked
// `not_assessed`, beside a `notAssessed` ledger written by hand as `[]`.
//
// Page 2 of the report branches on the LEDGER to decide whether to print
// "All fifteen checks were run against the live page." So the one report that
// had assessed nothing told the customer everything had been assessed.
//
// The ledger is now derived from the checks by the same function a live
// audit's ledger is derived by, and these are the tests that keep the two
// from drifting apart again.

describe('a run that found no auditable product page', () => {
  const REFS = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5']
  const checks = NO_SUBJECT_SCORECARD.pillars.flatMap((p) => p.checks)

  it('marks all fifteen checks not assessed', () => {
    expect(checks).toHaveLength(15)
    expect(checks.every((c) => c.status === 'not_assessed')).toBe(true)
    expect(checks.map((c) => c.ref)).toEqual(REFS)
  })

  // THE DEFECT, stated as the thing that must never be true again: a check
  // that says it was not assessed, and a ledger that does not list it.
  it('lists every one of them in the ledger the report reads', () => {
    expect(NO_SUBJECT_SCORECARD.notAssessed).toHaveLength(15)
    expect(NO_SUBJECT_SCORECARD.notAssessed.map((n) => n.ref)).toEqual(REFS)
  })

  it('counts nothing as assessed', () => {
    expect(NO_SUBJECT_SCORECARD.assessedCount).toBe(0)
    expect(NO_SUBJECT_SCORECARD.overall).toBe(0)
    expect(NO_SUBJECT_SCORECARD.pillars.every((p) => p.assessedCount === 0)).toBe(true)
    expect(NO_SUBJECT_SCORECARD.pillars.every((p) => p.notAssessedCount === 5)).toBe(true)
  })

  it('gives each one a reason naming the missing product page, not a capability gap', () => {
    for (const entry of NO_SUBJECT_SCORECARD.notAssessed) {
      expect(entry.reason, entry.ref).toMatch(/no inspected page published a product record/i)
      expect(entry.reason, entry.ref).not.toMatch(/harness|backlink|citation index/i)
    }
  })

  // A customer is owed the list of what WOULD have been measured. Fifteen rows
  // all reading "Not assessed" in the metric column say nothing at all.
  it('carries the real metric names, identical to the ones a live audit prints', () => {
    const live = new Map(buildScorecard(input()).pillars.flatMap((p) => p.checks).map((c) => [c.ref, c.metric]))
    for (const c of checks) {
      expect(c.metric, c.ref).toBe(live.get(c.ref))
    }
    expect(checks.some((c) => c.metric === 'Not assessed')).toBe(false)
  })

  it('says in its denominator note that the index is not a measurement', () => {
    expect(NO_SUBJECT_SCORECARD.denominatorNote).toMatch(/not a measurement of this catalogue/i)
    expect(NO_SUBJECT_SCORECARD.denominatorNote).toMatch(/none of the 15 checks could be run/i)
  })

  // The note is printed in two different sentence frames — page 2 opens
  // "The overall index above is …" and page 7 runs it on after the scope note.
  // A note that only reads correctly in one of them is how a document ends up
  // ungrammatical in front of a customer.
  it('reads correctly in both sentence frames the report prints it in', () => {
    const note = NO_SUBJECT_SCORECARD.denominatorNote
    expect(note.charAt(0)).toBe(note.charAt(0).toUpperCase())
    expect(note.trimEnd().endsWith('.')).toBe(true)
    const page2 = `The overall index above is ${note.charAt(0).toLowerCase()}${note.slice(1)}`
    expect(page2).toContain('The overall index above is not a measurement')
  })
})

describe('the ledger and the checks can no longer disagree', () => {
  it('derives a live audit’s ledger from its own checks too', () => {
    const sc = buildScorecard(input())
    const unassessed = sc.pillars.flatMap((p) => p.checks).filter((c) => c.status === 'not_assessed')
    expect(sc.notAssessed.map((n) => n.ref)).toEqual(unassessed.map((c) => c.ref))
    expect(sc.assessedCount).toBe(15 - unassessed.length)
    // Still the two the platform genuinely cannot run, with their own reasons.
    expect(sc.notAssessed.map((n) => n.ref)).toEqual(['A5', 'C5'])
    expect(sc.notAssessed.find((n) => n.ref === 'A5')!.reason).toMatch(/backlink or citation index/i)
    expect(sc.notAssessed.find((n) => n.ref === 'C5')!.reason).toMatch(/answer-engine query harness/i)
  })
})
