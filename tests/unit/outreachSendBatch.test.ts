import { beforeEach, describe, expect, it, vi } from 'vitest'

// SEVERAL COMPANIES (2026-10-07): select → addresses → schedule → review → send.
//
// Review composes every first email exactly as Send creates it, with the same
// checks as approval, and writes nothing. Send needs the one confirmation,
// creates REAL sequences (not test ones), approves each email and gives it its
// time. The email is the approved copy with only the company, the product's
// own name, the greeting and the sender filled in — no model is called. The
// platform sends nothing itself: a due email is sent by a person and marked
// sent, exactly as under One company.

// ── An in-memory Prisma, just wide enough for this service ────────────────
type Row = Record<string, unknown>
const store: Record<string, Row[]> = {}
const reset = () => {
  for (const k of ['outreachCampaign', 'outreachAction', 'outreachMessage', 'outreachReply', 'outreachBatch', 'auditEvent', 'tenantMember', 'appUser']) store[k] = []
  store.tenant = [{ id: 't1', settings: { outreachSender: { firstName: 'Ada', fullName: 'Ada Lovelace', email: 'ada@altius.test', companyName: 'AltiusNxt', signature: '' } } }]
  // The person who starts the outreach signs it: their own login name, never a shared setting.
  store.tenantMember = [{ tenantId: 't1', crmUserId: 'u1', email: 'ada@altius.test', name: 'Ada Lovelace' }]
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w))
    if (k === 'NOT') return !matches(row, v as Row)
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const o = v as Row
      if ('in' in o) return (o.in as unknown[]).includes(row[k])
      if ('startsWith' in o) return String(row[k] ?? '').startsWith(String(o.startsWith))
      if ('gte' in o) return (row[k] as Date) >= (o.gte as Date)
      if ('lte' in o) return row[k] != null && (row[k] as Date) <= (o.lte as Date)
      if ('gt' in o) return row[k] != null && (row[k] as Date) > (o.gt as Date)
      return true
    }
    return row[k] === v
  })
}
function withIncludes(table: string, row: Row, include?: Row): Row {
  if (!include) return row
  const out = { ...row }
  if (table === 'outreachCampaign' && include.actions) {
    out.actions = store.outreachAction
      .filter((a) => a.campaignId === row.id)
      .sort((a, b) => (a.stepNumber as number) - (b.stepNumber as number))
      .map((a) => ({ ...a, message: store.outreachMessage.find((m) => m.actionId === a.id) ?? null }))
  }
  if (table === 'outreachCampaign' && include.replies) {
    out.replies = store.outreachReply.filter((r) => r.campaignId === row.id).sort((a, b) => (a.receivedAt as Date).getTime() - (b.receivedAt as Date).getTime())
  }
  return out
}
const model = (table: string) => ({
  findFirst: vi.fn(async (args: Row = {}) => {
    const r = store[table]!.find((x) => matches(x, args.where as Row))
    return r ? withIncludes(table, r, args.include as Row) : null
  }),
  findUnique: vi.fn(async (args: Row = {}) => store[table]!.find((x) => matches(x, args.where as Row)) ?? null),
  findMany: vi.fn(async (args: Row = {}) => store[table]!.filter((x) => matches(x, args.where as Row)).map((r) => withIncludes(table, r, args.include as Row))),
  create: vi.fn(async ({ data }: { data: Row }) => {
    if (table === 'outreachAction' && store.outreachAction.some((a) => a.idempotencyKey === data.idempotencyKey)) {
      throw Object.assign(new Error('Unique constraint'), { code: 'P2002' })
    }
    const row = { createdAt: new Date(), updatedAt: new Date(), revision: 1, retryCount: 0, ...data }
    store[table]!.push(row)
    return row
  }),
  update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const row = store[table]!.find((x) => matches(x, where))!
    Object.assign(row, data, { updatedAt: new Date() })
    return row
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const rows = store[table]!.filter((x) => matches(x, where))
    rows.forEach((r) => Object.assign(r, data))
    return { count: rows.length }
  }),
  delete: vi.fn(async ({ where }: { where: Row }) => {
    store[table] = store[table]!.filter((x) => !matches(x, where))
  }),
  groupBy: vi.fn(async ({ where }: { where: Row }) => {
    const counts = new Map<unknown, number>()
    store[table]!.filter((x) => matches(x, where)).forEach((r) => counts.set(r.initialVersion, (counts.get(r.initialVersion) ?? 0) + 1))
    return [...counts].map(([initialVersion, n]) => ({ initialVersion, _count: { _all: n } }))
  }),
})
const prisma = new Proxy({} as Record<string, ReturnType<typeof model>>, {
  get: (target, key: string) => (target[key] ??= model(key)),
})
reset()

vi.mock('../../src/platform/db.js', () => ({ prisma, newId: () => `id_${Math.random().toString(36).slice(2, 10)}` }))
vi.mock('../../src/config/env.js', () => ({ env: { OUTREACH_SEQUENCE_TIMEZONE: 'America/New_York', OUTREACH_MAX_RETRIES: 3 } }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
vi.mock('../../src/platform/audit.js', () => ({ audit: vi.fn(async (a: Row) => store.auditEvent!.push({ ...a, id: String(store.auditEvent!.length), createdAt: new Date() })) }))
const sync = vi.fn()
vi.mock('../../src/engagement/adapters/outreachAdapter.js', () => ({ syncOutreachActions: (...a: unknown[]) => sync(...a) }))
const suppressed = { value: false }
vi.mock('../../src/outreach/suppression.js', () => ({ checkSuppression: vi.fn(async () => ({ suppressed: suppressed.value, detail: 'Opted out' })) }))
const generate = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate }) }))

const FACTS = {
  crmCompanyId: 'c1',
  discoveredCompanyId: null,
  companyName: 'Acme Safety Co, Inc.',
  companyDomain: 'acmesafety.test',
  companySummary: 'Acme supplies head protection.',
  decisionMaker: { id: 'dm1', fullName: 'Jane Smith', title: 'Head of eCommerce', email: 'jane@acmesafety.test', profileUrl: null },
  product: { name: 'Titan Hard Hat X200', url: 'https://acmesafety.test/p/x200', category: 'Safety > Hard Hats', description: null, gaps: [] },
  signals: [],
  facts: [
    { id: 'company.name', label: 'Company', value: 'Acme Safety Co, Inc.', source: 'NXT Sales', sourceUrl: null },
    { id: 'dm.name', label: 'Decision maker', value: 'Jane Smith', source: 'Decision Makers', sourceUrl: null },
    { id: 'product.name', label: 'Product analysed', value: 'Titan Hard Hat X200', source: 'Prospects', sourceUrl: null },
  ],
}
const loadFacts = vi.fn(async (_t: unknown, id: unknown) => ({ ...FACTS, crmCompanyId: id, companyName: id === 'c2' ? 'Beta Tools Ltd' : FACTS.companyName }) as unknown)
vi.mock('../../src/outreach/salesSequence/facts.js', () => ({ loadProspectFacts: (...a: unknown[]) => loadFacts(...a) }))
// The company-mailbox lookup reads web pages; here it answers from the test.
const ensureMailbox = vi.fn(async () => null as unknown)
vi.mock('../../src/decisionmakers/companyContactEmail.js', () => ({ ensureCompanyContactEmail: (...a: unknown[]) => ensureMailbox(...a), storedCompanyContactEmail: () => null }))
vi.mock('../../src/outreach/salesSequence/sending/transport.js', () => ({ transportStatus: () => ({ mode: 'off', transport: 'capture', ready: false, reason: 'off', testInbox: null, allowList: [] }) }))
vi.mock('../../src/auth/accessList.js', () => ({ isEmailShaped: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) }))

const batches = await import('../../src/outreach/salesSequence/batches.js')
const svc = await import('../../src/outreach/salesSequence/service.js')
const actor = { tenantId: 't1', crmUserId: 'u1' }

// Monday 12 October 2026, 09:00 in New York.
const MONDAY_9AM_NY = '2026-10-12T13:00:00.000Z'
const schedule = { firstSendAt: MONDAY_9AM_NY, timezone: 'America/New_York', sendDays: [1, 2, 3, 4, 5], sendStart: '09:00', sendEnd: '17:00', spacingMinutes: 10, dailyCap: 20 }
const factsFor = (_t: unknown, id: unknown) => ({ ...FACTS, crmCompanyId: id, companyName: id === 'c2' ? 'Beta Tools Ltd' : FACTS.companyName }) as unknown

beforeEach(() => {
  reset()
  vi.clearAllMocks()
  suppressed.value = false
  loadFacts.mockImplementation(async (t: unknown, id: unknown) => factsFor(t, id))
})

describe('Review: every email as it will be sent, and nothing written', () => {
  it('is the approved copy with only the company, the product’s own name and the sender filled in', async () => {
    const r = await batches.previewSendBatch(actor, { crmCompanyIds: ['c1'] })
    const e = r.emails[0]!
    expect(e.problems).toEqual([])
    expect(e.subject).toBe('Who AI recommends instead of Acme Safety for Titan Hard Hat X200?')
    expect(e.body).toMatch(/^Jane,\n\nAda here, from AltiusNxt\./)
    expect(e.body.trimEnd().endsWith('Ada\nada@altius.test')).toBe(true)
    expect(e.recipientEmail).toBe('jane@acmesafety.test')
    expect(generate).not.toHaveBeenCalled()
    expect(store.outreachCampaign).toHaveLength(0)
    expect(store.outreachAction).toHaveLength(0)
  })

  it('splits the versions across the companies, as the rotation would', async () => {
    const r = await batches.previewSendBatch(actor, { crmCompanyIds: ['c1', 'c2'] })
    expect(r.emails.map((e) => e.version)).toEqual(['v1', 'v2'])
  })

  it('names the problem for a company already in outreach, and for a missing greeting name', async () => {
    await svc.startSequence(actor, 'c1')
    loadFacts.mockImplementation(async (t: unknown, id: unknown) => (id === 'c2' ? { ...(factsFor(t, id) as object), decisionMaker: null } : factsFor(t, id)))
    const r = await batches.previewSendBatch(actor, { crmCompanyIds: ['c1', 'c2'], recipients: { c2: 'buyer@beta.test' } })
    expect(r.emails[0]!.problems[0]).toMatch(/already in outreach/)
    expect(r.emails[1]!.fillable).toEqual(['name'])
    expect(r.emails[1]!.problems.join(' ')).toMatch(/\[Name\]/)
  })
})

describe('Send: one confirmation, real sequences, approved and scheduled', () => {
  it('refuses without the confirmation', async () => {
    await expect(batches.createSendBatch(actor, { crmCompanyIds: ['c1'], ...schedule })).rejects.toThrow(/Tick the confirmation/)
    expect(store.outreachCampaign).toHaveLength(0)
  })

  it('approves each first email and gives it its time — no draft is left to open', async () => {
    const r = await batches.createSendBatch(actor, { crmCompanyIds: ['c1', 'c2'], ...schedule, confirmQueries: true })
    expect(r.scheduled).toBe(2)
    expect(store.outreachBatch![0]).toMatchObject({ mode: 'manual', status: 'running' })
    expect(store.outreachCampaign!.every((c) => c.isTest === false && c.batchId === r.batchId)).toBe(true)
    const initial = store.outreachAction!.filter((a) => a.stageKey === 'initial')
    expect(initial.map((a) => a.status)).toEqual(['ready_to_send', 'ready_to_send'])
    expect(initial.every((a) => a.approvedByCrmUserId === 'u1')).toBe(true)
    expect(initial.map((a) => (a.scheduledAt as Date).toISOString())).toEqual([MONDAY_9AM_NY, '2026-10-12T13:10:00.000Z'])
    // The one confirmation is recorded on each email it covers.
    for (const a of initial) expect(((store.outreachMessage!.find((m) => m.actionId === a.id)!.attestations as unknown[]) ?? []).length).toBe(1)
    expect(generate).not.toHaveBeenCalled()
  })

  it('sends what Review showed, with the greeting name Sales typed', async () => {
    loadFacts.mockImplementation(async (t: unknown, id: unknown) => ({ ...(factsFor(t, id) as object), decisionMaker: null }))
    const r = await batches.createSendBatch(actor, { crmCompanyIds: ['c1'], recipients: { c1: 'buyer@acme.test' }, names: { c1: 'Pat' }, ...schedule, confirmQueries: true })
    expect(r.results[0]).toMatchObject({ ok: true })
    expect(String(store.outreachMessage![0]!.body)).toMatch(/^Pat,\n/)
    expect(store.outreachCampaign![0]).toMatchObject({ recipientEmail: 'buyer@acme.test', recipientEmailSource: 'sales_entered' })
  })

  it('leaves out a company already in outreach, and never touches its sequence', async () => {
    await svc.startSequence(actor, 'c1')
    const existing = store.outreachCampaign![0]!.id
    const before = JSON.stringify(store.outreachAction!.filter((a) => a.campaignId === existing))
    const r = await batches.createSendBatch(actor, { crmCompanyIds: ['c1', 'c2'], ...schedule, confirmQueries: true })
    expect(r.results.find((x) => x.crmCompanyId === 'c1')).toMatchObject({ ok: false })
    expect(r.scheduled).toBe(1)
    expect(JSON.stringify(store.outreachAction!.filter((a) => a.campaignId === existing))).toBe(before)
  })
})

describe('When an email is due, a person sends it and marks it sent', () => {
  it('shows each email as scheduled until its time, then due — and marking it sent works as under One company', async () => {
    const r = await batches.createSendBatch(actor, { crmCompanyIds: ['c1', 'c2'], ...schedule, confirmQueries: true })
    const at = new Date('2026-10-12T13:05:00.000Z')
    const view = (await batches.batchView('t1', r.batchId, at)) as unknown as { emails: Array<{ state: string; actionId: string }> }
    expect(view.emails.map((e) => e.state)).toEqual(['due', 'scheduled'])

    await svc.markSent(actor, view.emails[0]!.actionId)
    const after = (await batches.batchView('t1', r.batchId, at)) as unknown as { emails: Array<{ state: string }> }
    expect(after.emails.map((e) => e.state)).toEqual(['sent', 'scheduled'])
  })
})
