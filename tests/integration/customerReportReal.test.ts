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
    expect(r.pdf.pageCount).toBeGreaterThanOrEqual(2)
    expect(r.pdf.pageCount).toBeLessThanOrEqual(7)
    expect(text).toContain('Product Data Health Check')
    expect(text).toContain('Next step')

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
    expect(text).not.toMatch(/\b\d{1,3}\s?%/)
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

  it('refuses an unapproved report — the invariant, on real data', async () => {
    await setup()
    const [runId, name, state] = UNAPPROVED
    const report = await prisma.auditReport.findFirst({ where: { auditRunId: runId } })
    expect(report?.status, `${name} should still be ${state}`).toBe(state)

    await expect(generate({ tenantId, auditRunId: runId })).rejects.toThrow(
      /may only be produced from a report approved/,
    )
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
})
