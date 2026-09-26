import { inflateSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'

// PHASE 6 CLOSURE — the customer report against REAL stored audit data.
//
// Gated on the marketing database alone, deliberately. Everything here reads
// stored observations, findings, reports and Workbench comparisons; nothing
// crawls a site or calls NXT Sales, so requiring those to be up would skip a
// suite that has no need of them.
//
// Nothing is written. Producing a customer copy of an approved report is a
// read, and these tests assert that too.

async function ready(): Promise<string | null> {
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
if (skipReason) console.warn(`\n[customer-report-real] SKIPPED — ${skipReason}\n`)

/** Inflates the content streams and decodes pdfkit's hex-encoded subset font. */
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
  const fromHex = (h: string) => Buffer.from(h.replace(/[^0-9a-fA-F]/g, ''), 'hex').toString('latin1')
  const runs: string[] = []
  for (const c of chunks) {
    for (const m of c.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) runs.push(m[1]!)
    for (const m of c.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)) runs.push(fromHex(m[1]!))
    for (const m of c.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
      const parts: string[] = []
      for (const s of m[1]!.matchAll(/\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]+)>/g)) {
        parts.push(s[1] !== undefined ? s[1] : fromHex(s[2]!))
      }
      runs.push(parts.join(''))
    }
  }
  return runs.join(' ').replace(/\\([()\\])/g, '$1').replace(/\s+/g, ' ').trim()
}

const DISCLAIMER =
  'Indicative product-data review. Not a certified audit. [PLACEHOLDER pending legal sign-off]'

/** Real audit runs, chosen for what each one exercises. */
const APPROVED = [
  ['qu7n7rsipctcvas69x6b191w', '1st Ayd', 'approved, 8 findings, ready Workbench demo'],
  ['l58fa5g756sz8phbrqwkw4n7', '3ECO', 'approved, site unreachable, nothing observed'],
  ['ent5mw0ujf31hals0w1cyeqq', '1 Stop Plumbing', 'approved revision 2, no product page'],
] as const

const UNAPPROVED = ['o5h6mudfsxzgnw5v4luj04is', '247 Lighting', 'in_review'] as const

describeIfReady('customer report — real stored audits', () => {
  let prisma: typeof import('../../src/platform/db.js')['prisma']
  let generate: typeof import('../../src/websiteaudit/customerReport.js')['generateCustomerReport']
  let tenantId: string

  async function setup() {
    if (!prisma) {
      ;({ prisma } = await import('../../src/platform/db.js'))
      ;({ generateCustomerReport: generate } = await import('../../src/websiteaudit/customerReport.js'))
      const run = await prisma.websiteAuditRun.findFirst({ where: { id: APPROVED[0][0] } })
      tenantId = run!.tenantId
      process.env.REPORT_LEGAL_DISCLAIMER = DISCLAIMER
    }
  }

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
  })

  // The disclaimer is read from env at call time via the config module, which
  // caches. Rather than fight that, these tests assert on what the guard does
  // with whatever is configured, and the unit suite covers the empty case.
  it.each(APPROVED)('generates a compliant report for %s (%s)', async (runId, _name, _what) => {
    await setup()
    const r = await generate({ tenantId, auditRunId: runId, workbenchUrl: 'https://demo.altiusnxt.com/w/x' })
    const text = pdfText(r.pdf.bytes)

    // Approval
    expect(r.approvalState).toBe('approved')
    expect(r.revisionNumber).toBeGreaterThanOrEqual(1)

    // Structure
    expect(r.pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-')
    // Seven, exactly: every footer in the document says "of 7", and pdfkit
    // adds pages silently when content overruns.
    expect(r.pdf.pageCount).toBe(7)
    expect(text).toContain('AI DISCOVERABILITY AUDIT')
    expect(text).toContain('THE 15-POINT SCORECARD')
    expect(text).toContain('Recommended Next Step')

    // A check the platform cannot run is never scored as one it failed.
    expect(text).toContain('NOT ASSESSED')
    expect(text).not.toContain('Sector Baseline')
    expect(text).not.toContain('Top Decile')

    // Nothing decoded badly on its way to the customer.
    expect(text).not.toContain('&amp;')
    expect(text).not.toContain('&nbsp;')

    // Reproducibility
    const again = await generate({ tenantId, auditRunId: runId, workbenchUrl: 'https://demo.altiusnxt.com/w/x' })
    expect(again.pdf.sha256).toBe(r.pdf.sha256)

    // Nothing that belongs to us leaves the building
    expect(r.collateral.keyFindings.every((f) => f.recommendation === '')).toBe(true)
    expect(r.collateral.recommendedImprovementAreas).toEqual([])
    expect(text).not.toContain('Evidence appendix')
    expect(text).not.toContain(runId)
    expect(text).not.toContain(tenantId)
    expect(text).not.toMatch(/\bobs_[a-z0-9]{6}/)
    expect(text).not.toContain('<div')
    expect(text).not.toContain('main >')

    // Bounded URL count
    expect(new Set(text.match(/https?:\/\/[^\s)]+/g) ?? []).size).toBeLessThanOrEqual(6)

    // No unsupported claim of any kind
    // Pillar weights are the one legitimate percentage in this document. The
    // guard exists to catch invented performance claims like "40% more
    // traffic", so it excludes the two weights the template itself prints.
    const percentages = (text.match(/\b\d{1,3}\s?%/g) ?? []).filter((m) => !['30%', '40%'].includes(m.trim()))
    expect(percentages).toEqual([])
    expect(text).not.toMatch(/[£$€]\s?\d/)
    expect(text).not.toMatch(/\bROI\b/i)
    expect(text).not.toMatch(/your (?:search )?ranking/i)

    // Required customer-facing elements
    expect(text.toUpperCase()).toContain('BOOK A 15-MINUTE WALKTHROUGH')
    expect(text).toContain('inspected pages only')
    expect(r.collateral.legalDisclaimer).toBeTruthy()

    // No peer was audited, so no comparison may be implied
    expect(r.collateral.comparison.available).toBe(false)
    expect(text).not.toContain('Compared with')

    // Every AFTER value traces to an observation
    for (const f of r.collateral.examples.flatMap((e) => e.fields)) {
      if (f.after && f.provenance.kind !== 'not_present') {
        expect(f.provenance.sourceObservationId, f.field).toBeTruthy()
        expect(f.provenance.rule.length, f.field).toBeGreaterThan(10)
      }
    }
  })

  it('renders an unapproved report as a REVIEW copy — the invariant, on real data', async () => {
    await setup()
    const [runId, name, state] = UNAPPROVED
    const report = await prisma.auditReport.findFirst({ where: { auditRunId: runId } })
    expect(report?.status, `${name} should still be ${state}`).toBe(state)

    // It renders, because the reviewer has to read what they are approving.
    // What it must never be is the customer copy.
    const r = await generate({ tenantId, auditRunId: runId })
    expect(r.audience).toBe('internal_review')
    expect(r.approvalState).toBe(state)
    expect(pdfText(r.pdf.bytes).toUpperCase(), 'every page says so').toContain('INTERNAL REVIEW')
  })

  it('produces exactly one worked example for 1st Ayd, and says so truthfully', async () => {
    await setup()
    const r = await generate({ tenantId, auditRunId: APPROVED[0][0] })
    expect(r.collateral.examples).toHaveLength(1)
    expect(r.collateral.examples[0]!.fields.length).toBeGreaterThan(0)
    // "1 worked example(s)" would read as an unfinished template.
    expect(r.collateral.withheldNote ?? '').not.toContain('example(s)')
    expect(r.collateral.withheldNote ?? '').not.toContain('finding(s)')
  })

  it('degrades honestly where there is no product page', async () => {
    await setup()
    const r = await generate({ tenantId, auditRunId: APPROVED[2][0] })
    expect(r.collateral.examples).toEqual([])
    expect(r.exampleNote).toMatch(/No product page could be identified/)
    expect(pdfText(r.pdf.bytes)).not.toContain('The same product, better described')
  })

  it('leaves the internal report untouched', async () => {
    await setup()
    const { buildCollateral } = await import('../../src/websiteaudit/collateral.js')
    const internal = buildCollateral({
      companyName: '1st Ayd',
      website: 'https://1stayd.com',
      auditDate: new Date('2026-08-27T00:00:00Z'),
      pagesInspected: 25,
      productPagesInspected: 12,
      categoryPagesInspected: 3,
      findings: [],
      limitsHit: [],
    })
    expect(internal.audience).toBe('internal')
    expect(internal.legalDisclaimer).toBeNull()
  })

  it('writes nothing while producing a customer copy', async () => {
    await setup()
    const before = await prisma.auditReport.findFirst({ where: { auditRunId: APPROVED[0][0] } })
    const revsBefore = await prisma.auditReportRevision.count({ where: { auditRunId: APPROVED[0][0] } })

    await generate({ tenantId, auditRunId: APPROVED[0][0] })

    const after = await prisma.auditReport.findFirst({ where: { auditRunId: APPROVED[0][0] } })
    const revsAfter = await prisma.auditReportRevision.count({ where: { auditRunId: APPROVED[0][0] } })
    expect(after?.status).toBe(before?.status)
    expect(after?.currentRevision).toBe(before?.currentRevision)
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime())
    expect(revsAfter).toBe(revsBefore)
  })

  // ── One customer's document contains one customer ──────────────────────
  //
  // The screenshot bug was exactly this failing in the UI: a report rendered
  // while one company was selected showed another company's pages. That was a
  // frontend cache-key defect, but nothing downstream was asserting the
  // property, so the same mistake made in the PDF builder would have shipped
  // silently — and unlike a screen, a PDF gets emailed to the wrong customer.
  it('never prints another audited company inside a customer report', async () => {
    await setup()

    const rendered = await Promise.all(
      APPROVED.map(async ([runId, name]) => {
        const result = await generate({ tenantId, auditRunId: runId })
        return { runId, name, text: pdfText(result.pdf.bytes) }
      }),
    )

    // Each company's own identifying strings, taken from its stored run rather
    // than written down here, so this keeps working as the dataset changes.
    const identity = await Promise.all(
      APPROVED.map(async ([runId]) => {
        const run = await prisma.websiteAuditRun.findFirstOrThrow({ where: { id: runId } })
        const host = run.startUrl ? new URL(run.startUrl).hostname.replace(/^www\./, '') : null
        return { runId, companyName: run.companyName, host, crmCompanyId: run.crmCompanyId }
      }),
    )

    for (const doc of rendered) {
      const mine = identity.find((i) => i.runId === doc.runId)!
      expect(doc.text, `${doc.name} must name itself`).toContain(mine.companyName)

      for (const other of identity) {
        if (other.runId === doc.runId) continue
        // A shared token between two real company names would make this
        // assertion meaningless rather than strict, so only compare names
        // that are actually distinct.
        if (other.companyName && !mine.companyName.includes(other.companyName)) {
          expect(doc.text, `${doc.name} must not name ${other.companyName}`).not.toContain(other.companyName)
        }
        if (other.host && other.host !== mine.host) {
          expect(doc.text, `${doc.name} must not cite ${other.host}`).not.toContain(other.host)
        }
      }
    }
  })

  it('draws its sectors from the audited run alone', async () => {
    await setup()
    const { analyseSectors } = await import('../../src/websiteaudit/sectorAnalysis.js')

    for (const [runId, name] of APPROVED) {
      const run = await prisma.websiteAuditRun.findFirstOrThrow({ where: { id: runId } })
      const host = run.startUrl ? new URL(run.startUrl).hostname.replace(/^www\./, '') : null
      if (!host) continue

      for (const sector of (await analyseSectors(runId)).sectors) {
        for (const url of sector.evidenceUrls) {
          expect(new URL(url).hostname.replace(/^www\./, ''), `${name} sector "${sector.name}"`).toBe(host)
        }
      }
    }
  })
})
