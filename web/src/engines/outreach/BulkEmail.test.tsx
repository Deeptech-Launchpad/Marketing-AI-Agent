import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../../lib/theme'
import { BulkEmail } from './BulkEmail'

// OUTREACH → BULK EMAIL (2026-10-07): upload → sender → schedule → review →
// approve and start. The sender is only ever a configured company mailbox;
// times are shown in 12-hour AM/PM in the chosen time zone (Indianapolis by
// default); nothing starts without the confirmation; a finished send says so.

const render = (ui: ReactElement) => rtlRender(<ThemeProvider><MemoryRouter>{ui}</MemoryRouter></ThemeProvider>)

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = []
const posts = () => calls.filter((c) => c.method === 'POST')

const SENDING: { enabled: boolean; mailboxConfigured: boolean; senders: string[]; reason: string | null; maxPerDay: number } = { enabled: true, mailboxConfigured: true, senders: ['manoj@altiusnxt.com'], reason: null, maxPerDay: 200 }
const SETTINGS = {
  sending: SENDING,
  templates: [{ key: 'static_site_v1', label: 'Static Site', subject: 'Are AI tools recommending [Company Name]?', body: '[First Name],\nManoj here, from AltiusNxt.', placeholders: ['[First Name]', '[Company Name]'] }],
  defaults: {},
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
const TEXT = 'Maddie,\n\nManoj here, from AltiusNxt.'
const REVIEW = {
  fileName: 'leads.xlsx',
  counts: { rowsWithCompany: 4, companies: 3, validEmails: 1, skipped: 1, noWorkAddress: 1 },
  rows: [
    { position: 0, companyName: 'Thermohvac', contactName: 'Maddie Stellick', toEmail: 'mstellick@thermohvac.com', ccEmails: ['mmurray@thermohvac.com'], rows: [2], subject: 'Are AI tools recommending Thermohvac?', text: TEXT, status: 'ready', reason: null, scheduledLocal: 'Mon, Oct 12, 2026, 8:00 AM' },
    { position: 1, companyName: 'Progressive power', contactName: 'hank', toEmail: 'hank@progressivepower.net', ccEmails: [], rows: [3], subject: null, text: null, status: 'skipped', reason: 'Said not interested', scheduledLocal: null },
  ],
  noAddress: ANALYSIS.noAddress,
  schedule: { timezone: 'America/Indiana/Indianapolis', startLocal: 'Mon, Oct 12, 2026, 8:00 AM', firstLocal: 'Mon, Oct 12, 2026, 8:00 AM', estimatedCompletionLocal: 'Mon, Oct 12, 2026, 8:00 AM', intervalMinutes: 5, dailyCap: 100 },
  from: { email: 'manoj@altiusnxt.com', name: null },
  sending: SENDING,
}
const DETAIL = {
  campaign: { id: 'bk1', name: 'leads — 2026-10-12', status: 'completed', fromEmail: 'manoj@altiusnxt.com', timezone: 'America/Indiana/Indianapolis', startLocal: 'Mon, Oct 12, 2026, 8:00 AM', sendHours: '8:00 AM – 5:00 PM', intervalMinutes: 5, dailyCap: 100, createdAt: '2026-10-12T12:00:00Z', completedLocal: 'Mon, Oct 12, 2026, 8:10 AM' },
  counts: { scheduled: 0, sending: 0, sent: 2, failed: 1, skipped: 1, total: 4 },
  recipients: [
    { id: 'r1', companyName: 'Thermohvac', contactName: 'Maddie Stellick', toEmail: 'mstellick@thermohvac.com', ccEmails: ['mmurray@thermohvac.com'], subject: 'Are AI tools recommending Thermohvac?', body: TEXT, status: 'sent', reason: null, scheduledLocal: 'Mon, Oct 12, 2026, 8:00 AM', sentLocal: 'Mon, Oct 12, 2026, 8:00 AM' },
    { id: 'r2', companyName: 'Armour Screw', contactName: 'Jeff', toEmail: 'jeff@armourscrew.com', ccEmails: [], subject: 's', body: 'b', status: 'failed', reason: '550 mailbox unavailable', scheduledLocal: 'Mon, Oct 12, 2026, 8:05 AM', sentLocal: null },
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
    if (method === 'POST' && u.endsWith('/outreach/bulk/start')) return json({ campaignId: 'bk1', scheduled: 1, skipped: 1 }, 201)
    if (method === 'POST') return json({ ok: true })
    if (u.endsWith('/outreach/bulk/settings')) return json({ ...SETTINGS, sending })
    if (u.endsWith('/outreach/bulk/bk1')) return json(DETAIL)
    if (u.endsWith('/outreach/bulk')) return json({ campaigns: [{ ...DETAIL.campaign, counts: DETAIL.counts }], sending })
    return json({ error: { code: 'not_found', message: 'none' } }, 404)
  })
}

async function toReview() {
  render(<BulkEmail canOperate canApprove />)
  await userEvent.click(await screen.findByRole('button', { name: /new bulk email/i }))
  const file = new File(['PK-fake-xlsx'], 'leads.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  await userEvent.upload(screen.getByLabelText(/excel file/i), file)
  expect(await screen.findByText(/companies with a valid work email address/i)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /next: sender/i }))
  await userEvent.type(screen.getByLabelText(/postal address/i), '1 Main St, Indianapolis, IN 46204')
  await userEvent.type(screen.getByLabelText(/^signature$/i), 'Manoj')
  await userEvent.click(screen.getByRole('button', { name: /next: schedule/i }))
  await userEvent.click(screen.getByRole('button', { name: /next: review/i }))
  await screen.findByText(/emails will be sent/i)
}

beforeEach(() => {
  calls = []
})

describe('a new bulk email', () => {
  it('reads the upload and shows the contacts and the number of valid addresses', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /new bulk email/i }))
    await userEvent.upload(screen.getByLabelText(/excel file/i), new File(['PK'], 'leads.xlsx'))
    expect(await screen.findByText('Thermohvac')).toBeInTheDocument()
    expect(screen.getByText(/skipped — said not interested/i)).toBeInTheDocument()
    const analyze = posts().find((c) => c.url.endsWith('/analyze'))!
    expect(analyze.body).toMatchObject({ fileName: 'leads.xlsx' })
    expect(typeof analyze.body!.fileBase64).toBe('string')
  })

  it('offers only the configured company mailbox as the sender', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /new bulk email/i }))
    await userEvent.upload(screen.getByLabelText(/excel file/i), new File(['PK'], 'leads.xlsx'))
    await userEvent.click(await screen.findByRole('button', { name: /next: sender/i }))
    const from = screen.getByText('From / sender email').closest('label')!.querySelector('select')!
    expect([...from.options].map((o) => o.value)).toEqual(['manoj@altiusnxt.com'])
    expect(document.body.textContent).not.toMatch(/dtlpmanikandan|Manikandan/)
  })

  it('schedules in Indianapolis time by default and shows times in AM/PM', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /new bulk email/i }))
    await userEvent.upload(screen.getByLabelText(/excel file/i), new File(['PK'], 'leads.xlsx'))
    await userEvent.click(await screen.findByRole('button', { name: /next: sender/i }))
    await userEvent.type(screen.getByLabelText(/postal address/i), '1 Main St')
    await userEvent.click(screen.getByRole('button', { name: /next: schedule/i }))
    const zone = screen.getByText('Time zone').closest('label')!.querySelector('select')!
    expect(zone.value).toBe('America/Indiana/Indianapolis')
    expect(screen.getByText('Start time (8:00 AM)')).toBeInTheDocument()
    expect(screen.getByText(/until \(5:00 PM\)/)).toBeInTheDocument()
  })

  it('reviews everything, and starts only after the confirmation, with the schedule chosen', async () => {
    stub()
    await toReview()
    expect(screen.getByText(/1 emails will be sent/i)).toBeInTheDocument()
    expect(screen.getByText(/estimated completion/i)).toBeInTheDocument()
    expect(within(screen.getByLabelText('Email preview')).getByText(/Are AI tools recommending Thermohvac\?/)).toBeInTheDocument()
    const start = screen.getByRole('button', { name: /approve and start sending/i })
    expect(start).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed this list/i }))
    await userEvent.click(start)
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/start'))).toBe(true))
    const body = posts().find((c) => c.url.endsWith('/start'))!.body!
    expect(body).toMatchObject({ confirm: true, fromEmail: 'manoj@altiusnxt.com', timezone: 'America/Indiana/Indianapolis', startTime: '08:00', intervalMinutes: 5, postalAddress: '1 Main St, Indianapolis, IN 46204', signature: 'Manoj' })
  })

  it('cannot start while no sending mailbox is configured, and says why', async () => {
    stub({ sending: { ...SENDING, enabled: false, senders: ['manoj@altiusnxt.com'], reason: 'Bulk sending is switched off on the server (BULK_EMAIL_ENABLED).' } })
    await toReview()
    await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed this list/i }))
    expect(screen.getByRole('button', { name: /approve and start sending/i })).toBeDisabled()
    expect(screen.getAllByText(/switched off on the server/i).length).toBeGreaterThan(0)
  })
})

describe('a bulk email that has run', () => {
  it('says the sequence is completed, with the final summary, and offers unsubscribe', async () => {
    stub()
    render(<BulkEmail canOperate canApprove />)
    await userEvent.click(await screen.findByRole('button', { name: /^open$/i }))
    expect(await screen.findByText('Bulk sequence completed')).toBeInTheDocument()
    expect(screen.getByText(/4 processed: 2 sent, 1 failed, 1 skipped/)).toBeInTheDocument()
    expect(screen.getByText('550 mailbox unavailable')).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: /unsubscribe/i })[0]!)
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/bulk/recipients/r1/unsubscribe'))).toBe(true))
  })
})
