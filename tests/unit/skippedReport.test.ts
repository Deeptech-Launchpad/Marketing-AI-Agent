import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

// THE SKIPPED COMPANIES OF A BULK SEND (2026-10-21) — read-only report + Excel file.

type Row = Record<string, unknown>
let campaigns: Row[] = []
let recipients: Row[] = []

const prisma = {
  bulkEmailCampaign: {
    findFirst: vi.fn(async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
      let rows = campaigns.filter((c) => c.tenantId === where.tenantId && (where.id === undefined || c.id === where.id))
      if (where.OR) rows = rows.filter((c) => (c.sourceFileName != null) || (c.totalRows as number) > 1)
      if (orderBy) rows = [...rows].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
      return rows[0] ?? null
    }),
  },
  bulkEmailRecipient: {
    groupBy: vi.fn(async ({ where }: { where: Row }) => {
      const by = new Map<string, number>()
      for (const r of recipients.filter((x) => x.campaignId === where.campaignId)) by.set(r.status as string, (by.get(r.status as string) ?? 0) + 1)
      return [...by].map(([status, n]) => ({ status, _count: { _all: n } }))
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      recipients.filter((r) => r.campaignId === where.campaignId && r.status === where.status).sort((a, b) => (a.position as number) - (b.position as number)),
    ),
  },
}
vi.mock('../../src/platform/db.js', () => ({ prisma }))

const { skippedReport, skippedWorkbook, skippedFileName } = await import('../../src/outreach/bulk/skipped.js')

const campaign = (id: string, over: Row = {}): Row => ({
  id,
  tenantId: 't1',
  name: `Send ${id}`,
  sourceFileName: 'list.xlsx',
  totalRows: 3,
  status: 'completed',
  startAt: new Date('2026-10-17T14:55:00Z'),
  createdAt: new Date('2026-10-17T10:00:00Z'),
  ...over,
})
const recipient = (campaignId: string, position: number, status: string, over: Row = {}): Row => ({
  id: `${campaignId}-${position}`,
  campaignId,
  position,
  status,
  companyName: `Co ${position}`,
  contactName: null,
  toEmail: `c${position}@co${position}.com`,
  ccEmails: [],
  sourceRows: [position + 2],
  reason: null,
  crmOutcome: null,
  updatedAt: new Date('2026-10-17T15:00:00Z'),
  ...over,
})

beforeEach(() => {
  campaigns = []
  recipients = []
})

describe('skippedReport', () => {
  it('returns only the skipped recipients, with company, email, reason and status details', async () => {
    campaigns = [campaign('c1')]
    recipients = [
      recipient('c1', 0, 'sent'),
      recipient('c1', 1, 'skipped', { companyName: 'Athena Supply', toEmail: 'info@athena-supply.com', reason: 'No contact name, so the greeting [First Name] cannot be filled.' }),
      recipient('c1', 2, 'skipped', { reason: null, crmOutcome: 'failed', ccEmails: ['a@x.com'] }),
      recipient('c1', 3, 'failed'),
    ]
    const r = await skippedReport('t1', 'c1')
    expect(r.counts).toEqual({ total: 4, sent: 1, failed: 1, skipped: 2 })
    expect(r.rows.map((x) => x.companyName)).toEqual(['Athena Supply', 'Co 2'])
    expect(r.rows[0]).toMatchObject({ no: 2, toEmail: 'info@athena-supply.com', status: 'skipped', reason: 'No contact name, so the greeting [First Name] cannot be filled.', detail: null })
    expect(r.rows[1]).toMatchObject({ reason: 'No reason was recorded.', detail: 'NXT Sales: failed', ccEmails: ['a@x.com'], sourceRows: [4] })
  })

  it("'latest' is the most recent bulk send from an Excel list — a one-person send is not it", async () => {
    campaigns = [
      campaign('old', { createdAt: new Date('2026-10-10T10:00:00Z') }),
      campaign('new', { createdAt: new Date('2026-10-17T10:00:00Z') }),
      campaign('single', { createdAt: new Date('2026-10-20T10:00:00Z'), sourceFileName: null, totalRows: 1 }),
    ]
    expect((await skippedReport('t1', 'latest')).campaign.id).toBe('new')
  })

  it('does not read another tenant’s send, and says so when there is none', async () => {
    campaigns = [campaign('c1', { tenantId: 'other' })]
    await expect(skippedReport('t1', 'c1')).rejects.toThrow('Bulk send not found.')
    await expect(skippedReport('t1', 'latest')).rejects.toThrow('There is no bulk send yet.')
  })

  it('never writes anything', async () => {
    campaigns = [campaign('c1')]
    recipients = [recipient('c1', 0, 'skipped', { reason: 'x' })]
    await skippedReport('t1', 'c1')
    expect(Object.keys(prisma.bulkEmailCampaign)).toEqual(['findFirst'])
    expect(Object.keys(prisma.bulkEmailRecipient).sort()).toEqual(['findMany', 'groupBy'])
  })
})

describe('skippedWorkbook', () => {
  it('writes a Skipped sheet and a Summary sheet', async () => {
    campaigns = [campaign('c1', { name: 'Evolution Motion — Oct 17' })]
    recipients = [
      recipient('c1', 0, 'sent'),
      recipient('c1', 1, 'skipped', { companyName: 'Athena Supply', toEmail: 'info@athena-supply.com', reason: 'No contact name', sourceRows: [3, 4] }),
    ]
    const report = await skippedReport('t1', 'c1')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await skippedWorkbook(report)) as unknown as ArrayBuffer)

    const sheet = wb.getWorksheet('Skipped')!
    expect(sheet.getRow(1).values).toEqual([undefined, 'No.', 'Company name', 'Contact name', 'Recipient email', 'CC', 'Status', 'Reason skipped', 'Status / error details', 'Row(s) in the uploaded sheet', 'Recorded (IST)'])
    expect(sheet.rowCount).toBe(2)
    expect(sheet.getRow(2).getCell(2).value).toBe('Athena Supply')
    expect(sheet.getRow(2).getCell(4).value).toBe('info@athena-supply.com')
    expect(sheet.getRow(2).getCell(6).value).toBe('Skipped')
    expect(sheet.getRow(2).getCell(7).value).toBe('No contact name')
    expect(sheet.getRow(2).getCell(9).value).toBe('3, 4')

    const summary = wb.getWorksheet('Summary')!
    const cells = new Map<string, unknown>()
    summary.eachRow((row) => cells.set(String(row.getCell(1).value), row.getCell(2).value))
    expect(cells.get('Skipped')).toBe(1)
    expect(cells.get('Sent')).toBe(1)
  })

  it('names the download safely', async () => {
    campaigns = [campaign('c1', { name: '../Evolution "Motion" — Oct 17' })]
    const name = skippedFileName(await skippedReport('t1', 'c1'), new Date('2026-10-21T00:00:00Z'))
    expect(name).toBe('skipped-companies-Evolution-Motion-Oct-17-2026-10-21.xlsx')
  })
})
