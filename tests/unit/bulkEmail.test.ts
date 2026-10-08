import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

// BULK EMAIL (2026-10-08) — simple and standalone.
//
// The approved static template and nothing else, with only [First Name] and
// [Company Name] filled. One email per company: the first named person
// receives it and colleagues are copied; only work addresses are used; rows
// marked not interested or already contacted are skipped. Date, time (IST) and
// minutes between emails: 10:00, 10:05, 10:10 … until the list is done. The
// sender sends ONE at a time, a failure does not stop the rest, and the send
// completes.

// ── An in-memory store ─────────────────────────────────────────────────────
type Row = Record<string, unknown>
const store: Record<string, Row[]> = {}
const reset = () => {
  for (const k of ['bulkEmailCampaign', 'bulkEmailRecipient', 'suppressionEntry', 'auditEvent']) store[k] = []
  store.tenant = [{ id: 't1', settings: null }]
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w))
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const o = v as Row
      if ('in' in o) return (o.in as unknown[]).includes(row[k])
      if ('not' in o) return row[k] !== o.not
      if ('lte' in o) return row[k] != null && (row[k] as Date) <= (o.lte as Date)
      if ('lt' in o) return row[k] != null && (row[k] as Date) < (o.lt as Date)
      if ('gte' in o) return row[k] != null && (row[k] as Date) >= (o.gte as Date)
      return true
    }
    return row[k] === v
  })
}
const sortBy = (rows: Row[], orderBy?: Row | Row[]) => {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0]!)
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? (a[k] as Date).getTime() : (a[k] as number)
      const y = b[k] instanceof Date ? (b[k] as Date).getTime() : (b[k] as number)
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1)
    }
    return 0
  })
}
const model = (table: string) => ({
  findUnique: vi.fn(async (a: Row = {}) => store[table]!.find((x) => matches(x, a.where as Row)) ?? null),
  findFirst: vi.fn(async (a: Row = {}) => sortBy(store[table]!.filter((x) => matches(x, a.where as Row)), a.orderBy as Row)[0] ?? null),
  findMany: vi.fn(async (a: Row = {}) => sortBy(store[table]!.filter((x) => matches(x, a.where as Row)), a.orderBy as Row)),
  count: vi.fn(async (a: Row = {}) => store[table]!.filter((x) => matches(x, a.where as Row)).length),
  create: vi.fn(async ({ data }: { data: Row }) => {
    const row = { createdAt: new Date(), updatedAt: new Date(), ...data }
    store[table]!.push(row)
    return row
  }),
  createMany: vi.fn(async ({ data }: { data: Row[] }) => {
    data.forEach((d) => store[table]!.push({ createdAt: new Date(), updatedAt: new Date(), ...d }))
    return { count: data.length }
  }),
  update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const row = store[table]!.find((x) => matches(x, where))!
    Object.assign(row, data, { updatedAt: new Date() })
    return row
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const rows = store[table]!.filter((x) => matches(x, where))
    rows.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }))
    return { count: rows.length }
  }),
  upsert: vi.fn(async ({ create }: { create: Row }) => {
    store[table]!.push(create)
    return create
  }),
  groupBy: vi.fn(async ({ where }: { where: Row }) => {
    const counts = new Map<unknown, number>()
    store[table]!.filter((x) => matches(x, where)).forEach((r) => counts.set(r.status, (counts.get(r.status) ?? 0) + 1))
    return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }))
  }),
})
const prisma = new Proxy({} as Record<string, ReturnType<typeof model>>, { get: (t, k: string) => (t[k] ??= model(k)) })
reset()

let n = 0
vi.mock('../../src/platform/db.js', () => ({ prisma, newId: () => `id_${++n}` }))
const env = {
  BULK_EMAIL_ENABLED: true,
  BULK_SMTP_HOST: 'smtp.example.test',
  BULK_SMTP_PORT: 587,
  BULK_SMTP_SECURE: false,
  BULK_SMTP_USER: 'manoj@altiusnxt.test',
  BULK_SMTP_PASS: 'x',
  // The system account (login codes) — used only when BULK_SMTP_* is empty.
  SMTP_HOST: '',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: '',
  SMTP_PASS: '',
  OUTREACH_COOLDOWN_DAYS: 30,
}
const BULK_ACCOUNT = { BULK_SMTP_HOST: env.BULK_SMTP_HOST, BULK_SMTP_USER: env.BULK_SMTP_USER, BULK_SMTP_PASS: env.BULK_SMTP_PASS }
vi.mock('../../src/config/env.js', () => ({ env }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
vi.mock('../../src/platform/audit.js', () => ({ audit: vi.fn(async (a: Row) => store.auditEvent!.push(a)) }))
const suppressed = new Set<string>()
vi.mock('../../src/outreach/suppression.js', () => ({
  checkSuppression: vi.fn(async (i: { destination: string | null }) => ({ suppressed: Boolean(i.destination && suppressed.has(i.destination)), detail: 'Opted out' })),
}))

const { composeBulkEmail, STATIC_SITE } = await import('../../src/outreach/bulk/template.js')
const { extractContacts, workAddress, firstNameOf, recipientsOf } = await import('../../src/outreach/bulk/extract.js')
const { istToUtc, planSequential, fmtIst } = await import('../../src/outreach/bulk/schedule.js')
const svc = await import('../../src/outreach/bulk/service.js')
const { setBulkSenderForTests, bulkTransportAccount, bulkMailOptions } = await import('../../src/outreach/bulk/transport.js')
const { checkSender, parseDmarc, setSenderCheckDepsForTests } = await import('../../src/outreach/bulk/senders.js')

// The sender check, without DNS or a mailbox: each test says what they answer.
const dmarcCalls: string[] = []
const probeCalls: string[] = []
let dmarcAnswer: { policy: 'none' | 'quarantine' | 'reject' | null; error: string | null } = { policy: null, error: null }
let probeAnswer: { deliveredFrom: string | null } | { error: string } = { error: 'no probe in this test' }

const actor = { tenantId: 't1', crmUserId: 'u1' }

async function xlsx(rows: unknown[][]): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  rows.forEach((r) => ws.addRow(r))
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64')
}
const HEADER = ['Company Name', 'Remarks–URL', 'Contact Person 1', 'Title 1', 'Email Id1', 'Contact Person 2 ', 'Title 2', 'Email 2 ', 'Status']

beforeEach(() => {
  reset()
  suppressed.clear()
  setBulkSenderForTests(null)
  Object.assign(env, BULK_ACCOUNT, { SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '' })
  dmarcCalls.length = 0
  probeCalls.length = 0
  dmarcAnswer = { policy: null, error: null }
  probeAnswer = { error: 'no probe in this test' }
  setSenderCheckDepsForTests({
    dmarc: async (d) => (dmarcCalls.push(d), dmarcAnswer),
    probe: async (_a, from) => (probeCalls.push(from), probeAnswer),
  })
})

/** The From, CC and signature set on the screen (the account itself: authorized without a probe). */
const setSender = (over: Partial<{ fromEmail: string; ccEmails: string[]; signature: string }> = {}) =>
  svc.saveBulkSender(actor, { fromEmail: 'manoj@altiusnxt.test', ccEmails: [], signature: '', ...over }, new Date('2026-10-09T11:00:00Z'))

describe('the approved template, and nothing else', () => {
  it('changes nothing but [First Name] and [Company Name], and adds no signature, footer or other text', () => {
    const e = composeBulkEmail({ template: STATIC_SITE, firstName: 'Ed', companyName: 'First Electric Supply' })
    expect(e.subject).toBe('Are AI tools recommending First Electric Supply?')
    expect(e.text).toBe(STATIC_SITE.body.replace('[First Name]', 'Ed').split('\n').join('\n\n'))
    expect(e.text.endsWith('Would you like me to send it?')).toBe(true)
    expect(e.text).not.toMatch(/unsubscribe|--/)
    expect(e.text).toContain("You didn't come up as a recommended supplier.")
    expect(e.unfilled).toEqual([])
    // The HTML part: the same words; "register here" links to the expo registration.
    expect(e.html).toContain('>register here</a> with code ALTIUSVIP.')
  })

  it('reports a placeholder it could not fill, rather than sending it', () => {
    expect(composeBulkEmail({ template: STATIC_SITE, firstName: null, companyName: 'X' }).unfilled).toEqual(['[First Name]'])
  })
})

describe('reading the spreadsheet', () => {
  it('uses the work address only — never one marked personal, never webmail', () => {
    expect(workAddress('Primary: jeff@armourscrew.com Personal: jefflg@sbcglobal.net').email).toBe('jeff@armourscrew.com')
    expect(workAddress('tcombustion@gmail.com , p.trimble@trimblecombustion.com').email).toBe('p.trimble@trimblecombustion.com')
    expect(workAddress('Personal: someone@acme.com').email).toBeNull()
    expect(workAddress('bob@gmail.com').email).toBeNull()
    expect(workAddress('bob@gmail.com').reason).toMatch(/personal/)
    expect(workAddress('').email).toBeNull()
  })

  it('with the test option on, also uses webmail — but still never an address marked personal', () => {
    expect(workAddress('dtlpsaranya@gmail.com', { allowWebmail: true }).email).toBe('dtlpsaranya@gmail.com')
    expect(workAddress('Primary: jeff@armourscrew.com Personal: jefflg@sbcglobal.net', { allowWebmail: true }).email).toBe('jeff@armourscrew.com')
    expect(workAddress('Personal: jefflg@sbcglobal.net', { allowWebmail: true }).email).toBeNull()
    expect(workAddress('dtlpsaranya@gmail.com').email).toBeNull()
  })

  it('takes the first name, tidily, and never invents one', () => {
    expect(firstNameOf('hank Rossman')).toBe('Hank')
    expect(firstNameOf('Mr. John T')).toBe('John')
    expect(firstNameOf(' ')).toBeNull()
  })

  it('sends one email per company: the first person receives it, colleagues are copied — across rows too', () => {
    const x = extractContacts([
      HEADER,
      ['Thermohvac', 'u', 'Maddie Stellick', 'Owner', 'mstellick@thermohvac.com', 'Mike Murray', 'GM', 'mmurray@thermohvac.com', ''],
      ['Thermohvac', 'u', 'Sam Lee', 'Buyer', 'slee@thermohvac.com', '', '', '', ''],
    ])
    expect(x.companies).toHaveLength(1)
    const r = recipientsOf(x.companies[0]!)
    expect(r.to?.email).toBe('mstellick@thermohvac.com')
    expect(r.cc.map((p) => p.email)).toEqual(['mmurray@thermohvac.com', 'slee@thermohvac.com'])
    expect(x.companies[0]!.rows).toEqual([2, 3])
  })

  it('skips companies that said not interested or were already contacted, and says why', () => {
    const x = extractContacts([
      HEADER,
      ['Progressive power', 'u', 'hank Rossman', 'President', 'Primary: hank@progressivepower.net', '', '', '', 'They said not interested'],
      ['First Electric Supply', 'u', 'Ed Droeger', 'President', 'edd@firstelectricsupply.com', '', '', '', 'Outreach - 06/10/2026'],
      ['Armour Screw', 'u', 'Jeff', 'Owner', 'jeff@armourscrew.com', '', '', '', ''],
    ])
    expect(x.companies.map((c) => c.skip?.split(' (')[0] ?? null)).toEqual(['Said not interested', 'Already contacted', null])
  })

  it('finds the columns by heading, in any order', () => {
    const x = extractContacts([
      ['Email', 'Name', 'Organization'],
      ['ann@beta.com', 'Ann Beta', 'Beta Tools'],
    ])
    expect(recipientsOf(x.companies[0]!).to).toMatchObject({ name: 'Ann Beta', email: 'ann@beta.com' })
  })
})

describe('the schedule: date, time (IST) and minutes between emails', () => {
  it('10:00 AM on 10 October 2026 is 10:00 AM in India', () => {
    const at = istToUtc('2026-10-10', '10:00')!
    expect(at.toISOString()).toBe('2026-10-10T04:30:00.000Z')
    expect(fmtIst(at)).toBe('Sat, Oct 10, 2026, 10:00 AM IST')
  })

  it('sends one after another, interval minutes apart — no hours, days or limits', () => {
    const slots = planSequential(istToUtc('2026-10-10', '10:00')!, 4, 5)
    expect(slots.map((d) => fmtIst(d).split(', ').pop())).toEqual(['10:00 AM IST', '10:05 AM IST', '10:10 AM IST', '10:15 AM IST'])
    // Late at night and over the weekend too: nothing holds them back.
    const late = planSequential(istToUtc('2026-10-10', '23:55')!, 2, 10)
    expect(late.map((d) => fmtIst(d))).toEqual(['Sat, Oct 10, 2026, 11:55 PM IST', 'Sun, Oct 11, 2026, 12:05 AM IST'])
  })
})

describe('review, start, and sending one at a time', () => {
  const setup = async (over: Record<string, unknown> = {}) => ({
    fileBase64: await xlsx([
      HEADER,
      ['Thermohvac', 'u', 'Maddie Stellick', 'Owner', 'mstellick@thermohvac.com', 'Mike Murray', 'GM', 'mmurray@thermohvac.com', ''],
      ['Armour Screw', 'u', 'jeff smith', 'Owner', 'Primary: jeff@armourscrew.com Personal: jefflg@sbcglobal.net', '', '', '', ''],
      ['Babsco', 'u', 'Steve Kile', 'Owner', 'skile@babsco.com', '', '', '', ''],
      ['Progressive power', 'u', 'hank Rossman', 'President', 'hank@progressivepower.net', '', '', '', 'Not interested'],
      ['No Email Co', 'u', 'Pat', 'Owner', '', '', '', '', ''],
    ]),
    fileName: 'Indianapolis - Static Leads.xlsx',
    templateKey: 'static_site_v1',
    startDate: '2026-10-10',
    startTime: '10:00',
    intervalMinutes: 5,
    ...over,
  })
  const BEFORE = new Date('2026-10-09T12:00:00Z')
  const at = (hhmm: string) => istToUtc('2026-10-10', hhmm)!

  it('Review shows every company, its To and CC, its email and its time — and writes nothing', async () => {
    const r = await svc.reviewBulk(actor, await setup(), BEFORE)
    expect(r.counts).toMatchObject({ validEmails: 3, skipped: 1, noWorkAddress: 1 })
    const thermo = r.rows.find((x) => x.companyName === 'Thermohvac')!
    expect(thermo).toMatchObject({ toEmail: 'mstellick@thermohvac.com', ccEmails: ['mmurray@thermohvac.com'], status: 'ready' })
    expect(thermo.text!.startsWith('Maddie,\n\nManoj here, from AltiusNxt.')).toBe(true)
    expect(r.rows.find((x) => x.companyName === 'Armour Screw')!.text!.startsWith('Jeff,')).toBe(true)
    expect(r.rows.filter((x) => x.status === 'ready').map((x) => x.scheduledLocal!.split(', ').pop())).toEqual(['10:00 AM IST', '10:05 AM IST', '10:10 AM IST'])
    expect(r.schedule.estimatedCompletionLocal).toBe('Sat, Oct 10, 2026, 10:10 AM IST')
    expect(store.bulkEmailCampaign).toHaveLength(0)
  })

  it('reviews before any From is set — but Start needs one, and never falls back to the sending account', async () => {
    const r = await svc.reviewBulk(actor, await setup(), BEFORE)
    expect(r.counts.validEmails).toBe(3)
    expect(r.from.email).toBeNull()
    expect(r.sender.problem).toBe('Set the From email for bulk emails.')
    await expect(svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)).rejects.toThrow(/Set the From email/)
    expect(store.bulkEmailCampaign).toHaveLength(0)

    await setSender()
    const { scheduled } = await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    expect(scheduled).toBe(3)
    expect(store.bulkEmailCampaign![0]).toMatchObject({ fromEmail: 'manoj@altiusnxt.test', timezone: 'Asia/Kolkata', intervalMinutes: 5 })
  })

  it('will not start without the confirmation, or from a From the account may not send as', async () => {
    await setSender()
    await expect(svc.startBulk(actor, { ...(await setup()), confirm: false }, BEFORE)).rejects.toThrow(/Tick the confirmation/)
    // Another address on a server whose send-as permission cannot be read.
    await setSender({ fromEmail: 'sales@altiusnxt.test' })
    await expect(svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)).rejects.toThrow(/Not started — sales@altiusnxt.test is not authorized/)
    expect(store.bulkEmailCampaign).toHaveLength(0)
  })

  it('sends one email at a time, interval apart, records a failure and carries on, then completes', async () => {
    const sent: Array<{ to: string; cc: string[]; from: string; subject: string; text: string }> = []
    setBulkSenderForTests({
      send: async (e) => {
        if (e.to === 'jeff@armourscrew.com') throw new Error('550 mailbox unavailable')
        sent.push({ to: e.to, cc: e.cc, from: e.fromEmail, subject: e.subject, text: e.text })
        return { messageId: `m${sent.length}` }
      },
    })
    await setSender()
    const { campaignId, scheduled } = await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    expect(scheduled).toBe(3)

    // 9:59 — before the start: nothing.
    await svc.dispatchBulkEmails(at('09:59'))
    expect(sent).toHaveLength(0)
    // 10:00 — the first. 10:02 — too soon after it.
    await svc.dispatchBulkEmails(at('10:00'))
    await svc.dispatchBulkEmails(at('10:02'))
    expect(sent.map((s) => s.to)).toEqual(['mstellick@thermohvac.com'])
    expect(sent[0]).toMatchObject({ from: 'manoj@altiusnxt.test', cc: ['mmurray@thermohvac.com'], subject: 'Are AI tools recommending Thermohvac?' })
    expect(sent[0]!.text.endsWith('Would you like me to send it?')).toBe(true)
    // 10:05 — the second fails; it is recorded and the send carries on.
    await svc.dispatchBulkEmails(at('10:05'))
    await svc.dispatchBulkEmails(at('10:10'))
    expect(sent.map((s) => s.to)).toEqual(['mstellick@thermohvac.com', 'skile@babsco.com'])
    const view = await svc.bulkView('t1', campaignId)
    expect(view.recipients.find((r) => r.companyName === 'Armour Screw')).toMatchObject({ status: 'failed', reason: '550 mailbox unavailable' })
    expect(view.counts).toMatchObject({ sent: 2, failed: 1, skipped: 1 })
    expect(view.campaign.status).toBe('completed')
    expect(store.auditEvent!.some((a) => a.action === 'outreach.bulk_email.completed')).toBe(true)
  })

  it('skips anyone who opted out before their email went', async () => {
    const sent: string[] = []
    setBulkSenderForTests({ send: async (e) => (sent.push(e.to), { messageId: 'm' }) })
    await setSender()
    await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    suppressed.add('mstellick@thermohvac.com')
    await svc.dispatchBulkEmails(at('10:00'))
    expect(sent).toEqual([])
    expect(store.bulkEmailRecipient!.find((r) => r.toEmail === 'mstellick@thermohvac.com')).toMatchObject({ status: 'skipped' })
  })

  it('sends nothing at all while bulk sending is switched off', async () => {
    const sent: string[] = []
    setBulkSenderForTests({ send: async (e) => (sent.push(e.to), { messageId: 'm' }) })
    await setSender()
    await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    env.BULK_EMAIL_ENABLED = false
    try {
      await svc.dispatchBulkEmails(at('10:00'))
      expect(sent).toEqual([])
    } finally {
      env.BULK_EMAIL_ENABLED = true
    }
  })
})

// THE SENDER (2026-10-08): the From the customer sees is the one the user
// set, carried by the server's SMTP account — and only when that account may
// genuinely send as it. dtlpmanikandan@gmail.com (the system account) is never
// the From unless the user typed exactly that.
describe('the sender: may this account send as the chosen From?', () => {
  const SYSTEM = { host: 'smtp.gmail.com', port: 587, secure: false, user: 'dtlpmanikandan@gmail.com', pass: 'x', source: 'system' as const }
  const NOW = new Date('2026-10-09T11:00:00Z')

  it('the account’s own address: yes — no lookup, no check message', async () => {
    const c = await checkSender('DTLPmanikandan@gmail.com', SYSTEM, NOW)
    expect(c).toMatchObject({ authorized: true, method: 'is_account', fromEmail: 'dtlpmanikandan@gmail.com' })
    expect(dmarcCalls).toEqual([])
    expect(probeCalls).toEqual([])
  })

  it('sales@altiusnxt.com through a gmail.com account: refused — altiusnxt.com publishes DMARC p=reject', async () => {
    dmarcAnswer = { policy: 'reject', error: null }
    const c = await checkSender('sales@altiusnxt.com', SYSTEM, NOW)
    expect(c.authorized).toBe(false)
    expect(c.reason).toMatch(/altiusnxt.com publishes a DMARC policy of "reject"/)
    expect(c.reason).toMatch(/must be a mailbox on altiusnxt.com/)
    expect(dmarcCalls).toEqual(['altiusnxt.com'])
    expect(probeCalls).toEqual([]) // not even a check message
  })

  it('refuses when the DMARC policy cannot be read — a failed lookup never passes', async () => {
    dmarcAnswer = { policy: null, error: 'ETIMEOUT' }
    const c = await checkSender('sales@example.org', SYSTEM, NOW)
    expect(c.authorized).toBe(false)
    expect(c.reason).toMatch(/could not be read \(ETIMEOUT\)/)
  })

  it('Gmail changed the From to the account: refused, with what to do', async () => {
    probeAnswer = { deliveredFrom: 'dtlpmanikandan@gmail.com' }
    const c = await checkSender('sales@example.org', SYSTEM, NOW)
    expect(probeCalls).toEqual(['sales@example.org'])
    expect(c.authorized).toBe(false)
    expect(c.reason).toMatch(/changed the From to dtlpmanikandan@gmail.com/)
    expect(c.reason).toMatch(/Send mail as/)
  })

  it('Gmail kept the From (a verified "Send mail as" address): yes', async () => {
    probeAnswer = { deliveredFrom: 'sales@example.org' }
    const c = await checkSender('sales@example.org', SYSTEM, NOW)
    expect(c).toMatchObject({ authorized: true, method: 'gmail_send_as' })
    expect(c.warning).toMatch(/via gmail.com/)
  })

  it('refuses when the check message cannot be read back', async () => {
    probeAnswer = { error: 'the mailbox could not be read over IMAP (Invalid credentials)' }
    const c = await checkSender('sales@example.org', SYSTEM, NOW)
    expect(c.authorized).toBe(false)
    expect(c.reason).toMatch(/could not complete/)
  })

  it('another mail server: only the account’s own address can be the From', async () => {
    const c = await checkSender('sales@altiusnxt.test', { ...SYSTEM, host: 'smtp.example.test', user: 'manoj@altiusnxt.test' }, NOW)
    expect(c.authorized).toBe(false)
    expect(c.reason).toMatch(/cannot be checked automatically/)
  })

  it('reads DMARC policies', () => {
    expect(parseDmarc([['v=DMARC1; p=reject; rua=mailto:admin@altiussolution.com; pct=100; adkim=s; aspf=s']], false)).toEqual({ policy: 'reject', error: null })
    expect(parseDmarc([['v=DMARC1; p=quarantine; pct=0']], false)).toEqual({ policy: 'none', error: null })
    expect(parseDmarc([['v=DMARC1; p=none; sp=reject']], true)).toEqual({ policy: 'reject', error: null })
    expect(parseDmarc([['v=spf1 include:_spf.google.com ~all']], false)).toBeNull()
  })

  it('uses the system SMTP account when no bulk account is configured', () => {
    Object.assign(env, { BULK_SMTP_HOST: '', BULK_SMTP_USER: '', BULK_SMTP_PASS: '', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'dtlpmanikandan@gmail.com', SMTP_PASS: 'x' })
    expect(bulkTransportAccount()).toMatchObject({ user: 'dtlpmanikandan@gmail.com', source: 'system' })
  })

  it('the customer sees the chosen From; replies and unsubscribes go to it; the envelope is the account’s', () => {
    const o = bulkMailOptions(SYSTEM, { fromEmail: 'sales@example.org', fromName: null, to: 'buyer@acme.test', cc: ['cc@acme.test'], subject: 'S', text: 't', html: 'h' })
    expect(o).toMatchObject({ from: 'sales@example.org', replyTo: 'sales@example.org', to: 'buyer@acme.test', cc: ['cc@acme.test'] })
    expect(o.headers['List-Unsubscribe']).toBe('<mailto:sales@example.org?subject=unsubscribe>')
    expect(o.envelope).toEqual({ from: 'dtlpmanikandan@gmail.com', to: ['buyer@acme.test', 'cc@acme.test'] })
    expect(JSON.stringify({ from: o.from, replyTo: o.replyTo, headers: o.headers })).not.toMatch(/dtlpmanikandan|Manikandan/i)
  })
})

describe('the sender on a bulk send: From, CC and signature', () => {
  const setup = async () => ({
    fileBase64: await xlsx([HEADER, ['Thermohvac', 'u', 'Maddie Stellick', 'Owner', 'mstellick@thermohvac.com', 'Mike Murray', 'GM', 'mmurray@thermohvac.com', ''], ['Babsco', 'u', 'Steve Kile', 'Owner', 'skile@babsco.com', '', '', '', '']]),
    fileName: 'leads.xlsx',
    templateKey: 'static_site_v1',
    startDate: '2026-10-10',
    startTime: '10:00',
    intervalMinutes: 5,
  })
  const BEFORE = new Date('2026-10-09T12:00:00Z')
  const at = (hhmm: string) => istToUtc('2026-10-10', hhmm)!
  const GMAIL_SYSTEM = { BULK_SMTP_HOST: '', BULK_SMTP_USER: '', BULK_SMTP_PASS: '', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'dtlpmanikandan@gmail.com', SMTP_PASS: 'x' }

  it('the email carries the CC on every email and the signature under the approved text, sent from the chosen From', async () => {
    Object.assign(env, GMAIL_SYSTEM)
    probeAnswer = { deliveredFrom: 'sales@example.org' }
    const view = await setSender({ fromEmail: 'sales@example.org', ccEmails: ['team@example.org'], signature: 'Manoj\nAltiusNxt' })
    expect(view).toMatchObject({ fromEmail: 'sales@example.org', authorized: true, problem: null, account: { email: 'dtlpmanikandan@gmail.com', source: 'system' } })

    const r = await svc.reviewBulk(actor, await setup(), BEFORE)
    const thermo = r.rows.find((x) => x.companyName === 'Thermohvac')!
    expect(thermo.ccEmails).toEqual(['mmurray@thermohvac.com', 'team@example.org'])
    expect(thermo.text!.endsWith('Would you like me to send it?\n\nManoj\nAltiusNxt')).toBe(true)

    const sent: Array<{ from: string; cc: string[]; text: string; html: string }> = []
    setBulkSenderForTests({ send: async (e) => (sent.push({ from: e.fromEmail, cc: e.cc, text: e.text, html: e.html }), { messageId: 'm' }) })
    await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    expect(store.bulkEmailCampaign![0]).toMatchObject({ fromEmail: 'sales@example.org', ccEmails: ['team@example.org'], signature: 'Manoj\nAltiusNxt' })
    await svc.dispatchBulkEmails(at('10:00'))
    expect(sent[0]).toMatchObject({ from: 'sales@example.org', cc: ['mmurray@thermohvac.com', 'team@example.org'] })
    expect(sent[0]!.text.endsWith('\n\nManoj\nAltiusNxt')).toBe(true)
    expect(sent[0]!.html).toContain('<p style="margin:0 0 12px">Manoj<br>AltiusNxt</p>')
  })

  it('cannot even start from sales@altiusnxt.com through the gmail.com system account', async () => {
    Object.assign(env, GMAIL_SYSTEM)
    dmarcAnswer = { policy: 'reject', error: null }
    const view = await setSender({ fromEmail: 'sales@altiusnxt.com' })
    expect(view.authorized).toBe(false)
    expect(view.problem).toMatch(/DMARC policy of "reject"/)
    await expect(svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)).rejects.toThrow(/Not started — sales@altiusnxt.com is not authorized/)
    expect(store.bulkEmailCampaign).toHaveLength(0)
  })

  it('pauses — and sends nothing — when the From stops being authorized during a send', async () => {
    Object.assign(env, GMAIL_SYSTEM)
    probeAnswer = { deliveredFrom: 'sales@example.org' }
    await setSender({ fromEmail: 'sales@example.org' })
    const sent: string[] = []
    setBulkSenderForTests({ send: async (e) => (sent.push(e.to), { messageId: 'm' }) })
    const { campaignId } = await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)

    // A day later the check is made again — and the "Send mail as" address is gone.
    probeAnswer = { deliveredFrom: 'dtlpmanikandan@gmail.com' }
    await svc.dispatchBulkEmails(new Date(at('10:00').getTime() + 26 * 3_600_000))
    expect(sent).toEqual([])
    const view = await svc.bulkView('t1', campaignId)
    expect(view.campaign.status).toBe('paused')
    expect(view.campaign.statusReason).toMatch(/not authorized.*changed the From to dtlpmanikandan@gmail.com/)
    expect(view.counts.scheduled).toBe(2)
    await expect(svc.setBulkState(actor, campaignId, 'resume')).rejects.toThrow(/Not resumed/)
  })

  it('pauses when the server’s sending account changes, until the From is checked with the new one', async () => {
    await setSender()
    const sent: string[] = []
    setBulkSenderForTests({ send: async (e) => (sent.push(e.to), { messageId: 'm' }) })
    const { campaignId } = await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    Object.assign(env, { BULK_SMTP_USER: 'other@altiusnxt.test' })
    await svc.dispatchBulkEmails(at('10:00'))
    expect(sent).toEqual([])
    expect((await svc.bulkView('t1', campaignId)).campaign.status).toBe('paused')
  })

  it('rejects an invalid From or CC address', async () => {
    await expect(setSender({ fromEmail: 'not an email' })).rejects.toThrow(/not a valid From email/)
    await expect(setSender({ ccEmails: ['ok@example.org', 'bad address'] })).rejects.toThrow(/CC "bad address"/)
  })
})

// BULK EMAIL IS A STANDALONE WORKFLOW (2026-10-07): it shares no code with
// the One company or Several companies flows. Only the opt-out list is shared,
// on purpose — an unsubscribe must hold everywhere.
describe('a standalone workflow', () => {
  it('imports nothing from the sales sequence or the several-companies code', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const dir = 'src/outreach/bulk'
    for (const f of readdirSync(dir)) {
      const src = readFileSync(`${dir}/${f}`, 'utf8')
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!)
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/salesSequence|batches|outreach\/engine/)
    }
  })
})
