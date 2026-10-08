import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

// BULK EMAIL UPLOAD (2026-10-07).
//
// The approved static template is used word for word, with only [First Name]
// and [Company Name] filled. One email per company: the first named person
// receives it and colleagues are copied; only work addresses are used; rows
// marked not interested or already contacted are skipped. 8:00 AM in
// Indianapolis is 8:00 AM in Indianapolis, emails are spaced by the interval,
// inside the sending hours, under the daily limit. The sender sends ONE at a
// time, a failure does not stop the rest, and the send completes.

// ── An in-memory store ─────────────────────────────────────────────────────
type Row = Record<string, unknown>
const store: Record<string, Row[]> = {}
const reset = () => {
  for (const k of ['bulkEmailCampaign', 'bulkEmailRecipient', 'suppressionEntry', 'auditEvent']) store[k] = []
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
  BULK_FROM_ADDRESSES: 'manoj@altiusnxt.test',
  BULK_MAX_PER_DAY: 200,
  OUTREACH_COOLDOWN_DAYS: 30,
}
vi.mock('../../src/config/env.js', () => ({ env }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
vi.mock('../../src/platform/audit.js', () => ({ audit: vi.fn(async (a: Row) => store.auditEvent!.push(a)) }))
const suppressed = new Set<string>()
vi.mock('../../src/outreach/suppression.js', () => ({
  checkSuppression: vi.fn(async (i: { destination: string | null }) => ({ suppressed: Boolean(i.destination && suppressed.has(i.destination)), detail: 'Opted out' })),
}))

const { composeBulkEmail, STATIC_SITE, OPT_OUT_LINE } = await import('../../src/outreach/bulk/template.js')
const { extractContacts, workAddress, firstNameOf, recipientsOf } = await import('../../src/outreach/bulk/extract.js')
const { localToUtc, planBulkSlots, fmtLocal } = await import('../../src/outreach/bulk/schedule.js')
const svc = await import('../../src/outreach/bulk/service.js')
const { setBulkSenderForTests } = await import('../../src/outreach/bulk/transport.js')

const INDY = 'America/Indiana/Indianapolis'
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
})

describe('the approved template, word for word', () => {
  it('changes nothing but [First Name] and [Company Name], then adds the signature and the opt-out footer', () => {
    const e = composeBulkEmail({ template: STATIC_SITE, firstName: 'Ed', companyName: 'First Electric Supply', signature: 'Manoj\nAltiusNxt', postalAddress: '1 Main St, Indianapolis, IN 46204' })
    expect(e.subject).toBe('Are AI tools recommending First Electric Supply?')
    const expected = STATIC_SITE.body.replace('[First Name]', 'Ed').split('\n').join('\n\n')
    expect(e.text).toBe(`${expected}\n\nManoj\nAltiusNxt\n\n--\n${OPT_OUT_LINE}\n1 Main St, Indianapolis, IN 46204`)
    expect(e.text).toContain("You didn't come up as a recommended supplier.")
    expect(e.unfilled).toEqual([])
    // The HTML part: the same words; "register here" links to the expo registration.
    expect(e.html).toContain('<a href="https://events.b2becommerceworld.org/')
    expect(e.html).toContain('>register here</a> with code ALTIUSVIP.')
  })

  it('reports a placeholder it could not fill, rather than sending it', () => {
    expect(composeBulkEmail({ template: STATIC_SITE, firstName: null, companyName: 'X', signature: '', postalAddress: 'a' }).unfilled).toEqual(['[First Name]'])
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

describe('the schedule, in the chosen US time zone', () => {
  const w = { tz: INDY, days: [1, 2, 3, 4, 5], startMinute: 8 * 60, endMinute: 17 * 60 }

  it('8:00 AM in Indianapolis is 8:00 AM in Indianapolis', () => {
    const at = localToUtc('2026-10-12', '08:00', INDY)!
    expect(at.toISOString()).toBe('2026-10-12T12:00:00.000Z')
    expect(fmtLocal(at, INDY)).toBe('Mon, Oct 12, 2026, 8:00 AM')
  })

  it('queues the emails one after another, interval minutes apart', () => {
    const slots = planBulkSlots(localToUtc('2026-10-12', '08:00', INDY)!, 4, 5, w, 100)
    expect(slots.map((s) => fmtLocal(s!, INDY).split(', ').pop())).toEqual(['8:00 AM', '8:05 AM', '8:10 AM', '8:15 AM'])
  })

  it('continues the next allowed day when the daily limit is reached, and skips the weekend', () => {
    const slots = planBulkSlots(localToUtc('2026-10-16', '08:00', INDY)!, 3, 5, w, 2) // a Friday
    expect(slots.map((s) => fmtLocal(s!, INDY))).toEqual(['Fri, Oct 16, 2026, 8:00 AM', 'Fri, Oct 16, 2026, 8:05 AM', 'Mon, Oct 19, 2026, 8:00 AM'])
  })

  it('stops at the end of the sending hours and carries on the next day', () => {
    const slots = planBulkSlots(localToUtc('2026-10-12', '16:50', INDY)!, 3, 5, w, 100)
    expect(slots.map((s) => fmtLocal(s!, INDY).replace('2026, ', ''))).toEqual(['Mon, Oct 12, 4:50 PM', 'Mon, Oct 12, 4:55 PM', 'Tue, Oct 13, 8:00 AM'])
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
    fromEmail: 'manoj@altiusnxt.test',
    fromName: 'Manoj | AltiusNxt',
    ccEmails: ['sales@altiusnxt.test'],
    signature: 'Manoj\nAltiusNxt',
    postalAddress: '1 Main St, Indianapolis, IN 46204',
    startDate: '2026-10-12',
    startTime: '08:00',
    timezone: INDY,
    sendStart: '08:00',
    sendEnd: '17:00',
    sendDays: [1, 2, 3, 4, 5],
    intervalMinutes: 5,
    dailyCap: 100,
    ...over,
  })
  const BEFORE = new Date('2026-10-11T12:00:00Z')

  it('Review shows every company, its To and CC, its email and its time — and writes nothing', async () => {
    const r = await svc.reviewBulk(actor, await setup(), BEFORE)
    expect(r.counts).toMatchObject({ validEmails: 3, skipped: 1, noWorkAddress: 1 })
    const thermo = r.rows.find((x) => x.companyName === 'Thermohvac')!
    expect(thermo).toMatchObject({ toEmail: 'mstellick@thermohvac.com', ccEmails: ['mmurray@thermohvac.com', 'sales@altiusnxt.test'], status: 'ready' })
    expect(thermo.text!.startsWith('Maddie,\n\nManoj here, from AltiusNxt.')).toBe(true)
    expect(r.rows.find((x) => x.companyName === 'Armour Screw')!.text!.startsWith('Jeff,')).toBe(true)
    expect(r.rows.filter((x) => x.status === 'ready').map((x) => x.scheduledLocal!.split(', ').pop())).toEqual(['8:00 AM', '8:05 AM', '8:10 AM'])
    expect(r.schedule.estimatedCompletionLocal).toBe('Mon, Oct 12, 2026, 8:10 AM')
    expect(store.bulkEmailCampaign).toHaveLength(0)
  })

  it('reviews before any sending mailbox is chosen, but will not start without one', async () => {
    const r = await svc.reviewBulk(actor, await setup({ fromEmail: '' }), BEFORE)
    expect(r.counts.validEmails).toBe(3)
    expect(r.from.email).toBeNull()
    await expect(svc.startBulk(actor, { ...(await setup({ fromEmail: '' })), confirm: true }, BEFORE)).rejects.toThrow(/Choose the From/)
    expect(store.bulkEmailCampaign).toHaveLength(0)
  })

  it('will not start without the confirmation, or from an address the server does not send as', async () => {
    await expect(svc.startBulk(actor, { ...(await setup()), confirm: false }, BEFORE)).rejects.toThrow(/Tick the confirmation/)
    await expect(svc.startBulk(actor, { ...(await setup({ fromEmail: 'dtlpmanikandan@gmail.com' })), confirm: true }, BEFORE)).rejects.toThrow(/not a configured sending address/)
    expect(store.bulkEmailCampaign).toHaveLength(0)
  })

  it('sends one email at a time, interval apart, records a failure and carries on, then completes', async () => {
    const sent: Array<{ to: string; cc: string[]; from: string; subject: string }> = []
    setBulkSenderForTests({
      send: async (e) => {
        if (e.to === 'jeff@armourscrew.com') throw new Error('550 mailbox unavailable')
        sent.push({ to: e.to, cc: e.cc, from: e.fromEmail, subject: e.subject })
        return { messageId: `m${sent.length}` }
      },
    })
    const { campaignId, scheduled } = await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    expect(scheduled).toBe(3)

    const at = (hhmm: string) => localToUtc('2026-10-12', hhmm, INDY)!
    // 7:59 — before the sending hours: nothing.
    await svc.dispatchBulkEmails(at('07:59'))
    expect(sent).toHaveLength(0)
    // 8:00 — the first. 8:02 — too soon after it, even though nothing else is due.
    await svc.dispatchBulkEmails(at('08:00'))
    await svc.dispatchBulkEmails(at('08:02'))
    expect(sent.map((s) => s.to)).toEqual(['mstellick@thermohvac.com'])
    expect(sent[0]).toMatchObject({ from: 'manoj@altiusnxt.test', cc: ['mmurray@thermohvac.com', 'sales@altiusnxt.test'], subject: 'Are AI tools recommending Thermohvac?' })
    // 8:05 — the second fails; it is recorded and the send carries on.
    await svc.dispatchBulkEmails(at('08:05'))
    await svc.dispatchBulkEmails(at('08:10'))
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
    await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    suppressed.add('mstellick@thermohvac.com')
    await svc.dispatchBulkEmails(localToUtc('2026-10-12', '08:00', INDY)!)
    expect(sent).toEqual([])
    expect(store.bulkEmailRecipient!.find((r) => r.toEmail === 'mstellick@thermohvac.com')).toMatchObject({ status: 'skipped' })
  })

  it('sends nothing at all while bulk sending is switched off', async () => {
    const sent: string[] = []
    setBulkSenderForTests({ send: async (e) => (sent.push(e.to), { messageId: 'm' }) })
    await svc.startBulk(actor, { ...(await setup()), confirm: true }, BEFORE)
    env.BULK_EMAIL_ENABLED = false
    try {
      await svc.dispatchBulkEmails(localToUtc('2026-10-12', '08:00', INDY)!)
      expect(sent).toEqual([])
    } finally {
      env.BULK_EMAIL_ENABLED = true
    }
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
