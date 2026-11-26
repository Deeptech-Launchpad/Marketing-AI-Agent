import { beforeEach, describe, expect, it, vi } from 'vitest'

// The pilot opt-out review list: NOTHING is silently left out (the evaluations are read in batches until there are no more), the total number of
// pending proposals is reported, and what an approver needs (the company's classification, the exact reason) is attached. Stand-in database.

const h = vi.hoisted(() => ({
  evaluations: [] as Array<Record<string, any>>,
  calls: [] as unknown[][],
  classifications: new Map<string, string>(),
  approvals: [] as Array<{ resourceId: string; actorCrmUserId: string }>,
  alwaysFull: false,
}))
vi.mock('../../src/platform/db.js', () => ({
  newId: () => 'id',
  prisma: {
    $queryRaw: async (_strings: TemplateStringsArray, ...raw: unknown[]) => {
      // Prisma flattens nested Prisma.sql fragments into one parameter list; do the same
      const values = raw.flatMap((v) => (v && typeof v === 'object' && 'values' in (v as object) ? ((v as { values: unknown[] }).values) : [v]))
      h.calls.push(values)
      if (h.alwaysFull) return Array.from({ length: 500 }, (_, i) => h.evaluations[i % h.evaluations.length])
      // keyset paging: the cursor is the (createdAt, id) of the last row of the previous batch
      const cursor = values.find((v): v is Date => v instanceof Date)
      const cursorId = values[values.findIndex((v) => v instanceof Date) + 1]
      const rows = h.evaluations.filter((e) => !cursor || e.createdAt.getTime() < cursor.getTime() || (e.createdAt.getTime() === cursor.getTime() && e.id < String(cursorId)))
      return rows.slice(0, 500)
    },
    warmLeadCompany: { findMany: async (a: Record<string, any>) => (a.where.crmCompanyId.in as string[]).map((id) => ({ crmCompanyId: id, classification: h.classifications.get(id) ?? null })) },
    auditEvent: { findMany: async (a: Record<string, any>) => h.approvals.filter((x) => (a.where.resourceId.in as string[]).includes(x.resourceId)) },
  },
}))

import { itemsFromReasons, optOutReview, optOutReviewForCompany } from '../../src/warmleads/optOutReview.js'

const proposal = (activity: string, status = 'dry_run', over: Partial<{ fp: string; phrase: string }> = {}) => ({
  signal: 'opt_out_proposal',
  summary: `r***@acme.example (the sender of the opt-out of 2026-11-03) ${status === 'dry_run' ? 'is PROPOSED' : 'is NOT added yet'}`,
  evidence: `status: ${status} · NXT activity ${activity} · received 2026-11-03 · fp ${over.fp ?? 'abcdef0123456789'} · phrase: ${over.phrase ?? 'UNSUBSCRIBE'} · one address only; no domain or company is ever suppressed automatically`,
})
const evaluation = (n: number, reasons: unknown[], company = `c${n}`) => ({ id: `e${String(100000 - n).padStart(6, '0')}`, crmCompanyId: company, companyName: `Co ${n}`, evaluatedAt: new Date(2026, 10, 3, 0, 0, 0, 0), createdAt: new Date(Date.UTC(2026, 10, 3) - n * 1000), reasons })

beforeEach(() => {
  h.evaluations = []
  h.calls.length = 0
  h.classifications.clear()
  h.approvals = []
  h.alwaysFull = false
})

describe('the stored line is read back with what an approver needs', () => {
  it('status, activity, date, keyed fingerprint, the standard phrase (our label, never the customer\'s words) and the reason in words', () => {
    const [it1] = itemsFromReasons([proposal('act_1', 'awaiting_approval', { phrase: 'STOP SENDING ME EMAILS' })], { crmCompanyId: 'c1', companyName: 'Acme', evaluationId: 'e1', evaluatedAt: null })
    expect(it1).toMatchObject({ kind: 'proposal', status: 'awaiting_approval', activityId: 'act_1', receivedOn: '2026-11-03', fingerprint: 'abcdef0123456789', phrase: 'STOP SENDING ME EMAILS', masked: 'r***@acme.example' })
    expect(it1!.reason).toMatch(/standard request “STOP SENDING ME EMAILS”/)
    expect(it1!.reason).toMatch(/the sender is not authenticated/)
  })
  it('an old line without fingerprint / phrase is still listed (it simply cannot be approved)', () => {
    const [old] = itemsFromReasons([{ signal: 'opt_out_proposal', summary: 'r***@acme.example is PROPOSED', evidence: 'status: dry_run · NXT activity act_2 · received 2026-10-20 · one address only' }], { crmCompanyId: 'c1', companyName: 'Acme', evaluationId: 'e1', evaluatedAt: null })
    expect(old).toMatchObject({ fingerprint: null, phrase: null, reason: null, activityId: 'act_2' })
  })
})

describe('no proposal is silently left out', () => {
  it('1,300 evaluations are read in batches until none is left: every proposal is listed and counted as pending', async () => {
    h.evaluations = Array.from({ length: 1300 }, (_, i) => evaluation(i, [proposal(`act_${i}`)]))
    const r = await optOutReview('tenant-A')
    expect(r.items).toHaveLength(1300)
    expect(r.pendingCount).toBe(1300)
    expect(r.complete).toBe(true)
    expect(h.calls).toHaveLength(3) // 500 + 500 + 300
    expect(new Set(r.items.map((i) => i.activityId)).size).toBe(1300)
    expect(h.calls.every((c) => c.includes('tenant-A'))).toBe(true) // always the caller's tenant
  })

  it('only the NEWEST evaluation\'s version of a proposal counts, wherever it falls between batches', async () => {
    // the same activity of the same company in 600 evaluations (newest first); only the newest says "awaiting_approval"
    h.evaluations = Array.from({ length: 600 }, (_, i) => evaluation(i, [proposal('act_same', i === 0 ? 'awaiting_approval' : 'dry_run')], 'c-same'))
    const r = await optOutReview('tenant-A')
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ status: 'awaiting_approval', activityId: 'act_same' })
    expect(r.pendingCount).toBe(1)
  })

  it('an approved proposal is "recorded" (named by the audit trail), is not pending, and the company\'s classification is attached', async () => {
    h.evaluations = [evaluation(1, [proposal('act_a')], 'c1'), evaluation(2, [proposal('act_b')], 'c2')]
    h.approvals = [{ resourceId: 'c1|act_a', actorCrmUserId: 'user-7' }]
    h.classifications.set('c1', 'existing_customer')
    h.classifications.set('c2', 'active_opportunity')
    const r = await optOutReview('tenant-A')
    const a = r.items.find((i) => i.activityId === 'act_a')!
    const b = r.items.find((i) => i.activityId === 'act_b')!
    expect(a).toMatchObject({ status: 'recorded', approvedBy: 'user-7', companyClassification: 'existing_customer' })
    expect(b).toMatchObject({ status: 'dry_run', approvedBy: null, companyClassification: 'active_opportunity' })
    expect(r.pendingCount).toBe(1)
  })

  it('"not recorded" and re-consent lines are listed but are not pending proposals', async () => {
    h.evaluations = [evaluation(1, [proposal('act_a'), { signal: 'opt_out_not_recorded', summary: 'An opt-out message of 2026-11-01 was found', evidence: 'status: needs_person · NXT activity act_n · received 2026-11-01' }])]
    const r = await optOutReview('tenant-A')
    expect(r.items).toHaveLength(2)
    expect(r.pendingCount).toBe(1)
  })

  it('a runaway table cannot loop forever: the backstop stops the read and says the list is NOT complete', async () => {
    h.evaluations = [evaluation(1, [proposal('act_a')])]
    h.alwaysFull = true
    const r = await optOutReview('tenant-A')
    expect(r.complete).toBe(false)
    expect(h.calls.length).toBe(200)
  })

  it('for ONE company (what an approval checks the request against) only that company\'s evaluations are asked for', async () => {
    h.evaluations = [evaluation(1, [proposal('act_a')], 'c1')]
    const items = await optOutReviewForCompany('tenant-A', 'c1')
    expect(items.map((i) => i.activityId)).toEqual(['act_a'])
    expect(h.calls[0]).toContain('c1')
    expect(h.calls[0]).toContain('tenant-A')
  })
})
