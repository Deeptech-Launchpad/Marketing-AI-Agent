import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// TEST MODE OUTREACH SENDING (2026-09-28).
//
// The rules this phase must never break:
//   · a customer address is never an addressee — every email goes only to an
//     allow-listed INTERNAL test inbox, and there is no live mode at all;
//   · nothing is sent that Sales did not approve, or that changed after approval;
//   · each email is sent at most once;
//   · a confirmed reply stops the remaining no-reply follow-ups;
//   · test campaigns never count as contact, never reach Engagement or CRM
//     Sync, and never block or stand in for the real sequence;
//   · the PDF timing is unchanged — a follow-up goes inside its window or not at all.

// ── An in-memory Prisma, just wide enough for these modules ───────────────
type Row = Record<string, unknown>
const store: Record<string, Row[]> = {}
const TABLES = ['outreachCampaign', 'outreachAction', 'outreachMessage', 'outreachReply', 'auditEvent', 'outreachBatch', 'outreachSendAttempt', 'decisionMakerRun', 'decisionMakerCandidate']
const reset = () => {
  for (const k of TABLES) store[k] = []
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
      if ('not' in o) return row[k] !== o.not
      if ('gte' in o) return (row[k] as Date) >= (o.gte as Date)
      if ('lte' in o) return row[k] instanceof Date && (row[k] as Date) <= (o.lte as Date)
      return true
    }
    return (row[k] ?? null) === v
  })
}
function withIncludes(table: string, row: Row, include?: Row): Row {
  if (!include) return row
  const out = { ...row }
  if (table === 'outreachCampaign' && include.actions) {
    out.actions = store.outreachAction!
      .filter((a) => a.campaignId === row.id)
      .sort((a, b) => (a.stepNumber as number) - (b.stepNumber as number))
      .map((a) => ({ ...a, message: store.outreachMessage!.find((m) => m.actionId === a.id) ?? null }))
  }
  if (table === 'outreachCampaign' && include.replies) {
    out.replies = store.outreachReply!.filter((r) => r.campaignId === row.id)
  }
  return out
}
const sortBy = (rows: Row[], orderBy: unknown) => {
  const o = (Array.isArray(orderBy) ? orderBy[0] : orderBy) as Record<string, 'asc' | 'desc'> | undefined
  if (!o) return rows
  const [field, dir] = Object.entries(o)[0]!
  return [...rows].sort((a, b) => {
    const x = a[field] as number | Date
    const y = b[field] as number | Date
    return (x > y ? 1 : x < y ? -1 : 0) * (dir === 'desc' ? -1 : 1)
  })
}
let seq = 0
const model = (table: string) => ({
  findFirst: vi.fn(async (args: Row = {}) => {
    const r = sortBy((store[table] ??= []).filter((x) => matches(x, args.where as Row)), args.orderBy)[0]
    return r ? withIncludes(table, r, args.include as Row) : null
  }),
  findUnique: vi.fn(async (args: Row = {}) => (store[table] ??= []).find((x) => matches(x, args.where as Row)) ?? null),
  findMany: vi.fn(async (args: Row = {}) => {
    const rows = sortBy((store[table] ??= []).filter((x) => matches(x, args.where as Row)), args.orderBy)
    return rows.slice(0, (args.take as number) ?? rows.length).map((r) => withIncludes(table, r, args.include as Row))
  }),
  count: vi.fn(async (args: Row = {}) => (store[table] ??= []).filter((x) => matches(x, args.where as Row)).length),
  create: vi.fn(async ({ data }: { data: Row }) => {
    if (table === 'outreachAction' && store.outreachAction!.some((a) => a.idempotencyKey === data.idempotencyKey)) {
      throw Object.assign(new Error('Unique constraint'), { code: 'P2002' })
    }
    const row = { createdAt: new Date(Date.now() + seq++), updatedAt: new Date(), revision: 1, retryCount: 0, isTest: false, batchId: null, ...data }
    ;(store[table] ??= []).push(row)
    return row
  }),
  update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const row = (store[table] ??= []).find((x) => matches(x, where))!
    for (const [k, v] of Object.entries(data)) {
      row[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? Number(row[k] ?? 0) + Number((v as Row).increment) : v
    }
    return row
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const rows = (store[table] ??= []).filter((x) => matches(x, where))
    rows.forEach((r) => Object.assign(r, data))
    return { count: rows.length }
  }),
  delete: vi.fn(async ({ where }: { where: Row }) => {
    store[table] = (store[table] ??= []).filter((x) => !matches(x, where))
  }),
  groupBy: vi.fn(async ({ where }: { where: Row }) => {
    const counts = new Map<unknown, number>()
    ;(store[table] ??= []).filter((x) => matches(x, where)).forEach((r) => counts.set(r.initialVersion, (counts.get(r.initialVersion) ?? 0) + 1))
    return [...counts].map(([initialVersion, n]) => ({ initialVersion, _count: { _all: n } }))
  }),
})
const prisma = new Proxy({} as Record<string, unknown>, {
  get: (target, key: string) => {
    if (key === '$transaction') return async (ops: Promise<unknown>[]) => Promise.all(ops)
    return (target[key] ??= model(key))
  },
}) as Record<string, ReturnType<typeof model>>
reset()

const env = {
  OUTREACH_SEQUENCE_TIMEZONE: 'America/New_York',
  OUTREACH_MAX_RETRIES: 3,
  OUTREACH_EMAIL_MODE: 'test' as 'off' | 'test',
  OUTREACH_TEST_RECIPIENTS: 'qa@altius.test, @internal.altius.test',
  OUTREACH_TEST_INBOX: 'qa@altius.test',
  OUTREACH_TEST_TRANSPORT: 'capture' as 'capture' | 'smtp',
  SMTP_HOST: '',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: '',
  SMTP_PASS: '',
  SMTP_FROM: '',
}
vi.mock('../../src/platform/db.js', () => ({ prisma, newId: () => `id_${Math.random().toString(36).slice(2, 10)}` }))
vi.mock('../../src/config/env.js', () => ({ env }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
vi.mock('../../src/platform/audit.js', () => ({ audit: vi.fn(async (a: Row) => store.auditEvent!.push({ ...a, id: String(store.auditEvent!.length), createdAt: new Date() })) }))
const sync = vi.fn()
vi.mock('../../src/engagement/adapters/outreachAdapter.js', () => ({ syncOutreachActions: (...a: unknown[]) => sync(...a) }))
const suppressed = { value: false }
vi.mock('../../src/outreach/suppression.js', () => ({ checkSuppression: vi.fn(async () => ({ suppressed: suppressed.value, detail: 'Opted out' })) }))
const generate = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate }) }))

const CUSTOMER = 'jane@acmesafety.test'
const factsFor = (crmCompanyId: string, withDm = true) => ({
  crmCompanyId,
  discoveredCompanyId: null,
  companyName: `Acme ${crmCompanyId}`,
  companyDomain: 'acmesafety.test',
  companySummary: 'Acme supplies head protection.',
  decisionMaker: withDm ? { id: `dm-${crmCompanyId}`, fullName: 'Jane Smith', title: 'Head of eCommerce', email: CUSTOMER, profileUrl: null } : null,
  product: { name: 'Titan Hard Hat X200', url: null, category: 'Safety > Hard Hats', description: null, gaps: [] },
  productPageUrl: null,
  productPageNote: 'No verified product page.',
  signals: [],
  facts: [{ id: 'company.name', label: 'Company', value: `Acme ${crmCompanyId}`, source: 'NXT Sales', sourceUrl: null }],
})
const loadFacts = vi.fn(async (_t: string, id: string) => factsFor(id, id !== 'no-dm') as unknown)
vi.mock('../../src/outreach/salesSequence/facts.js', () => ({ loadProspectFacts: (...a: unknown[]) => loadFacts(...(a as [string, string])) }))
vi.mock('../../src/decisionmakers/companyContactEmail.js', () => ({ ensureCompanyContactEmail: vi.fn(async () => null), storedCompanyContactEmail: () => null }))

const guard = await import('../../src/outreach/salesSequence/sending/guard.js')
const schedule = await import('../../src/outreach/salesSequence/sending/schedule.js')
const svc = await import('../../src/outreach/salesSequence/service.js')
const batches = await import('../../src/outreach/salesSequence/batches.js')
const { dispatchTestSends } = await import('../../src/outreach/salesSequence/sending/dispatcher.js')

const actor = { tenantId: 't1', crmUserId: 'u1' }
const messageOf = (actionId: unknown) => store.outreachMessage!.find((m) => m.actionId === actionId)!
const initialOf = (campaignId: unknown) => store.outreachAction!.find((a) => a.campaignId === campaignId && a.stageKey === 'initial')!

beforeEach(() => {
  reset()
  vi.clearAllMocks()
  suppressed.value = false
  env.OUTREACH_EMAIL_MODE = 'test'
  env.OUTREACH_TEST_RECIPIENTS = 'qa@altius.test, @internal.altius.test'
  env.OUTREACH_TEST_INBOX = 'qa@altius.test'
  generate.mockResolvedValue({ data: { productTerm: 'Hard Hat', productCategoryTerm: 'Hard Hats', line: null }, model: 'm', costUsd: 0 })
})

// A batch whose window is always open, starting now.
const OPEN = { firstSendAt: new Date(Date.now() - 60_000).toISOString(), timezone: 'UTC', sendDays: [1, 2, 3, 4, 5, 6, 7], sendStart: '00:00', sendEnd: '23:59', spacingMinutes: 1, dailyCap: 50 }

async function approvedTestEmail() {
  const r = await batches.createTestBatch(actor, { ...OPEN, crmCompanyIds: ['c1'] })
  const campaignId = r.results[0]!.campaignId!
  const id = initialOf(campaignId).id as string
  await svc.attest(actor, id, 'ai_test', true)
  await svc.approve(actor, id)
  return { batchId: r.batchId, campaignId, id }
}
const later = () => new Date(Date.now() + 5 * 60_000)

// ── The guard ─────────────────────────────────────────────────────────────

describe('the test-mode guard', () => {
  const config = (over: Partial<Parameters<typeof guard.resolveTestDelivery>[0]['config']> = {}) => ({
    mode: 'test' as const,
    allowList: guard.parseAllowList('qa@altius.test, @internal.altius.test'),
    testInbox: 'qa@altius.test',
    ...over,
  })

  it('never makes the customer an addressee: the email goes to the test inbox, the customer is only named', () => {
    const d = guard.resolveTestDelivery({ config: config(), intendedRecipient: CUSTOMER, subject: 'Hello' })
    expect(d).toMatchObject({ ok: true, to: ['qa@altius.test'] })
    if (!d.ok) throw new Error('refused')
    expect(d.to).not.toContain(CUSTOMER)
    expect(d.subject).toBe(`[TEST → ${CUSTOMER}] Hello`)
    expect(d.banner).toMatch(/customer was NOT contacted/)
  })

  it('refuses when sending is off, or in any mode that is not "test"', () => {
    expect(guard.resolveTestDelivery({ config: config({ mode: 'off' }), intendedRecipient: CUSTOMER, subject: 'x' }).ok).toBe(false)
    expect(guard.resolveTestDelivery({ config: config({ mode: 'live' as never }), intendedRecipient: CUSTOMER, subject: 'x' }).ok).toBe(false)
    expect(() => guard.assertDeliverable(['qa@altius.test'], config({ mode: 'live' as never }))).toThrow(/^Refused/)
  })

  it('refuses with no allow-list, or a test inbox that is not on it', () => {
    expect(guard.resolveTestDelivery({ config: config({ allowList: guard.parseAllowList('') }), intendedRecipient: CUSTOMER, subject: 'x' }).ok).toBe(false)
    expect(guard.resolveTestDelivery({ config: config({ testInbox: CUSTOMER }), intendedRecipient: CUSTOMER, subject: 'x' }).ok).toBe(false)
  })

  it('a preview goes to the requester only when they are an internal inbox — otherwise to the test inbox', () => {
    const own = guard.resolveTestDelivery({ config: config(), intendedRecipient: CUSTOMER, subject: 'x', requester: 'sam@internal.altius.test' })
    expect(own.ok && own.to).toEqual(['sam@internal.altius.test'])
    const outsider = guard.resolveTestDelivery({ config: config(), intendedRecipient: CUSTOMER, subject: 'x', requester: 'someone@gmail.test' })
    expect(outsider.ok && outsider.to).toEqual(['qa@altius.test'])
  })

  it('the transport-level check refuses any address outside the allow-list, whatever the caller did', () => {
    expect(() => guard.assertDeliverable([CUSTOMER], config())).toThrow(/Refused: .* is not an internal test inbox/)
    expect(() => guard.assertDeliverable(['qa@altius.test', CUSTOMER], config())).toThrow(/Refused/)
    expect(() => guard.assertDeliverable([], config())).toThrow(/Refused/)
    expect(() => guard.assertDeliverable(['qa@altius.test'], config())).not.toThrow()
  })

  it('the configuration cannot express a live mode', () => {
    const src = readFileSync(new URL('../../src/config/env.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/OUTREACH_EMAIL_MODE: z\.enum\(\['off', 'test'\]\)\.default\('off'\)/)
  })
})

// ── The schedule helpers ──────────────────────────────────────────────────

describe('the send schedule', () => {
  const w = { tz: 'America/New_York', days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 17 * 60 }

  it('moves a Saturday send to Monday at the opening hour', () => {
    const sat = new Date('2026-10-03T15:00:00Z') // Saturday 11:00 New York
    expect(schedule.nextSendSlot(sat, w)!.toISOString()).toBe('2026-10-05T13:00:00.000Z') // Monday 09:00 EDT
  })

  it('spaces the batch’s initial emails and rolls past closing time', () => {
    const slots = schedule.plannedInitialSlots(new Date('2026-10-05T20:40:00Z'), 3, 10, w) // Mon 16:40
    expect(slots.map((s) => s!.toISOString())).toEqual(['2026-10-05T20:40:00.000Z', '2026-10-05T20:50:00.000Z', '2026-10-06T13:00:00.000Z'])
  })

  it('places a follow-up inside its PDF window, or nowhere', () => {
    const window = { start: new Date('2026-10-14T04:00:00Z'), end: new Date('2026-10-16T03:59:00Z') }
    expect(schedule.followUpSlot({ window, index: 0, spacingMinutes: 10, w, now: new Date('2026-10-01T00:00:00Z') })!.toISOString()).toBe('2026-10-14T13:00:00.000Z')
    expect(schedule.followUpSlot({ window, index: 0, spacingMinutes: 10, w, now: new Date('2026-10-16T12:00:00Z') })).toBeNull()
  })

  it('reads clock times', () => {
    expect(schedule.parseClock('09:30')).toBe(570)
    expect(schedule.parseClock('25:00')).toBeNull()
  })
})

// ── Batches and the scheduled sender ──────────────────────────────────────

describe('a test batch', () => {
  it('drafts every company’s initial email and schedules nothing until Sales approves it', async () => {
    const r = await batches.createTestBatch(actor, { ...OPEN, crmCompanyIds: ['c1', 'c2', 'no-dm'] })
    expect(r.created).toBe(2)
    expect(r.results.find((x) => x.crmCompanyId === 'no-dm')).toMatchObject({ ok: false, error: expect.stringMatching(/decision maker/) })
    const initials = store.outreachAction!.filter((a) => a.stageKey === 'initial')
    expect(initials).toHaveLength(2)
    expect(initials.every((a) => a.status === 'draft')).toBe(true)
    expect(store.outreachCampaign!.every((c) => c.isTest === true && c.batchId === r.batchId)).toBe(true)
  })

  it('an unapproved draft is never sent, even when its planned time has come', async () => {
    const r = await batches.createTestBatch(actor, { ...OPEN, crmCompanyIds: ['c1'] })
    await dispatchTestSends(later())
    expect(initialOf(r.results[0]!.campaignId).status).toBe('draft')
    expect(store.outreachSendAttempt).toHaveLength(0)
  })

  it('once approved, it is sent at its time to the internal test inbox only — and recorded', async () => {
    const { id } = await approvedTestEmail()
    expect(store.outreachAction!.find((a) => a.id === id)!.status).toBe('scheduled')
    const summary = await dispatchTestSends(later())
    expect(summary.sent).toBe(1)
    const action = store.outreachAction!.find((a) => a.id === id)!
    expect(action).toMatchObject({ status: 'sent', sentVia: 'platform_test' })
    const [attempt] = store.outreachSendAttempt!
    expect(attempt).toMatchObject({ kind: 'scheduled', status: 'accepted', intendedRecipient: CUSTOMER, actualRecipients: ['qa@altius.test'], transport: 'capture' })
    expect(String(attempt!.subject)).toMatch(/^\[TEST → jane@acmesafety\.test\]/)
  })

  it('sends each email at most once', async () => {
    const { id } = await approvedTestEmail()
    expect(await svc.runScheduledTestSend(id, later())).toBe('sent')
    expect(await svc.runScheduledTestSend(id, later())).toBe('skipped')
    await dispatchTestSends(later())
    expect(store.outreachSendAttempt).toHaveLength(1)
  })

  it('does not send an email that changed after approval — it goes back to review', async () => {
    const { id } = await approvedTestEmail()
    messageOf(id).body = `${messageOf(id).body} extra`
    expect(await svc.runScheduledTestSend(id, later())).toBe('not_sent')
    expect(store.outreachAction!.find((a) => a.id === id)!.status).toBe('draft')
    expect(store.outreachSendAttempt).toHaveLength(0)
  })

  it('with sending turned off, the dispatcher does nothing and a direct send is blocked, not delivered', async () => {
    const { id } = await approvedTestEmail()
    env.OUTREACH_EMAIL_MODE = 'off'
    expect(await dispatchTestSends(later())).toMatchObject({ batches: 0, sent: 0 })
    expect(await svc.runScheduledTestSend(id, later())).toBe('failed')
    expect(store.outreachSendAttempt![0]).toMatchObject({ status: 'blocked', actualRecipients: [] })
    expect(store.outreachAction!.find((a) => a.id === id)!.status).toBe('failed')
  })

  it('a test inbox that is not on the allow-list is refused, and nothing goes out', async () => {
    const { id } = await approvedTestEmail()
    env.OUTREACH_TEST_INBOX = CUSTOMER
    expect(await svc.runScheduledTestSend(id, later())).toBe('failed')
    expect(store.outreachSendAttempt![0]).toMatchObject({ status: 'blocked', actualRecipients: [] })
  })

  it('a paused batch sends nothing; a cancelled batch cancels its unsent emails', async () => {
    const { batchId, id } = await approvedTestEmail()
    await batches.setBatchState(actor, batchId, 'pause')
    await dispatchTestSends(later())
    expect(store.outreachSendAttempt).toHaveLength(0)
    await batches.setBatchState(actor, batchId, 'cancel')
    expect(store.outreachAction!.find((a) => a.id === id)!.status).toBe('cancelled')
    expect(await svc.runScheduledTestSend(id, later())).toBe('skipped')
  })

  it('"Test email to my inbox" goes only to an internal address and changes nothing in the sequence', async () => {
    const r = await batches.createTestBatch(actor, { ...OPEN, crmCompanyIds: ['c1'] })
    const id = initialOf(r.results[0]!.campaignId).id as string
    const out = await svc.sendTestPreview({ ...actor, email: 'sam@internal.altius.test' }, id)
    expect(out).toMatchObject({ status: 'accepted', to: ['sam@internal.altius.test'] })
    expect(initialOf(r.results[0]!.campaignId).status).toBe('draft')
    // Exactly the customer's email — same subject — only the addressee differs.
    const attempt = store.outreachSendAttempt![0]!
    expect(attempt.subject).toBe(messageOf(id).subject)
    expect(attempt).toMatchObject({ intendedRecipient: CUSTOMER, actualRecipients: ['sam@internal.altius.test'] })
  })

  it('a test campaign cannot be "marked sent" by hand', async () => {
    const { id } = await approvedTestEmail()
    store.outreachAction!.find((a) => a.id === id)!.status = 'ready_to_send'
    await expect(svc.markSent(actor, id)).rejects.toThrow(/TEST campaign/)
  })
})

describe('a confirmed reply', () => {
  it('stops the remaining no-reply follow-ups, including ones already approved and scheduled', async () => {
    const { campaignId, id } = await approvedTestEmail()
    await svc.runScheduledTestSend(id, later())
    // A 2.3 follow-up that Sales approved and the test sender has scheduled.
    store.outreachAction!.push({ id: 'f1', tenantId: 't1', campaignId, stageKey: 'noreply_followup', stepNumber: 23, status: 'scheduled', scheduledAt: new Date(Date.now() + 9 * 86_400_000), createdAt: new Date() })
    generate.mockResolvedValueOnce({ data: { classification: 'not_interested', evidenceQuote: 'not interested', skus: [] }, model: 'm', costUsd: 0 })
    const { replyId } = await svc.addReply(actor, campaignId, { text: 'We are not interested, thanks.', receivedAt: new Date().toISOString() })
    await svc.confirmReply(actor, replyId, { classification: 'not_interested' })
    expect(store.outreachAction!.find((a) => a.id === 'f1')!.status).toBe('cancelled')
    expect(await svc.runScheduledTestSend('f1', new Date(Date.now() + 10 * 86_400_000))).toBe('skipped')
  })
})

describe('test campaigns stay apart from real outreach', () => {
  it('never stand in for, or block, the real sequence — and are not in the real prospect list', async () => {
    const { campaignId } = await approvedTestEmail()
    const real = await svc.startSequence(actor, 'c1')
    expect(real.created).toBe(true)
    expect(real.campaignId).not.toBe(campaignId)
    const listed = await svc.listProspects('t1')
    expect(listed.map((p: { campaignId: string }) => p.campaignId)).toEqual([real.campaignId])
    const view = await svc.companyView('t1', 'c1')
    expect(view.campaign?.id).toBe(real.campaignId)
    const testView = await svc.companyView('t1', 'c1', new Date(), campaignId)
    expect(testView.campaign).toMatchObject({ id: campaignId, isTest: true })
  })

  it('are excluded from Engagement and CRM Sync at the query', () => {
    const adapter = readFileSync(new URL('../../src/engagement/adapters/outreachAdapter.ts', import.meta.url), 'utf8')
    expect(adapter).toMatch(/campaign: \{ isTest: false \}/)
    const payload = readFileSync(new URL('../../src/crmsync/payload.ts', import.meta.url), 'utf8')
    expect(payload).toMatch(/crmCompanyId: q\.crmCompanyId, isTest: false/)
    const suppression = readFileSync(new URL('../../src/outreach/suppression.ts', import.meta.url), 'utf8')
    expect(suppression).toMatch(/campaign: \{ isTest: false \}/)
  })
})
