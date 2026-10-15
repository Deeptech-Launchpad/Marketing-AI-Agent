import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../../lib/theme'
import { BulkEmail } from './BulkEmail'

// OUTREACH → BULK EMAIL (2026-10-08), simple and standalone: upload Excel →
// review the emails → date, time (IST) and minutes between emails → approve
// and start. The email is the approved template only — no signature, no
// footer. No time zone, sending hours, days or daily limit. Nothing starts
// without the confirmation; a finished send says so.

const render = (ui: ReactElement) => rtlRender(<ThemeProvider><MemoryRouter>{ui}</MemoryRouter></ThemeProvider>)

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = []
const uploaded = new Map<string, { id: string; fileName: string; mimeType: string; sizeBytes: number }>()
const posts = () => calls.filter((c) => c.method === 'POST')

const SENDING: { enabled: boolean; mailboxConfigured: boolean; account: { email: string; source: 'bulk' | 'system' } | null; reason: string | null } = {
  enabled: true,
  mailboxConfigured: true,
  account: { email: 'dtlpmanikandan@gmail.com', source: 'system' },
  reason: null,
}
type Sender = { via?: 'smtp' | 'crm'; senderName?: string | null; fromEmail: string | null; ccEmails: string[]; signature: string; signatureHtml?: string; signatureRemoved?: string[]; check: { authorized: boolean; reason: string; warning: string | null; checkedLocal: string } | null; authorized: boolean; problem: string | null; account: typeof SENDING.account }
// A signature as Gmail copies it: a table with the logo and the details.
const SIG_HTML =
  '<table cellpadding="0" cellspacing="0"><tbody><tr><td style="padding-right:15px">Best Regards,<br /><img src="https://ci3.googleusercontent.com/mail-sig/logo" width="200" alt="AltiusNxt" /></td><td style="border-left:1px solid #555555;padding-left:15px"><b>Manoj S</b><br />Digital Commerce Lead<br />m: <a href="tel:+13134869697">+13134869697</a></td></tr></tbody></table>'
const SENDER_OK: Sender = {
  fromEmail: 'sales@example.org',
  ccEmails: ['team@example.org'],
  signature: 'Best Regards,\nAltiusNxt\nManoj S\nDigital Commerce Lead\nm: +13134869697',
  signatureHtml: SIG_HTML,
  signatureRemoved: [],
  check: { authorized: true, reason: 'Checked: Gmail sends as sales@example.org.', warning: null, checkedLocal: 'Thu, Oct 8, 2026, 11:00 AM IST' },
  authorized: true,
  problem: null,
  account: SENDING.account,
}
const DMARC = 'altiusnxt.com publishes a DMARC policy of "reject": receiving mail servers reject email that says it is from @altiusnxt.com unless altiusnxt.com’s own mail servers sent it.'
const SENDER_REFUSED: Sender = {
  ...SENDER_OK,
  fromEmail: 'sales@altiusnxt.com',
  check: { authorized: false, reason: DMARC, warning: null, checkedLocal: 'Thu, Oct 8, 2026, 11:00 AM IST' },
  authorized: false,
  problem: DMARC,
}
const SETTINGS = {
  sending: SENDING,
  templates: [{ key: 'static_site_v1', label: 'Static Site', subject: 'Are AI tools recommending [Company Name]?', body: '[First Name],\nManoj here, from AltiusNxt.', placeholders: ['[First Name]', '[Company Name]'] }],
}
const ANALYSIS = {
  fileName: 'leads.xlsx',
  totalRows: 4,
  columns: { company: 'Company Name', status: 'Status', contacts: [{ name: 'Contact Person 1', title: 'Title 1', email: 'Email Id1' }] },
  companies: [
    { key: 'thermohvac', companyName: 'Thermohvac', rows: [2], people: [{ name: 'Maddie Stellick', email: 'mstellick@thermohvac.com' }, { name: 'Mike Murray', email: 'mmurray@thermohvac.com' }], skip: null },
    { key: 'progressive', companyName: 'Progressive power', rows: [3], people: [{ name: 'hank', email: 'hank@progressivepower.net' }], skip: 'Said not interested' },
  ],
  noAddress: [{ row: 4, companyName: 'No Email Co', reason: 'No email address' }],
}
const TEXT = ['Maddie,', 'Manoj here, from AltiusNxt.', 'Would you like me to send it?'].join('\n\n')
const REVIEW = {
  fileName: 'leads.xlsx',
  counts: { rowsWithCompany: 4, companies: 3, validEmails: 2, skipped: 1, noWorkAddress: 1 },
  rows: [
    { position: 0, companyName: 'Thermohvac', contactName: 'Maddie Stellick', toEmail: 'mstellick@thermohvac.com', ccEmails: ['mmurray@thermohvac.com'], rows: [2], subject: 'Are AI tools recommending Thermohvac?', text: TEXT, html: `<div style="font-family:Verdana"><p>Maddie,</p><p>Manoj here, from AltiusNxt.</p><div><br></div><div>${SIG_HTML}</div></div>`, version: 1, status: 'ready', reason: null, scheduledLocal: 'Sat, Oct 10, 2026, 10:00 AM IST' },
    { position: 1, companyName: 'Babsco', contactName: 'Steve Kile', toEmail: 'skile@babsco.com', ccEmails: [], rows: [5], subject: 'What AI LLMs say about Babsco', text: 'Steve,', version: 2, status: 'ready', reason: null, scheduledLocal: 'Sat, Oct 10, 2026, 10:05 AM IST' },
    { position: 2, companyName: 'Progressive power', contactName: 'hank', toEmail: 'hank@progressivepower.net', ccEmails: [], rows: [3], subject: null, text: null, status: 'skipped', reason: 'Said not interested', scheduledLocal: null },
  ],
  noAddress: ANALYSIS.noAddress,
  schedule: { timezone: 'Asia/Kolkata', startLocal: 'Sat, Oct 10, 2026, 10:00 AM IST', firstLocal: 'Sat, Oct 10, 2026, 10:00 AM IST', estimatedCompletionLocal: 'Sat, Oct 10, 2026, 10:05 AM IST', intervalMinutes: 5 },
  from: { email: 'sales@example.org' },
  sender: SENDER_OK,
  sending: SENDING,
}
const DETAIL = {
  campaign: { id: 'bk1', name: 'leads — 2026-10-10', status: 'completed', statusReason: null, templateKey: 'static_site_v1', fromEmail: 'sales@example.org', startLocal: 'Sat, Oct 10, 2026, 10:00 AM IST', intervalMinutes: 5, sourceFileName: 'leads.xlsx', createdAt: '2026-10-09T12:00:00Z', completedAt: '2026-10-10T04:40:00Z', completedLocal: 'Sat, Oct 10, 2026, 10:10 AM IST' },
  counts: { scheduled: 0, sending: 0, sent: 2, failed: 1, skipped: 1, total: 4 },
  recipients: [
    { id: 'r1', companyName: 'Thermohvac', contactName: 'Maddie Stellick', toEmail: 'mstellick@thermohvac.com', ccEmails: ['mmurray@thermohvac.com'], subject: 'Are AI tools recommending Thermohvac?', body: TEXT, status: 'sent', reason: null, scheduledLocal: 'Sat, Oct 10, 2026, 10:00 AM IST', sentLocal: 'Sat, Oct 10, 2026, 10:00 AM IST' },
    { id: 'r2', companyName: 'Armour Screw', contactName: 'Jeff', toEmail: 'jeff@armourscrew.com', ccEmails: [], subject: 's', body: 'b', status: 'failed', reason: '550 mailbox unavailable', scheduledLocal: 'Sat, Oct 10, 2026, 10:05 AM IST', sentLocal: null },
  ],
  sending: SENDING,
}

const SINGLE_REVIEW = {
  toEmail: 'priya@acme.test',
  ccEmails: [],
  version: 3,
  subject: 'Quick note on AI search for Acme Supply',
  text: 'Priya,\n\nManoj from AltiusNxt here.',
  html: '<div style="font-family:Verdana"><p>Priya,</p><p>Manoj from AltiusNxt here.</p></div>',
  blocked: null,
  previouslySentLocal: null,
}

// A send with open tracking: three sent — one open detected, one not, one
// sent before tracking existed.
const TRACKED = {
  ...DETAIL,
  campaign: { ...DETAIL.campaign, id: 'bk2', name: 'tracked send' },
  counts: { scheduled: 0, sending: 0, sent: 3, failed: 0, skipped: 0, total: 3, opens: { sent: 3, openDetected: 1, noOpenDetected: 1, trackingUnavailable: 1 } },
  recipients: [
    { id: 't1', companyName: 'Alpha Co', contactName: 'Ann', toEmail: 'ann@alpha.test', ccEmails: [], subject: 's', body: 'b', status: 'sent', reason: null, scheduledLocal: 'x', sentLocal: 'Sat, Oct 10, 2026, 10:00 AM IST', version: 1, tracking: { status: 'open_detected', note: null, openCount: 3, firstOpenedLocal: 'Sat, Oct 10, 2026, 11:30 AM IST', lastOpenedLocal: 'Sat, Oct 10, 2026, 1:00 PM IST' } },
    { id: 't2', companyName: 'Bravo Co', contactName: 'Bob', toEmail: 'bob@bravo.test', ccEmails: [], subject: 's', body: 'b', status: 'sent', reason: null, scheduledLocal: 'x', sentLocal: 'Sat, Oct 10, 2026, 10:05 AM IST', version: 2, tracking: { status: 'no_open_detected', note: null, openCount: 0, firstOpenedLocal: null, lastOpenedLocal: null } },
    { id: 't3', companyName: 'Old Co', contactName: 'Olga', toEmail: 'olga@old.test', ccEmails: [], subject: 's', body: 'b', status: 'sent', reason: null, scheduledLocal: 'x', sentLocal: 'Fri, Oct 9, 2026, 10:00 AM IST', version: 1, tracking: { status: 'tracking_unavailable', note: 'Sent before open tracking existed.', openCount: 0, firstOpenedLocal: null, lastOpenedLocal: null } },
  ],
  openTracking: { enabled: true, reason: null },
}

function stub(opts: { sending?: typeof SENDING; sender?: Sender; saved?: Sender; tracking?: { enabled: boolean; reason: string | null }; singleBlocked?: string; attachmentProblem?: string; templateNotes?: string[] } = {}) {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url: u, method, body: init.body ? JSON.parse(String(init.body)) : null })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    const sending = opts.sending ?? SENDING
    const sender = opts.sender ?? SENDER_OK
    if (method === 'POST' && u.endsWith('/outreach/bulk/sender')) return json(opts.saved ?? sender)
    if (method === 'POST' && u.endsWith('/outreach/bulk/sender/check')) return json(sender)
    if (u.endsWith('/outreach/bulk/sender')) return json(sender)
    // Attachments (2026-10-12): stored one by one; the reviews echo the files they were given.
    const files = (ids: unknown) => ((ids as string[] | undefined) ?? []).map((id) => uploaded.get(id)).filter(Boolean)
    if (method === 'POST' && u.endsWith('/outreach/bulk/attachments')) {
      const b = JSON.parse(String(init.body)) as { fileName: string; contentBase64: string }
      const a = { id: `att${uploaded.size + 1}`, fileName: b.fileName, mimeType: 'application/pdf', sizeBytes: Math.round((b.contentBase64.length * 3) / 4) }
      uploaded.set(a.id, a)
      return json(a, 201)
    }
    if (method === 'DELETE' && u.includes('/outreach/bulk/attachments/')) return json({ id: u.split('/').pop(), removed: true })
    // Your own template (2026-10-12): the server returns the template filled for the person, with no version.
    const ownFill = (t: { subject: string; bodyHtml: string }, first: string, co: string) => ({
      subject: t.subject.replace('[Company Name]', co),
      html: t.bodyHtml.replace('[First Name]', first).replace('[Company Name]', co),
      text: `Hi ${first}`,
    })
    if (method === 'POST' && u.endsWith('/outreach/bulk/single/review')) {
      const b = JSON.parse(String(init.body)) as { attachmentIds?: string[]; customTemplate?: { subject: string; bodyHtml: string } }
      const own = b.customTemplate ? { ...ownFill(b.customTemplate, 'Priya', 'Acme Supply'), templateKey: 'custom', version: null, templateNotes: opts.templateNotes ?? [] } : {}
      return json({ ...SINGLE_REVIEW, ...own, blocked: opts.singleBlocked ?? null, sender, sending, attachments: files(b.attachmentIds) })
    }
    if (method === 'POST' && u.endsWith('/outreach/bulk/single/start')) return json({ campaignId: 'bk1', scheduled: 1 }, 201)
    if (method === 'POST' && u.endsWith('/outreach/bulk/analyze')) return json(ANALYSIS)
    if (method === 'POST' && u.endsWith('/outreach/bulk/review')) {
      const b = JSON.parse(String(init.body)) as {
        attachmentIds?: string[]
        customTemplate?: { subject: string; bodyHtml: string }
        customTemplates?: Array<{ subject: string; bodyHtml: string }>
        templateOrder?: 'sequential' | 'random'
      }
      // Several own templates (2026-10-14): the fake server gives them out in order over the ready rows.
      const list = b.customTemplates ?? (b.customTemplate ? [b.customTemplate] : [])
      let k = 0
      const rows = list.length
        ? REVIEW.rows.map((r) => {
            if (r.status !== 'ready') return r
            const n = k++ % list.length
            return { ...r, ...ownFill(list[n]!, r.contactName!.split(' ')[0]!, r.companyName), templateKey: n === 0 ? 'custom' : `custom_${n + 1}`, version: null }
          })
        : REVIEW.rows
      const templateOrder = list.length > 1 ? (b.templateOrder ?? 'sequential') : null
      return json({ ...REVIEW, rows, templateOrder, sender, sending, attachments: files(b.attachmentIds), attachmentProblem: opts.attachmentProblem ?? null, templateNotes: opts.templateNotes ?? [] })
    }
    if (method === 'POST' && u.endsWith('/outreach/bulk/start')) return json({ campaignId: 'bk1', scheduled: 2, skipped: 1 }, 201)
    if (method === 'POST') return json({ ok: true })
    if (u.endsWith('/outreach/bulk/settings')) return json({ ...SETTINGS, sending, sender })
    if (u.endsWith('/outreach/bulk/bk1')) return json(DETAIL)
    if (u.endsWith('/outreach/bulk/bk2')) return json(TRACKED)
    if (u.endsWith('/outreach/bulk'))
      return json({
        campaigns: [
          { ...TRACKED.campaign, counts: TRACKED.counts },
          { ...DETAIL.campaign, counts: DETAIL.counts },
        ],
        sending,
        openTracking: opts.tracking ?? { enabled: false, reason: 'No public HTTPS address is configured for open tracking (BULK_OPEN_TRACKING_BASE_URL).' },
      })
    return json({ error: { code: 'not_found', message: 'none' } }, 404)
  })
}

async function upload() {
  render(<BulkEmail canOperate canApprove />)
  await userEvent.click(await screen.findByRole('button', { name: /new bulk email/i }))
  await userEvent.upload(screen.getByLabelText(/excel file/i), new File(['PK-fake-xlsx'], 'leads.xlsx'))
  await screen.findByText('Thermohvac')
}

async function toSchedule() {
  await upload()
  await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
  await screen.findByLabelText('Email preview')
  await userEvent.click(screen.getByRole('button', { name: /next: date and time/i }))
}

const field = (text: string) => screen.getByText(text).closest('label')!.querySelector('input')!

beforeEach(() => {
  calls = []
  uploaded.clear()
})

describe('step 1: upload Excel', () => {
  it('reads the upload and shows the contacts and the number of valid addresses', async () => {
    stub()
    await upload()
    expect(screen.getByText(/skipped — said not interested/i)).toBeInTheDocument()
    expect(screen.getByText(/companies with a valid email address/i)).toBeInTheDocument()
    const analyze = posts().find((c) => c.url.endsWith('/analyze'))!
    expect(analyze.body).toMatchObject({ fileName: 'leads.xlsx', allowWebmail: false })
    expect(typeof analyze.body!.fileBase64).toBe('string')
  })

  it('has a test option for the team’s own webmail addresses — off unless ticked — and reads the file again with it', async () => {
    stub()
    await upload()
    const option = screen.getByRole('checkbox', { name: /include personal \/ webmail addresses/i })
    expect(option).not.toBeChecked()
    await userEvent.click(option)
    await waitFor(() => expect(posts().filter((c) => c.url.endsWith('/analyze')).pop()!.body).toMatchObject({ allowWebmail: true }))
  })

  it('shows three steps only, and nothing about senders, signatures, postal addresses or time zones', async () => {
    stub()
    await upload()
    expect(within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '1. Upload Excel',
      '2. Review emails',
      '3. Date, time and start',
    ])
    expect(document.body.textContent).not.toMatch(/postal address|time zone|sending hours|daily limit|Indianapolis|select compan/i)
  })
})

describe('step 2: review emails', () => {
  it('shows every company, its To and CC, and the email exactly as it will be sent', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    const preview = await screen.findByLabelText('Email preview')
    expect(within(preview).getByText(/Are AI tools recommending Thermohvac\?/)).toBeInTheDocument()
    expect(within(preview).getByText(/CC: mmurray@thermohvac.com/)).toBeInTheDocument()
    // The email as it will look, the pasted signature included.
    expect(preview.querySelector('.bulk-email-html table img')!.getAttribute('src')).toBe('https://ci3.googleusercontent.com/mail-sig/logo')
    expect(within(preview).getByText('Manoj S')).toBeInTheDocument()
    expect(screen.getByText(/skipped — said not interested/i)).toBeInTheDocument()
    expect(posts().find((c) => c.url.endsWith('/review'))!.body).toMatchObject({ startTime: '10:00', intervalMinutes: 5 })
  })
})

describe('versions in turn', () => {
  it('shows which approved version each person gets', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    const preview = await screen.findByLabelText('Email preview')
    expect(screen.getByRole('columnheader', { name: 'Version' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Version 2' })).toBeInTheDocument()
    expect(within(preview).getByText('Version 1')).toBeInTheDocument()
  })
})

describe('send to one person', () => {
  it('shows the warning and cannot send when that address was possibly already emailed', async () => {
    const WARNING =
      "Possibly already emailed: an earlier email to priya@acme.test was handed to NXT Sales on 2026-10-10 and its outcome is unknown, so it is not sent again. Check the sender's Sent folder in Gmail."
    stub({ singleBlocked: WARNING })
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /send to one person/i }))
    await userEvent.type(screen.getByLabelText('First name'), 'Priya')
    await userEvent.type(screen.getByLabelText('Company name'), 'Acme Supply')
    await userEvent.type(screen.getByLabelText('Email'), 'priya@acme.test')
    await userEvent.click(screen.getByRole('button', { name: /review the email/i }))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /approve sending it now/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve and send/i })).toBeDisabled()
    expect(posts().some((c) => c.url.endsWith('/single/start'))).toBe(false)
  })

  it('reviews the chosen version and sends it after the confirmation — no Excel file', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /send to one person/i }))
    await userEvent.type(screen.getByLabelText('First name'), 'Priya')
    await userEvent.type(screen.getByLabelText('Company name'), 'Acme Supply')
    await userEvent.type(screen.getByLabelText('Email'), 'priya@acme.test')
    await userEvent.selectOptions(screen.getByLabelText('Approved email'), 'static_site_v3')
    await userEvent.click(screen.getByRole('button', { name: /review the email/i }))
    const preview = await screen.findByLabelText('Email preview')
    expect(within(preview).getByText(/Quick note on AI search for Acme Supply/)).toBeInTheDocument()
    expect(within(preview).getByText('Version 3')).toBeInTheDocument()
    const send = screen.getByRole('button', { name: /approve and send/i })
    expect(send).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /approve sending it now/i }))
    await userEvent.click(send)
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/single/start'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/single/start'))!.body).toEqual({ firstName: 'Priya', companyName: 'Acme Supply', toEmail: 'priya@acme.test', ccEmails: [], templateKey: 'static_site_v3', confirm: true })
    expect(await screen.findByText('Bulk sequence completed')).toBeInTheDocument()
  })
})

describe('step 3: date, time (IST) and minutes between emails', () => {
  it('asks for only date, time and minutes — and shows each email’s time in IST', async () => {
    stub()
    await toSchedule()
    expect(field('Date').type).toBe('date')
    expect(field('Time, IST (10:00 AM)').value).toBe('10:00')
    expect(field('Minutes between emails').value).toBe('5')
    expect(screen.queryByText(/send from/i)).not.toBeInTheDocument()

    await userEvent.clear(field('Date'))
    await userEvent.type(field('Date'), '2026-10-10')
    await userEvent.clear(field('Minutes between emails'))
    await userEvent.type(field('Minutes between emails'), '5')
    await userEvent.click(screen.getByRole('button', { name: /show the sending times/i }))
    expect(await screen.findByText('Sat, Oct 10, 2026, 10:00 AM IST', { selector: 'td' })).toBeInTheDocument()
    expect(screen.getByText('Sat, Oct 10, 2026, 10:05 AM IST', { selector: 'td' })).toBeInTheDocument()
    expect(posts().filter((c) => c.url.endsWith('/review')).pop()!.body).toMatchObject({ startDate: '2026-10-10', startTime: '10:00', intervalMinutes: 5 })
  })

  it('starts only after the confirmation, with the date, time and minutes chosen', async () => {
    stub()
    await toSchedule()
    const start = await screen.findByRole('button', { name: /approve and start sending/i })
    expect(start).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed these 2 emails/i }))
    await userEvent.click(start)
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/start'))).toBe(true))
    const body = posts().find((c) => c.url.endsWith('/start'))!.body!
    expect(body).toMatchObject({ confirm: true, startTime: '10:00', intervalMinutes: 5, templateKey: 'static_site_v1' })
    // The From is the checked sender on the server — the screen sends no From of its own.
    expect(Object.keys(body).sort()).toEqual(['allowWebmail', 'confirm', 'fileBase64', 'fileName', 'intervalMinutes', 'startDate', 'startTime', 'templateKey'])
    expect(screen.queryByText(/dtlpmanikandan/)).not.toBeInTheDocument()
  })

  it('cannot start while no sending mailbox is configured, and says why', async () => {
    stub({ sending: { enabled: false, mailboxConfigured: false, account: null, reason: 'No sending mailbox is configured on the server.' } })
    await toSchedule()
    await userEvent.click(await screen.findByRole('checkbox', { name: /I reviewed these/i }))
    expect(screen.getByRole('button', { name: /approve and start sending/i })).toBeDisabled()
    expect(screen.getByText(/no sending mailbox is configured on the server\./i)).toBeInTheDocument()
  })
})

describe('the sender: From, CC and signature', () => {
  it('shows the From customers see, the CC and signature, and that it is authorized', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    expect(await screen.findByText('Authorized')).toBeInTheDocument()
    expect(screen.getByText('sales@example.org')).toBeInTheDocument()
    expect(screen.getByText('team@example.org')).toBeInTheDocument()
    expect(screen.getByText(/carried by the server’s SMTP account dtlpmanikandan@gmail.com \(the system account\) — customers see only the From above/i)).toBeInTheDocument()
  })

  it('saves the From, CC and signature, and shows the check’s answer — here, refused, with the reason', async () => {
    stub({ sender: { ...SENDER_OK, fromEmail: null, ccEmails: [], signature: '', check: null, authorized: false, problem: 'Set the From email for bulk emails.' }, saved: SENDER_REFUSED })
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /set sender/i }))
    await userEvent.type(screen.getByLabelText('From email'), 'sales@altiusnxt.com')
    await userEvent.type(screen.getByLabelText('CC emails'), 'a@altiusnxt.com, b@altiusnxt.com')
    // Paste the signature copied from Gmail into the (cleared) box.
    screen.getByRole('textbox', { name: 'Signature' }).innerHTML = ''
    fireEvent.paste(screen.getByRole('textbox', { name: 'Signature' }), { clipboardData: { getData: (t: string) => (t === 'text/html' ? SIG_HTML : ''), files: [] } })
    await userEvent.click(screen.getByRole('button', { name: /save and check sender/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/sender'))).toBe(true))
    const saved = posts().find((c) => c.url.endsWith('/outreach/bulk/sender'))!.body!
    expect(saved).toMatchObject({ fromEmail: 'sales@altiusnxt.com', ccEmails: ['a@altiusnxt.com', 'b@altiusnxt.com'] })
    const box = document.createElement('div')
    box.innerHTML = String(saved.signatureHtml)
    expect(box.querySelectorAll('table td')).toHaveLength(2)
    expect(box.querySelector('img')!.getAttribute('src')).toBe('https://ci3.googleusercontent.com/mail-sig/logo')
    expect(box.querySelector('td + td')!.getAttribute('style')).toBe('border-left:1px solid #555555;padding-left:15px')
    expect(box.querySelector('a')!.getAttribute('href')).toBe('tel:+13134869697')
    expect(await screen.findByText('Not authorized')).toBeInTheDocument()
    expect(screen.getByText(/DMARC policy of "reject"/)).toBeInTheDocument()
  })

  it('shows the saved signature as it will look in the email — logo and layout', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await screen.findByText('Authorized')
    const view = document.querySelector('.bulk-sig-view')!
    expect(view.querySelector('img')!.getAttribute('src')).toBe('https://ci3.googleusercontent.com/mail-sig/logo')
    expect(within(view as HTMLElement).getByText('Digital Commerce Lead', { exact: false })).toBeInTheDocument()
  })

  it('a pasted signature never brings code into the page', async () => {
    stub({ sender: { ...SENDER_OK, fromEmail: null, check: null, authorized: false, problem: 'Set the From email for bulk emails.' } })
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /set sender/i }))
    const box = screen.getByRole('textbox', { name: 'Signature' })
    box.innerHTML = ''
    fireEvent.paste(box, { clipboardData: { getData: (t: string) => (t === 'text/html' ? '<p onclick="steal()">Manoj</p><script>alert(1)</script><img src="x" onerror="alert(1)">' : ''), files: [] } })
    expect(box.innerHTML).toContain('Manoj')
    expect(box.innerHTML).not.toMatch(/onclick|script|onerror/)
  })

  it('cannot start while the From is not authorized, and says why', async () => {
    stub({ sender: SENDER_REFUSED })
    await toSchedule()
    await userEvent.click(await screen.findByRole('checkbox', { name: /I reviewed these/i }))
    expect(screen.getByRole('button', { name: /approve and start sending/i })).toBeDisabled()
    expect(screen.getAllByText(/DMARC policy of "reject"/).length).toBeGreaterThan(0)
  })

  it('only someone who can approve can change the sender', async () => {
    stub()
    render(<BulkEmail canOperate canApprove={false} />)
    await screen.findByText('Authorized')
    expect(screen.queryByRole('button', { name: /edit sender/i })).not.toBeInTheDocument()
  })
})

describe('email open tracking', () => {
  it('says when tracking is off, why, and that a privacy review comes first', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    expect(await screen.findByText(/Open tracking is off: No public HTTPS address is configured/)).toBeInTheDocument()
    expect(screen.getByText(/privacy policy\s+\/ consent wording should be reviewed/)).toBeInTheDocument()
  })

  it('shows opens per send, counted over the emails that carried tracking', async () => {
    stub({ tracking: { enabled: true, reason: null } })
    render(<BulkEmail canOperate canApprove />)
    expect(await screen.findByText('1 of 2 tracked')).toBeInTheDocument()
    expect(screen.getByText(/Open tracking is on for new emails/)).toBeInTheDocument()
  })

  it('shows each person: Open detected with first, last and count; No open detected; Tracking unavailable — and the totals', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click((await screen.findAllByRole('button', { name: /^open$/i }))[0]!)
    expect(await screen.findByLabelText('Open tracking')).toHaveTextContent('Emails sent 3 · Open detected 1 · No open detected 1 · Tracking unavailable 1')
    const rowOf = (email: string) => screen.getByText(email).closest('tr')!
    expect(within(rowOf('ann@alpha.test')).getByText('Open detected')).toBeInTheDocument()
    expect(within(rowOf('ann@alpha.test')).getByText('First Sat, Oct 10, 2026, 11:30 AM IST · last Sat, Oct 10, 2026, 1:00 PM IST · 3 detected')).toBeInTheDocument()
    expect(within(rowOf('bob@bravo.test')).getByText('No open detected')).toBeInTheDocument()
    expect(within(rowOf('olga@old.test')).getByText('Tracking unavailable')).toBeInTheDocument()
    expect(within(rowOf('olga@old.test')).getByText('Sent before open tracking existed.')).toBeInTheDocument()
    // Never "read" / "opened" as a certainty.
    expect(document.body.textContent).not.toMatch(/\b(was read|definitely opened|not opened|unopened)\b/i)
    expect(screen.getByText(/a signal, not proof of reading/)).toBeInTheDocument()
  })
})

describe('sending through NXT Sales', () => {
  it('asks for at least 5 minutes between emails', async () => {
    stub({ sender: { ...SENDER_OK, via: 'crm', senderName: 'Manoj S', fromEmail: 'manoj@altiusnxt.com', signature: '', signatureHtml: '', check: null, account: null } as Sender })
    await toSchedule()
    const minutes = screen.getByText('Minutes between emails').closest('label')!.querySelector('input')!
    expect(minutes.min).toBe('5')
    await userEvent.clear(minutes)
    await userEvent.type(minutes, '3')
    expect(screen.getByRole('button', { name: /show the sending times/i })).toBeDisabled()
    await userEvent.clear(minutes)
    await userEvent.type(minutes, '5')
    expect(screen.getByRole('button', { name: /show the sending times/i })).toBeEnabled()
  })

  const CRM_SENDER: Sender = { ...SENDER_OK, fromEmail: 'manoj@altiusnxt.com', signature: '', signatureHtml: '', check: null, authorized: true, problem: null, account: null }
  const viaCrm = { ...CRM_SENDER, via: 'crm', senderName: 'Manoj S' } as Sender

  it('shows NXT Sales’ Gmail sender and signature, and lets only the CC be changed', async () => {
    stub({ sender: viaCrm, saved: viaCrm, tracking: { enabled: true, reason: null, via: 'crm' } as never })
    render(<BulkEmail canOperate canApprove />)
    expect(await screen.findByText(/Sent through NXT Sales, from its configured Gmail sender \(Manoj S\)/)).toBeInTheDocument()
    expect(screen.getByText(/The Gmail account’s own signature, added by NXT Sales/)).toBeInTheDocument()
    expect(screen.getByText(/Emails are sent through NXT Sales, which tracks opens with its own tracking/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Edit CC' }))
    expect(screen.queryByLabelText('From email')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Signature' })).not.toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('CC emails'))
    await userEvent.type(screen.getByLabelText('CC emails'), 'team@altiusnxt.com')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/sender'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/outreach/bulk/sender'))!.body).toEqual({ ccEmails: ['team@altiusnxt.com'] })
  })

  it('says why sending cannot start when NXT Sales cannot send', async () => {
    stub({ sender: { ...viaCrm, fromEmail: null, authorized: false, problem: 'The configured sender (manoj@altiusnxt.com) has no Gmail connected in NXT Sales.' } as Sender })
    render(<BulkEmail canOperate canApprove />)
    expect(await screen.findByText(/has no Gmail connected in NXT Sales/)).toBeInTheDocument()
  })
})

describe('a bulk email that has run', () => {
  it('says the sequence is completed, with the final summary, and offers unsubscribe', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click((await screen.findAllByRole('button', { name: /^open$/i }))[1]!)
    expect(await screen.findByText('Bulk sequence completed')).toBeInTheDocument()
    expect(screen.getByText(/4 processed: 2 sent, 1 failed, 1 skipped/)).toBeInTheDocument()
    expect(screen.getByText(/one every 5 min/)).toBeInTheDocument()
    expect(screen.getByText('550 mailbox unavailable')).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: /unsubscribe/i })[0]!)
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/recipients/r1/unsubscribe'))).toBe(true))
  })
})

// Bulk Email is standalone: nothing in its folder comes from the One company
// or Several companies screens.
describe('a standalone workflow', () => {
  it('imports nothing from the other Outreach flows', () => {
    const sources = import.meta.glob('./*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(2)
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/from '([^']+)'/g)) expect(m[1], `${file}`).not.toMatch(/outreach\/|\.\.\/Outreach/)
    }
  })
})

describe('attachments (2026-10-12): upload once below the preview, the same files on every email', () => {
  const pdf = () => new File(['%PDF-1.4 overview'], 'overview.pdf', { type: 'application/pdf' })

  it('bulk: files added below the preview show in the preview and on the approval page, and go with Start', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    const preview = await screen.findByLabelText('Email preview')
    const section = screen.getByRole('region', { name: 'Attachments' })
    expect(within(section).getByText(/same files go with every email/i)).toBeInTheDocument()
    await userEvent.upload(within(section).getByLabelText('Choose files to attach'), pdf())
    expect(await within(section).findByRole('button', { name: /remove overview\.pdf/i })).toBeInTheDocument()
    expect(within(preview).getByText(/Attachments: overview\.pdf/)).toBeInTheDocument()
    expect(posts().find((c) => c.url.endsWith('/outreach/bulk/attachments'))!.body).toMatchObject({ fileName: 'overview.pdf' })

    await userEvent.click(screen.getByRole('button', { name: /next: date and time/i }))
    expect(await screen.findByText(/Attachments on every email: overview\.pdf/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed these 2 emails/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve and start sending/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/start'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/start'))!.body).toMatchObject({ attachmentIds: ['att1'], confirm: true })
  })

  it('bulk: without files, nothing about attachments is sent with Start', async () => {
    stub()
    await toSchedule()
    await userEvent.click(await screen.findByRole('checkbox', { name: /I reviewed these 2 emails/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve and start sending/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/start'))).toBe(true))
    expect('attachmentIds' in posts().find((c) => c.url.endsWith('/start'))!.body!).toBe(false)
  })

  it('a program or script is refused on the screen and never uploaded', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    const section = screen.getByRole('region', { name: 'Attachments' })
    await userEvent.upload(within(section).getByLabelText('Choose files to attach'), new File(['MZ'], 'setup.exe'), { applyAccept: false })
    expect(await within(section).findByRole('alert')).toHaveTextContent(/programs and scripts cannot be attached/)
    expect(posts().some((c) => c.url.endsWith('/outreach/bulk/attachments'))).toBe(false)
  })

  it('a file can be removed before sending', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    const section = screen.getByRole('region', { name: 'Attachments' })
    await userEvent.upload(within(section).getByLabelText('Choose files to attach'), pdf())
    await userEvent.click(await within(section).findByRole('button', { name: /remove overview\.pdf/i }))
    await waitFor(() => expect(within(section).queryByText(/overview\.pdf/)).not.toBeInTheDocument())
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/outreach/bulk/attachments/att1'))).toBe(true)
  })

  it('bulk: when NXT Sales cannot take attachments, the approval page says so and Start stays disabled', async () => {
    stub({ attachmentProblem: 'NXT Sales on this server cannot send attachments yet (it needs its update).' })
    await upload()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    await userEvent.upload(within(screen.getByRole('region', { name: 'Attachments' })).getByLabelText('Choose files to attach'), pdf())
    await screen.findByText(/Attachments: overview\.pdf/)
    await userEvent.click(screen.getByRole('button', { name: /next: date and time/i }))
    expect(await screen.findByText(/cannot send attachments yet/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed these 2 emails/i }))
    expect(screen.getByRole('button', { name: /approve and start sending/i })).toBeDisabled()
  })

  it('one person: two files added quickly — the preview and Approve use the review of BOTH files, never a stale one', async () => {
    stub()
    const realFetch = globalThis.fetch
    // The first re-review (one file) answers late; the second (two files) answers at once.
    let slowOnce = true
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const res = realFetch(url, init)
      if (String(url).endsWith('/single/review') && JSON.parse(String(init.body)).attachmentIds?.length === 1 && slowOnce) {
        slowOnce = false
        await new Promise((r) => setTimeout(r, 150))
      }
      return res
    })
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /send to one person/i }))
    await userEvent.type(screen.getByLabelText('First name'), 'Priya')
    await userEvent.type(screen.getByLabelText('Company name'), 'Acme Supply')
    await userEvent.type(screen.getByLabelText('Email'), 'priya@acme.test')
    await userEvent.click(screen.getByRole('button', { name: /review the email/i }))
    await screen.findByLabelText('Email preview')
    const input = within(screen.getByRole('region', { name: 'Attachments' })).getByLabelText('Choose files to attach')
    await userEvent.upload(input, [pdf(), new File(['%PDF-1.4 second'], 'second.pdf', { type: 'application/pdf' })])
    const preview = screen.getByLabelText('Email preview')
    await waitFor(() => expect(within(preview).getByText(/Attachments: overview\.pdf.*second\.pdf/)).toBeInTheDocument())
    await new Promise((r) => setTimeout(r, 300)) // the slow, older answer has arrived by now
    expect(within(screen.getByLabelText('Email preview')).getByText(/Attachments: overview\.pdf.*second\.pdf/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /approve sending it now/i }))
    expect(screen.getByRole('button', { name: /approve and send/i })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: /approve and send/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/single/start'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/single/start'))!.body).toMatchObject({ attachmentIds: ['att1', 'att2'] })
  })

  it('one person: a file added below the preview is reviewed again, shown, and sent with the email', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /send to one person/i }))
    await userEvent.type(screen.getByLabelText('First name'), 'Priya')
    await userEvent.type(screen.getByLabelText('Company name'), 'Acme Supply')
    await userEvent.type(screen.getByLabelText('Email'), 'priya@acme.test')
    await userEvent.click(screen.getByRole('button', { name: /review the email/i }))
    await screen.findByLabelText('Email preview')
    await userEvent.upload(within(screen.getByRole('region', { name: 'Attachments' })).getByLabelText('Choose files to attach'), pdf())
    const preview = await screen.findByLabelText('Email preview')
    expect(await within(preview).findByText(/Attachments: overview\.pdf/)).toBeInTheDocument()
    expect(posts().filter((c) => c.url.endsWith('/single/review')).pop()!.body).toMatchObject({ attachmentIds: ['att1'] })
    await userEvent.click(screen.getByRole('checkbox', { name: /approve sending it now/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve and send/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/single/start'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/single/start'))!.body).toMatchObject({ attachmentIds: ['att1'], confirm: true })
  })
})

describe('your own template (2026-10-12): paste it, see the complete email, approve it, the same email goes to everyone', () => {
  const BODY = '<p>Hi <b>[First Name]</b>,</p><p>Our own offer for [Company Name]: <a href="https://example.com/offer">see it</a>.</p>'
  const own = async () => {
    await userEvent.click(screen.getByRole('radio', { name: /use my own template/i }))
    await userEvent.type(screen.getByLabelText('Template subject'), 'Idea for [[Company Name]') // [[ types a literal [
    const box = screen.getByRole('textbox', { name: 'Template body' })
    box.innerHTML = BODY
    fireEvent.input(box)
  }

  it('offers the approved versions (default) or your own template; choosing your own shows a subject and a body box', async () => {
    stub()
    await upload()
    expect(screen.getByRole('radio', { name: /approved emails version 1, 2 and 3/i })).toBeChecked()
    expect(screen.queryByLabelText('Template subject')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /use my own template/i }))
    expect(screen.getByLabelText('Template subject')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Template body' })).toBeInTheDocument()
    expect(screen.getByText(/filled for\s+each person/i)).toBeInTheDocument()
  })

  it('cannot go to the review until the subject and the body are both entered', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('radio', { name: /use my own template/i }))
    const next = screen.getByRole('button', { name: /next: review emails/i })
    expect(next).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Template subject'), 'Idea')
    expect(next).toBeDisabled() // no body yet
    const box = screen.getByRole('textbox', { name: 'Template body' })
    box.innerHTML = '<p> </p>'
    fireEvent.input(box)
    expect(next).toBeDisabled() // a body with no text
    box.innerHTML = BODY
    fireEvent.input(box)
    expect(next).toBeEnabled()
  })

  it('shows the complete email in the preview, labelled as your template, and sends the template with the review and the start', async () => {
    stub()
    await upload()
    await own()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    const preview = await screen.findByLabelText('Email preview')
    expect(within(preview).getByText('Your template')).toBeInTheDocument()
    expect(within(preview).getByText(/Idea for Thermohvac/)).toBeInTheDocument()
    expect(within(preview).getByText('Maddie')).toBeInTheDocument() // the filled [First Name], inside the bold
    expect(within(preview).getByRole('link', { name: 'see it' })).toHaveAttribute('href', 'https://example.com/offer')
    expect(within(preview).queryByText(/Version/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('cell', { name: 'Your template' }).length).toBeGreaterThan(0)
    expect(posts().filter((c) => c.url.endsWith('/outreach/bulk/review')).pop()!.body).toMatchObject({ customTemplate: { subject: 'Idea for [Company Name]', bodyHtml: BODY } })

    await userEvent.click(screen.getByRole('button', { name: /next: date and time/i }))
    expect(await screen.findByText(/Your own template: every recipient gets this same email/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed these 2 emails/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve and start sending/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/start'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/start'))!.body).toMatchObject({ confirm: true, customTemplate: { subject: 'Idea for [Company Name]', bodyHtml: BODY } })
  })

  it('with the approved versions nothing about a template is sent', async () => {
    stub()
    await toSchedule()
    await userEvent.click(await screen.findByRole('checkbox', { name: /I reviewed these 2 emails/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve and start sending/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/start'))).toBe(true))
    expect('customTemplate' in posts().find((c) => c.url.endsWith('/start'))!.body!).toBe(false)
  })

  it('switching back to the approved versions drops the template from the request (and the typed text is kept if you return)', async () => {
    stub()
    await upload()
    await own()
    await userEvent.click(screen.getByRole('radio', { name: /approved emails version 1, 2 and 3/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    expect('customTemplate' in posts().filter((c) => c.url.endsWith('/outreach/bulk/review')).pop()!.body!).toBe(false)
  })

  it('a pasted template never brings code into the page', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('radio', { name: /use my own template/i }))
    const box = screen.getByRole('textbox', { name: 'Template body' })
    box.innerHTML = ''
    fireEvent.paste(box, { clipboardData: { getData: (t: string) => (t === 'text/html' ? '<p onclick="steal()"><b>Hi</b> [First Name]</p><script>alert(1)</script><img src="x" onerror="alert(1)">' : ''), files: [] } })
    expect(box.innerHTML).toContain('<b>Hi</b>')
    expect(box.innerHTML).not.toMatch(/onclick|script|onerror/)
  })

  it('says what the server took out of the pasted template, on the review', async () => {
    stub({ templateNotes: ['scripts and active content'] })
    await upload()
    await own()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    expect(await screen.findByText(/Taken out of your template for safety: scripts and active content/)).toBeInTheDocument()
  })

  it('changing the template after a review clears the review and the confirmation', async () => {
    stub()
    await upload()
    await own()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    await userEvent.click(screen.getAllByRole('button', { name: /^back$/i }).pop()!)
    await userEvent.type(screen.getByLabelText('Template subject'), ' now')
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    expect(posts().filter((c) => c.url.endsWith('/outreach/bulk/review')).pop()!.body).toMatchObject({ customTemplate: { subject: 'Idea for [Company Name] now' } })
  })

  it('one person: your own template replaces the version list, is reviewed in full, and the same email is sent after the approval', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /send to one person/i }))
    await userEvent.type(screen.getByLabelText('First name'), 'Priya')
    await userEvent.type(screen.getByLabelText('Company name'), 'Acme Supply')
    await userEvent.type(screen.getByLabelText('Email'), 'priya@acme.test')
    expect(screen.getByLabelText('Approved email')).toBeInTheDocument()
    await own()
    expect(screen.queryByLabelText('Approved email')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /review the email/i }))
    const preview = await screen.findByLabelText('Email preview')
    expect(within(preview).getByText('Your template')).toBeInTheDocument()
    expect(within(preview).getByText(/Idea for Acme Supply/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /approve sending it now/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve and send/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/single/start'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/single/start'))!.body).toMatchObject({ confirm: true, customTemplate: { subject: 'Idea for [Company Name]', bodyHtml: BODY } })
  })
})

describe('several own templates (2026-10-14): add 2-3 templates and choose in order or random', () => {
  const body = (n: number) => `<p>Hi <b>[First Name]</b>, this is template ${n}.</p>`
  const fill = async (n: number, label: string) => {
    await userEvent.type(screen.getByLabelText(`${label} subject`), `T${n} for [[Company Name]`) // [[ types a literal [
    const box = screen.getByRole('textbox', { name: `${label} body` })
    box.innerHTML = body(n)
    fireEvent.input(box)
  }
  const twoTemplates = async () => {
    await userEvent.click(screen.getByRole('radio', { name: /use my own template/i }))
    await fill(1, 'Template')
    await userEvent.click(screen.getByRole('button', { name: /add another template/i }))
    await fill(2, 'Template 2')
  }
  const lastReview = () => posts().filter((c) => c.url.endsWith('/outreach/bulk/review')).pop()!.body!

  it('one own template works as before; "Add another template" adds up to 3, each with its own subject and body; Remove takes one away', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('radio', { name: /use my own template/i }))
    expect(screen.queryByRole('radio', { name: /^in order/i })).not.toBeInTheDocument() // no order choice for one template
    await userEvent.click(screen.getByRole('button', { name: /add another template/i }))
    expect(screen.getByLabelText('Template 1 subject')).toBeInTheDocument()
    expect(screen.getByLabelText('Template 2 subject')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /add another template/i }))
    expect(screen.getByLabelText('Template 3 subject')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add another template/i })).not.toBeInTheDocument() // at most 3
    await userEvent.click(screen.getByRole('button', { name: /remove template 2/i }))
    expect(screen.queryByLabelText('Template 3 subject')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add another template/i })).toBeInTheDocument()
  })

  it('removing a template keeps what was typed in the others', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('radio', { name: /use my own template/i }))
    await userEvent.click(screen.getByRole('button', { name: /add another template/i }))
    await userEvent.click(screen.getByRole('button', { name: /add another template/i }))
    await fill(3, 'Template 3')
    await userEvent.click(screen.getByRole('button', { name: /remove template 1/i }))
    expect(screen.getByLabelText('Template 2 subject')).toHaveValue('T3 for [Company Name]')
    expect(screen.getByRole('textbox', { name: 'Template 2 body' }).innerHTML).toContain('this is template 3')
  })

  it('cannot review until every template has a subject and a body', async () => {
    stub()
    await upload()
    await userEvent.click(screen.getByRole('radio', { name: /use my own template/i }))
    await fill(1, 'Template')
    await userEvent.click(screen.getByRole('button', { name: /add another template/i }))
    const next = screen.getByRole('button', { name: /next: review emails/i })
    expect(next).toBeDisabled() // template 2 is empty
    await fill(2, 'Template 2')
    expect(next).toBeEnabled()
  })

  it('in order (the default): the request carries both templates and the order; the review and approval show which template each person gets', async () => {
    stub()
    await upload()
    await twoTemplates()
    expect(screen.getByRole('radio', { name: /^in order/i })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    expect(lastReview()).toMatchObject({
      customTemplates: [
        { subject: 'T1 for [Company Name]', bodyHtml: body(1) },
        { subject: 'T2 for [Company Name]', bodyHtml: body(2) },
      ],
      templateOrder: 'sequential',
    })
    expect('customTemplate' in lastReview()).toBe(false)
    expect('shuffleSeed' in lastReview()).toBe(false)
    expect(screen.getByRole('cell', { name: 'Your template 1' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Your template 2' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /next: date and time/i }))
    expect(await screen.findByText(/Your own templates, in order:\s*template 1 → 1 emails · template 2 → 1 emails/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed these 2 emails/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve and start sending/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/start'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/start'))!.body).toMatchObject({ confirm: true, customTemplates: lastReview().customTemplates, templateOrder: 'sequential' })
  })

  it('random: the same random order (seed) is used for the review and the start — what was reviewed is what is sent', async () => {
    stub()
    await upload()
    await twoTemplates()
    await userEvent.click(screen.getByRole('radio', { name: /^random/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    const seed = lastReview().shuffleSeed
    expect(lastReview()).toMatchObject({ templateOrder: 'random' })
    expect(Number.isInteger(seed)).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: /next: date and time/i }))
    expect(await screen.findByText(/Your own templates, at random/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed these 2 emails/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve and start sending/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/start'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/start'))!.body).toMatchObject({ templateOrder: 'random', shuffleSeed: seed })
  })

  it('changing the order after a review clears the review: the next one is asked for again', async () => {
    stub()
    await upload()
    await twoTemplates()
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    await userEvent.click(screen.getAllByRole('button', { name: /^back$/i }).pop()!)
    await userEvent.click(screen.getByRole('radio', { name: /^random/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    expect(lastReview()).toMatchObject({ templateOrder: 'random' })
  })

  it('back to one template: the request is exactly the single-template one again', async () => {
    stub()
    await upload()
    await twoTemplates()
    await userEvent.click(screen.getByRole('button', { name: /remove template 2/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: review emails/i }))
    await screen.findByLabelText('Email preview')
    expect(lastReview()).toMatchObject({ customTemplate: { subject: 'T1 for [Company Name]', bodyHtml: body(1) } })
    for (const k of ['customTemplates', 'templateOrder', 'shuffleSeed']) expect(k in lastReview()).toBe(false)
  })

  it('send to one person still has one template (no "Add another")', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /send to one person/i }))
    await userEvent.click(screen.getByRole('radio', { name: /use my own template/i }))
    expect(screen.getByLabelText('Template subject')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add another template/i })).not.toBeInTheDocument()
  })
})
