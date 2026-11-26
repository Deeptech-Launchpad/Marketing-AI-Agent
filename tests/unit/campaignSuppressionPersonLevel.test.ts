import { beforeEach, describe, expect, it, vi } from 'vitest'

// DECISION OF 2026-11-06: an email-level suppression is PERSON-level. Suppressing person1@company.com must never exclude person2 from the
// same company's campaign audience; a company or domain row stays a company-wide restriction. The database is a stand-in.

const db = vi.hoisted(() => ({ rows: [] as Array<{ matchType: string; matchValue: string; reason: string }> }))
vi.mock('../../src/platform/db.js', () => ({ newId: () => 'id', prisma: { suppressionEntry: { findMany: async () => db.rows } } }))

import { judge, loadSuppressionContext } from '../../src/campaign/suppressionService.js'
import type { CrmCompany } from '../../src/crm/types.js'

const company = (over: Partial<CrmCompany> = {}): CrmCompany =>
  ({ id: 'C1', name: 'Acme', email: 'person1@acme.example', emails: ['person1@acme.example', 'person2@acme.example'], domain: 'acme.example', ...over }) as CrmCompany
const ctx = (entries: Array<{ matchType: string; matchValue: string; reason: string }>) => ({ entries, recentlyContacted: new Set<string>(), activeDealCompanyIds: new Set<string>() })
const MANUAL = { matchType: 'email', matchValue: 'person1@acme.example', reason: 'Asked to be removed by phone (manual)' }
const AUTOMATED = { matchType: 'email', matchValue: 'person1@acme.example', reason: 'Opt-out request in an email reply on 2026-11-03 (read by Warm Leads)' }

beforeEach(() => {
  db.rows = []
})

describe('an email suppression is person-level in campaign audiences', () => {
  it.each([
    ['a manual row', MANUAL],
    ['an automated opt-out row', AUTOMATED],
  ])('%s for person1 does not exclude the company: person2 stays, and person1 is reported as excluded', (_n, row) => {
    const d = judge(company(), ctx([row]))
    expect(d.suppressed).toBe(false)
    expect(d.excludedEmails).toEqual(['person1@acme.example'])
  })

  it('the company is excluded only when NO saved address is left', () => {
    const both = ctx([MANUAL, { ...MANUAL, matchValue: 'person2@acme.example' }])
    expect(judge(company(), both)).toMatchObject({ suppressed: true })
    expect(judge(company(), both).reason).toMatch(/^Every saved contact address is on the opt-out list/)
    // a single-address company whose only address is suppressed has nobody left
    expect(judge(company({ email: 'person1@acme.example', emails: [] }), ctx([MANUAL])).suppressed).toBe(true)
  })

  it('a blank saved address is not a contact: it does not keep the company in the audience', () => {
    const c = company({ email: 'person1@acme.example', emails: ['person1@acme.example', '  ', ''] })
    expect(judge(c, ctx([MANUAL])).suppressed).toBe(true)
  })

  it('matching is by exact address, ignoring case; an address that is not saved on the company does not matter', () => {
    expect(judge(company({ emails: ['Person1@Acme.example', 'person2@acme.example'], email: null }), ctx([MANUAL])).excludedEmails).toEqual(['person1@acme.example'])
    expect(judge(company(), ctx([{ ...MANUAL, matchValue: 'person9@acme.example' }]))).toEqual({ suppressed: false })
    expect(judge(company(), ctx([{ ...MANUAL, matchValue: 'person1@other.example' }]))).toEqual({ suppressed: false })
  })

  it('company-level and domain-level rows remain COMPANY-WIDE restrictions', () => {
    expect(judge(company(), ctx([{ matchType: 'company', matchValue: 'c1', reason: 'DNC' }]))).toMatchObject({ suppressed: true, reason: 'DNC' })
    expect(judge(company(), ctx([{ matchType: 'domain', matchValue: 'acme.example', reason: 'domain DNC' }]))).toMatchObject({ suppressed: true, reason: 'domain DNC' })
    // ... and they win even when an email row is also present
    expect(judge(company(), ctx([MANUAL, { matchType: 'domain', matchValue: 'acme.example', reason: 'domain DNC' }]))).toMatchObject({ suppressed: true, reason: 'domain DNC' })
  })

  it('the other restrictions are unchanged: an open deal and a recent contact still exclude the company', () => {
    expect(judge(company(), { entries: [], recentlyContacted: new Set(), activeDealCompanyIds: new Set(['C1']) }).suppressed).toBe(true)
    expect(judge(company(), { entries: [], recentlyContacted: new Set(['C1']), activeDealCompanyIds: new Set() }).suppressed).toBe(true)
  })

  it('a company with no saved addresses is not touched by an email row', () => {
    expect(judge(company({ email: null, emails: [] }), ctx([MANUAL]))).toEqual({ suppressed: false })
  })

  it('end to end through the context loader: both the manual and the automated row of one company leave the company in', async () => {
    db.rows = [MANUAL, { ...AUTOMATED, matchValue: 'person3@acme.example' }]
    const c = await loadSuppressionContext({ tenantId: 't1', activeDealCompanyIds: new Set(), recentlyContacted: new Set() })
    const d = judge(company({ emails: ['person1@acme.example', 'person2@acme.example', 'person3@acme.example'] }), c)
    expect(d.suppressed).toBe(false)
    expect(d.excludedEmails?.sort()).toEqual(['person1@acme.example', 'person3@acme.example'])
  })
})
