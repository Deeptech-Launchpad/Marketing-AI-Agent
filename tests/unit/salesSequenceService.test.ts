import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// THE SALES SEQUENCE SERVICE — end to end over an in-memory store.
//
// Start → a personalised initial draft (one version per prospect, rotated);
// approval refused until the test is confirmed; approval; "mark as sent"
// refused if the copy changed; a pasted reply that changes nothing until Sales
// confirms it; confirmation ending the no-reply track and drafting 2.1; and
// the legacy executor refusing to touch any of it.

// ── An in-memory Prisma, just wide enough for this service ────────────────
type Row = Record<string, unknown>
const store: Record<string, Row[]> = {}
const reset = () => {
  for (const k of ['outreachCampaign', 'outreachAction', 'outreachMessage', 'outreachReply', 'auditEvent', 'tenantMember', 'appUser']) store[k] = []
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
const loadFacts = vi.fn(async () => FACTS as unknown)
vi.mock('../../src/outreach/salesSequence/facts.js', () => ({ loadProspectFacts: (...a: unknown[]) => loadFacts(...a) }))
// The company-mailbox lookup reads web pages; here it answers from the test.
const ensureMailbox = vi.fn(async () => null as unknown)
vi.mock('../../src/decisionmakers/companyContactEmail.js', () => ({ ensureCompanyContactEmail: (...a: unknown[]) => ensureMailbox(...a) }))

const svc = await import('../../src/outreach/salesSequence/service.js')
const actor = { tenantId: 't1', crmUserId: 'u1' }

const initialAction = () => store.outreachAction!.find((a) => a.stageKey === 'initial')!
const messageOf = (actionId: unknown) => store.outreachMessage!.find((m) => m.actionId === actionId)!

beforeEach(() => {
  reset()
  vi.clearAllMocks()
  suppressed.value = false
  generate.mockResolvedValue({ data: { productTerm: 'Hard Hat', productCategoryTerm: 'Hard Hats', line: null }, model: 'm', costUsd: 0 })
})

describe('starting outreach', () => {
  it('prepares the initial draft from the approved copy, filled with verified facts', async () => {
    const r = await svc.startSequence(actor, 'c1')
    expect(r.created).toBe(true)
    const m = messageOf(initialAction().id)
    // The product's own name, exactly as its page states it — no model picks a shorter word (2026-10-07).
    expect(m.subject).toBe('Who AI recommends instead of Acme Safety for Titan Hard Hat X200?')
    expect(m.body).toMatch(/^Jane,\n\nAda here, from AltiusNxt\./)
    expect(m.body).toContain("Acme Safety wasn't the one recommended. Two other suppliers were.")
    expect(initialAction().status).toBe('draft')
    expect(sync).toHaveBeenCalled()
  })

  it('is idempotent: a second start returns the same sequence', async () => {
    const a = await svc.startSequence(actor, 'c1')
    const b = await svc.startSequence(actor, 'c1')
    expect(b).toEqual({ campaignId: a.campaignId, created: false })
    expect(store.outreachAction!.filter((x) => x.stageKey === 'initial')).toHaveLength(1)
  })

  it('rotates the versions evenly across prospects', async () => {
    await svc.startSequence(actor, 'c1')
    await svc.startSequence(actor, 'c2')
    await svc.startSequence(actor, 'c3')
    expect(store.outreachCampaign!.map((c) => c.initialVersion).sort()).toEqual(['v1', 'v2', 'v3'])
  })

  it('refuses without a shortlisted decision maker', async () => {
    loadFacts.mockResolvedValueOnce({ ...FACTS, decisionMaker: null })
    await expect(svc.startSequence(actor, 'c1')).rejects.toThrow(/decision maker/)
  })

  it('addresses the decision maker’s own email when there is one', async () => {
    await svc.startSequence(actor, 'c1')
    expect(store.outreachCampaign![0]).toMatchObject({ recipientEmail: 'jane@acmesafety.test', recipientEmailSource: 'decision_maker' })
    expect(ensureMailbox).not.toHaveBeenCalled()
  })

  it('uses a verified company mailbox when the decision maker has no email of their own, labelled as such', async () => {
    const mailbox = { email: 'sales@acmesafety.test', mailbox: 'sales', source: 'company_website', sourceLabel: 'the company’s own website', sourceUrl: 'https://acmesafety.test/contact', evidence: 'x', checkedAt: 'x' }
    loadFacts.mockResolvedValueOnce({ ...FACTS, decisionMaker: { ...FACTS.decisionMaker, email: null, companyContactEmail: mailbox } })
    await svc.startSequence(actor, 'c1')
    expect(store.outreachCampaign![0]).toMatchObject({ recipientEmail: 'sales@acmesafety.test', recipientEmailSource: 'company_mailbox' })
  })

  it('looks for a company mailbox once when neither is stored, and leaves the recipient empty if none exists — nothing guessed', async () => {
    loadFacts.mockResolvedValue({ ...FACTS, decisionMaker: { ...FACTS.decisionMaker, email: null } })
    ensureMailbox.mockResolvedValueOnce(null)
    await svc.startSequence(actor, 'c1')
    expect(ensureMailbox).toHaveBeenCalledWith('t1', 'c1')
    expect(store.outreachCampaign![0]).toMatchObject({ recipientEmail: null, recipientEmailSource: null })
    loadFacts.mockImplementation(async () => FACTS as unknown)
  })
})

// NO SHORTLISTED DECISION MAKER, BUT AN ADDRESS SALES FOUND (2026-10-01).
//
// Sales asked to reach these companies with a contact they looked up
// themselves. Without that address the refusal stands exactly as before; with
// it, outreach starts, writes to that address, and invents nothing — the
// greeting's [Name] stays visibly unfilled until Sales writes it.
describe('starting outreach with an address Sales typed', () => {
  // Every facts lookup — starting, then drafting — sees no decision maker, as
  // it would from the database. A one-shot mock would let drafting fall back
  // to the fixture's Jane and hide the very thing being tested.
  const noDm = () => loadFacts.mockResolvedValue({ ...FACTS, decisionMaker: null })
  afterEach(() => {
    loadFacts.mockImplementation(async () => FACTS as unknown)
  })

  it('still refuses a company with no decision maker when no address is given', async () => {
    noDm()
    await expect(svc.startSequence(actor, 'c1')).rejects.toThrow(/No decision maker has been shortlisted/)
    expect(store.outreachCampaign).toHaveLength(0)
  })

  it('starts for a company with no decision maker once Sales gives the address', async () => {
    noDm()
    const r = await svc.startSequence(actor, 'c1', { recipientEmail: 'buyer@acmesafety.test' })
    expect(r.created).toBe(true)
    expect(store.outreachCampaign![0]).toMatchObject({
      recipientEmail: 'buyer@acmesafety.test',
      recipientEmailSource: 'sales_entered',
      decisionMakerId: null,
    })
    // The first draft goes to that address.
    expect(initialAction()).toMatchObject({ destination: 'buyer@acmesafety.test', destinationKind: 'email' })
  })

  it('leaves [Name] unfilled rather than inventing a person, so approval waits for Sales', async () => {
    noDm()
    await svc.startSequence(actor, 'c1', { recipientEmail: 'buyer@acmesafety.test' })
    const m = messageOf(initialAction().id)
    expect(m.body.startsWith('[Name],')).toBe(true)
    // The company and product still fill themselves.
    expect(m.body).toContain('Acme Safety')
  })

  it('does not go looking for a company mailbox when Sales already gave the address', async () => {
    loadFacts.mockResolvedValueOnce({ ...FACTS, decisionMaker: { ...FACTS.decisionMaker, email: null } })
    await svc.startSequence(actor, 'c1', { recipientEmail: 'buyer@acmesafety.test' })
    expect(ensureMailbox).not.toHaveBeenCalled()
  })

  it('puts a typed address ahead of the decision maker’s own, recorded as Sales’s choice', async () => {
    await svc.startSequence(actor, 'c1', { recipientEmail: 'purchasing@acmesafety.test' })
    expect(store.outreachCampaign![0]).toMatchObject({
      recipientEmail: 'purchasing@acmesafety.test',
      recipientEmailSource: 'sales_entered',
      decisionMakerId: 'dm1',
    })
  })

  it('treats a blank address as none at all', async () => {
    noDm()
    await expect(svc.startSequence(actor, 'c1', { recipientEmail: '   ' })).rejects.toThrow(/No decision maker has been shortlisted/)
  })
})

describe('review, approval and manual sending', () => {
  it('refuses approval until Sales confirms the AI-engine test, then approves', async () => {
    await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await expect(svc.approve(actor, id)).rejects.toThrow(/cannot be approved yet/)
    await svc.attest(actor, id, 'ai_test', true)
    await svc.approve(actor, id)
    expect(initialAction().status).toBe('ready_to_send')
    expect(initialAction().approvedBodyHash).toBeTruthy()
  })

  it('refuses "mark as sent" if the email changed after approval', async () => {
    await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await svc.attest(actor, id, 'ai_test', true)
    await svc.approve(actor, id)
    messageOf(id).body = `${messageOf(id).body} extra`
    await expect(svc.markSent(actor, id)).rejects.toThrow(/changed after it was approved/)
  })

  it('an edit after approval sends the draft back to review', async () => {
    await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await svc.attest(actor, id, 'ai_test', true)
    await svc.approve(actor, id)
    await svc.editDraft(actor, id, { subject: messageOf(id).subject as string, body: 'Jane,\n\nEdited.\n\nAda' })
    expect(initialAction().status).toBe('draft')
    expect(messageOf(id).draftBody).not.toBe(messageOf(id).body) // the original draft is kept
  })

  it('marks an approved email sent, recording who and when — nothing is sent by the platform', async () => {
    await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await svc.attest(actor, id, 'ai_test', true)
    await svc.approve(actor, id)
    await svc.markSent(actor, id)
    expect(initialAction()).toMatchObject({ status: 'sent', sentByCrmUserId: 'u1' })
  })

  // A STOPPED SEQUENCE SENDS NOTHING MORE (2026-10-06). A draft left over in a
  // stopped sequence used to pass every check, so it could still be approved
  // and marked sent after the prospect said "not interested".
  it('refuses approval once the sequence is stopped, and says why', async () => {
    const { campaignId } = await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await svc.attest(actor, id, 'ai_test', true)
    await svc.setCampaignState(actor, campaignId, 'stop')
    await expect(svc.approve(actor, id)).rejects.toThrow(/cannot be approved yet/)
    expect(initialAction().status).toBe('draft')
  })

  it('refuses "mark as sent" for an email approved before the sequence was stopped', async () => {
    const { campaignId } = await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await svc.attest(actor, id, 'ai_test', true)
    await svc.approve(actor, id)
    await svc.setCampaignState(actor, campaignId, 'stop')
    await expect(svc.markSent(actor, id)).rejects.toThrow(/stopped, so no further email can be marked sent/)
    expect(initialAction().status).toBe('ready_to_send')
  })

  it('still lets a paused sequence’s approved email be marked sent, as documented', async () => {
    const { campaignId } = await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await svc.attest(actor, id, 'ai_test', true)
    await svc.approve(actor, id)
    await svc.setCampaignState(actor, campaignId, 'pause')
    await svc.markSent(actor, id)
    expect(initialAction().status).toBe('sent')
  })

  it('refuses to mark sent while the company is suppressed', async () => {
    await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await svc.attest(actor, id, 'ai_test', true)
    await svc.approve(actor, id)
    suppressed.value = true
    await expect(svc.markSent(actor, id)).rejects.toThrow(/suppressed/)
  })

  it('switching version clears the test confirmation, since the statement differs', async () => {
    await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await svc.attest(actor, id, 'ai_test', true)
    const other = store.outreachCampaign![0]!.initialVersion === 'v2' ? 'v3' : 'v2'
    await svc.switchVersion(actor, id, other as 'v2')
    expect(messageOf(id).attestations).toEqual([])
    expect(store.outreachCampaign![0]!.versionSource).toBe('sales_override')
  })
})

describe('replies', () => {
  const sendInitial = async () => {
    const { campaignId } = await svc.startSequence(actor, 'c1')
    const id = initialAction().id as string
    await svc.attest(actor, id, 'ai_test', true)
    await svc.approve(actor, id)
    await svc.markSent(actor, id)
    return campaignId
  }

  it('stores a pasted reply unconfirmed — nothing changes until Sales confirms', async () => {
    const campaignId = await sendInitial()
    generate.mockResolvedValueOnce({ data: { classification: 'sent_skus', evidenceQuote: 'here are our SKUs', skus: ['A1', 'B2', 'C3', 'D4', 'E5'] }, model: 'm', costUsd: 0 })
    const r = await svc.addReply(actor, campaignId, { text: 'Hi, here are our SKUs: A1, B2, C3, D4, E5', receivedAt: new Date().toISOString() })
    expect(r.reading.classification).toBe('sent_skus')
    expect(store.outreachReply![0]!.confirmedAt).toBeUndefined()
    expect(store.outreachAction!.some((a) => a.stageKey === 'reply_followup')).toBe(false)
  })

  it('on confirmation, ends the no-reply track and drafts 2.1 from the approved copy', async () => {
    const campaignId = await sendInitial()
    generate.mockResolvedValueOnce({ data: { classification: 'sent_skus', evidenceQuote: 'here are our SKUs', skus: ['A1', 'B2', 'C3', 'D4', 'E5'] }, model: 'm', costUsd: 0 })
    const { replyId } = await svc.addReply(actor, campaignId, { text: 'Hi, here are our SKUs: A1, B2, C3, D4, E5', receivedAt: new Date().toISOString() })
    const r = await svc.confirmReply(actor, replyId, { classification: 'sent_skus' })
    expect(r.preparedActionId).toBeTruthy()
    const draft = store.outreachAction!.find((a) => a.stageKey === 'reply_followup')!
    expect(messageOf(draft.id).body).toContain('Thanks for the quick reply, and for sending over the 5 SKUs.')
    expect(messageOf(draft.id).subject).toMatch(/^Re: /)
  })

  it('refuses to confirm an unclear reply — Sales picks what it is', async () => {
    const campaignId = await sendInitial()
    generate.mockResolvedValueOnce({ data: { classification: 'unclear', skus: [] }, model: 'm', costUsd: 0 })
    const { replyId } = await svc.addReply(actor, campaignId, { text: 'Hmm.', receivedAt: new Date().toISOString() })
    await expect(svc.confirmReply(actor, replyId, { classification: 'unclear' })).rejects.toThrow(/Choose what kind of reply/)
  })

  it('a "not interested" reply stops the sequence', async () => {
    const campaignId = await sendInitial()
    generate.mockResolvedValueOnce({ data: { classification: 'not_interested', evidenceQuote: 'not interested', skus: [] }, model: 'm', costUsd: 0 })
    const { replyId } = await svc.addReply(actor, campaignId, { text: 'We are not interested, thanks.', receivedAt: new Date().toISOString() })
    await svc.confirmReply(actor, replyId, { classification: 'not_interested' })
    expect(store.outreachCampaign![0]!.status).toBe('cancelled')
  })
})

describe('who signs the email', () => {
  it('is the logged-in user who started the outreach — not a shared or hard-coded person', async () => {
    store.tenantMember!.push({ tenantId: 't1', crmUserId: 'u2', email: 'bo@altius.test', name: 'Bo Diddley' })
    // Settings still carry an old person's details; they must be ignored.
    ;(store.tenant![0]!.settings as Record<string, Record<string, string>>).outreachSender!.firstName = 'Mani'
    await svc.startSequence({ tenantId: 't1', crmUserId: 'u2' }, 'c1')
    const body = messageOf(initialAction().id).body as string
    expect(body).toMatch(/^Jane,\n\nBo here, from AltiusNxt\./)
    expect(body).not.toMatch(/Mani|Ada/)
  })

  it('leaves the name unfilled (and approval blocked) when the user has no name on record', async () => {
    store.tenantMember!.push({ tenantId: 't1', crmUserId: 'u3', email: 'x@altius.test', name: null })
    await svc.startSequence({ tenantId: 't1', crmUserId: 'u3' }, 'c1')
    expect(messageOf(initialAction().id).body).toMatch(/\[Sender first name\] here/)
  })
})
