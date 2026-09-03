import { describe, expect, it } from 'vitest'
import {
  APPROVAL_STATES,
  availableActions,
  canTransition,
  isEditable,
  isTerminal,
  type ApprovalAction,
  type ApprovalState,
} from '../../src/websiteaudit/approvalStateMachine.js'
import {
  IMMUTABLE_FIELDS,
  RevisionEditSchema,
  applyEdits,
  editableProse,
  immutableDrift,
} from '../../src/websiteaudit/revisionContent.js'
import type { SalesCollateral } from '../../src/websiteaudit/collateral.js'

// TASK #980 — STATE MACHINE, EDIT SURFACE, EVIDENCE PROTECTION.
//
// The tests that matter most here are the ones asserting a REFUSAL: an invalid
// transition, an approved report that cannot be edited, and a payload trying to
// carry a metric. A workflow is only worth having if it says no.

function collateral(over: Partial<SalesCollateral> = {}): SalesCollateral {
  return {
    companyName: 'Acme Industrial Supply',
    website: 'https://acme.example',
    auditDate: '2026-08-27',
    pagesInspected: 25,
    productPagesInspected: 12,
    categoryPagesInspected: 3,
    headline: 'Product Data Health Check — Acme Industrial Supply',
    summary: 'This review covers 25 page(s) inspected on https://acme.example, of which 12 were product pages.',
    keyFindings: [
      {
        priority: 'high',
        title: 'Specifications not present on inspected product pages',
        metric: 'A specification block was observed on 3 of 12 inspected product pages.',
        impact: 'A buyer comparing options has nothing structured to compare.',
        recommendation: 'Publish a consistent specification block on each product page.',
        sourceUrls: ['https://acme.example/p/bolt-1', 'https://acme.example/p/bolt-2'],
        evidenceCount: 5,
      },
    ],
    metrics: [{ label: 'Pages inspected', value: '25', basis: 'Pages fetched successfully during this audit run.' }],
    businessImpact: ['A buyer comparing options has nothing structured to compare.'],
    recommendedImprovementAreas: ['Publish a consistent specification block on each product page.'],
    nextStep: 'Review these findings against the pages cited.',
    scopeNote: 'Scope: every figure describes the inspected pages only.',
    status: 'ready_for_approval',
    ...over,
  }
}

// ── STATE MACHINE (categories 1-6) ─────────────────────────────────────────

describe('approval state machine', () => {
  const valid: Array<[ApprovalState, ApprovalAction, ApprovalState]> = [
    ['ready_for_approval', 'start', 'in_review'],
    ['ready_for_approval', 'approve', 'approved'],
    ['ready_for_approval', 'request_changes', 'changes_requested'],
    ['ready_for_approval', 'reject', 'rejected'],
    ['in_review', 'approve', 'approved'],
    ['in_review', 'request_changes', 'changes_requested'],
    ['in_review', 'reject', 'rejected'],
    ['changes_requested', 'start', 'in_review'],
    ['changes_requested', 'reject', 'rejected'],
  ]

  valid.forEach(([from, action, to]) => {
    it(`allows ${from} --${action}--> ${to}`, () => {
      const r = canTransition(from, action)
      expect(r.ok).toBe(true)
      expect(r.next).toBe(to)
    })
  })

  const invalid: Array<[ApprovalState, ApprovalAction]> = [
    // The example from the specification: an approved report cannot drift.
    ['approved', 'request_changes'],
    ['approved', 'approve'],
    ['approved', 'reject'],
    ['approved', 'start'],
    ['rejected', 'approve'],
    ['rejected', 'request_changes'],
    // Changes were requested for a reason; something should change first.
    ['changes_requested', 'approve'],
    ['ready_for_approval', 'reopen'],
    ['in_review', 'start'],
  ]

  invalid.forEach(([from, action]) => {
    it(`REFUSES ${from} --${action}-->`, () => {
      const r = canTransition(from, action)
      expect(r.ok).toBe(false)
      expect(r.reason).toBeTruthy()
    })
  })

  it('explains what IS available when it refuses', () => {
    const r = canTransition('approved', 'request_changes')
    expect(r.reason).toMatch(/Available actions here: reopen/)
  })

  it('offers reopen as the only way out of a terminal state', () => {
    expect(availableActions('approved')).toEqual(['reopen'])
    expect(availableActions('rejected')).toEqual(['reopen'])
  })

  it('treats approved and rejected as terminal and uneditable', () => {
    expect(isTerminal('approved')).toBe(true)
    expect(isTerminal('rejected')).toBe(true)
    expect(isEditable('approved')).toBe(false)
    expect(isEditable('rejected')).toBe(false)
  })

  it('allows editing only while the report is still in the review loop', () => {
    expect(isEditable('ready_for_approval')).toBe(true)
    expect(isEditable('in_review')).toBe(true)
    expect(isEditable('changes_requested')).toBe(true)
  })

  it('covers every declared state in the transition table', () => {
    APPROVAL_STATES.forEach((s) => expect(() => availableActions(s)).not.toThrow())
  })
})

// ── EDIT SURFACE AND EVIDENCE PROTECTION (categories 12, 21) ───────────────

describe('the editable surface', () => {
  it('accepts the prose fields a reviewer is meant to change', () => {
    const parsed = RevisionEditSchema.safeParse({
      headline: 'Product Data Health Check — Acme',
      summary: 'A reworded summary that still says the same thing.',
      nextStep: 'Book a call to walk through the findings.',
      businessImpact: ['Buyers cannot compare on the page.'],
      recommendedImprovementAreas: ['Publish specifications consistently.'],
      keyFindingEdits: [{ index: 0, recommendation: 'Reworded recommendation.' }],
    })
    expect(parsed.success).toBe(true)
  })

  const forbidden: Array<[string, unknown]> = [
    ['metrics', [{ label: 'x', value: '99', basis: 'made up' }]],
    ['pagesInspected', 999],
    ['productPagesInspected', 5],
    ['keyFindings', []],
    ['scopeNote', 'no limits applied'],
    ['companyName', 'Someone Else Ltd'],
    ['auditDate', '2020-01-01'],
    ['status', 'approved'],
    ['evidence', []],
  ]

  forbidden.forEach(([field, value]) => {
    it(`REJECTS a payload carrying "${field}"`, () => {
      // .strict() makes an unknown key a hard error, so there is no field in
      // which a reviewer could send a fact.
      const parsed = RevisionEditSchema.safeParse({ [field]: value })
      expect(parsed.success).toBe(false)
    })
  })

  it('documents why each blocked field is blocked', () => {
    forbidden.forEach(([field]) => {
      if (IMMUTABLE_FIELDS[field]) expect(IMMUTABLE_FIELDS[field]!.length).toBeGreaterThan(20)
    })
    expect(IMMUTABLE_FIELDS.metrics).toMatch(/detach it from its evidence/)
  })

  it('cannot reach a finding metric even through keyFindingEdits', () => {
    const parsed = RevisionEditSchema.safeParse({
      keyFindingEdits: [{ index: 0, metric: 'A specification block was observed on 11 of 12 inspected product pages.' }],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('applying edits', () => {
  const source = collateral()

  it('replaces only the prose it was given', () => {
    const next = applyEdits(source, { summary: 'Reworded.', nextStep: 'Call us.' })
    expect(next.summary).toBe('Reworded.')
    expect(next.nextStep).toBe('Call us.')
    expect(next.headline).toBe(source.headline)
    expect(next.metrics).toEqual(source.metrics)
  })

  it('never mutates the source document', () => {
    const before = JSON.stringify(source)
    applyEdits(source, { summary: 'Changed', keyFindingEdits: [{ index: 0, impact: 'Changed' }] })
    // Two revisions sharing an array reference would silently rewrite history.
    expect(JSON.stringify(source)).toBe(before)
  })

  it('rewords a finding without touching its metric or evidence', () => {
    const next = applyEdits(source, { keyFindingEdits: [{ index: 0, recommendation: 'Do it sooner.' }] })
    expect(next.keyFindings[0]!.recommendation).toBe('Do it sooner.')
    expect(next.keyFindings[0]!.metric).toBe(source.keyFindings[0]!.metric)
    expect(next.keyFindings[0]!.sourceUrls).toEqual(source.keyFindings[0]!.sourceUrls)
    expect(next.keyFindings[0]!.evidenceCount).toBe(source.keyFindings[0]!.evidenceCount)
  })

  it('ignores an edit aimed at a finding that does not exist', () => {
    const next = applyEdits(source, { keyFindingEdits: [{ index: 99, impact: 'x' }] })
    expect(next.keyFindings.length).toBe(source.keyFindings.length)
  })
})

describe('immutable drift detection', () => {
  const source = collateral()

  it('reports nothing when only prose changed', () => {
    expect(immutableDrift(source, applyEdits(source, { summary: 'Reworded.' }))).toEqual([])
  })

  const drifts: Array<[string, Partial<SalesCollateral>]> = [
    ['pagesInspected', { pagesInspected: 99 }],
    ['productPagesInspected', { productPagesInspected: 5 }],
    ['scopeNote', { scopeNote: 'no limits' }],
    ['companyName', { companyName: 'Other Ltd' }],
    ['auditDate', { auditDate: '2020-01-01' }],
    ['website', { website: 'https://other.example' }],
    ['metrics', { metrics: [{ label: 'x', value: '1', basis: 'y' }] }],
  ]

  drifts.forEach(([field, patch]) => {
    it(`catches a tampered "${field}" even if it bypassed the schema`, () => {
      // Belt and braces for a future code path that builds a revision some
      // other way: this turns silent corruption into a blocked approval.
      expect(immutableDrift(source, collateral(patch))).toContain(field)
    })
  })

  it('catches a tampered finding metric', () => {
    const tampered = collateral()
    tampered.keyFindings[0]!.metric = 'A specification block was observed on 11 of 12 inspected product pages.'
    expect(immutableDrift(source, tampered)).toContain('keyFindings[0].metric')
  })

  it('catches removed or added findings', () => {
    expect(immutableDrift(source, collateral({ keyFindings: [] }))).toContain('keyFindings.length')
  })

  it('catches tampered source URLs', () => {
    const tampered = collateral()
    tampered.keyFindings[0]!.sourceUrls = ['https://somewhere-else.example']
    expect(immutableDrift(source, tampered)).toContain('keyFindings[0].sourceUrls')
  })
})

describe('prose surface for validation', () => {
  it('enumerates exactly the fields a reviewer can change', () => {
    const fields = editableProse(collateral()).map((p) => p.field)
    expect(fields).toEqual([
      'headline',
      'summary',
      'nextStep',
      'businessImpact[0]',
      'recommendedImprovementAreas[0]',
      'keyFindings[0].impact',
      'keyFindings[0].recommendation',
    ])
  })

  it('does not expose metrics or the scope note to the claim checker as editable', () => {
    // They are checked for DRIFT instead: they must be identical, not merely
    // free of unsupported claims.
    const fields = editableProse(collateral()).map((p) => p.field)
    expect(fields).not.toContain('scopeNote')
    expect(fields.some((f) => f.includes('metric'))).toBe(false)
  })
})

// ── FINDING ORDER (regression) ─────────────────────────────────────────────

describe('finding order is shared by the analyser, the PDF and the API', () => {
  it('ranks high above medium above low', async () => {
    const { sortFindingsByPriority } = await import('../../src/websiteaudit/findings.js')
    const rows = [
      { priority: 'low', affectedCount: 1, sampleSize: 1, id: 'l' },
      { priority: 'medium', affectedCount: 1, sampleSize: 1, id: 'm' },
      { priority: 'high', affectedCount: 1, sampleSize: 1, id: 'h' },
    ]
    expect(sortFindingsByPriority(rows).map((r) => r.id)).toEqual(['h', 'm', 'l'])
  })

  it('does NOT sort alphabetically, which would put low above medium', async () => {
    // This is the bug it exists to prevent: `ORDER BY priority ASC` on a string
    // column gives high, low, medium. The PDF prints the first four findings,
    // so a revision rendered that way showed a different set than the original.
    const { sortFindingsByPriority } = await import('../../src/websiteaudit/findings.js')
    const alphabetical = ['high', 'low', 'medium']
    const sorted = sortFindingsByPriority(
      alphabetical.map((priority) => ({ priority, affectedCount: 1, sampleSize: 1 })),
    ).map((r) => r.priority)
    expect(sorted).toEqual(['high', 'medium', 'low'])
    expect(sorted).not.toEqual(alphabetical)
  })

  it('breaks ties by the larger share of the sample', async () => {
    const { sortFindingsByPriority } = await import('../../src/websiteaudit/findings.js')
    const rows = [
      { priority: 'high', affectedCount: 1, sampleSize: 12, id: 'small' },
      { priority: 'high', affectedCount: 12, sampleSize: 12, id: 'large' },
    ]
    expect(sortFindingsByPriority(rows).map((r) => r.id)).toEqual(['large', 'small'])
  })

  it('does not mutate the array it was given', async () => {
    const { sortFindingsByPriority } = await import('../../src/websiteaudit/findings.js')
    const rows = [
      { priority: 'low', affectedCount: 1, sampleSize: 1 },
      { priority: 'high', affectedCount: 1, sampleSize: 1 },
    ]
    sortFindingsByPriority(rows)
    expect(rows[0]!.priority).toBe('low')
  })

  it('survives an unknown priority without reordering the known ones', async () => {
    const { sortFindingsByPriority } = await import('../../src/websiteaudit/findings.js')
    const rows = [
      { priority: 'unknown', affectedCount: 1, sampleSize: 1, id: 'u' },
      { priority: 'high', affectedCount: 1, sampleSize: 1, id: 'h' },
    ]
    expect(sortFindingsByPriority(rows).map((r) => r.id)).toEqual(['h', 'u'])
  })
})
