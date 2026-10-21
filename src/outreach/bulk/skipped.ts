import ExcelJS from 'exceljs'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { fmtIst } from './schedule.js'

// THE SKIPPED COMPANIES OF ONE BULK SEND (2026-10-21).
//
// A read-only report: the recipients a bulk send did NOT email, with the reason
// each was skipped, to look at on the screen and to download as an Excel file.
// It writes nothing and sends nothing; the sending code is not involved.

export interface SkippedRow {
  /** 1-based place in the send's list. */
  no: number
  companyName: string
  contactName: string | null
  toEmail: string | null
  ccEmails: string[]
  /** Rows of the uploaded spreadsheet this company came from. */
  sourceRows: number[]
  status: string
  reason: string
  /** Extra status detail when there is one (the NXT Sales answer), else null. */
  detail: string | null
  skippedLocal: string
}

export interface SkippedReport {
  campaign: { id: string; name: string; sourceFileName: string | null; startLocal: string; status: string }
  counts: { total: number; sent: number; failed: number; skipped: number }
  rows: SkippedRow[]
}

const NO_REASON = 'No reason was recorded.'

const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [])
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * The skipped recipients of one send, or of the most recent bulk send made from
 * an Excel list (`id` = 'latest'; a one-person send is not counted as one).
 */
export async function skippedReport(tenantId: string, id: string): Promise<SkippedReport> {
  const c =
    id === 'latest'
      ? await prisma.bulkEmailCampaign.findFirst({
          where: { tenantId, OR: [{ sourceFileName: { not: null } }, { totalRows: { gt: 1 } }] },
          orderBy: { createdAt: 'desc' },
        })
      : await prisma.bulkEmailCampaign.findFirst({ where: { id, tenantId } })
  if (!c) throw new NotFoundError(id === 'latest' ? 'There is no bulk send yet.' : 'Bulk send not found.')

  const groups = await prisma.bulkEmailRecipient.groupBy({ by: ['status'], where: { campaignId: c.id }, _count: { _all: true } })
  const n = (st: string) => groups.find((g) => g.status === st)?._count._all ?? 0
  const skipped = await prisma.bulkEmailRecipient.findMany({ where: { campaignId: c.id, status: 'skipped' }, orderBy: { position: 'asc' } })

  return {
    campaign: { id: c.id, name: c.name, sourceFileName: c.sourceFileName, startLocal: fmtIst(c.startAt), status: c.status },
    counts: { total: groups.reduce((a, g) => a + g._count._all, 0), sent: n('sent'), failed: n('failed'), skipped: n('skipped') },
    rows: skipped.map((r) => ({
      no: r.position + 1,
      companyName: r.companyName,
      contactName: r.contactName,
      toEmail: r.toEmail,
      ccEmails: strings(r.ccEmails),
      sourceRows: numbers(r.sourceRows),
      status: r.status,
      reason: r.reason?.trim() || NO_REASON,
      detail: r.crmOutcome ? `NXT Sales: ${r.crmOutcome}` : null,
      skippedLocal: fmtIst(r.updatedAt),
    })),
  }
}

/** The report as an .xlsx file: a "Skipped" sheet to filter, and a "Summary" sheet. */
export async function skippedWorkbook(report: SkippedReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Marketing AI'

  const sheet = wb.addWorksheet('Skipped')
  sheet.columns = [
    { header: 'No.', key: 'no', width: 6 },
    { header: 'Company name', key: 'companyName', width: 34 },
    { header: 'Contact name', key: 'contactName', width: 24 },
    { header: 'Recipient email', key: 'toEmail', width: 38 },
    { header: 'CC', key: 'cc', width: 38 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Reason skipped', key: 'reason', width: 70 },
    { header: 'Status / error details', key: 'detail', width: 30 },
    { header: 'Row(s) in the uploaded sheet', key: 'rows', width: 16 },
    { header: 'Recorded (IST)', key: 'skippedLocal', width: 30 },
  ]
  for (const r of report.rows) {
    sheet.addRow({
      no: r.no,
      companyName: r.companyName,
      contactName: r.contactName ?? '',
      toEmail: r.toEmail ?? '',
      cc: r.ccEmails.join(', '),
      status: 'Skipped',
      reason: r.reason,
      detail: r.detail ?? '',
      rows: r.sourceRows.join(', '),
      skippedLocal: r.skippedLocal,
    })
  }
  sheet.getRow(1).font = { bold: true }
  sheet.getRow(1).alignment = { vertical: 'middle', wrapText: true }
  sheet.getColumn('reason').alignment = { wrapText: true, vertical: 'top' }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.autoFilter = { from: 'A1', to: 'J1' }

  const summary = wb.addWorksheet('Summary')
  summary.columns = [
    { header: 'Item', key: 'k', width: 26 },
    { header: 'Value', key: 'v', width: 60 },
  ]
  const { campaign: c, counts } = report
  for (const [k, v] of [
    ['Bulk email', c.name],
    ['Uploaded file', c.sourceFileName ?? '—'],
    ['Started (IST)', c.startLocal],
    ['Send status', c.status],
    ['Processed', counts.sent + counts.failed + counts.skipped],
    ['Sent', counts.sent],
    ['Failed', counts.failed],
    ['Skipped', counts.skipped],
    ['Total in the list', counts.total],
  ] as Array<[string, string | number]>) {
    summary.addRow({ k, v })
  }
  summary.getRow(1).font = { bold: true }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** A safe download name: ASCII letters, digits and dashes only. */
export function skippedFileName(report: SkippedReport, now = new Date()): string {
  const slug = report.campaign.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'bulk-email'
  return `skipped-companies-${slug}-${now.toISOString().slice(0, 10)}.xlsx`
}
