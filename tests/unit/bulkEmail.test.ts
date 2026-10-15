import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

// BULK EMAIL (2026-10-08) — simple and standalone.
//
// The approved static template and nothing else, with only [First Name] and
// [Company Name] filled. One email per company: the first named person
// receives it and colleagues are copied; only work addresses are used; rows
// whose Status contains "Outreach" are skipped. Date, time (IST) and
// minutes between emails: 10:00, 10:05, 10:10 … until the list is done. The
// sender sends ONE at a time, a failure does not stop the rest, and the send
// completes.

// ── An in-memory store ─────────────────────────────────────────────────────
type Row = Record<string, unknown>
const store: Record<string, Row[]> = {}
const reset = () => {
  for (const k of ['bulkEmailCampaign', 'bulkEmailRecipient', 'bulkAttachment', 'suppressionEntry', 'auditEvent']) store[k] = []
  store.tenant = [{ id: 't1', settings: null }]
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w))
    if (v === null) return row[k] == null
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const o = v as Row
      if ('in' in o) return (o.in as unknown[]).includes(row[k])
      if ('not' in o) return o.not === null ? row[k] != null : row[k] !== o.not
      if ('lte' in o) return row[k] != null && (row[k] as Date) <= (o.lte as Date)
      if ('lt' in o) return row[k] != null && (row[k] as Date) < (o.lt as Date)
      if ('gt' in o) return row[k] != null && (row[k] as Date) > (o.gt as Date)
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
/** Writes data into a row; { increment: n } adds, as the database does. */
function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && 'increment' in (v as Row)) row[k] = ((row[k] as number) ?? 0) + ((v as Row).increment as number)
    else row[k] = v
  }
  row.updatedAt = new Date()
}
const model = (table: string) => ({
  findUnique: vi.fn(async (a: Row = {}) => store[table]!.find((x) => matches(x, a.where as Row)) ?? null),
  findFirst: vi.fn(async (a: Row = {}) => sortBy(store[table]!.filter((x) => matches(x, a.where as Row)), a.orderBy as Row)[0] ?? null),
  findMany: vi.fn(async (a: Row = {}) => sortBy(store[table]!.filter((x) => matches(x, a.where as Row)), a.orderBy as Row)),
  count: vi.fn(async (a: Row = {}) => store[table]!.filter((x) => matches(x, a.where as Row)).length),
  create: vi.fn(async ({ data }: { data: Row }) => {
    const row = { createdAt: new Date(), updatedAt: new Date(), ...(table === 'bulkEmailRecipient' ? { openCount: 0 } : {}), ...data }
    store[table]!.push(row)
    return row
  }),
  createMany: vi.fn(async ({ data }: { data: Row[] }) => {
    // Column defaults, as the database applies them.
    data.forEach((d) => store[table]!.push({ createdAt: new Date(), updatedAt: new Date(), ...(table === 'bulkEmailRecipient' ? { openCount: 0 } : {}), ...d }))
    return { count: data.length }
  }),
  update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const row = store[table]!.find((x) => matches(x, where))!
    apply(row, data)
    return row
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const rows = store[table]!.filter((x) => matches(x, where))
    rows.forEach((r) => apply(r, data))
    return { count: rows.length }
  }),
  deleteMany: vi.fn(async ({ where }: { where: Row }) => {
    const before = store[table]!.length
    store[table] = store[table]!.filter((x) => !matches(x, where))
    return { count: before - store[table]!.length }
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
  // NXT Sales: sending through it is off unless a test switches it on.
  BULK_SEND_VIA: 'smtp',
  NXT_SALES_BASE_URL: 'http://localhost:4000',
  NXT_SALES_MAX_CONCURRENCY: 2,
  NXT_SALES_TIMEOUT_MS: 1000,
  // Open tracking: off unless a test switches it on.
  NODE_ENV: 'production',
  BULK_OPEN_TRACKING_ENABLED: false,
  BULK_OPEN_TRACKING_BASE_URL: '',
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

const { composeBulkEmail, STATIC_SITE, STATIC_SITE_V2, STATIC_SITE_V3, SIGNATURE_GAP } = await import('../../src/outreach/bulk/template.js')
const { extractContacts, workAddress, firstNameOf, recipientsOf } = await import('../../src/outreach/bulk/extract.js')
const { istToUtc, planSequential, fmtIst } = await import('../../src/outreach/bulk/schedule.js')
const svc = await import('../../src/outreach/bulk/service.js')
const { setBulkSenderForTests, bulkTransportAccount, bulkMailOptions } = await import('../../src/outreach/bulk/transport.js')
const { checkSender, parseDmarc, setSenderCheckDepsForTests } = await import('../../src/outreach/bulk/senders.js')
const { cleanSignatureHtml, inlineImages } = await import('../../src/outreach/bulk/signature.js')
const tracking = await import('../../src/outreach/bulk/tracking.js')
const { bulkOpenTrackingRoutes } = await import('../../src/api/routes/bulkOpenTracking.routes.js')
const crmSend = await import('../../src/outreach/bulk/crmSend.js')

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
  Object.assign(env, BULK_ACCOUNT, { SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', NODE_ENV: 'production', BULK_OPEN_TRACKING_ENABLED: false, BULK_OPEN_TRACKING_BASE_URL: '' })
  tracking.setTrackingProbeForTests(async () => true)
  crmSend.setCrmBulkForTests(null)
  svc.resetCrmSyncForTests()
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
const setSender = (over: Partial<{ fromEmail: string; ccEmails: string[]; signatureHtml: string }> = {}) =>
  svc.saveBulkSender(actor, { fromEmail: 'manoj@altiusnxt.test', ccEmails: [], signatureHtml: '', ...over }, new Date('2026-10-09T11:00:00Z'))

// A signature as Gmail puts it on the clipboard: a table, a logo, styles, links.
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const GMAIL_SIG = [
  '<div dir="ltr"><table cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tbody><tr>',
  '<td style="padding-right:15px;vertical-align:top"><span style="color:#555555;font-size:16px">Best Regards,</span><br /><img src="' + LOGO + '" width="200" height="60" alt="AltiusNxt" /></td>',
  '<td style="border-left:1px solid #555555;padding-left:15px;color:#333333"><b>Manoj S</b><br />Digital Commerce Lead<br /><br />',
  'm: <a href="tel:+13134869697">+13134869697</a><br />e: <a href="mailto:Manoj@altiusnxt.com">Manoj@altiusnxt.com</a><br />w:<a href="http://www.altiusnxt.com" target="_blank">www.altiusnxt.com</a></td>',
  '</tr></tbody></table></div>',
].join('')

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

  it('skips a company only when its Status contains "Outreach" — any other Status is processed', () => {
    const x = extractContacts([
      HEADER,
      ['Progressive power', 'u', 'hank Rossman', 'President', 'Primary: hank@progressivepower.net', '', '', '', 'They said not interested'],
      ['First Electric Supply', 'u', 'Ed Droeger', 'President', 'edd@firstelectricsupply.com', '', '', '', 'Outreach - 06/10/2026'],
      ['Armour Screw', 'u', 'Jeff', 'Owner', 'jeff@armourscrew.com', '', '', '', ''],
    ])
    expect(x.companies.map((c) => c.skip?.split(' (')[0] ?? null)).toEqual([null, 'Already contacted', null])
    const y = extractContacts([
      HEADER,
      ['A Co', 'u', 'Ann Lee', 'Owner', 'ann@aco.test', '', '', '', 'Do not contact'],
      ['B Co', 'u', 'Bob Ray', 'Owner', 'bob@bco.test', '', '', '', 'OUTREACH done'],
      ['C Co', 'u', 'Cy Fox', 'Owner', 'cy@cco.test', '', '', '', 'Follow up next week'],
    ])
    expect(y.companies.map((c) => [c.companyName, c.skip?.split(' (')[0] ?? null])).toEqual([['A Co', null], ['B Co', 'Already contacted'], ['C Co', null]])
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
      ['Progressive power', 'u', 'hank Rossman', 'President', 'hank@progressivepower.net', '', '', '', 'Outreach - 06/10/2026'],
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

describe('this platform\'s own mailbox (SMTP) is unchanged by the NXT Sales guards', () => {
  it('an SMTP email that failed does not block that address; nothing NXT Sales-related applies', async () => {
    await setSender()
    const list = async () => ({
      fileBase64: await xlsx([HEADER, ['Alpha Co', 'u', 'Ann Lee', 'Owner', 'ann@alpha.test', '', '', '', ''], ['Bravo Co', 'u', 'Bob Ray', 'Owner', 'bob@bravo.test', '', '', '', '']]),
      fileName: 'two.xlsx',
      templateKey: 'static_site_v1',
      startDate: '2026-10-10',
      startTime: '10:00',
      intervalMinutes: 1,
    })
    setBulkSenderForTests({
      send: async (e) => {
        if (e.to === 'ann@alpha.test') throw new Error('421 try again later')
        return { messageId: 'm' }
      },
    })
    await svc.startBulk(actor, { ...(await list()), confirm: true }, new Date('2026-10-09T12:00:00Z'))
    for (const t of ['10:00', '10:01', '10:02']) await svc.dispatchBulkEmails(istToUtc('2026-10-10', t)!)
    expect(store.bulkEmailRecipient!.find((r) => r.toEmail === 'ann@alpha.test')).toMatchObject({ status: 'failed' })
    expect(store.bulkEmailRecipient!.every((r) => r.crmSendKey === undefined && r.crmAttemptedAt === undefined)).toBe(true)
    const r = await svc.reviewBulk(actor, await list(), new Date('2026-10-11T12:00:00Z'))
    expect(r.rows.find((x) => x.toEmail === 'ann@alpha.test')!.status).toBe('ready')
    expect(r.rows.find((x) => x.toEmail === 'bob@bravo.test')!.reason).toMatch(/^Already emailed by a bulk send on/)
    expect((await svc.reviewSingle(actor, { firstName: 'Ann', companyName: 'Alpha Co', toEmail: 'ann@alpha.test', ccEmails: [], templateKey: 'static_site_v1' })).blocked).toBeNull()
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
    const view = await setSender({ fromEmail: 'sales@example.org', ccEmails: ['team@example.org'], signatureHtml: GMAIL_SIG })
    expect(view).toMatchObject({ fromEmail: 'sales@example.org', authorized: true, problem: null, account: { email: 'dtlpmanikandan@gmail.com', source: 'system' } })

    const r = await svc.reviewBulk(actor, await setup(), BEFORE)
    const thermo = r.rows.find((x) => x.companyName === 'Thermohvac')!
    expect(thermo.ccEmails).toEqual(['mmurray@thermohvac.com', 'team@example.org'])
    expect(thermo.text!.endsWith('Would you like me to send it?\n\nBest Regards,\nAltiusNxt\nManoj S\nDigital Commerce Lead\n\nm: +13134869697\ne: Manoj@altiusnxt.com\nw:www.altiusnxt.com')).toBe(true)
    // The pasted signature, unchanged, under the approved text.
    expect(thermo.html).toContain(GMAIL_SIG)

    const sent: Array<{ from: string; cc: string[]; text: string; html: string }> = []
    setBulkSenderForTests({ send: async (e) => (sent.push({ from: e.fromEmail, cc: e.cc, text: e.text, html: e.html }), { messageId: 'm' }) })
    await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    expect(store.bulkEmailCampaign![0]).toMatchObject({ fromEmail: 'sales@example.org', ccEmails: ['team@example.org'], signatureHtml: GMAIL_SIG })
    await svc.dispatchBulkEmails(at('10:00'))
    expect(sent[0]).toMatchObject({ from: 'sales@example.org', cc: ['mmurray@thermohvac.com', 'team@example.org'] })
    expect(sent[0]!.text.endsWith('w:www.altiusnxt.com')).toBe(true)
    expect(sent[0]!.html).toContain(GMAIL_SIG)
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

  it('a plain-text signature saved earlier still goes, line by line', async () => {
    const r = await composeBulkEmail({ template: STATIC_SITE, firstName: 'Ed', companyName: 'X', signature: 'Manoj\nAltiusNxt' })
    expect(r.text.endsWith('\n\nManoj\nAltiusNxt')).toBe(true)
    expect(r.html).toContain('<p style="margin:0 0 12px">Manoj<br>AltiusNxt</p>')
  })

  it('rejects an invalid From or CC address', async () => {
    await expect(setSender({ fromEmail: 'not an email' })).rejects.toThrow(/not a valid From email/)
    await expect(setSender({ ccEmails: ['ok@example.org', 'bad address'] })).rejects.toThrow(/CC "bad address"/)
  })
})

// THE SIGNATURE AS PASTED (2026-10-08): kept exactly — only what could run
// code, or cannot travel in an email, is taken out, and the screen says what.
describe('the signature, exactly as pasted', () => {
  it('keeps a Gmail signature whole: table, styles, logo, links', () => {
    const c = cleanSignatureHtml(GMAIL_SIG)
    expect(c.html).toBe(GMAIL_SIG)
    expect(c.removed).toEqual([])
    expect(c.text.split('\n')[0]).toBe('Best Regards,')
  })

  it('keeps a logo hosted on the web as it is', () => {
    const html = '<p>Thanks</p><img src="https://ci3.googleusercontent.com/mail-sig/AIorK4x" width="200" />'
    expect(cleanSignatureHtml(html).html).toBe(html)
  })

  it('takes out only what could run code — and says so', () => {
    const c = cleanSignatureHtml(
      '<p onclick="steal()">Manoj</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><td style="color:#333;background:url(javascript:alert(1))">S</td><img src="https://x.test/a.png" onerror="alert(1)" />',
    )
    expect(c.html).not.toMatch(/onclick|script|javascript|onerror|alert/i)
    expect(c.html).toContain('<p>Manoj</p>')
    expect(c.html).toContain('<img src="https://x.test/a.png" />')
    expect(c.html).toContain('style="color:#333"')
    expect(c.removed).toContain('scripts and active content')
  })

  it('cannot send an image that is on the computer, not the web — and says so', () => {
    const c = cleanSignatureHtml('<p>Manoj</p><img src="file:///C:/Users/m/logo.png" />')
    expect(c.html).toBe('<p>Manoj</p>')
    expect(c.removed.join(' ')).toMatch(/not on the web/)
  })

  it('embedded images travel inside the email as inline attachments', () => {
    const i = inlineImages(`<div>${GMAIL_SIG}</div>`)
    expect(i.html).not.toContain('data:image')
    expect(i.html).toContain('src="cid:sig1@altius-bulk"')
    expect(i.attachments).toHaveLength(1)
    expect(i.attachments[0]).toMatchObject({ cid: 'sig1@altius-bulk', contentType: 'image/png', contentDisposition: 'inline' })
    expect(i.attachments[0]!.content.subarray(1, 4).toString()).toBe('PNG')
    const o = bulkMailOptions({ host: 'smtp.gmail.com', port: 587, secure: false, user: 'manoj@altiusnxt.com', pass: 'x', source: 'bulk' }, { fromEmail: 'manoj@altiusnxt.com', fromName: null, to: 'a@b.test', cc: [], subject: 's', text: 't', html: `<div>${GMAIL_SIG}</div>` })
    expect(o.attachments).toHaveLength(1)
    expect(o.html).toContain('cid:sig1@altius-bulk')
  })
})

// VERSIONS 1, 2 AND 3 IN ROTATION (2026-10-08): the approved texts, word for
// word; only which version a person gets is chosen.
describe('approved Versions 1, 2 and 3, in rotation', () => {
  it('Version 2 and Version 3 are the approved texts, word for word', () => {
    expect(STATIC_SITE_V2.subject).toBe('What AI LLMs say about [Company Name]')
    expect(STATIC_SITE_V2.body.split('\n')).toEqual([
      '[First Name],',
      'This is Manoj from AltiusNxt.',
      "I asked ChatGPT, Gemini, Claude and Perplexity which suppliers they would recommend for your product category. You didn't come up as a recommended supplier.",
      "One likely reason: your range and services are described well on your site, but there are no pages for individual parts with specs and datasheets. That leaves AI tools with little to quote, so buyers end up on competitors' listings.",
      'We fix this for distributors with an online parts catalog, part-level Request-a-Quote and product details built from manufacturer sources. Our clients include Vallen, Travers Tool Co and Rubix Group, and we have worked in this area for 20+ years.',
      'We are also attending B2B eCommerce World in Indianapolis on Nov 2-3, and you are welcome to join us as our guest - register here with code ALTIUSVIP.',
      'I put together a short report on what the AI tools returned for you. Shall I send it over?',
    ])
    expect(STATIC_SITE_V3.subject).toBe('Quick note on AI search for [Company Name]')
    expect(STATIC_SITE_V3.body.split('\n')).toEqual([
      '[First Name],',
      'Manoj from AltiusNxt here.',
      "I asked ChatGPT, Gemini, Claude and Perplexity which suppliers they would recommend for your product category. You didn't come up as a recommended supplier.",
      "My guess is that your website talks about your strengths, but each part doesn't have its own page with details like specs and datasheets. Without these, AI tools have little to point to, and buyers go to other suppliers.",
      'For 20+ years we have helped distributors, including Vallen, Travers Tool Co and Rubix Group, with an online parts catalog, part-level Request-a-Quote and well-structured product data.',
      'If you will be in Indianapolis on Nov 2-3 for B2B eCommerce World, we would be glad to host you as our guest - register here with the code ALTIUSVIP.',
      'I can send you a short report on what each AI tool returned. Just let me know, and I will send it over.',
    ])
    // Version 1 is unchanged.
    expect(STATIC_SITE.subject).toBe('Are AI tools recommending [Company Name]?')
    expect(STATIC_SITE.body.split('\n')[1]).toBe('Manoj here, from AltiusNxt.')
  })

  it('person 1 → V1, 2 → V2, 3 → V3, 4 → V1 … skipped rows take no turn; each is sent its own version', async () => {
    const people = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']
    const fileBase64 = await xlsx([
      HEADER,
      ...people.slice(0, 2).map((p) => [`${p} Co`, 'u', `${p} Smith`, 'Owner', `${p.toLowerCase()}@${p.toLowerCase()}.test`, '', '', '', '']),
      ['Skipped Co', 'u', 'Sam Skip', 'Owner', 'sam@skipped.test', '', '', '', 'Outreach - 06/10/2026'],
      ...people.slice(2).map((p) => [`${p} Co`, 'u', `${p} Smith`, 'Owner', `${p.toLowerCase()}@${p.toLowerCase()}.test`, '', '', '', '']),
    ])
    const setup = { fileBase64, fileName: 'five.xlsx', templateKey: 'static_site_v1', startDate: '2026-10-10', startTime: '10:00', intervalMinutes: 5 }
    const r = await svc.reviewBulk(actor, setup, new Date('2026-10-09T12:00:00Z'))
    const ready = r.rows.filter((x) => x.status === 'ready')
    expect(ready.map((x) => [x.companyName, x.version])).toEqual([['Alpha Co', 1], ['Bravo Co', 2], ['Charlie Co', 3], ['Delta Co', 1], ['Echo Co', 2]])
    expect(ready[0]!.subject).toBe('Are AI tools recommending Alpha Co?')
    expect(ready[1]!.subject).toBe('What AI LLMs say about Bravo Co')
    expect(ready[1]!.text!.startsWith('Bravo,\n\nThis is Manoj from AltiusNxt.')).toBe(true)
    expect(ready[2]!.subject).toBe('Quick note on AI search for Charlie Co')
    expect(ready[2]!.text!.startsWith('Charlie,\n\nManoj from AltiusNxt here.')).toBe(true)

    await setSender()
    const sent: Array<{ to: string; subject: string; text: string }> = []
    setBulkSenderForTests({ send: async (e) => (sent.push({ to: e.to, subject: e.subject, text: e.text }), { messageId: 'm' }) })
    await svc.startBulk(actor, { ...setup, confirm: true }, new Date('2026-10-09T12:00:00Z'))
    for (const t of ['10:00', '10:05', '10:10']) await svc.dispatchBulkEmails(istToUtc('2026-10-10', t)!)
    expect(sent.map((x) => x.subject)).toEqual(['Are AI tools recommending Alpha Co?', 'What AI LLMs say about Bravo Co', 'Quick note on AI search for Charlie Co'])
    expect(sent[2]!.text.endsWith('Just let me know, and I will send it over.')).toBe(true)
  })

  it('a blank line separates the email from the signature', () => {
    const e = composeBulkEmail({ template: STATIC_SITE_V2, firstName: 'Ed', companyName: 'X', signature: 'Best Regards,\nManoj S', signatureHtml: '<div>Best Regards,<br />Manoj S</div>' })
    expect(e.text).toContain('Shall I send it over?\n\nBest Regards,')
    expect(e.html).toContain(`Shall I send it over?</p>${SIGNATURE_GAP}<div><div>Best Regards,`)
    // No signature: no extra line.
    expect(composeBulkEmail({ template: STATIC_SITE, firstName: 'Ed', companyName: 'X' }).html).not.toContain(SIGNATURE_GAP)
  })
})

// ONE PERSON, WITHOUT AN EXCEL FILE (2026-10-08).
describe('send to one person', () => {
  const one = { firstName: 'Priya', companyName: 'Acme Supply', toEmail: 'priya@acme.test', ccEmails: [], templateKey: 'static_site_v2' }

  it('reviews the chosen version with only the name and company filled — and writes nothing', async () => {
    await setSender({ ccEmails: ['team@altiusnxt.test'] })
    const r = await svc.reviewSingle(actor, one)
    expect(r).toMatchObject({ toEmail: 'priya@acme.test', ccEmails: ['team@altiusnxt.test'], version: 2, subject: 'What AI LLMs say about Acme Supply', blocked: null })
    expect(r.text.startsWith('Priya,\n\nThis is Manoj from AltiusNxt.')).toBe(true)
    expect(store.bulkEmailCampaign).toHaveLength(0)
  })

  it('sends it within a minute of approval, from the checked sender', async () => {
    await setSender()
    const sent: Array<{ to: string; from: string; subject: string }> = []
    setBulkSenderForTests({ send: async (e) => (sent.push({ to: e.to, from: e.fromEmail, subject: e.subject }), { messageId: 'm' }) })
    const now = new Date('2026-10-09T12:00:00Z')
    await expect(svc.startSingle(actor, { ...one, confirm: false }, now)).rejects.toThrow(/Tick the confirmation/)
    const { campaignId } = await svc.startSingle(actor, { ...one, confirm: true }, now)
    await svc.dispatchBulkEmails(new Date(now.getTime() + 60_000))
    expect(sent).toEqual([{ to: 'priya@acme.test', from: 'manoj@altiusnxt.test', subject: 'What AI LLMs say about Acme Supply' }])
    const view = await svc.bulkView('t1', campaignId)
    expect(view.campaign.status).toBe('completed')
    expect(view.recipients[0]).toMatchObject({ status: 'sent', version: 2 })
  })

  it('will not send to someone who opted out, or with no From set', async () => {
    await expect(svc.startSingle(actor, { ...one, confirm: true })).rejects.toThrow(/Set the From email/)
    await setSender()
    suppressed.add('priya@acme.test')
    expect((await svc.reviewSingle(actor, one)).blocked).toMatch(/opt-out list/)
    await expect(svc.startSingle(actor, { ...one, confirm: true })).rejects.toThrow(/Not sent — priya@acme.test is on the opt-out list/)
  })

  it('needs a valid address, a first name, a company and a version', async () => {
    await expect(svc.reviewSingle(actor, { ...one, toEmail: 'not an email' })).rejects.toThrow(/not a valid email address/)
    await expect(svc.reviewSingle(actor, { ...one, firstName: ' ' })).rejects.toThrow(/first name/)
    await expect(svc.reviewSingle(actor, { ...one, companyName: '' })).rejects.toThrow(/company name/)
    await expect(svc.reviewSingle(actor, { ...one, templateKey: 'x' })).rejects.toThrow(/Version 1, 2 or 3/)
  })
})

// EMAIL OPEN TRACKING (2026-10-09): one invisible image per email, with its
// own random token; counted for that email only; never reported as working
// when there is no verified HTTPS address or no pixel; never in the way of
// sending.
describe('email open tracking', () => {
  const BASE = 'https://track.example.test'
  const on = () => Object.assign(env, { BULK_OPEN_TRACKING_ENABLED: true, BULK_OPEN_TRACKING_BASE_URL: BASE })
  const LIST = async () => ({
    fileBase64: await xlsx([
      HEADER,
      ['Alpha Co', 'u', 'Ann Lee', 'Owner', 'ann@alpha.test', '', '', '', ''],
      ['Bravo Co', 'u', 'Bob Ray', 'Owner', 'bob@bravo.test', '', '', '', ''],
      ['Charlie Co', 'u', 'Cy Fox', 'Owner', 'cy@charlie.test', '', '', '', ''],
    ]),
    fileName: 'three.xlsx',
    templateKey: 'static_site_v1',
    startDate: '2026-10-10',
    startTime: '10:00',
    intervalMinutes: 5,
  })
  const BEFORE = new Date('2026-10-09T12:00:00Z')
  const at = (hhmm: string) => istToUtc('2026-10-10', hhmm)!
  const tokenIn = (html: string) => /bulk-open\/([A-Za-z0-9_-]{43})\.gif/.exec(html)?.[1] ?? null

  async function sendAll(capture: Array<{ to: string; html: string; text: string }>) {
    setBulkSenderForTests({ send: async (e) => (capture.push({ to: e.to, html: e.html, text: e.text }), { messageId: 'm' }) })
    await setSender()
    const { campaignId } = await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    for (const t of ['10:00', '10:05', '10:10']) await svc.dispatchBulkEmails(at(t))
    return campaignId
  }
  const row = (to: string) => store.bulkEmailRecipient!.find((r) => r.toEmail === to)!

  it('each email carries its own random token, as an invisible image at the end of the HTML only', async () => {
    on()
    const sent: Array<{ to: string; html: string; text: string }> = []
    await sendAll(sent)
    const tokens = sent.map((e) => tokenIn(e.html))
    expect(tokens.every((t) => t && tracking.isTrackingToken(t))).toBe(true)
    expect(new Set(tokens).size).toBe(3)
    // The pixel is the only addition: the approved HTML is intact before it; the text part has none.
    const first = sent[0]!
    const reviewed = svc_reviewedHtml(first.html)
    expect(first.html).toBe(tracking.addPixel(reviewed, `${BASE}/api/v1/bulk-open/${tokens[0]}.gif`))
    expect(first.html).toMatch(/<img src="https:\/\/track\.example\.test\/api\/v1\/bulk-open\/[A-Za-z0-9_-]{43}\.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;opacity:0" \/><\/div>$/)
    expect(first.text).not.toMatch(/bulk-open|track\.example/)
    // The address says nothing about the person; only the token's hash is stored.
    expect(first.html.match(/bulk-open\/[^"]+/)![0]).not.toMatch(/ann|alpha|@/i)
    expect(row('ann@alpha.test').trackingTokenHash).toBe(tracking.hashToken(tokens[0]!))
    expect(JSON.stringify(store.bulkEmailRecipient)).not.toContain(tokens[0]!)
    expect(row('ann@alpha.test')).toMatchObject({ trackingEnabled: true, trackingNote: null })
  })

  it('an image request counts for that one email — first, last and how many', async () => {
    on()
    const sent: Array<{ to: string; html: string; text: string }> = []
    const campaignId = await sendAll(sent)
    const bob = tokenIn(sent.find((e) => e.to === 'bob@bravo.test')!.html)!
    const t1 = new Date('2026-10-10T06:00:00Z')
    const t2 = new Date('2026-10-10T07:30:00Z')
    expect(await tracking.recordOpen(bob, t1)).toBe(true)
    expect(await tracking.recordOpen(bob, new Date('2026-10-10T06:30:00Z'))).toBe(true)
    expect(await tracking.recordOpen(bob, t2)).toBe(true)
    expect(row('bob@bravo.test')).toMatchObject({ openCount: 3, firstOpenedAt: t1, lastOpenedAt: t2 })
    expect(row('ann@alpha.test')).toMatchObject({ openCount: 0 })
    expect(row('ann@alpha.test').firstOpenedAt).toBeUndefined()

    const view = await svc.bulkView('t1', campaignId)
    expect(view.counts.opens).toEqual({ sent: 3, openDetected: 1, noOpenDetected: 2, trackingUnavailable: 0 })
    const b = view.recipients.find((r) => r.toEmail === 'bob@bravo.test')!
    expect(b.tracking).toEqual({ status: 'open_detected', note: null, openCount: 3, firstOpenedLocal: 'Sat, Oct 10, 2026, 11:30 AM IST', lastOpenedLocal: 'Sat, Oct 10, 2026, 1:00 PM IST' })
    expect(view.recipients.find((r) => r.toEmail === 'ann@alpha.test')!.tracking).toMatchObject({ status: 'no_open_detected', openCount: 0 })
  })

  it('requests at once all count, and first open is set once', async () => {
    on()
    const sent: Array<{ to: string; html: string; text: string }> = []
    await sendAll(sent)
    const cy = tokenIn(sent.find((e) => e.to === 'cy@charlie.test')!.html)!
    const times = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 9, 10, 8, 0, i)))
    const results = await Promise.all(times.map((t) => tracking.recordOpen(cy, t)))
    expect(results.every(Boolean)).toBe(true)
    expect(row('cy@charlie.test')).toMatchObject({ openCount: 20, firstOpenedAt: times[0] })
    expect(row('ann@alpha.test').openCount).toBe(0)
    expect(row('bob@bravo.test').openCount).toBe(0)
  })

  it('a wrong, malformed or made-up token records nothing', async () => {
    on()
    const sent: Array<{ to: string; html: string; text: string }> = []
    await sendAll(sent)
    const real = tokenIn(sent[0]!.html)!
    const altered = `${real.slice(0, 42)}${real.endsWith('A') ? 'B' : 'A'}`
    for (const bad of ['', 'x', 'ann@alpha.test', tracking.newTrackingToken(), altered, '../../etc/passwd']) {
      expect(await tracking.recordOpen(bad)).toBe(false)
    }
    expect(store.bulkEmailRecipient!.every((r) => !r.openCount)).toBe(true)
  })

  it('the public endpoint answers every request with the same image, no-cache, and reveals nothing', async () => {
    on()
    const sent: Array<{ to: string; html: string; text: string }> = []
    await sendAll(sent)
    const express = (await import('express')).default
    const app = express()
    app.use(bulkOpenTrackingRoutes)
    const server = app.listen(0)
    try {
      const port = (server.address() as { port: number }).port
      const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`)
      const good = await get(`/api/v1/bulk-open/${tokenIn(sent[0]!.html)}.gif`)
      const bad = await get(`/api/v1/bulk-open/${tracking.newTrackingToken()}.gif`)
      const junk = await get('/api/v1/bulk-open/whoever@example.com')
      for (const r of [good, bad, junk]) {
        expect(r.status).toBe(200)
        expect(r.headers.get('content-type')).toBe('image/gif')
        expect(r.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate, private, max-age=0')
        expect(r.headers.get('set-cookie')).toBeNull()
        expect(Buffer.from(await r.arrayBuffer()).equals(tracking.PIXEL_GIF)).toBe(true)
      }
      expect(row('ann@alpha.test').openCount).toBe(1)
      expect(store.bulkEmailRecipient!.reduce((a, r) => a + ((r.openCount as number) ?? 0), 0)).toBe(1)
      const ping = await get('/api/v1/bulk-open/ping.gif')
      expect(ping.headers.get('x-open-tracking')).toBe('ok')
    } finally {
      server.close()
    }
  })

  it('without a verified HTTPS address: no image in the email, and "Tracking unavailable" — never "no open"', async () => {
    // Switched off.
    let sent: Array<{ to: string; html: string; text: string }> = []
    let campaignId = await sendAll(sent)
    expect(sent.every((e) => !/bulk-open/.test(e.html))).toBe(true)
    let view = await svc.bulkView('t1', campaignId)
    expect(view.counts.opens).toEqual({ sent: 3, openDetected: 0, noOpenDetected: 0, trackingUnavailable: 3 })
    expect(view.recipients[0]!.tracking).toMatchObject({ status: 'tracking_unavailable', note: expect.stringMatching(/switched off/) })
    expect(view.openTracking).toEqual({ enabled: false, reason: expect.stringMatching(/switched off/), via: 'smtp' })

    // A plain-http address in production.
    expect(tracking.trackingConfig()).toMatchObject({ ok: false })
    Object.assign(env, { BULK_OPEN_TRACKING_ENABLED: true, BULK_OPEN_TRACKING_BASE_URL: 'http://72.61.245.208:8110' })
    expect(tracking.trackingConfig()).toEqual({ ok: false, base: null, reason: 'BULK_OPEN_TRACKING_BASE_URL must be an https:// address.' })

    // HTTPS configured, but the address does not answer.
    reset()
    Object.assign(env, { BULK_OPEN_TRACKING_BASE_URL: BASE })
    tracking.setTrackingProbeForTests(async () => false)
    sent = []
    campaignId = await sendAll(sent)
    expect(sent.every((e) => !/bulk-open/.test(e.html))).toBe(true)
    view = await svc.bulkView('t1', campaignId)
    expect(view.counts.opens.trackingUnavailable).toBe(3)
    expect(view.recipients[0]!.tracking!.note).toMatch(/did not answer/)
    expect(view.openTracking.enabled).toBe(false)
  })

  it('a tracking problem never stops the email', async () => {
    on()
    const p = prisma as unknown as Record<string, { update: ReturnType<typeof vi.fn> }>
    const orig = p.bulkEmailRecipient!.update.getMockImplementation()!
    p.bulkEmailRecipient!.update.mockImplementation(async (a: { data: Row }) => {
      if ('trackingTokenHash' in a.data) throw new Error('database unavailable')
      return orig(a)
    })
    try {
      const sent: Array<{ to: string; html: string; text: string }> = []
      await sendAll(sent)
      expect(sent).toHaveLength(3)
      expect(sent.every((e) => !/bulk-open/.test(e.html))).toBe(true)
      expect(row('ann@alpha.test')).toMatchObject({ status: 'sent', trackingEnabled: false, trackingNote: expect.stringMatching(/sent without it/) })
    } finally {
      p.bulkEmailRecipient!.update.mockImplementation(orig)
    }
  })

  it('emails sent before tracking existed are "Tracking unavailable", not "No open detected"', async () => {
    store.bulkEmailCampaign!.push({ id: 'old', tenantId: 't1', name: 'Old send', status: 'completed', templateKey: 'static_site_v1', fromEmail: 'manoj@altiusnxt.test', startAt: BEFORE, intervalMinutes: 5, createdAt: BEFORE, completedAt: BEFORE, ccEmails: [], statusReason: null })
    store.bulkEmailRecipient!.push({ id: 'o1', tenantId: 't1', campaignId: 'old', position: 0, companyName: 'Old Co', contactName: 'Olga', toEmail: 'olga@old.test', ccEmails: [], status: 'sent', sentAt: BEFORE, scheduledAt: BEFORE, openCount: 0 })
    const view = await svc.bulkView('t1', 'old')
    expect(view.counts.opens).toEqual({ sent: 1, openDetected: 0, noOpenDetected: 0, trackingUnavailable: 1 })
    expect(view.recipients[0]!.tracking).toMatchObject({ status: 'tracking_unavailable', note: 'Sent before open tracking existed.' })
  })

  it('only https, plain addresses are accepted; plain http only to this machine in development', () => {
    Object.assign(env, { BULK_OPEN_TRACKING_ENABLED: true })
    const cfg = (u: string, nodeEnv = 'production') => (Object.assign(env, { BULK_OPEN_TRACKING_BASE_URL: u, NODE_ENV: nodeEnv }), tracking.trackingConfig())
    expect(cfg('https://marketing.example.com/')).toEqual({ ok: true, base: 'https://marketing.example.com', reason: null })
    expect(cfg('https://marketing.example.com?x=1').ok).toBe(false)
    expect(cfg('not a url').ok).toBe(false)
    expect(cfg('http://localhost:4100', 'development').ok).toBe(true)
    expect(cfg('http://localhost:4100', 'production').ok).toBe(false)
    expect(cfg('http://example.com', 'development').ok).toBe(false)
  })
})

// SENDING THROUGH NXT SALES (2026-10-09): prepared, approved and timed here;
// sent by NXT Sales' own Gmail pipeline as its configured sender, with its own
// open tracking. Each email has a stable key, so it is never sent twice; there
// is never a fallback to this platform's mailbox.
describe('sending through NXT Sales', () => {
  const LIST = async () => ({
    fileBase64: await xlsx([
      HEADER,
      ['Alpha Co', 'u', 'Ann Lee', 'Owner', 'ann@alpha.test', 'Al Kim', 'GM', 'al@alpha.test', ''],
      ['Bravo Co', 'u', 'Bob Ray', 'Owner', 'bob@bravo.test', '', '', '', ''],
      ['Charlie Co', 'u', 'Cy Fox', 'Owner', 'cy@charlie.test', '', '', '', ''],
    ]),
    fileName: 'three.xlsx',
    templateKey: 'static_site_v1',
    startDate: '2026-10-10',
    startTime: '10:00',
    intervalMinutes: 5,
  })
  const BEFORE = new Date('2026-10-09T12:00:00Z')
  const at = (hhmm: string) => istToUtc('2026-10-10', hhmm)!
  const row = (to: string) => store.bulkEmailRecipient!.find((r) => r.toEmail === to)!

  // A stand-in for NXT Sales' /api/marketing-bulk API, with its idempotency.
  type Sent = { key: string; to: string; cc: string[]; subject: string; html: string; text: string }
  let crm: { ready: boolean; sends: Sent[]; records: Map<string, { status: string; tracked: boolean; openCount: number; firstOpenedAt: string | null; lastOpenedAt: string | null; error: string | null }>; next: 'sent' | 'failed' | 'unknown' | 'throw'; calls: string[] }
  const smtp: string[] = []
  beforeEach(() => {
    env.BULK_SEND_VIA = 'crm'
    smtp.length = 0
    setBulkSenderForTests({ send: async (e) => (smtp.push(e.to), { messageId: 'smtp' }) })
    crm = { ready: true, sends: [], records: new Map(), next: 'sent', calls: [] }
    crmSend.setCrmBulkForTests({
      sender: async () => (crm.ready ? { ready: true, problem: null, name: 'Manoj S', fromEmail: 'manoj@altiusnxt.com' } : { ready: false, problem: 'The configured sender (manoj@altiusnxt.com) has no Gmail connected in NXT Sales.', name: 'Manoj S', fromEmail: null }),
      send: async (e) => {
        crm.calls.push(e.key)
        const prior = crm.records.get(e.key)
        if (prior && prior.status !== 'failed') return { outcome: prior.status as 'sent', messageId: 'gm', activityId: 'act', fromEmail: 'manoj@altiusnxt.com', tracked: prior.tracked, error: null }
        if (crm.next === 'throw') {
          // Sent by NXT Sales, but the answer never arrived.
          crm.sends.push({ key: e.key, to: e.to, cc: e.cc, subject: e.subject, html: e.html, text: e.text })
          crm.records.set(e.key, { status: 'sent', tracked: true, openCount: 0, firstOpenedAt: null, lastOpenedAt: null, error: null })
          return { outcome: 'unknown', messageId: null, activityId: null, fromEmail: null, tracked: false, error: 'No answer from NXT Sales (timeout).' }
        }
        if (crm.next === 'unknown') {
          // NXT Sales itself could not tell whether Gmail took it (e.g. a timeout or a quota error).
          crm.records.set(e.key, { status: 'unknown', tracked: false, openCount: 0, firstOpenedAt: null, lastOpenedAt: null, error: 'Outcome unknown — check the sender\'s Sent folder before sending again.' })
          return { outcome: 'unknown', messageId: null, activityId: null, fromEmail: null, tracked: false, error: 'Outcome unknown — check the sender\'s Sent folder before sending again.' }
        }
        if (crm.next === 'failed') {
          crm.records.set(e.key, { status: 'failed', tracked: false, openCount: 0, firstOpenedAt: null, lastOpenedAt: null, error: 'Gmail not connected.' })
          return { outcome: 'failed', messageId: null, activityId: null, fromEmail: null, tracked: false, error: 'Gmail not connected.' }
        }
        crm.sends.push({ key: e.key, to: e.to, cc: e.cc, subject: e.subject, html: e.html, text: e.text })
        crm.records.set(e.key, { status: 'sent', tracked: true, openCount: 0, firstOpenedAt: null, lastOpenedAt: null, error: null })
        return { outcome: 'sent', messageId: `gm-${crm.sends.length}`, activityId: `act-${crm.sends.length}`, fromEmail: 'manoj@altiusnxt.com', tracked: true, error: null }
      },
      statuses: async (keys) =>
        keys.flatMap((k) => {
          const r = crm.records.get(k)
          return r ? [{ idempotencyKey: k, status: r.status as 'sent', error: r.error, sentAt: '2026-10-10T04:30:00.000Z', messageId: 'gm', activityId: 'act', fromEmail: 'manoj@altiusnxt.com', tracked: r.tracked, openCount: r.tracked ? r.openCount : null, firstOpenedAt: r.firstOpenedAt, lastOpenedAt: r.lastOpenedAt }] : []
        }),
    })
  })
  afterEach(() => {
    env.BULK_SEND_VIA = 'smtp'
  })

  it('the sender is NXT Sales\' configured Gmail sender; the review has no signature of this platform (NXT Sales adds the Gmail one)', async () => {
    await setSender({ ccEmails: ['team@altiusnxt.com'], signatureHtml: '<p>Old signature</p>' })
    const view = await svc.senderView('t1')
    expect(view).toMatchObject({ via: 'crm', fromEmail: 'manoj@altiusnxt.com', authorized: true, problem: null, ccEmails: ['team@altiusnxt.com'], signatureHtml: '' })
    const r = await svc.reviewBulk(actor, await LIST(), BEFORE)
    const alpha = r.rows.find((x) => x.companyName === 'Alpha Co')!
    expect(alpha.text!.endsWith('Would you like me to send it?')).toBe(true)
    expect(alpha.html).not.toContain('Old signature')
    expect(alpha.ccEmails).toEqual(['al@alpha.test', 'team@altiusnxt.com'])
  })

  it('each email is sent by NXT Sales, once, with its own key — the approved content, no pixel, never this platform\'s mailbox', async () => {
    const { campaignId } = await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    expect(store.bulkEmailCampaign![0]).toMatchObject({ sendVia: 'crm', fromEmail: 'manoj@altiusnxt.com', signature: '', signatureHtml: '' })
    for (const t of ['10:00', '10:05', '10:10']) await svc.dispatchBulkEmails(at(t))
    expect(smtp).toEqual([])
    expect(crm.sends.map((x) => [x.to, x.subject])).toEqual([
      ['ann@alpha.test', 'Are AI tools recommending Alpha Co?'],
      ['bob@bravo.test', 'What AI LLMs say about Bravo Co'],
      ['cy@charlie.test', 'Quick note on AI search for Charlie Co'],
    ])
    expect(crm.sends[0]!.cc).toEqual(['al@alpha.test'])
    expect(new Set(crm.sends.map((x) => x.key)).size).toBe(3)
    expect(crm.sends.every((x) => !/bulk-open/.test(x.html))).toBe(true)
    expect(row('ann@alpha.test')).toMatchObject({ status: 'sent', crmOutcome: 'sent', crmSendKey: crm.sends[0]!.key, trackingEnabled: true })
    const view = await svc.bulkView('t1', campaignId)
    expect(view.campaign.status).toBe('completed')
    expect(view.counts.opens).toEqual({ sent: 3, openDetected: 0, noOpenDetected: 3, trackingUnavailable: 0 })
  })

  it('asking NXT Sales again with the same key never sends twice', async () => {
    await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(at('10:00'))
    const key = row('ann@alpha.test').crmSendKey as string
    const again = await crmSend.crmBulk().send({ key, campaignId: 'x', recipientId: 'x', to: 'ann@alpha.test', cc: [], subject: 's', html: 'h', text: 't' })
    expect(again.outcome).toBe('sent')
    expect(crm.sends.filter((x) => x.key === key)).toHaveLength(1)
  })

  it('a refusal is recorded as failed — no fallback to this platform\'s mailbox — and the rest carry on', async () => {
    crm.next = 'failed'
    await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(at('10:00'))
    crm.next = 'sent'
    await svc.dispatchBulkEmails(at('10:05'))
    expect(smtp).toEqual([])
    expect(row('ann@alpha.test')).toMatchObject({ status: 'failed', crmOutcome: 'failed', reason: 'NXT Sales did not send it: Gmail not connected.' })
    expect(row('bob@bravo.test')).toMatchObject({ status: 'sent' })
  })

  it('an unanswered send is not resent; the status check with NXT Sales confirms it was sent', async () => {
    crm.next = 'throw'
    await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    // A status check just ran, so the next one is a few minutes away.
    await svc.syncCrmSends(at('09:59'), true)
    await svc.dispatchBulkEmails(at('10:00'))
    expect(row('ann@alpha.test')).toMatchObject({ status: 'failed', crmOutcome: 'unknown' })
    expect(row('ann@alpha.test').reason).toMatch(/Not confirmed by NXT Sales/)
    expect(crm.sends).toHaveLength(1)
    expect(await svc.syncCrmSends(at('10:01'), true)).toBeGreaterThan(0)
    expect(row('ann@alpha.test')).toMatchObject({ status: 'sent', crmOutcome: 'sent', reason: null })
    expect(crm.sends).toHaveLength(1)
  })

  it('NXT Sales\' own open tracking is copied in — never raised here, never assumed from sending', async () => {
    await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    for (const t of ['10:00', '10:05', '10:10']) await svc.dispatchBulkEmails(at(t))
    expect(row('bob@bravo.test')).toMatchObject({ openCount: 0 })
    const bobKey = row('bob@bravo.test').crmSendKey as string
    crm.records.set(bobKey, { ...crm.records.get(bobKey)!, openCount: 2, firstOpenedAt: '2026-10-10T06:00:00.000Z', lastOpenedAt: '2026-10-10T07:30:00.000Z' })
    await svc.syncCrmSends(at('11:00'), true)
    expect(row('bob@bravo.test')).toMatchObject({ openCount: 2, firstOpenedAt: new Date('2026-10-10T06:00:00.000Z'), lastOpenedAt: new Date('2026-10-10T07:30:00.000Z') })
    expect(row('ann@alpha.test')).toMatchObject({ openCount: 0 })
    // An email NXT Sales sent without tracking is "Tracking unavailable", not "No open".
    const cyKey = row('cy@charlie.test').crmSendKey as string
    crm.records.set(cyKey, { ...crm.records.get(cyKey)!, tracked: false })
    await svc.syncCrmSends(at('11:05'), true)
    const view = await svc.bulkView('t1', store.bulkEmailCampaign![0]!.id as string)
    expect(view.counts.opens).toEqual({ sent: 3, openDetected: 1, noOpenDetected: 1, trackingUnavailable: 1 })
  })

  it('cannot start, and a running send pauses, when NXT Sales cannot send — nothing goes another way', async () => {
    crm.ready = false
    await expect(svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)).rejects.toThrow(/Not started — NXT Sales cannot send yet: .*no Gmail connected/)
    crm.ready = true
    const { campaignId } = await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    crm.ready = false
    await svc.dispatchBulkEmails(at('10:00'))
    let view = await svc.bulkView('t1', campaignId)
    expect(view.campaign).toMatchObject({ status: 'paused' })
    expect(view.campaign.statusReason).toMatch(/no Gmail connected/)
    // Switching the server back to its own mailbox does not send a CRM send that way.
    crm.ready = true
    env.BULK_SEND_VIA = 'smtp'
    await expect(svc.setBulkState(actor, campaignId, 'resume')).rejects.toThrow(/BULK_SEND_VIA/)
    expect(smtp).toEqual([])
    expect(crm.sends).toEqual([])
    view = await svc.bulkView('t1', campaignId)
    expect(view.counts.scheduled).toBe(3)
  })

  // ── The safety rules (2026-10-10) ──
  const LIST_B = async () => ({
    ...(await LIST()),
    fileName: 'other.xlsx',
    fileBase64: await xlsx([HEADER, ['Delta Co', 'u', 'Dee Lane', 'Owner', 'dee@delta.test', '', '', '', ''], ['Echo Co', 'u', 'Eve Moss', 'Owner', 'eve@echo.test', '', '', '', '']]),
  })
  const one = (toEmail: string) => ({ firstName: 'Priya', companyName: `Co ${toEmail}`, toEmail, ccEmails: [], templateKey: 'static_site_v1', confirm: true as const })
  const minute = (t: Date, m: number) => new Date(t.getTime() + m * 60_000)

  it('rule 1: emails through NXT Sales are at least 5 minutes apart — fewer minutes are refused', async () => {
    await expect(svc.reviewBulk(actor, { ...(await LIST()), intervalMinutes: 4 }, BEFORE)).rejects.toThrow(/at least 5 minutes apart/)
    await expect(svc.startBulk(actor, { ...(await LIST()), intervalMinutes: 1, confirm: true }, BEFORE)).rejects.toThrow(/at least 5 minutes apart/)
    expect(store.bulkEmailCampaign).toHaveLength(0)
    const ok = await svc.reviewBulk(actor, { ...(await LIST()), intervalMinutes: 5 }, BEFORE)
    expect(ok.rows.filter((x) => x.status === 'ready').map((x) => x.scheduledLocal!.split(', ').pop())).toEqual(['10:00 AM IST', '10:05 AM IST', '10:10 AM IST'])
    // This platform's own mailbox keeps its 1-minute minimum.
    env.BULK_SEND_VIA = 'smtp'
    await setSender()
    expect((await svc.reviewBulk(actor, { ...(await LIST()), intervalMinutes: 1 }, BEFORE)).schedule.intervalMinutes).toBe(1)
  })

  it('rule 1: the 5 minutes hold across sends — a second one-person send waits for them', async () => {
    const t0 = new Date('2026-10-12T05:00:00Z')
    await svc.startSingle(actor, one('a@one.test'), t0)
    await svc.dispatchBulkEmails(minute(t0, 1)) // handed over at +1 min
    expect(crm.calls).toHaveLength(1)
    await svc.startSingle(actor, one('b@two.test'), minute(t0, 2))
    for (const m of [2, 3, 4, 5]) await svc.dispatchBulkEmails(minute(t0, m))
    expect(crm.calls).toHaveLength(1) // not before 5 minutes after the first
    await svc.dispatchBulkEmails(minute(t0, 6))
    expect(crm.sends.map((x) => x.to)).toEqual(['a@one.test', 'b@two.test'])
  })

  it('rule 2: only one send through NXT Sales is active at a time — running or paused', async () => {
    const first = await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    await expect(svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)).rejects.toThrow(/Not started — another bulk email is being sent through NXT Sales .*sending/)
    await expect(svc.startSingle(actor, one('c@three.test'), BEFORE)).rejects.toThrow(/Not sent — another bulk email is being sent through NXT Sales/)
    await svc.setBulkState(actor, first.campaignId, 'pause')
    await expect(svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)).rejects.toThrow(/paused/)
    await svc.setBulkState(actor, first.campaignId, 'cancel')
    const second = await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    expect(second.scheduled).toBe(3)
    expect(store.bulkEmailCampaign!.filter((c) => c.status === 'running')).toHaveLength(1)
  })

  it('rule 2: a paused send cannot be resumed while another one is active', async () => {
    const first = await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    await svc.setBulkState(actor, first.campaignId, 'pause')
    // A second one slipped in (as if two people started at the same instant).
    store.bulkEmailCampaign![0]!.status = 'completed'
    await svc.startBulk(actor, { ...(await LIST_B()), confirm: true }, BEFORE)
    store.bulkEmailCampaign![0]!.status = 'paused'
    await expect(svc.setBulkState(actor, first.campaignId, 'resume')).rejects.toThrow(/Not resumed — another bulk email is being sent through NXT Sales/)
  })

  it('rule 2: even two running at once never send side by side — the oldest goes first, 5 minutes apart', async () => {
    const a = await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    // Simulate a race that slipped past the start check.
    store.bulkEmailCampaign![0]!.status = 'completed'
    const b = await svc.startBulk(actor, { ...(await LIST_B()), confirm: true }, BEFORE)
    store.bulkEmailCampaign![0]!.status = 'running'
    for (const t of ['10:00', '10:01', '10:02', '10:05', '10:06', '10:10', '10:15']) await svc.dispatchBulkEmails(at(t))
    const owner = (key: string) => store.bulkEmailRecipient!.find((r) => r.crmSendKey === key)!.campaignId
    expect(crm.calls.map(owner)).toEqual([a.campaignId, a.campaignId, a.campaignId, b.campaignId])
    const times = store.bulkEmailRecipient!.filter((r) => r.crmAttemptedAt).map((r) => (r.crmAttemptedAt as Date).getTime()).sort()
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(5 * 60_000 - 5_000)
  })

  it('rule 3: an email whose outcome is unknown is never handed over again — the others carry on', async () => {
    crm.next = 'unknown'
    const { campaignId } = await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(at('10:00'))
    crm.next = 'sent'
    for (const t of ['10:05', '10:10', '10:15', '10:20', '10:30']) {
      await svc.dispatchBulkEmails(at(t))
      await svc.syncCrmSends(at(t), true)
    }
    const annKey = row('ann@alpha.test').crmSendKey as string
    expect(crm.calls.filter((k) => k === annKey)).toHaveLength(1)
    expect(row('ann@alpha.test')).toMatchObject({ status: 'failed', crmOutcome: 'unknown' })
    expect(row('ann@alpha.test').reason).toMatch(/Not confirmed by NXT Sales/)
    expect(crm.sends.map((x) => x.to)).toEqual(['bob@bravo.test', 'cy@charlie.test'])
    expect((await svc.bulkView('t1', campaignId)).campaign.status).toBe('completed')
    // Not even a resume hands it over again.
    expect(row('ann@alpha.test').status).toBe('failed')
  })

  it('normal sending: every email once, 5 minutes apart, in order', async () => {
    await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    for (const t of ['10:00', '10:02', '10:04', '10:05', '10:09', '10:10', '10:11']) await svc.dispatchBulkEmails(at(t))
    expect(crm.sends.map((x) => x.to)).toEqual(['ann@alpha.test', 'bob@bravo.test', 'cy@charlie.test'])
    expect(new Set(crm.calls).size).toBe(crm.calls.length)
    expect(store.bulkEmailRecipient!.map((r) => r.crmAttemptedAt && (r.crmAttemptedAt as Date).toISOString())).toEqual([at('10:00').toISOString(), at('10:05').toISOString(), at('10:10').toISOString()])
  })

  // ── Possibly already emailed: unknown or unconfirmed outcomes (2026-10-10) ──
  const ANN_AND_DEE = async () => ({
    ...(await LIST()),
    fileName: 'again.xlsx',
    fileBase64: await xlsx([HEADER, ['Alpha Co', 'u', 'Ann Lee', 'Owner', 'ann@alpha.test', '', '', '', ''], ['Delta Co', 'u', 'Dee Lane', 'Owner', 'dee@delta.test', '', '', '', '']]),
  })
  const LATER = new Date('2026-10-11T12:00:00Z')
  /** A first send through NXT Sales in which Ann's outcome is unknown; Bob and Cy are sent. */
  async function firstSendWithUnknownAnn() {
    crm.next = 'unknown'
    const first = await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(at('10:00'))
    crm.next = 'sent'
    for (const t of ['10:05', '10:10', '10:15']) await svc.dispatchBulkEmails(at(t))
    expect((await svc.bulkView('t1', first.campaignId)).campaign.status).toBe('completed')
    expect(row('ann@alpha.test')).toMatchObject({ status: 'failed', crmOutcome: 'unknown' })
  }

  it('bulk review skips an address whose earlier email through NXT Sales has an unknown outcome — with the reason', async () => {
    await firstSendWithUnknownAnn()
    const r = await svc.reviewBulk(actor, await ANN_AND_DEE(), LATER)
    const ann = r.rows.find((x) => x.toEmail === 'ann@alpha.test')!
    expect(ann.status).toBe('skipped')
    expect(ann.reason).toBe(`Possibly already emailed: an earlier email to ann@alpha.test was handed to NXT Sales on 2026-10-10 and its outcome is unknown, so it is not sent again. Check the sender's Sent folder in Gmail.`)
    expect(r.rows.find((x) => x.toEmail === 'dee@delta.test')!.status).toBe('ready')
    // Starting it sends Dee only — never Ann again.
    await svc.startBulk(actor, { ...(await ANN_AND_DEE()), confirm: true }, LATER)
    await svc.dispatchBulkEmails(new Date(LATER.getTime() + 60_000))
    await svc.dispatchBulkEmails(new Date(LATER.getTime() + 10 * 60_000))
    expect(crm.calls.filter((k) => k === row('ann@alpha.test').crmSendKey)).toHaveLength(1)
    expect(crm.sends.map((x) => x.to)).toEqual(['bob@bravo.test', 'cy@charlie.test', 'dee@delta.test'])
  })

  it('an email handed over with no outcome recorded (e.g. after a crash) counts as possibly emailed too', async () => {
    await firstSendWithUnknownAnn()
    Object.assign(row('ann@alpha.test'), { crmOutcome: null, reason: 'Sending did not complete. It was not retried, so the contact cannot receive it twice.' })
    const r = await svc.reviewBulk(actor, await ANN_AND_DEE(), LATER)
    expect(r.rows.find((x) => x.toEmail === 'ann@alpha.test')!.reason).toMatch(/^Possibly already emailed/)
  })

  it('an email NXT Sales refused before sending was not delivered — that address may be emailed again', async () => {
    crm.next = 'failed'
    await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(at('10:00'))
    crm.next = 'sent'
    for (const t of ['10:05', '10:10', '10:15']) await svc.dispatchBulkEmails(at(t))
    expect(row('ann@alpha.test')).toMatchObject({ status: 'failed', crmOutcome: 'failed' })
    const r = await svc.reviewBulk(actor, await ANN_AND_DEE(), LATER)
    expect(r.rows.find((x) => x.toEmail === 'ann@alpha.test')!.status).toBe('ready')
  })

  it('once NXT Sales confirms it was sent, it is "already emailed" like any sent email', async () => {
    await firstSendWithUnknownAnn()
    crm.records.set(row('ann@alpha.test').crmSendKey as string, { status: 'sent', tracked: true, openCount: 0, firstOpenedAt: null, lastOpenedAt: null, error: null })
    await svc.syncCrmSends(at('10:20'), true)
    const r = await svc.reviewBulk(actor, await ANN_AND_DEE(), LATER)
    expect(r.rows.find((x) => x.toEmail === 'ann@alpha.test')!.reason).toMatch(/^Already emailed by a bulk send on/)
  })

  it('one-person sending is blocked for that address, with the warning', async () => {
    await firstSendWithUnknownAnn()
    const single = { firstName: 'Ann', companyName: 'Alpha Co', toEmail: 'ann@alpha.test', ccEmails: [], templateKey: 'static_site_v2' }
    const r = await svc.reviewSingle(actor, single)
    expect(r.blocked).toMatch(/^Possibly already emailed: an earlier email to ann@alpha.test was handed to NXT Sales on 2026-10-10 and its outcome is unknown/)
    await expect(svc.startSingle(actor, { ...single, confirm: true }, LATER)).rejects.toThrow(/Not sent — Possibly already emailed/)
    expect(crm.calls.filter((k) => k === row('ann@alpha.test').crmSendKey)).toHaveLength(1)
    // Another address is not affected.
    expect((await svc.reviewSingle(actor, { ...single, toEmail: 'dee@delta.test' })).blocked).toBeNull()
  })

  it('the guard holds whichever way the next email would be sent', async () => {
    await firstSendWithUnknownAnn()
    env.BULK_SEND_VIA = 'smtp'
    await setSender()
    const r = await svc.reviewBulk(actor, await ANN_AND_DEE(), LATER)
    expect(r.rows.find((x) => x.toEmail === 'ann@alpha.test')!.reason).toMatch(/^Possibly already emailed/)
  })

  it('one person is sent through NXT Sales too', async () => {
    const { campaignId } = await svc.startSingle(actor, { firstName: 'Priya', companyName: 'Acme Supply', toEmail: 'priya@acme.test', ccEmails: [], templateKey: 'static_site_v2', confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(new Date(BEFORE.getTime() + 60_000))
    expect(crm.sends.map((x) => [x.to, x.subject])).toEqual([['priya@acme.test', 'What AI LLMs say about Acme Supply']])
    expect((await svc.bulkView('t1', campaignId)).campaign.status).toBe('completed')
    expect(smtp).toEqual([])
  })
})

/** The approved HTML before the pixel. */
function svc_reviewedHtml(html: string) {
  return html.replace(/<img src="[^"]*bulk-open[^"]*"[^>]*\/>/, '')
}

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

describe('the email font', () => {
  it('the email text is in Verdana', () => {
    expect(composeBulkEmail({ template: STATIC_SITE, firstName: 'Ed', companyName: 'X' }).html.startsWith('<div style="font-family:Verdana,Geneva,sans-serif;')).toBe(true)
  })
})

// ── Attachments (2026-10-12) ─────────────────────────────────────────────
// Uploaded once, below the preview; the same files go with every email of the
// send. Through NXT Sales they are only sent when NXT Sales says it accepts
// them; an email never goes without the files that were approved.
describe('attachments', async () => {
  const att = await import('../../src/outreach/bulk/attachments.js')
  const LIST = async (extra: Record<string, unknown> = {}) => ({
    fileBase64: await xlsx([
      HEADER,
      ['Alpha Co', 'u', 'Ann Lee', 'Owner', 'ann@alpha.test', '', '', '', ''],
      ['Bravo Co', 'u', 'Bob Ray', 'Owner', 'bob@bravo.test', '', '', '', ''],
      ['Charlie Co', 'u', 'Cy Fox', 'Owner', 'cy@charlie.test', '', '', '', ''],
    ]),
    fileName: 'three.xlsx',
    templateKey: 'static_site_v1',
    startDate: '2026-10-10',
    startTime: '10:00',
    intervalMinutes: 5,
    ...extra,
  })
  const BEFORE = new Date('2026-10-09T12:00:00Z')
  const at = (hhmm: string) => istToUtc('2026-10-10', hhmm)!
  const PDF = Buffer.from('%PDF-1.4 AltiusNxt overview').toString('base64')
  const PNG = Buffer.from('fake png bytes').toString('base64')
  type Sent = { key: string; to: string; html: string; attachments?: Array<{ filename: string; mimeType: string; content: string }> }
  let crm: { capable: boolean; sends: Sent[] }
  const smtp: Array<{ to: string; attachments?: unknown[] }> = []

  beforeEach(() => {
    env.BULK_SEND_VIA = 'crm'
    smtp.length = 0
    setBulkSenderForTests({ send: async (e) => (smtp.push({ to: e.to, attachments: e.attachments }), { messageId: 'smtp' }) })
    crm = { capable: true, sends: [] }
    crmSend.setCrmBulkForTests({
      sender: async () => ({ ready: true, problem: null, name: 'Manoj S', fromEmail: 'manoj@altiusnxt.com', attachments: crm.capable ? { maxFiles: 5, maxBytes: 10485760 } : null }),
      send: async (e) => {
        crm.sends.push({ key: e.key, to: e.to, html: e.html, ...(e.attachments ? { attachments: e.attachments } : {}) })
        return { outcome: 'sent', messageId: `gm-${crm.sends.length}`, activityId: `act-${crm.sends.length}`, fromEmail: 'manoj@altiusnxt.com', tracked: true, error: null }
      },
      statuses: async () => [],
    })
  })
  afterEach(() => {
    env.BULK_SEND_VIA = 'smtp'
  })

  it('checks each file: name, blocked programs, size, readable content; the type comes from the extension', () => {
    expect(att.checkFile({ fileName: 'Overview.PDF', contentBase64: PDF }).mimeType).toBe('application/pdf')
    expect(att.checkFile({ fileName: 'notes', contentBase64: PDF }).mimeType).toBe('application/octet-stream')
    expect(att.checkFile({ fileName: 'a.pdf', contentBase64: `data:application/pdf;base64,${PDF}` }).bytes.toString()).toContain('%PDF')
    const bad: Array<[string, string, RegExp]> = [
      ['run.exe', PDF, /cannot be attached/],
      ['macro.JS', PDF, /cannot be attached/],
      ['a\r\nb.pdf', PDF, /file name/],
      ['../x.pdf', PDF, /file name/],
      ['q"uote.pdf', PDF, /file name/],
      ['a.pdf', 'not base64!', /could not be read/],
      ['a.pdf', '', /could not be read/],
      ['big.pdf', Buffer.alloc(att.MAX_FILE_BYTES + 1, 1).toString('base64'), /larger than 7 MB/],
    ]
    for (const [fileName, contentBase64, msg] of bad) {
      expect(() => att.checkFile({ fileName, contentBase64 }), fileName).toThrow(msg)
    }
  })

  it('a staged file can be removed; staged files older than a day are cleared at the next upload', async () => {
    const a = await att.stageAttachment(actor, { fileName: 'a.pdf', contentBase64: PDF }, new Date('2026-10-01T00:00:00Z'))
    store.bulkAttachment![0]!.createdAt = new Date('2026-10-01T00:00:00Z')
    const b = await att.stageAttachment(actor, { fileName: 'b.pdf', contentBase64: PDF }, new Date('2026-10-12T00:00:00Z'))
    expect(store.bulkAttachment!.map((r) => r.id)).toEqual([b.id]) // a was more than a day old
    await att.removeStagedAttachment(actor, b.id)
    expect(store.bulkAttachment).toEqual([])
    await expect(att.removeStagedAttachment(actor, a.id)).rejects.toThrow(/not found/)
  })

  it('bulk through NXT Sales: every email carries the same files, in order, byte for byte; the HTML (pixel) is untouched', async () => {
    const pdf = await att.stageAttachment(actor, { fileName: 'Overview.pdf', contentBase64: PDF }, BEFORE)
    const png = await att.stageAttachment(actor, { fileName: 'Chart.png', contentBase64: PNG }, BEFORE)
    const review = await svc.reviewBulk(actor, await LIST({ attachmentIds: [pdf.id, png.id] }), BEFORE)
    expect(review.attachments.map((a) => a.fileName)).toEqual(['Overview.pdf', 'Chart.png'])
    expect(review.attachmentProblem).toBeNull()
    const { campaignId } = await svc.startBulk(actor, { ...(await LIST({ attachmentIds: [pdf.id, png.id] })), confirm: true }, BEFORE)
    expect(store.bulkEmailCampaign![0]).toMatchObject({ attachmentCount: 2, sendVia: 'crm' })
    expect(store.bulkAttachment!.map((r) => [r.fileName, r.campaignId, r.position])).toEqual([
      ['Overview.pdf', campaignId, 0],
      ['Chart.png', campaignId, 1],
    ])
    for (const t of ['10:00', '10:05', '10:10']) await svc.dispatchBulkEmails(at(t))
    expect(crm.sends.map((x) => x.to)).toEqual(['ann@alpha.test', 'bob@bravo.test', 'cy@charlie.test'])
    const expected = [
      { filename: 'Overview.pdf', mimeType: 'application/pdf', content: PDF },
      { filename: 'Chart.png', mimeType: 'image/png', content: PNG },
    ]
    for (const s of crm.sends) expect(s.attachments).toEqual(expected)
    expect(new Set(crm.sends.map((x) => x.html)).size).toBe(3) // personalised HTML, no attachment content inside it
    expect(crm.sends.every((x) => !x.html.includes(PDF))).toBe(true)
    expect(smtp).toEqual([])
    const view = await svc.bulkView('t1', campaignId)
    expect(view.attachments.map((a) => a.fileName)).toEqual(['Overview.pdf', 'Chart.png'])
    expect(store.auditEvent!.some((e) => JSON.stringify(e).includes('attachments: Overview.pdf, Chart.png'))).toBe(true)
  })

  it('without attachments nothing changes: no attachments key goes to NXT Sales', async () => {
    await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(at('10:00'))
    expect(crm.sends).toHaveLength(1)
    expect('attachments' in crm.sends[0]!).toBe(false)
    expect(store.bulkEmailCampaign![0]).toMatchObject({ attachmentCount: 0 })
  })

  it('an NXT Sales that does not accept attachments: the review says so and the send cannot start; nothing is created', async () => {
    crm.capable = false
    const pdf = await att.stageAttachment(actor, { fileName: 'Overview.pdf', contentBase64: PDF }, BEFORE)
    const review = await svc.reviewBulk(actor, await LIST({ attachmentIds: [pdf.id] }), BEFORE)
    expect(review.attachmentProblem).toMatch(/cannot send attachments yet/)
    await expect(svc.startBulk(actor, { ...(await LIST({ attachmentIds: [pdf.id] })), confirm: true }, BEFORE)).rejects.toThrow(
      /Not started — NXT Sales on this server cannot send attachments/,
    )
    expect(store.bulkEmailCampaign).toEqual([])
    expect(store.bulkAttachment![0]!.campaignId).toBeNull()
  })

  it('if NXT Sales stops accepting attachments while a send runs, the send pauses; no email goes without its files', async () => {
    const pdf = await att.stageAttachment(actor, { fileName: 'Overview.pdf', contentBase64: PDF }, BEFORE)
    await svc.startBulk(actor, { ...(await LIST({ attachmentIds: [pdf.id] })), confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(at('10:00'))
    expect(crm.sends).toHaveLength(1)
    crm.capable = false
    await svc.dispatchBulkEmails(at('10:05'))
    expect(crm.sends).toHaveLength(1)
    expect(store.bulkEmailCampaign![0]).toMatchObject({ status: 'paused' })
    expect(store.bulkEmailCampaign![0]!.statusReason).toMatch(/cannot send attachments/)
  })

  it('if a file cannot be loaded at send time, that email is not sent (failed, with the reason)', async () => {
    const pdf = await att.stageAttachment(actor, { fileName: 'Overview.pdf', contentBase64: PDF }, BEFORE)
    await svc.startBulk(actor, { ...(await LIST({ attachmentIds: [pdf.id] })), confirm: true }, BEFORE)
    store.bulkAttachment = [] // the stored file is gone
    await svc.dispatchBulkEmails(at('10:00'))
    expect(crm.sends).toEqual([])
    const ann = store.bulkEmailRecipient!.find((r) => r.toEmail === 'ann@alpha.test')!
    expect(ann).toMatchObject({ status: 'failed', reason: 'Its attachments could not be loaded, so it was not sent.' })
  })

  it('an unknown, repeated or over-limit attachment is refused at review', async () => {
    await expect(svc.reviewBulk(actor, await LIST({ attachmentIds: ['nope'] }), BEFORE)).rejects.toThrow(/no longer available/)
    const a = await att.stageAttachment(actor, { fileName: 'a.pdf', contentBase64: PDF }, BEFORE)
    await expect(svc.reviewBulk(actor, await LIST({ attachmentIds: [a.id, a.id] }), BEFORE)).rejects.toThrow(/listed twice/)
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push((await att.stageAttachment(actor, { fileName: `f${i}.pdf`, contentBase64: PDF }, BEFORE)).id)
    await expect(svc.reviewBulk(actor, await LIST({ attachmentIds: ids }), BEFORE)).rejects.toThrow(/At most 5/)
    store.bulkAttachment!.forEach((r) => (r.sizeBytes = 6 * 1024 * 1024)) // 12 MB for two
    await expect(svc.reviewBulk(actor, await LIST({ attachmentIds: ids.slice(0, 2) }), BEFORE)).rejects.toThrow(/larger than 10 MB/)
  })

  it('one person through NXT Sales carries the files too', async () => {
    const pdf = await att.stageAttachment(actor, { fileName: 'Overview.pdf', contentBase64: PDF }, BEFORE)
    const single = { firstName: 'Ann', companyName: 'Alpha Co', toEmail: 'ann@alpha.test', templateKey: 'static_site_v1', attachmentIds: [pdf.id] }
    const review = await svc.reviewSingle(actor, single)
    expect(review.attachments.map((a) => a.fileName)).toEqual(['Overview.pdf'])
    expect(review.blocked).toBeNull()
    await svc.startSingle(actor, { ...single, confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(new Date(BEFORE.getTime() + 60_000))
    expect(crm.sends).toHaveLength(1)
    expect(crm.sends[0]!.attachments).toEqual([{ filename: 'Overview.pdf', mimeType: 'application/pdf', content: PDF }])
  })

  it('one person: an NXT Sales without attachment support blocks the review', async () => {
    crm.capable = false
    const pdf = await att.stageAttachment(actor, { fileName: 'Overview.pdf', contentBase64: PDF }, BEFORE)
    const review = await svc.reviewSingle(actor, { firstName: 'Ann', companyName: 'Alpha Co', toEmail: 'ann@alpha.test', templateKey: 'static_site_v1', attachmentIds: [pdf.id] })
    expect(review.blocked).toMatch(/cannot send attachments yet/)
  })

  it("through this platform's mailbox (SMTP) the same files become ordinary attachments", () => {
    const options = bulkMailOptions(
      { host: 'h', port: 587, secure: false, user: 'manoj@altiusnxt.test', pass: 'x', source: 'bulk' },
      {
        fromEmail: 'manoj@altiusnxt.test',
        fromName: null,
        to: 'ann@alpha.test',
        cc: [],
        subject: 's',
        text: 't',
        html: '<p>h</p>',
        attachments: [{ filename: 'Overview.pdf', mimeType: 'application/pdf', content: PDF }],
      },
    )
    expect(options.attachments).toEqual([{ filename: 'Overview.pdf', content: Buffer.from(PDF, 'base64'), contentType: 'application/pdf' }])
  })
})

// ── Your own template (2026-10-12) ──────────────────────────────────────────
// The user pastes their own email instead of Versions 1-3. It is reviewed, and
// the SAME approved email (only [First Name] / [Company Name] filled) is sent to
// every recipient, through NXT Sales exactly like the approved versions.
describe('your own template', () => {
  const OWN = {
    subject: 'A quick idea for [Company Name]',
    bodyHtml: '<p>Hi <b>[First Name]</b>,</p><p>Here is <i>our</i> own offer: <a href="https://example.com/offer">see it</a>.</p><ul><li>Fast</li><li>Simple</li></ul>',
  }
  const LIST = async (extra: Record<string, unknown> = {}) => ({
    fileBase64: await xlsx([
      HEADER,
      ['Alpha Co', 'u', 'Ann Lee', 'Owner', 'ann@alpha.test', '', '', '', ''],
      ['Bravo Co', 'u', 'Bob Ray', 'Owner', 'bob@bravo.test', '', '', '', ''],
      ['Charlie Co', 'u', 'Cy Fox', 'Owner', 'cy@charlie.test', '', '', '', ''],
    ]),
    fileName: 'three.xlsx',
    templateKey: 'static_site_v1',
    startDate: '2026-10-10',
    startTime: '10:00',
    intervalMinutes: 5,
    ...extra,
  })
  const BEFORE = new Date('2026-10-09T12:00:00Z')
  const at = (hhmm: string) => istToUtc('2026-10-10', hhmm)!
  type Sent = { key: string; to: string; subject: string; html: string; text: string; attachments?: unknown[] }
  let crm: { sends: Sent[] }
  const smtpSent: Array<{ to: string; subject: string; html: string; text: string }> = []

  beforeEach(() => {
    env.BULK_SEND_VIA = 'crm'
    smtpSent.length = 0
    setBulkSenderForTests({ send: async (e) => (smtpSent.push({ to: e.to, subject: e.subject, html: e.html, text: e.text }), { messageId: 'smtp' }) })
    crm = { sends: [] }
    crmSend.setCrmBulkForTests({
      sender: async () => ({ ready: true, problem: null, name: 'Manoj S', fromEmail: 'manoj@altiusnxt.com', attachments: { maxFiles: 5, maxBytes: 10485760 } }),
      send: async (e) => {
        crm.sends.push({ key: e.key, to: e.to, subject: e.subject, html: e.html, text: e.text, ...(e.attachments ? { attachments: e.attachments } : {}) })
        return { outcome: 'sent', messageId: `gm-${crm.sends.length}`, activityId: `act-${crm.sends.length}`, fromEmail: 'manoj@altiusnxt.com', tracked: true, error: null }
      },
      statuses: async () => [],
    })
  })
  afterEach(() => {
    env.BULK_SEND_VIA = 'smtp'
  })

  it('the review shows the complete email for every person — the same template, no versions in turn, only the names differ', async () => {
    const review = await svc.reviewBulk(actor, await LIST({ customTemplate: OWN }), BEFORE)
    const ready = review.rows.filter((r) => r.status === 'ready')
    expect(ready).toHaveLength(3)
    expect(ready.map((r) => [r.templateKey, r.version])).toEqual([['custom', null], ['custom', null], ['custom', null]])
    expect(ready.map((r) => r.subject)).toEqual(['A quick idea for Alpha Co', 'A quick idea for Bravo Co', 'A quick idea for Charlie Co'])
    expect(ready[0]!.html).toContain('<b>Ann</b>')
    expect(ready[0]!.html).toContain('<a href="https://example.com/offer">see it</a>')
    expect(ready[0]!.html).toContain('<ul><li>Fast</li><li>Simple</li></ul>')
    expect(ready[0]!.text).toContain('Hi Ann,')
    const same = (r: (typeof ready)[number], first: string, co: string) => r.html!.replace(first, '#').replace(co, '$')
    expect(same(ready[0]!, 'Ann', 'Alpha')).toBe(same(ready[1]!, 'Bob', 'Bravo'))
    expect(review.templateNotes).toEqual([])
    expect(store.bulkEmailCampaign).toEqual([]) // a review writes nothing
  })

  it('the review says what was taken out of the pasted template (scripts, pictures that are not links)', async () => {
    const review = await svc.reviewBulk(actor, await LIST({ customTemplate: { ...OWN, bodyHtml: OWN.bodyHtml + '<script>alert(1)</script><img src="data:image/png;base64,AAAA">' } }), BEFORE)
    expect(review.templateNotes.join(' ')).toMatch(/scripts and active content/)
    expect(review.templateNotes.join(' ')).toMatch(/not a link to the web/)
    expect(review.rows[0]!.html).not.toMatch(/<script|data:image/)
  })

  it('through NXT Sales every recipient is sent the same approved email, byte for byte (only their names differ) — never a <pre> fallback', async () => {
    const { campaignId } = await svc.startBulk(actor, { ...(await LIST({ customTemplate: OWN })), confirm: true }, BEFORE)
    expect(store.bulkEmailCampaign![0]).toMatchObject({ templateKey: 'custom', subject: OWN.subject, sendVia: 'crm', signature: '', signatureHtml: '' })
    const approved = store.bulkEmailRecipient!.map((r) => [r.toEmail, r.subject, r.body, r.bodyHtml])
    expect(approved.every((a) => typeof a[3] === 'string' && (a[3] as string).includes('<b>'))).toBe(true)
    for (const t of ['10:00', '10:05', '10:10']) await svc.dispatchBulkEmails(at(t))
    expect(crm.sends.map((x) => x.to)).toEqual(['ann@alpha.test', 'bob@bravo.test', 'cy@charlie.test'])
    // What was stored at approval is exactly what goes.
    for (const s of crm.sends) {
      const r = store.bulkEmailRecipient!.find((x) => x.toEmail === s.to)!
      expect(s.html).toBe(r.bodyHtml)
      expect(s.subject).toBe(r.subject)
      expect(s.text).toBe(r.body)
      expect(s.html).not.toContain('<pre')
      expect(s.html).toContain('<ul><li>Fast</li>')
    }
    expect(smtpSent).toEqual([])
    const view = await svc.bulkView('t1', campaignId)
    expect(view.recipients.every((r) => r.ownTemplate === true && r.version === null)).toBe(true)
    expect(view.campaign.status).toBe('completed')
  })

  it('a send with the approved versions is unchanged: no bodyHtml is stored, versions rotate', async () => {
    await svc.startBulk(actor, { ...(await LIST()), confirm: true }, BEFORE)
    expect(store.bulkEmailRecipient!.every((r) => r.bodyHtml === null)).toBe(true)
    expect(store.bulkEmailRecipient!.map((r) => r.templateKey)).toEqual(['static_site_v1', 'static_site_v2', 'static_site_v3'])
  })

  it('a recipient whose placeholder cannot be filled is skipped with the reason — the rest go', async () => {
    const file = await xlsx([
      HEADER,
      ['Alpha Co', 'u', '', 'Owner', 'ann@alpha.test', '', '', '', ''],
      ['Bravo Co', 'u', 'Bob Ray', 'Owner', 'bob@bravo.test', '', '', '', ''],
    ])
    const review = await svc.reviewBulk(actor, { ...(await LIST({ customTemplate: OWN })), fileBase64: file }, BEFORE)
    expect(review.rows.map((r) => r.status)).toEqual(['skipped', 'ready'])
    expect(review.rows[0]!.reason).toMatch(/\[First Name\]/)
  })

  it('a template with no placeholders is the very same email for everyone', async () => {
    await svc.startBulk(actor, { ...(await LIST({ customTemplate: { subject: 'Hello', bodyHtml: '<p>Same for all.</p>' } })), confirm: true }, BEFORE)
    const rows = store.bulkEmailRecipient!
    expect(new Set(rows.map((r) => r.bodyHtml)).size).toBe(1)
    expect(new Set(rows.map((r) => r.body)).size).toBe(1)
    expect(new Set(rows.map((r) => r.subject)).size).toBe(1)
  })

  it('an unusable template is refused at review and at start — nothing is created', async () => {
    for (const customTemplate of [
      { subject: '', bodyHtml: OWN.bodyHtml },
      { subject: 'two\nlines', bodyHtml: OWN.bodyHtml },
      { subject: 'S', bodyHtml: '' },
      { subject: 'S', bodyHtml: '<script>alert(1)</script>' },
    ]) {
      await expect(svc.reviewBulk(actor, await LIST({ customTemplate }), BEFORE)).rejects.toThrow()
      await expect(svc.startBulk(actor, { ...(await LIST({ customTemplate })), confirm: true }, BEFORE)).rejects.toThrow()
    }
    expect(store.bulkEmailCampaign).toEqual([])
    expect(store.bulkEmailRecipient).toEqual([])
  })

  it('attachments work with your own template: the same files on every email', async () => {
    const att = await import('../../src/outreach/bulk/attachments.js')
    const pdf = await att.stageAttachment(actor, { fileName: 'Overview.pdf', contentBase64: Buffer.from('%PDF-1.4 x').toString('base64') }, BEFORE)
    await svc.startBulk(actor, { ...(await LIST({ customTemplate: OWN, attachmentIds: [pdf.id] })), confirm: true }, BEFORE)
    for (const t of ['10:00', '10:05', '10:10']) await svc.dispatchBulkEmails(at(t))
    expect(crm.sends).toHaveLength(3)
    for (const s of crm.sends) expect(s.attachments).toEqual([{ filename: 'Overview.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4 x').toString('base64') }])
  })

  it('one person: your own template is reviewed in full, and the same approved email is sent', async () => {
    const single = { firstName: 'Ann', companyName: 'Alpha Co', toEmail: 'ann@alpha.test', templateKey: 'static_site_v1', customTemplate: OWN }
    const review = await svc.reviewSingle(actor, single)
    expect(review).toMatchObject({ templateKey: 'custom', version: null, subject: 'A quick idea for Alpha Co', blocked: null })
    expect(review.html).toContain('<b>Ann</b>')
    await svc.startSingle(actor, { ...single, confirm: true }, BEFORE)
    expect(store.bulkEmailRecipient![0]!.bodyHtml).toBe(review.html)
    await svc.dispatchBulkEmails(new Date(BEFORE.getTime() + 60_000))
    expect(crm.sends).toHaveLength(1)
    expect(crm.sends[0]).toMatchObject({ to: 'ann@alpha.test', subject: review.subject, html: review.html, text: review.text })
    expect(store.auditEvent!.some((e) => JSON.stringify(e).includes('your own template'))).toBe(true)
  })

  it('through this platform\'s mailbox (SMTP) the reviewed HTML is also sent as it is', async () => {
    env.BULK_SEND_VIA = 'smtp'
    await setSender()
    await svc.startBulk(actor, { ...(await LIST({ customTemplate: OWN })), confirm: true }, BEFORE)
    await svc.dispatchBulkEmails(at('10:00'))
    expect(smtpSent).toHaveLength(1)
    const r = store.bulkEmailRecipient!.find((x) => x.toEmail === 'ann@alpha.test')!
    expect(smtpSent[0]!.html).toBe(r.bodyHtml)
    expect(smtpSent[0]!.subject).toBe('A quick idea for Alpha Co')
  })
})

describe('your own template: size guard', () => {
  it('a very large template for many recipients is refused with a clear sentence instead of building a huge review', async () => {
    env.BULK_SEND_VIA = 'crm'
    crmSend.setCrmBulkForTests({
      sender: async () => ({ ready: true, problem: null, name: 'Manoj S', fromEmail: 'manoj@altiusnxt.com', attachments: null }),
      send: async () => ({ outcome: 'sent', messageId: 'g', activityId: 'a', fromEmail: 'manoj@altiusnxt.com', tracked: true, error: null }),
      statuses: async () => [],
    })
    const rows = Array.from({ length: 230 }, (_, i) => [`Co ${i}`, 'u', `Person${i} Lee`, 'Owner', `p${i}@co${i}.test`, '', '', '', ''])
    const fileBase64 = await xlsx([HEADER, ...rows])
    const bodyHtml = `<p>Hi [First Name],</p><p>${'x'.repeat(185_000)}</p>`
    const setup = { fileBase64, fileName: 'many.xlsx', templateKey: 'static_site_v1', startDate: '2026-10-10', startTime: '10:00', intervalMinutes: 5, customTemplate: { subject: 'S', bodyHtml } }
    await expect(svc.reviewBulk(actor, setup, new Date('2026-10-09T12:00:00Z'))).rejects.toThrow(/too large to send to this many people/)
    // The same template for a few people is fine.
    const few = await xlsx([HEADER, ...rows.slice(0, 3)])
    const review = await svc.reviewBulk(actor, { ...setup, fileBase64: few }, new Date('2026-10-09T12:00:00Z'))
    expect(review.rows.filter((r) => r.status === 'ready')).toHaveLength(3)
    env.BULK_SEND_VIA = 'smtp'
  })
})

// ── Several own templates (2026-10-14) ──────────────────────────────────────
// 2-3 of the user's own templates, given in order (1 → 2 → 3 → 1 …) or at
// random (seeded in the browser, so the start sends exactly what was reviewed).
describe('several own templates, in order or at random', () => {
  const T = [1, 2, 3].map((n) => ({ subject: `T${n} for [Company Name]`, bodyHtml: `<p>Hi [First Name], this is <b>template ${n}</b>.</p>` }))
  const people = (n: number) =>
    Array.from({ length: n }, (_, i) => [`Co ${i + 1}`, 'u', `Person${i + 1} Lee`, 'Owner', `p${i + 1}@co${i + 1}.test`, '', '', '', ''])
  const LIST = async (n: number, extra: Record<string, unknown> = {}) => ({
    fileBase64: await xlsx([HEADER, ...people(n)]),
    fileName: 'list.xlsx',
    templateKey: 'static_site_v1',
    startDate: '2026-10-10',
    startTime: '10:00',
    intervalMinutes: 5,
    ...extra,
  })
  const BEFORE = new Date('2026-10-09T12:00:00Z')
  const at = (m: number) => new Date(istToUtc('2026-10-10', '10:00')!.getTime() + m * 60_000)
  let sends: Array<{ to: string; subject: string; html: string; text: string; attachments?: unknown[] }>

  beforeEach(() => {
    env.BULK_SEND_VIA = 'crm'
    sends = []
    crmSend.setCrmBulkForTests({
      sender: async () => ({ ready: true, problem: null, name: 'Manoj S', fromEmail: 'manoj@altiusnxt.com', attachments: { maxFiles: 5, maxBytes: 10485760 } }),
      send: async (e) => {
        sends.push({ to: e.to, subject: e.subject, html: e.html, text: e.text, ...(e.attachments ? { attachments: e.attachments } : {}) })
        return { outcome: 'sent', messageId: `gm-${sends.length}`, activityId: `act-${sends.length}`, fromEmail: 'manoj@altiusnxt.com', tracked: true, error: null }
      },
      statuses: async () => [],
    })
  })
  afterEach(() => {
    env.BULK_SEND_VIA = 'smtp'
  })

  it('in order: template 1 → 2 → 3 → 1 → 2 → 3 down the list, each filled for its person', async () => {
    const review = await svc.reviewBulk(actor, await LIST(6, { customTemplates: T, templateOrder: 'sequential' }), BEFORE)
    const ready = review.rows.filter((r) => r.status === 'ready')
    expect(ready.map((r) => r.templateKey)).toEqual(['custom', 'custom_2', 'custom_3', 'custom', 'custom_2', 'custom_3'])
    expect(ready.map((r) => r.subject)).toEqual(['T1 for Co 1', 'T2 for Co 2', 'T3 for Co 3', 'T1 for Co 4', 'T2 for Co 5', 'T3 for Co 6'])
    expect(ready[1]!.html).toContain('Hi Person, this is <b>template 2</b>.') // first names keep letters only ("Person2" → "Person"), as before
    expect(ready.every((r) => r.version === null)).toBe(true)
    expect(review.templateOrder).toBe('sequential')
    expect(store.bulkEmailCampaign).toEqual([]) // a review writes nothing
  })

  it('two templates in order: 1, 2, 1, 2', async () => {
    const review = await svc.reviewBulk(actor, await LIST(4, { customTemplates: T.slice(0, 2), templateOrder: 'sequential' }), BEFORE)
    expect(review.rows.map((r) => r.templateKey)).toEqual(['custom', 'custom_2', 'custom', 'custom_2'])
  })

  it('at random: the review and the start give every person the same template, and each person is sent exactly what was reviewed', async () => {
    const setup = await LIST(12, { customTemplates: T, templateOrder: 'random', shuffleSeed: 424242 })
    const review = await svc.reviewBulk(actor, setup, BEFORE)
    const again = await svc.reviewBulk(actor, setup, BEFORE)
    const keys = review.rows.map((r) => r.templateKey)
    expect(again.rows.map((r) => r.templateKey)).toEqual(keys)
    expect(new Set(keys).size).toBeGreaterThan(1) // really mixed, not one template for all
    expect(keys.join()).not.toBe('custom,custom_2,custom_3,custom,custom_2,custom_3,custom,custom_2,custom_3,custom,custom_2,custom_3')
    expect(review.templateOrder).toBe('random')

    await svc.startBulk(actor, { ...setup, confirm: true }, BEFORE)
    const stored = store.bulkEmailRecipient!
    expect(stored.map((r) => r.templateKey)).toEqual(keys)
    for (const [i, r] of review.rows.entries()) {
      expect(stored[i]!.bodyHtml).toBe(r.html)
      expect(stored[i]!.subject).toBe(r.subject)
    }
    for (let m = 0; m < 12 * 5; m += 5) await svc.dispatchBulkEmails(at(m))
    expect(sends).toHaveLength(12)
    for (const s of sends) {
      const r = stored.find((x) => x.toEmail === s.to)!
      expect(s.html).toBe(r.bodyHtml)
      expect(s.subject).toBe(r.subject)
      expect(s.text).toBe(r.body)
      expect(s.html).not.toContain('<pre')
    }
  })

  it('a different random order gives a different assignment (the browser picks a new seed for "Random")', async () => {
    const a = await svc.reviewBulk(actor, await LIST(12, { customTemplates: T, templateOrder: 'random', shuffleSeed: 1 }), BEFORE)
    const b = await svc.reviewBulk(actor, await LIST(12, { customTemplates: T, templateOrder: 'random', shuffleSeed: 2 }), BEFORE)
    expect(a.rows.map((r) => r.templateKey)).not.toEqual(b.rows.map((r) => r.templateKey))
  })

  it('a person who cannot be filled is skipped and does not use up a turn: the order continues with the next person', async () => {
    const file = await xlsx([HEADER, ['Co 1', 'u', 'Ann Lee', 'Owner', 'a@co1.test', '', '', '', ''], ['Co 2', 'u', '', 'Owner', 'b@co2.test', '', '', '', ''], ['Co 3', 'u', 'Cy Fox', 'Owner', 'c@co3.test', '', '', '', '']])
    const review = await svc.reviewBulk(actor, { ...(await LIST(1, { customTemplates: T, templateOrder: 'sequential' })), fileBase64: file }, BEFORE)
    expect(review.rows.map((r) => [r.status, r.templateKey])).toEqual([['ready', 'custom'], ['skipped', null], ['ready', 'custom_2']])
  })

  it('the files go on every email, whichever template it is; the campaign view says which template each person got', async () => {
    const att = await import('../../src/outreach/bulk/attachments.js')
    const pdf = await att.stageAttachment(actor, { fileName: 'Overview.pdf', contentBase64: Buffer.from('%PDF-1.4 y').toString('base64') }, BEFORE)
    const { campaignId } = await svc.startBulk(actor, { ...(await LIST(3, { customTemplates: T, templateOrder: 'sequential', attachmentIds: [pdf.id] })), confirm: true }, BEFORE)
    for (const m of [0, 5, 10]) await svc.dispatchBulkEmails(at(m))
    expect(sends).toHaveLength(3)
    for (const s of sends) expect(s.attachments).toEqual([{ filename: 'Overview.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4 y').toString('base64') }])
    const view = await svc.bulkView('t1', campaignId)
    expect(view.recipients.map((r) => r.ownTemplateNumber)).toEqual([1, 2, 3])
    expect(store.auditEvent!.some((e) => JSON.stringify(e).includes('3 own templates, in order'))).toBe(true)
  })

  it('one template in the list is exactly the single own template (as before)', async () => {
    const a = await svc.reviewBulk(actor, await LIST(3, { customTemplates: [T[0]] }), BEFORE)
    const b = await svc.reviewBulk(actor, await LIST(3, { customTemplate: T[0] }), BEFORE)
    expect(a.rows).toEqual(b.rows)
    expect(a.templateOrder).toBeNull()
  })

  it('what was taken out is said per template', async () => {
    const dirty = [T[0], { ...T[1]!, bodyHtml: T[1]!.bodyHtml + '<script>alert(1)</script>' }]
    const review = await svc.reviewBulk(actor, await LIST(2, { customTemplates: dirty, templateOrder: 'sequential' }), BEFORE)
    expect(review.templateNotes).toEqual(['template 2: scripts and active content'])
  })

  it('refused: more than 3 templates, both forms at once, random without its seed, an empty template (named by number) — nothing is created', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ customTemplates: [...T, T[0]] }, /At most 3 templates/],
      [{ customTemplates: T, customTemplate: T[0] }, /either one template or a list/],
      [{ customTemplates: T, templateOrder: 'random' }, /random order is missing/],
      [{ customTemplates: [T[0], { subject: 'S', bodyHtml: '' }] }, /^Template 2: Paste the body/],
      [{ customTemplates: [] }, /at least one template/],
    ]
    for (const [extra, msg] of cases) {
      await expect(svc.reviewBulk(actor, await LIST(2, extra), BEFORE)).rejects.toThrow(msg)
      await expect(svc.startBulk(actor, { ...(await LIST(2, extra)), confirm: true }, BEFORE)).rejects.toThrow(msg)
    }
    expect(store.bulkEmailCampaign).toEqual([])
    expect(store.bulkEmailRecipient).toEqual([])
  })

  it('the approved versions still rotate 1, 2, 3 as before', async () => {
    const review = await svc.reviewBulk(actor, await LIST(4), BEFORE)
    expect(review.rows.map((r) => r.templateKey)).toEqual(['static_site_v1', 'static_site_v2', 'static_site_v3', 'static_site_v1'])
    expect(review.templateOrder).toBeNull()
  })
})

// ── Follow-up campaigns (2026-10-15) ────────────────────────────────────────
// The same Excel file, uploaded again for a separately approved follow-up with
// DIFFERENT content: the people an earlier campaign emailed are no longer
// skipped. Still blocked: the same email twice, the approved first email again
// inside the cooldown, the same address twice in one send, an address queued
// elsewhere, an unknown outcome, and anyone on the opt-out list.
describe('follow-up campaigns to people an earlier campaign emailed', () => {
  const FILE = async () =>
    xlsx([
      HEADER,
      ['Alpha Co', 'u', 'Ann Lee', 'Owner', 'ann@alpha.test', '', '', '', ''],
      ['Bravo Co', 'u', 'Bob Ray', 'Owner', 'bob@bravo.test', '', '', '', ''],
      ['Charlie Co', 'u', 'Cy Fox', 'Owner', 'cy@charlie.test', '', '', '', ''],
    ])
  const FOLLOW_UP = { subject: 'Following up, [Company Name]', bodyHtml: '<p>Hi [First Name], following up on my earlier note — the overview is attached.</p>' }
  const OTHER = { subject: 'One more idea for [Company Name]', bodyHtml: '<p>Hi [First Name], one more idea for you.</p>' }
  const setup = async (day: string, extra: Record<string, unknown> = {}) => ({
    fileBase64: await FILE(),
    fileName: 'leads.xlsx',
    templateKey: 'static_site_v1',
    startDate: day,
    startTime: '10:00',
    intervalMinutes: 5,
    ...extra,
  })
  const run = async (day: string, n: number) => {
    for (let m = 0; m < n * 5; m += 5) await svc.dispatchBulkEmails(new Date(istToUtc(day, '10:00')!.getTime() + m * 60_000))
  }
  let sends: Array<{ key: string; to: string; subject: string; attachments?: unknown[] }>
  let outcomeFor: (to: string) => 'sent' | 'unknown'

  beforeEach(() => {
    env.BULK_SEND_VIA = 'crm'
    sends = []
    outcomeFor = () => 'sent'
    crmSend.setCrmBulkForTests({
      sender: async () => ({ ready: true, problem: null, name: 'Manoj S', fromEmail: 'manoj@altiusnxt.com', attachments: { maxFiles: 5, maxBytes: 10485760 } }),
      send: async (e) => {
        sends.push({ key: e.key, to: e.to, subject: e.subject, ...(e.attachments ? { attachments: e.attachments } : {}) })
        return outcomeFor(e.to) === 'sent'
          ? { outcome: 'sent', messageId: `gm-${sends.length}`, activityId: `act-${sends.length}`, fromEmail: 'manoj@altiusnxt.com', tracked: true, error: null }
          : { outcome: 'unknown', messageId: null, activityId: null, fromEmail: null, tracked: false, error: 'timeout' }
      },
      statuses: async () => [],
    })
  })
  afterEach(() => {
    env.BULK_SEND_VIA = 'smtp'
  })

  /** Campaign 1: the approved Versions 1-3 to all three, sent. */
  const firstCampaign = async () => {
    const { campaignId } = await svc.startBulk(actor, { ...(await setup('2026-10-10')), confirm: true }, new Date('2026-10-09T12:00:00Z'))
    await run('2026-10-10', 3)
    return campaignId
  }

  it('the same Excel file, a follow-up with different content and an attachment: everyone an earlier campaign emailed gets it; each campaign counts its own', async () => {
    const first = await firstCampaign()
    expect(sends.map((s) => s.to)).toEqual(['ann@alpha.test', 'bob@bravo.test', 'cy@charlie.test'])

    const att = await import('../../src/outreach/bulk/attachments.js')
    const pdf = await att.stageAttachment(actor, { fileName: 'Overview.pdf', contentBase64: Buffer.from('%PDF-1.4 f').toString('base64') }, new Date('2026-10-11T12:00:00Z'))
    const followUp = await setup('2026-10-12', { customTemplate: FOLLOW_UP, attachmentIds: [pdf.id] })
    const review = await svc.reviewBulk(actor, followUp, new Date('2026-10-11T12:00:00Z'))
    expect(review.rows.map((r) => [r.toEmail, r.status, r.reason])).toEqual([
      ['ann@alpha.test', 'ready', null],
      ['bob@bravo.test', 'ready', null],
      ['cy@charlie.test', 'ready', null],
    ])
    expect(review.rows.every((r) => r.note === 'Follow-up: last emailed on 2026-10-10.')).toBe(true)

    const { campaignId: second } = await svc.startBulk(actor, { ...followUp, confirm: true }, new Date('2026-10-11T12:00:00Z'))
    await run('2026-10-12', 3)
    const followUps = sends.slice(3)
    expect(followUps.map((s) => s.to)).toEqual(['ann@alpha.test', 'bob@bravo.test', 'cy@charlie.test'])
    expect(followUps.map((s) => s.subject)).toEqual(['Following up, Alpha Co', 'Following up, Bravo Co', 'Following up, Charlie Co'])
    for (const s of followUps) expect(s.attachments).toEqual([{ filename: 'Overview.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4 f').toString('base64') }])
    // Each email has its own send key (its own NXT Sales record and tracking), none shared with the first campaign.
    expect(new Set(sends.map((s) => s.key)).size).toBe(6)

    const v1 = await svc.bulkView('t1', first)
    const v2 = await svc.bulkView('t1', second)
    expect(v1.counts).toMatchObject({ sent: 3, failed: 0, skipped: 0, total: 3 })
    expect(v2.counts).toMatchObject({ sent: 3, failed: 0, skipped: 0, total: 3 })
  })

  it('the very same email is never sent twice: repeating the follow-up skips everyone who already got it', async () => {
    await firstCampaign()
    await svc.startBulk(actor, { ...(await setup('2026-10-12', { customTemplate: FOLLOW_UP })), confirm: true }, new Date('2026-10-11T12:00:00Z'))
    await run('2026-10-12', 3)
    const again = await svc.reviewBulk(actor, await setup('2026-10-14', { customTemplate: FOLLOW_UP }), new Date('2026-10-13T12:00:00Z'))
    expect(again.rows.every((r) => r.status === 'skipped' && /^Already sent this same email on 2026-10-12; a follow-up needs different content\.$/.test(r.reason!))).toBe(true)
    // …while a second follow-up with different content may go.
    const other = await svc.reviewBulk(actor, await setup('2026-10-14', { customTemplate: OTHER }), new Date('2026-10-13T12:00:00Z'))
    expect(other.rows.every((r) => r.status === 'ready')).toBe(true)
  })

  it('the approved first email (Versions 1-3) still goes once per cooldown: re-running it skips everyone, as before', async () => {
    await firstCampaign()
    const rerun = await svc.reviewBulk(actor, await setup('2026-10-12'), new Date('2026-10-11T12:00:00Z'))
    expect(rerun.rows.every((r) => r.status === 'skipped' && /^Already emailed by a bulk send on 2026-10-10/.test(r.reason!))).toBe(true)
  })

  it('within one send, the same address listed under two companies is emailed once', async () => {
    const file = await xlsx([
      HEADER,
      ['Alpha Co', 'u', 'Ann Lee', 'Owner', 'ann@alpha.test', '', '', '', ''],
      ['Alpha Holdings', 'u', 'Ann Lee', 'Owner', 'ann@alpha.test', '', '', '', ''],
      ['Bravo Co', 'u', 'Bob Ray', 'Owner', 'bob@bravo.test', '', '', '', ''],
    ])
    const s = { ...(await setup('2026-10-12', { customTemplate: FOLLOW_UP })), fileBase64: file }
    const review = await svc.reviewBulk(actor, s, new Date('2026-10-11T12:00:00Z'))
    expect(review.rows.map((r) => [r.companyName, r.status])).toEqual([['Alpha Co', 'ready'], ['Alpha Holdings', 'skipped'], ['Bravo Co', 'ready']])
    expect(review.rows[1]!.reason).toMatch(/already in this send/)
    await svc.startBulk(actor, { ...s, confirm: true }, new Date('2026-10-11T12:00:00Z'))
    await run('2026-10-12', 3)
    expect(sends.filter((x) => x.to === 'ann@alpha.test')).toHaveLength(1)
  })

  it('an earlier email with an unknown outcome still blocks that address in a follow-up (never resent blindly)', async () => {
    outcomeFor = (to) => (to === 'bob@bravo.test' ? 'unknown' : 'sent')
    await firstCampaign()
    const review = await svc.reviewBulk(actor, await setup('2026-10-12', { customTemplate: FOLLOW_UP }), new Date('2026-10-11T12:00:00Z'))
    expect(review.rows.find((r) => r.toEmail === 'bob@bravo.test')).toMatchObject({ status: 'skipped' })
    expect(review.rows.find((r) => r.toEmail === 'bob@bravo.test')!.reason).toMatch(/^Possibly already emailed/)
    expect(review.rows.filter((r) => r.status === 'ready').map((r) => r.toEmail)).toEqual(['ann@alpha.test', 'cy@charlie.test'])
  })

  it('an address still queued in another send is not added to a second one; the opt-out list still applies to follow-ups', async () => {
    await firstCampaign()
    await svc.startBulk(actor, { ...(await setup('2026-10-20', { customTemplate: FOLLOW_UP })), confirm: true }, new Date('2026-10-11T12:00:00Z')) // queued, not sent yet
    suppressed.add('cy@charlie.test')
    const review = await svc.reviewBulk(actor, await setup('2026-10-21', { customTemplate: OTHER }), new Date('2026-10-11T12:00:00Z'))
    expect(review.rows.find((r) => r.toEmail === 'ann@alpha.test')!.reason).toBe('Already queued in another bulk send.')
    expect(review.rows.find((r) => r.toEmail === 'cy@charlie.test')!.reason).toMatch(/^Already queued|^On the opt-out list/)
    suppressed.clear()
  })

  it('opt-out applies to a follow-up even when nothing else blocks it', async () => {
    await firstCampaign()
    suppressed.add('bob@bravo.test')
    const review = await svc.reviewBulk(actor, await setup('2026-10-12', { customTemplate: FOLLOW_UP }), new Date('2026-10-11T12:00:00Z'))
    expect(review.rows.find((r) => r.toEmail === 'bob@bravo.test')!.reason).toMatch(/^On the opt-out list/)
    suppressed.clear()
  })
})
