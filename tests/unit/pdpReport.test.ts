import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { renderPdpReport, referenceFor, type PdpReportInput } from '../../src/websiteaudit/pdpReport.js'
import { buildScorecard, buildRemediation, NO_SUBJECT_SCORECARD, type ScorecardInput } from '../../src/websiteaudit/discoverabilityScore.js'
import type { EnrichedRecord, RecordField } from '../../src/websiteaudit/enrichedRecord.js'

// THE CUSTOMER DELIVERABLE.
//
// Three properties matter more than how it looks:
//
//   · it is exactly seven pages, because the page count is part of the
//     document's identity and pdfkit will silently add pages when content
//     overruns
//   · it never prints a value the audit did not observe
//   · a check that was not run is never scored as a failure that was
//
// The third is new and is the one that would quietly destroy the document's
// credibility: the template it follows shows live answer-engine query logs and
// sector benchmarks, and this platform can produce neither. A zero in those
// rows would read as a measured failure.

const DISCLAIMER = 'Disclaimer: This report is generated through automated analysis of publicly available data.'

function field(over: Partial<RecordField> & { field: string; label: string }): RecordField {
  return {
    group: 'identity',
    before: null,
    after: null,
    state: 'absent',
    method: null,
    sourcePath: null,
    sourceUrl: 'https://acme-supplier.test/product/pump/',
    derivedAttributes: [],
    recommendation: null,
    ...over,
  }
}

function record(over: Partial<EnrichedRecord> = {}): EnrichedRecord {
  return {
    crmCompanyId: 'company-a',
    auditRunId: 'run-1',
    pageId: 'page-1',
    sourceUrl: 'https://acme-supplier.test/product/pump/',
    pageContext: {
      pageTitle: 'ACME Circulation Pump 42 — ACME Supplier',
      siteName: 'ACME Supplier',
      breadcrumbs: 'Home > Pumps > Circulation',
      host: 'acme-supplier.test',
    },
    title: 'ACME Circulation Pump 42',
    imageUrl: null,
    fields: [
      field({ field: 'product.name', label: 'Product name', before: 'ACME Circulation Pump 42', after: 'ACME Circulation Pump 42', state: 'observed' }),
      field({ field: 'product.brand', label: 'Brand', before: 'ACME', after: 'ACME', state: 'observed' }),
      field({ field: 'product.sku', label: 'Product code / SKU', before: 'ACM-42', after: 'ACM-42', state: 'observed' }),
      field({ field: 'product.mpn', label: 'Manufacturer part number' }),
      field({ field: 'product.gtin', label: 'GTIN / barcode' }),
      field({ field: 'product.price', label: 'Price' }),
      field({ field: 'product.availability', label: 'Availability' }),
      field({ field: 'product.documents', label: 'Supporting documents' }),
      field({ field: 'product.description', label: 'Description', before: 'A circulation pump. Suitable for heating systems. Cast iron body.', after: null, state: 'observed' }),
    ],
    observedCount: 4,
    restructuredCount: 0,
    absentCount: 5,
    derivedAttributeCount: 1,
    beforeSummary: 'The page publishes product name, brand and product code.',
    afterSummary: 'The enriched record carries the same values as named fields.',
    keyTransformation: 'The published values become a structured record.',
    ...over,
  }
}

function scorecardInput(over: Partial<ScorecardInput> = {}): ScorecardInput {
  return {
    page: {
      httpStatus: 200,
      finalUrl: 'https://acme-supplier.test/product/pump/',
      canonicalUrl: 'https://acme-supplier.test/product/pump/',
      wordCount: 420,
      outcome: 'fetched',
    },
    structuredDataTypes: [],
    breadcrumbs: 'Home > Pumps > Circulation',
    record: record(),
    productPagesInspected: 12,
    siblingProductLinks: 11,
    ...over,
  }
}

function input(over: Partial<PdpReportInput> = {}): PdpReportInput {
  const scorecard = buildScorecard(scorecardInput())
  return {
    companyName: 'ACME Supplier Ltd',
    website: 'https://acme-supplier.test',
    preparedFor: 'ACME Supplier Ltd',
    auditDate: '2026-09-04',
    sector: 'Industrial Supply',
    location: 'Malta',
    pagesInspected: 15,
    productPagesInspected: 12,
    scorecard,
    remediation: buildRemediation(scorecard),
    subject: record(),
    categoryLabel: 'Plumbing & pipework',
    recommendedAttributes: [
      { label: 'Material', state: 'derived', value: 'Cast iron', why: 'Buyers filter on material.' },
      { label: 'Connection type', state: 'recommended', value: null, why: 'Determines what it fits.' },
    ],
    scopeNote: 'Scope: every figure describes the inspected pages only.',
    nextStep: 'A fifteen-minute walkthrough of the enriched records built from your own pages.',
    ctaLabel: 'Book a 15-minute walkthrough',
    preparedBy: { name: 'AltiusNxt Marketing AI', role: 'Automated catalogue audit', email: null },
    approvedBy: { name: 'reviewer@altiusnxt.test', role: 'Approving reviewer' },
    workbenchUrl: 'http://localhost:4100/workbench/demo-1',
    legalDisclaimer: DISCLAIMER,
    ...over,
  }
}

/** pdfkit compresses content streams and writes text as hex runs. */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1')
  const chunks: string[] = []
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      chunks.push(inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1'))
    } catch {
      chunks.push(m[1]!)
    }
  }
  const fromHex = (hex: string): string => Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ''), 'hex').toString('latin1')
  const runs: string[] = []
  for (const content of chunks) {
    for (const m of content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) runs.push(m[1]!)
    for (const m of content.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)) runs.push(fromHex(m[1]!))
    for (const m of content.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
      const parts: string[] = []
      for (const s of m[1]!.matchAll(/\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]+)>/g)) {
        parts.push(s[1] !== undefined ? s[1] : fromHex(s[2]!))
      }
      runs.push(parts.join(''))
    }
  }
  return runs.join(' ').replace(/\\([()\\])/g, '$1').replace(/\s+/g, ' ').trim()
}

const textOf = (b: Buffer) => pdfText(b)

describe('the document keeps the shape the template defines', () => {
  it('is exactly seven pages', async () => {
    const pdf = await renderPdpReport(input())
    expect(pdf.pageCount).toBe(7)
  })

  // The count is part of the identity: every footer says "of 7". pdfkit adds
  // pages silently when content overruns, and a footer loop that overruns the
  // bottom margin once turned a six-page report into an eighteen-page one.
  it('stays seven pages when the customer has a large catalogue and many failures', async () => {
    const big = record({
      fields: Array.from({ length: 40 }, (_, i) =>
        field({ field: `product.f${i}`, label: `A very long field label number ${i + 1}`, before: null, state: 'absent' }),
      ),
      absentCount: 40,
      observedCount: 0,
    })
    const sc = buildScorecard(scorecardInput({ record: big }))
    const pdf = await renderPdpReport(
      input({ subject: big, scorecard: sc, remediation: buildRemediation(sc) }),
    )
    expect(pdf.pageCount).toBe(7)
  })

  it('is still seven pages when the run found no product page at all', async () => {
    const pdf = await renderPdpReport(
      input({ subject: null, scorecard: NO_SUBJECT_SCORECARD, remediation: [] }),
    )
    expect(pdf.pageCount).toBe(7)
  })

  it('renders every page of the template by name', async () => {
    const text = textOf((await renderPdpReport(input())).bytes)
    for (const heading of [
      'AI DISCOVERABILITY AUDIT',
      'WHAT THIS AUDIT MEASURED',
      'THE 15-POINT SCORECARD',
      'WHAT GOOD LOOKS LIKE',
      'VISUAL COMPARISON MATRIX',
      'STRATEGIC REMEDIATION ROADMAP',
      'METHODOLOGY & PRACTICE SIGN-OFF',
    ]) {
      expect(text, heading).toContain(heading)
    }
  })

  it('numbers every page against the real total', async () => {
    const text = textOf((await renderPdpReport(input())).bytes)
    expect(text).toContain('Page 1 of 7')
    expect(text).toContain('Page 7 of 7')
  })

  it('is byte-identical for the same audit, so a stored copy can be checked', async () => {
    const a = await renderPdpReport(input())
    const b = await renderPdpReport(input())
    expect(a.sha256).toBe(b.sha256)
  })
})

describe('a check that was not run is never scored as a failure', () => {
  it('marks the two unrunnable checks NOT ASSESSED and says why', async () => {
    const text = textOf((await renderPdpReport(input())).bytes)
    expect(text).toContain('NOT ASSESSED')
    expect(text).toContain('Off-Domain Citation Surface')
    expect(text).toContain('Live Answer Engine Outcome')
    expect(text).toContain('No answer-engine query harness is configured')
  })

  it('excludes them from the denominator and states the denominator', async () => {
    const sc = buildScorecard(scorecardInput())
    expect(sc.assessedCount).toBe(13)
    expect(sc.denominatorNote).toContain('13 checks')
    const text = textOf((await renderPdpReport(input({ scorecard: sc }))).bytes)
    expect(text).toContain('13')
  })

  // The template's sector-average and top-decile columns are proprietary
  // figures this system does not hold. Printing a plausible number there would
  // be the single most damaging thing the document could do.
  it('prints no benchmark it cannot source', async () => {
    const text = textOf((await renderPdpReport(input())).bytes)
    expect(text).not.toContain('Sector Baseline')
    expect(text).not.toContain('Top Decile')
    expect(text).not.toContain('Invisible Catalog Index')
  })

  it('invents no answer-engine query log', async () => {
    const text = textOf((await renderPdpReport(input())).bytes)
    for (const engine of ['ChatGPT', 'Perplexity', 'Claude', 'Grok']) {
      expect(text, engine).not.toContain(engine)
    }
    expect(text).not.toContain('Competitors Surfaced')
  })
})

describe('nothing in the document is invented', () => {
  it('never prints a value for a field the page did not publish', async () => {
    const text = textOf((await renderPdpReport(input())).bytes)
    // GTIN is absent in the fixture; no digits may appear beside it.
    expect(text).not.toMatch(/GTIN[^.]{0,40}\d{8}/)
  })

  it('names no person who did not act on this report', async () => {
    const text = textOf((await renderPdpReport(input({ approvedBy: null }))).bytes)
    // The sample report carries two named signatories. Ours must not.
    expect(text).not.toContain('Manoj')
    expect(text).not.toContain('Govind')
    expect(text).toContain('Not yet approved')
  })

  it('carries the approved wording verbatim rather than paraphrasing it', async () => {
    const text = textOf(
      (await renderPdpReport(
        input({ scopeNote: 'Scope: bounded sample of 12 pages.', ctaLabel: 'Talk to us on Thursday' }),
      )).bytes,
    )
    expect(text).toContain('Scope: bounded sample of 12 pages.')
    expect(text).toContain('Talk to us on Thursday')
  })

  it('says plainly when no product page could be audited', async () => {
    const text = textOf(
      (await renderPdpReport(input({ subject: null, scorecard: NO_SUBJECT_SCORECARD, remediation: [] }))).bytes,
    )
    expect(text).toContain('No product page')
    expect(text).toContain('No example has been invented in its place.')
  })

  it('marks an unapproved copy on every page', async () => {
    const pdf = await renderPdpReport(input({ reviewWatermark: 'INTERNAL REVIEW — not for distribution' }))
    const text = textOf(pdf.bytes)
    const marks = text.match(/INTERNAL REVIEW/g) ?? []
    expect(marks.length).toBe(7)
  })

  it('warns loudly when no approved disclaimer is configured', async () => {
    const text = textOf((await renderPdpReport(input({ legalDisclaimer: null }))).bytes)
    expect(text).toContain('NOT FOR CUSTOMER DISTRIBUTION')
  })
})

describe('one company’s report carries only that company', () => {
  it('prints no other company’s name or host', async () => {
    const text = textOf((await renderPdpReport(input())).bytes)
    for (const foreign of ['Jamesco', '1source', 'accleaning', 'ind-supply.com', 'Brighton-Best', 'BBI']) {
      expect(text, foreign).not.toContain(foreign)
    }
  })

  it('cites the audited company’s own host', async () => {
    const text = textOf((await renderPdpReport(input())).bytes)
    expect(text).toContain('acme-supplier.test')
  })

  // The reference is derived from the audit, so it identifies one audit of one
  // company rather than being a random string that means nothing later.
  it('gives the same audit the same reference, and two audits different ones', () => {
    const a = referenceFor({ companyName: 'ACME', auditDate: '2026-09-04', website: 'https://acme.test' })
    const b = referenceFor({ companyName: 'ACME', auditDate: '2026-09-04', website: 'https://acme.test' })
    const c = referenceFor({ companyName: 'Other', auditDate: '2026-09-04', website: 'https://other.test' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^ANXT-AEO-2026-[0-9A-F]{4}$/)
  })
})

// ── Page 2 when nothing could be assessed ─────────────────────────────────
//
// Page 2 has two branches: a green panel saying everything was run, and a
// table of what was not and why. It chose between them on the LENGTH OF THE
// NOT-ASSESSED LEDGER, and the no-subject scorecard shipped that ledger empty
// while carrying fifteen unassessed checks. So the one report that had
// measured nothing printed, in a green panel, directly beneath a table reading
// 0 of 5 / 0 of 5 / 0 of 5:
//
//     "All fifteen checks were run against the live page.
//      Nothing in this report is estimated."
//
// Three of the six companies audited so far reach that path — it is where a
// new prospect with a JavaScript catalogue or no product pages lands. The
// renderer was never wrong; it was told fifteen checks had been assessed.

describe('a report that could assess nothing says so', () => {
  const noSubject = () => input({ subject: null, scorecard: NO_SUBJECT_SCORECARD, remediation: [] })

  it('never claims the checks were run', async () => {
    const text = textOf((await renderPdpReport(noSubject())).bytes)
    expect(text).not.toContain('All fifteen checks were run against the live page')
    expect(text).not.toContain('Nothing in this report is estimated')
  })

  it('names every one of the fifteen checks as NOT ASSESSED', async () => {
    const text = textOf((await renderPdpReport(noSubject())).bytes)
    for (const ref of ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5']) {
      expect(text, ref).toContain(ref)
    }
    // Fifteen on page 2's ledger and fifteen more in page 3's status column.
    expect((text.match(/NOT ASSESSED/g) ?? []).length).toBeGreaterThanOrEqual(30)
  })

  it('says the reason is the missing product page, not a missing capability', async () => {
    const text = textOf((await renderPdpReport(noSubject())).bytes)
    expect(text).toContain('No inspected page published a product record')
    expect(text).toContain('not a measurement of this catalogue')
  })

  // The metric column is the customer's list of what WOULD have been measured.
  // Fifteen rows reading "Not assessed" in that column tell them nothing.
  it('still lists what would have been measured', async () => {
    const text = textOf((await renderPdpReport(noSubject())).bytes)
    for (const metric of ['Crawler Access & Rendering', 'Attribute Completeness', 'Buying-Decision Content']) {
      expect(text, metric).toContain(metric)
    }
  })

  it('is still exactly seven pages, with the ledger fitting on page 2', async () => {
    const pdf = await renderPdpReport(noSubject())
    expect(pdf.pageCount).toBe(7)
  })

  it('keeps the honest wording it already had elsewhere', async () => {
    const text = textOf((await renderPdpReport(noSubject())).bytes)
    expect(text).toContain('NO AUDITABLE PRODUCT PAGE FOUND')
    expect(text).toContain('No example has been invented in its place.')
  })
})

describe('a report that DID assess a product page is unchanged', () => {
  it('still reports only the two checks the platform cannot run', async () => {
    const text = textOf((await renderPdpReport(input())).bytes)
    expect(text).toContain('Off-Domain Citation Surface')
    expect(text).toContain('Live Answer Engine Outcome')
    expect(text).toContain('No backlink or citation index is configured')
    expect(text).toContain('No answer-engine query harness is configured')
    // The no-subject wording must not leak into a report that read a page.
    expect(text).not.toContain('No inspected page published a product record')
    expect(text).not.toContain('not a measurement of this catalogue')
  })

  it('still scores over thirteen and says so', async () => {
    const sc = buildScorecard(scorecardInput())
    expect(sc.assessedCount).toBe(13)
    expect(sc.notAssessed).toHaveLength(2)
    const text = textOf((await renderPdpReport(input({ scorecard: sc }))).bytes)
    expect(text).toContain('13 checks')
  })

  it('is still byte-identical for the same audit', async () => {
    const a = await renderPdpReport(input())
    const b = await renderPdpReport(input())
    expect(a.sha256).toBe(b.sha256)
  })
})

// ── The roadmap argues from their own page, not from theory ───────────────
//
// The roadmap used to open on the PROBLEM, which reads as an assertion about
// somebody's website before they have been shown what it was read from. A
// customer arguing with the first line never reaches the fourth.
//
// It now runs BEFORE → PROBLEM → RECOMMENDED CHANGE → EXPECTED IMPROVEMENT,
// where BEFORE is the check's own `basis` — the literal things the audit
// observed. So every recommendation traces back to one observation, and the
// report introduces no claim the scorecard did not already make.

describe('every recommendation opens on what is on their page today', () => {
  it('prints all four steps, in order, for each fix', async () => {
    const sc = buildScorecard(scorecardInput())
    const fixes = buildRemediation(sc)
    expect(fixes.length).toBeGreaterThan(0)

    const text = textOf((await renderPdpReport(input({ scorecard: sc, remediation: fixes }))).bytes)
    for (const label of ['On your page today:', 'Problem:', 'Recommended change:', 'Expected improvement:']) {
      expect(text, label).toContain(label)
    }
    // The order is the argument: the observation has to precede the problem.
    expect(text.indexOf('On your page today:')).toBeLessThan(text.indexOf('Problem:'))
    expect(text.indexOf('Problem:')).toBeLessThan(text.indexOf('Recommended change:'))
    expect(text.indexOf('Recommended change:')).toBeLessThan(text.indexOf('Expected improvement:'))
  })

  it('quotes the check’s own basis, not a restatement of it', async () => {
    const sc = buildScorecard(scorecardInput())
    const fixes = buildRemediation(sc)
    const text = textOf((await renderPdpReport(input({ scorecard: sc, remediation: fixes }))).bytes)

    for (const fix of fixes) {
      // Whatever the check recorded as its basis is what the BEFORE line says.
      for (const observed of fix.observedBefore) {
        expect(text, observed).toContain(observed)
      }
    }
  })

  it('carries the basis through from the scorecard untouched', () => {
    const sc = buildScorecard(scorecardInput())
    const byRef = new Map(sc.pillars.flatMap((p) => p.checks).map((c) => [c.ref, c]))
    for (const fix of buildRemediation(sc)) {
      // `addresses` names the checks a fix covers; the first is the one it was
      // selected for, and the BEFORE line must be that check's own basis.
      const source = [...byRef.values()].find((c) => c.basis === fix.observedBefore)
      expect(source, fix.title).toBeDefined()
    }
  })

  // A check with no recorded basis has nothing to show, and a heading with
  // nothing under it is worse than no heading.
  it('omits the BEFORE line entirely rather than printing an empty one', async () => {
    const sc = buildScorecard(scorecardInput())
    const fixes = buildRemediation(sc).map((f) => ({ ...f, observedBefore: [] }))
    const text = textOf((await renderPdpReport(input({ scorecard: sc, remediation: fixes }))).bytes)

    expect(text).not.toContain('On your page today:')
    // Everything else still prints.
    expect(text).toContain('Problem:')
    expect(text).toContain('Recommended change:')
    expect(text).toContain('Expected improvement:')
  })

  // The card is sized from the same strings it prints. A card measured for
  // three lines and printed with four overflows its border and pushes the
  // roadmap onto an eighth page.
  it('is still exactly seven pages with the extra line', async () => {
    const sc = buildScorecard(scorecardInput())
    expect((await renderPdpReport(input({ scorecard: sc, remediation: buildRemediation(sc) }))).pageCount).toBe(7)
  })

  it('is still seven pages when every fix carries a long basis', async () => {
    const sc = buildScorecard(scorecardInput())
    const wordy = buildRemediation(sc).map((f) => ({
      ...f,
      observedBefore: Array.from({ length: 6 }, (_, i) => `a rather long observed condition number ${i + 1}`),
    }))
    expect((await renderPdpReport(input({ scorecard: sc, remediation: wordy }))).pageCount).toBe(7)
  })

  it('still states no money and no return-on-investment claim', async () => {
    const sc = buildScorecard(scorecardInput())
    const text = textOf((await renderPdpReport(input({ scorecard: sc, remediation: buildRemediation(sc) }))).bytes)
    expect(text).not.toMatch(/\bROI\b/i)
    expect(text).not.toMatch(/[£$€]\s?\d/)
    // Percentages are NOT forbidden in this document and must not be asserted
    // against: the three pillar weights are printed as 30% / 30% / 40%, which
    // is the scorecard describing its own arithmetic. What is forbidden is a
    // percentage that reads as a measurement of the customer's catalogue, and
    // the claim guard on generated prose is what covers that.
    expect(text).toMatch(/Weight: 30%/)
  })
})

// ── ONE DEMONSTRATION, RENDERED TWICE ─────────────────────────────────────
//
// The Workbench and this document must show the customer the SAME product
// improvement. They now do, because the report consumes the customer view
// instead of re-deriving the demonstration for itself — the captured website
// context and the proposal are handed in rather than sampled again here.
//
// These pin the rendering half of that: what arrives is drawn, in both frames,
// and what did not arrive is drawn nowhere.

const SHELL = {
  captured: true,
  siteName: 'Northwind Fasteners',
  logoUrl: 'https://northwind.test/logo.png',
  nav: [{ label: 'Shop' }, { label: 'About Us' }, { label: 'Contact' }],
  footerText: '(c) 2026 Northwind Fasteners Ltd',
}

describe('the customer’s own page context, shared with the Workbench', () => {
  it('draws their masthead in BOTH frames, not just the improved one', async () => {
    const text = textOf((await renderPdpReport(input({ websiteShell: SHELL }))).bytes)
    // Once per frame. A masthead on the right only would make the improved
    // frame look like a different website.
    expect((text.match(/Northwind Fasteners/g) ?? []).length).toBeGreaterThanOrEqual(2)
    for (const label of ['Shop', 'About Us', 'Contact']) {
      expect(text, label).toContain(label)
    }
  })

  it('prints their footer line once, beneath the frames', async () => {
    const text = textOf((await renderPdpReport(input({ websiteShell: SHELL }))).bytes)
    expect(text).toContain('2026 Northwind Fasteners Ltd')
  })

  // EDGE CASE 2: the product exists but the website context is incomplete.
  it('draws nothing for the parts the run did not capture', async () => {
    const partial = { captured: true, siteName: null, logoUrl: null, nav: [], footerText: null }
    const text = textOf((await renderPdpReport(input({ websiteShell: partial }))).bytes)
    // The product still renders; no furniture is substituted for the absent parts.
    expect(text).toContain('ACME Circulation Pump 42')
    expect(text).not.toContain('Northwind')
  })

  it('renders the product without furniture when nothing was captured', async () => {
    const uncaptured = { captured: false, siteName: 'Ignored', logoUrl: null, nav: [{ label: 'Ignored' }], footerText: 'Ignored' }
    const text = textOf((await renderPdpReport(input({ websiteShell: uncaptured }))).bytes)
    // `captured: false` means the sample failed. Its fields are not drawn.
    expect(text).not.toContain('Ignored')
    expect(text).toContain('ACME Circulation Pump 42')
  })

  it('is unchanged when no context is supplied at all', async () => {
    const withNone = await renderPdpReport(input({ websiteShell: null }))
    const withUndefined = await renderPdpReport(input())
    expect(withNone.sha256).toBe(withUndefined.sha256)
  })
})

describe('the proposal is the Workbench’s, and is labelled as a proposal', () => {
  const PROPOSED = {
    overview: 'ACME Circulation Pump 42 is listed by ACME on this catalogue.',
    bullets: ['Brand: ACME'],
  }

  it('prints the same wording the Workbench shows', async () => {
    const text = textOf((await renderPdpReport(input({ proposedContent: PROPOSED }))).bytes)
    expect(text).toContain('ACME Circulation Pump 42 is listed by ACME on this catalogue.')
  })

  it('marks it a suggestion rather than a finding', async () => {
    const text = textOf((await renderPdpReport(input({ proposedContent: PROPOSED }))).bytes)
    // The one block on the page that is ours rather than theirs.
    expect(text).toMatch(/Proposed wording/)
    expect(text).toMatch(/a suggestion, not a finding/)
  })

  // EDGE CASE 4: proposed content is null.
  it('writes nothing in its place when there is no proposal', async () => {
    const text = textOf((await renderPdpReport(input({ proposedContent: null }))).bytes)
    expect(text).not.toContain('Proposed wording')
    // The rest of the comparison still renders.
    expect(text).toContain('VISUAL COMPARISON MATRIX')
    expect(text).toContain('Core Architectural Differentiator')
  })

  // EDGE CASE 3: no auditable product page — no fake demonstration.
  it('shows no product demonstration at all when there is no product page', async () => {
    const text = textOf(
      (
        await renderPdpReport(
          input({
            subject: null,
            scorecard: NO_SUBJECT_SCORECARD,
            remediation: [],
            websiteShell: SHELL,
            proposedContent: PROPOSED,
          }),
        )
      ).bytes,
    )
    // Neither the context nor the proposal may conjure a demonstration.
    expect(text).not.toContain('AS PUBLISHED TODAY (PDP WIREFRAME)')
    expect(text).not.toContain('Proposed wording')
    expect(text).not.toContain('Northwind Fasteners')
    expect(text).toContain('Nothing has been mocked up in its place')
  })

  it('is still exactly seven pages with both blocks present', async () => {
    const pdf = await renderPdpReport(input({ websiteShell: SHELL, proposedContent: PROPOSED }))
    expect(pdf.pageCount).toBe(7)
  })

  it('is still seven pages with a long proposal and a long masthead', async () => {
    const big = {
      captured: true,
      siteName: 'A Very Long Trading Company Name Indeed Limited',
      logoUrl: null,
      nav: Array.from({ length: 8 }, (_, i) => ({ label: `Navigation Item Number ${i + 1}` })),
      footerText: 'Copyright 2026 A Very Long Trading Company Name Indeed Limited, all rights reserved worldwide',
    }
    const wordy = { overview: 'x'.repeat(900), bullets: [] }
    expect((await renderPdpReport(input({ websiteShell: big, proposedContent: wordy }))).pageCount).toBe(7)
  })
})

// ── ILLUSTRATIVE EXAMPLES IN THE IMPROVED FRAME ONLY ──────────────────────
//
// The improved frame now fills the fields the customer's page leaves empty
// with a labelled EXAMPLE of what the finished field looks like, so the
// improvement is visible rather than a column of blanks. Two rules must hold:
// every example is labelled, and nothing is added to the frame that shows the
// customer's page as it is today.

describe('illustrative examples in the comparison frames', () => {
  const EXAMPLES = {
    'product.mpn': { value: '[Manufacturer part number]', kind: 'format' as const },
    'product.gtin': { value: '[13-digit GTIN / EAN barcode]', kind: 'format' as const },
    'product.price': { value: '[Price] [Currency] · ex. / inc. tax stated', kind: 'format' as const },
  }

  it('labels every example it draws', async () => {
    const text = textOf((await renderPdpReport(input({ illustrativeExamples: EXAMPLES }))).bytes)
    expect(text).toContain('EXAMPLE')
    expect(text).toContain('[Manufacturer part number]')
    // Each example value is preceded by its label.
    expect(text).toMatch(/EXAMPLE\s+\[Manufacturer part number\]/)
  })

  it('shows where product photography goes when the page has no image, labelled as an example', async () => {
    const text = textOf((await renderPdpReport(input({ illustrativeExamples: EXAMPLES }))).bytes)
    expect(text).toContain('Product photography goes here')
    // The frame showing their page today still says it honestly.
    expect(text).toContain('No product image published on this page')
  })

  it('draws nothing extra when there are no examples', async () => {
    const without = await renderPdpReport(input({ illustrativeExamples: null }))
    const omitted = await renderPdpReport(input())
    expect(without.sha256).toBe(omitted.sha256)
    const text = textOf(without.bytes)
    expect(text).not.toContain('[Manufacturer part number]')
  })

  it('still never prints a real-looking barcode beside GTIN', async () => {
    const text = textOf((await renderPdpReport(input({ illustrativeExamples: EXAMPLES }))).bytes)
    expect(text).not.toMatch(/GTIN[^.]{0,40}\d{8}/)
  })

  it('is still exactly seven pages with examples present', async () => {
    expect((await renderPdpReport(input({ illustrativeExamples: EXAMPLES }))).pageCount).toBe(7)
  })

  it('draws no example when there is no product page to improve', async () => {
    const text = textOf(
      (
        await renderPdpReport(
          input({ subject: null, scorecard: NO_SUBJECT_SCORECARD, remediation: [], illustrativeExamples: EXAMPLES }),
        )
      ).bytes,
    )
    expect(text).not.toContain('[Manufacturer part number]')
    expect(text).not.toContain('Product photography goes here')
  })
})
