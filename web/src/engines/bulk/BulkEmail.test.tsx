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

function stub(opts: { sending?: typeof SENDING; sender?: Sender; saved?: Sender; tracking?: { enabled: boolean; reason: string | null } } = {}) {
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
    if (method === 'POST' && u.endsWith('/outreach/bulk/single/review')) return json({ ...SINGLE_REVIEW, sender, sending })
    if (method === 'POST' && u.endsWith('/outreach/bulk/single/start')) return json({ campaignId: 'bk1', scheduled: 1 }, 201)
    if (method === 'POST' && u.endsWith('/outreach/bulk/analyze')) return json(ANALYSIS)
    if (method === 'POST' && u.endsWith('/outreach/bulk/review')) return json({ ...REVIEW, sender, sending })
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
