import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react'
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

const SENDING: { enabled: boolean; mailboxConfigured: boolean; senders: string[]; reason: string | null } = { enabled: true, mailboxConfigured: true, senders: ['manoj@altiusnxt.com'], reason: null }
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
    { position: 0, companyName: 'Thermohvac', contactName: 'Maddie Stellick', toEmail: 'mstellick@thermohvac.com', ccEmails: ['mmurray@thermohvac.com'], rows: [2], subject: 'Are AI tools recommending Thermohvac?', text: TEXT, status: 'ready', reason: null, scheduledLocal: 'Sat, Oct 10, 2026, 10:00 AM IST' },
    { position: 1, companyName: 'Babsco', contactName: 'Steve Kile', toEmail: 'skile@babsco.com', ccEmails: [], rows: [5], subject: 'Are AI tools recommending Babsco?', text: 'Steve,', status: 'ready', reason: null, scheduledLocal: 'Sat, Oct 10, 2026, 10:05 AM IST' },
    { position: 2, companyName: 'Progressive power', contactName: 'hank', toEmail: 'hank@progressivepower.net', ccEmails: [], rows: [3], subject: null, text: null, status: 'skipped', reason: 'Said not interested', scheduledLocal: null },
  ],
  noAddress: ANALYSIS.noAddress,
  schedule: { timezone: 'Asia/Kolkata', startLocal: 'Sat, Oct 10, 2026, 10:00 AM IST', firstLocal: 'Sat, Oct 10, 2026, 10:00 AM IST', estimatedCompletionLocal: 'Sat, Oct 10, 2026, 10:05 AM IST', intervalMinutes: 5 },
  from: { email: 'manoj@altiusnxt.com' },
  sending: SENDING,
}
const DETAIL = {
  campaign: { id: 'bk1', name: 'leads — 2026-10-10', status: 'completed', templateKey: 'static_site_v1', fromEmail: 'manoj@altiusnxt.com', startLocal: 'Sat, Oct 10, 2026, 10:00 AM IST', intervalMinutes: 5, sourceFileName: 'leads.xlsx', createdAt: '2026-10-09T12:00:00Z', completedAt: '2026-10-10T04:40:00Z', completedLocal: 'Sat, Oct 10, 2026, 10:10 AM IST' },
  counts: { scheduled: 0, sending: 0, sent: 2, failed: 1, skipped: 1, total: 4 },
  recipients: [
    { id: 'r1', companyName: 'Thermohvac', contactName: 'Maddie Stellick', toEmail: 'mstellick@thermohvac.com', ccEmails: ['mmurray@thermohvac.com'], subject: 'Are AI tools recommending Thermohvac?', body: TEXT, status: 'sent', reason: null, scheduledLocal: 'Sat, Oct 10, 2026, 10:00 AM IST', sentLocal: 'Sat, Oct 10, 2026, 10:00 AM IST' },
    { id: 'r2', companyName: 'Armour Screw', contactName: 'Jeff', toEmail: 'jeff@armourscrew.com', ccEmails: [], subject: 's', body: 'b', status: 'failed', reason: '550 mailbox unavailable', scheduledLocal: 'Sat, Oct 10, 2026, 10:05 AM IST', sentLocal: null },
  ],
  sending: SENDING,
}

function stub(opts: { sending?: typeof SENDING } = {}) {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url: u, method, body: init.body ? JSON.parse(String(init.body)) : null })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    const sending = opts.sending ?? SENDING
    if (method === 'POST' && u.endsWith('/outreach/bulk/analyze')) return json(ANALYSIS)
    if (method === 'POST' && u.endsWith('/outreach/bulk/review')) return json({ ...REVIEW, sending })
    if (method === 'POST' && u.endsWith('/outreach/bulk/start')) return json({ campaignId: 'bk1', scheduled: 2, skipped: 1 }, 201)
    if (method === 'POST') return json({ ok: true })
    if (u.endsWith('/outreach/bulk/settings')) return json({ ...SETTINGS, sending })
    if (u.endsWith('/outreach/bulk/bk1')) return json(DETAIL)
    if (u.endsWith('/outreach/bulk')) return json({ campaigns: [{ ...DETAIL.campaign, counts: DETAIL.counts }], sending })
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
    expect(document.body.textContent).not.toMatch(/signature|postal address|time zone|sending hours|daily limit|Indianapolis|select compan/i)
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
    expect(preview.querySelector('pre')!.textContent).toBe(TEXT)
    expect(screen.getByText(/skipped — said not interested/i)).toBeInTheDocument()
    expect(posts().find((c) => c.url.endsWith('/review'))!.body).toMatchObject({ startTime: '10:00', intervalMinutes: 5 })
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
    expect(body).toMatchObject({ confirm: true, fromEmail: 'manoj@altiusnxt.com', startTime: '10:00', intervalMinutes: 5, templateKey: 'static_site_v1' })
    expect(Object.keys(body).sort()).toEqual(['allowWebmail', 'confirm', 'fileBase64', 'fileName', 'fromEmail', 'intervalMinutes', 'startDate', 'startTime', 'templateKey'])
  })

  it('cannot start while no sending mailbox is configured, and says why', async () => {
    stub({ sending: { enabled: false, mailboxConfigured: false, senders: [], reason: 'No sending mailbox is configured on the server.' } })
    await toSchedule()
    await userEvent.click(await screen.findByRole('checkbox', { name: /I reviewed these/i }))
    expect(screen.getByRole('button', { name: /approve and start sending/i })).toBeDisabled()
    expect(screen.getByText(/no sending mailbox is configured on the server\./i)).toBeInTheDocument()
  })
})

describe('a bulk email that has run', () => {
  it('says the sequence is completed, with the final summary, and offers unsubscribe', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /^open$/i }))
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
