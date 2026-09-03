import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// PHASE 6 CLOSURE — the two production gates.
//
// THE INVARIANT UNDER TEST
//
//   A customer-facing report may be produced ONLY from a report in the
//   `approved` state, and ONLY when the legal disclaimer has been configured.
//
// Both fail closed. `REPORT_ALLOW_UNAPPROVED` relaxes them for local work and
// is refused at process start in production, so no combination of settings
// lets a production process send an unreviewed or unlawyered document.
//
// prisma and env are mocked because these tests are about the GATES, not about
// database reachability. The approval state machine itself is not touched by
// the code under test — generating a copy of an approved report is a read.

const db = {
  auditReport: { findFirst: vi.fn() },
  auditReportRevision: { findFirst: vi.fn() },
  catalogFinding: { findMany: vi.fn() },
  websiteAuditRun: { findUniqueOrThrow: vi.fn() },
  workbenchDemo: { findFirst: vi.fn() },
}
vi.mock('../../src/platform/db.js', () => ({ prisma: db }))

// Only the two gate settings are overridden; everything else falls through to
// the real configuration, so the logger and the rest of the module graph load
// exactly as they do in production.
const envMock: Record<string, unknown> = {
  REPORT_ALLOW_UNAPPROVED: false,
  REPORT_LEGAL_DISCLAIMER: 'Approved wording, ref LGL-2026-11.',
}
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> }
  return {
    env: new Proxy(envMock, {
      get: (target, key: string) => (key in target ? target[key] : actual.env[key]),
    }),
  }
})

const { generateCustomerReport, resolvePeer } = await import('../../src/websiteaudit/customerReport.js')

const APPROVAL_STATES = ['ready_for_approval', 'in_review', 'changes_requested', 'approved', 'rejected'] as const

function seed(status: string) {
  db.auditReport.findFirst.mockResolvedValue({
    id: 'rep_1',
    status,
    currentRevision: 2,
    collateral: null,
  })
  db.auditReportRevision.findFirst.mockResolvedValue({
    revisionNumber: 2,
    content: { headline: 'Reviewer-edited headline', summary: 'Reviewer-edited summary.', nextStep: '', businessImpact: [] },
  })
  db.catalogFinding.findMany.mockResolvedValue([
    {
      code: 'incomplete_specifications',
      title: 'Specifications not present',
      category: 'specifications',
      priority: 'high',
      priorityReasons: [],
      affectedCount: 9,
      observedCount: 3,
      sampleSize: 12,
      sampleUnit: 'product pages',
      metric: 'A specification block was observed on 3 of 12 inspected product pages.',
      finding: 'Not found on 9 of the 12 inspected product pages',
      impact: 'Buyers cannot compare on specification.',
      recommendation: 'Hold specifications as named attributes.',
      evidence: [{ observationId: 'o1', pageId: 'p1', sourceUrl: 'https://x.com/p/1', field: 'product.specifications', status: 'missing', value: null, sourcePath: null, fragment: null, observedAt: new Date() }],
    },
  ])
  db.websiteAuditRun.findUniqueOrThrow.mockResolvedValue({
    companyName: '1st Ayd',
    startUrl: 'https://1stayd.com',
    completedAt: new Date('2026-08-27T00:00:00Z'),
    createdAt: new Date('2026-08-27T00:00:00Z'),
    pagesFetched: 25,
    productPages: 12,
    categoryPages: 3,
    limitsHit: [],
  })
  db.workbenchDemo.findFirst.mockResolvedValue(null)
}

beforeEach(() => {
  vi.clearAllMocks()
  envMock.REPORT_ALLOW_UNAPPROVED = false
  envMock.REPORT_LEGAL_DISCLAIMER = 'Approved wording, ref LGL-2026-11.'
})
afterEach(() => vi.restoreAllMocks())

// ── GATE 1: APPROVAL ───────────────────────────────────────────────────────

describe('a customer report requires an approved report', () => {
  it('generates from an approved report', async () => {
    seed('approved')
    const r = await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    expect(r.approvalState).toBe('approved')
    expect(r.revisionNumber).toBe(2)
    expect(r.pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it.each(APPROVAL_STATES.filter((s) => s !== 'approved'))('refuses a report in state "%s"', async (status) => {
    seed(status)
    await expect(generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })).rejects.toThrow(
      /may only be produced from a report approved/,
    )
  })

  it('names the offending state and how to resolve it', async () => {
    seed('changes_requested')
    await expect(generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })).rejects.toThrow(
      /This report is "changes_requested"/,
    )
  })

  it('refuses when there is no report at all', async () => {
    db.auditReport.findFirst.mockResolvedValue(null)
    await expect(generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })).rejects.toThrow(
      /No audit report exists/,
    )
  })

  it('permits an unapproved report ONLY under the development bypass', async () => {
    seed('in_review')
    envMock.REPORT_ALLOW_UNAPPROVED = true
    const r = await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    expect(r.approvalState).toBe('in_review')
  })

  it('never writes anything — generating a copy cannot damage the report', async () => {
    seed('approved')
    await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    // The mocked client exposes no write method at all; the assertion that
    // matters is that the code never reached for one.
    for (const model of Object.values(db)) {
      for (const [name, fn] of Object.entries(model)) {
        if (/create|update|delete|upsert/.test(name)) {
          expect((fn as ReturnType<typeof vi.fn>).mock.calls.length, name).toBe(0)
        }
      }
    }
  })

  it('renders from the approved revision, carrying reviewer edits across', async () => {
    seed('approved')
    const r = await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    expect(r.collateral.headline).toBe('Reviewer-edited headline')
    expect(r.collateral.summary).toBe('Reviewer-edited summary.')
    expect(db.auditReportRevision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revisionNumber: 2 }) }),
    )
  })
})

// ── GATE 2: THE LEGAL DISCLAIMER ───────────────────────────────────────────

describe('a customer report requires configured legal wording', () => {
  it('refuses to generate when the disclaimer is unset', async () => {
    seed('approved')
    envMock.REPORT_LEGAL_DISCLAIMER = ''
    await expect(generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })).rejects.toThrow(
      /REPORT_LEGAL_DISCLAIMER is not configured/,
    )
  })

  it('treats whitespace as unset', async () => {
    seed('approved')
    envMock.REPORT_LEGAL_DISCLAIMER = '   '
    await expect(generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })).rejects.toThrow(
      /not configured/,
    )
  })

  it('does not invent wording of its own', async () => {
    seed('approved')
    envMock.REPORT_LEGAL_DISCLAIMER = ''
    await expect(generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })).rejects.toThrow(
      /will not invent it/,
    )
  })

  it('carries the configured wording onto the report', async () => {
    seed('approved')
    envMock.REPORT_LEGAL_DISCLAIMER = 'Approved wording, ref LGL-2026-11.'
    const r = await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    expect(r.collateral.legalDisclaimer).toBe('Approved wording, ref LGL-2026-11.')
  })

  it('allows an unset disclaimer only under the development bypass', async () => {
    seed('approved')
    envMock.REPORT_LEGAL_DISCLAIMER = ''
    envMock.REPORT_ALLOW_UNAPPROVED = true
    const r = await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    expect(r.collateral.legalDisclaimer).toBeNull()
  })
})

// ── PEER POLICY ────────────────────────────────────────────────────────────

describe('peer comparison is never invented', () => {
  it('resolves to no peer when none is supplied', () => {
    expect(resolvePeer(undefined)).toBeNull()
    expect(resolvePeer(null)).toBeNull()
  })

  it('produces the refusal, not a comparison, by default', async () => {
    seed('approved')
    const r = await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    expect(r.collateral.comparison.available).toBe(false)
    if (!r.collateral.comparison.available) {
      expect(r.collateral.comparison.message).toBe('Comparable evidence not available for this audit.')
    }
  })

  it('never implies a comparison happened when none did', async () => {
    seed('approved')
    const r = await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    const text = JSON.stringify(r.collateral)
    expect(text).not.toMatch(/compared with/i)
    expect(text).not.toMatch(/peer[A-Za-z]*:/)
  })

  it('uses a peer only when the caller supplies a genuinely audited one', async () => {
    seed('approved')
    const r = await generateCustomerReport({
      tenantId: 't1',
      auditRunId: 'run1',
      peer: {
        label: 'A comparable distributor',
        auditDate: new Date('2026-08-20T00:00:00Z'),
        productPagesInspected: 10,
        findings: [
          {
            code: 'incomplete_specifications', title: 'x', category: 'specifications', priority: 'high',
            priorityReasons: [], affectedCount: 1, observedCount: 9, sampleSize: 10, sampleUnit: 'product pages',
            metric: 'm', finding: 'f', impact: 'i', recommendation: 'r',
            evidence: [{ observationId: 'po1', pageId: 'pp1', sourceUrl: 'https://peer.example/p/1', field: 'product.specifications', status: 'observed', value: null, sourcePath: null, fragment: null, observedAt: new Date() }],
          },
        ],
      },
    })
    expect(r.collateral.comparison.available).toBe(true)
  })
})

// ── ONE EXAMPLE, TRUTHFULLY ────────────────────────────────────────────────

describe('wording when there is only one worked example', () => {
  it('says "one worked example", not "1 worked example(s)"', async () => {
    seed('approved')
    db.workbenchDemo.findFirst.mockResolvedValue({
      status: 'ready',
      statusReason: null,
      productPageUrl: 'https://1stayd.com/p/gloves',
      websiteUrl: 'https://1stayd.com',
      productName: 'Gloves',
      fields: [
        {
          field: 'product.category', label: 'Category', position: 0, beforeValue: null,
          afterValue: 'Nitrile Disposable Gloves', delta: 'added', headline: true,
          transformKind: 'derived', sourceObservationId: 'obs_1', sourceField: 'page.breadcrumbs',
          sourceUrl: 'https://1stayd.com/p/gloves', sourcePath: 'nav', sourceFragment: 'Home &gt; PPE',
          transformRule: 'Derived from the breadcrumb trail published on this page.',
        },
      ],
    })
    const r = await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    expect(r.collateral.examples).toHaveLength(1)
    expect(r.collateral.withheldNote ?? '').not.toMatch(/example\(s\)/)
    if (r.collateral.withheldNote) expect(r.collateral.withheldNote).toContain('one worked example')
  })

  it('reports why there is no example rather than staying silent', async () => {
    seed('approved')
    db.workbenchDemo.findFirst.mockResolvedValue({ status: 'no_product_page', statusReason: null, fields: [] })
    const r = await generateCustomerReport({ tenantId: 't1', auditRunId: 'run1' })
    expect(r.collateral.examples).toEqual([])
    expect(r.exampleNote).toMatch(/No product page could be identified/)
  })
})
