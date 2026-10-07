import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { Outreach } from './Outreach'

// TEST MODE ON THE OUTREACH SCREEN (2026-09-28).
//
// The banner always says whether sending is off or in test mode; a test batch
// is created from companies that are ready, and nothing is sent until each
// email is approved; a test email offers no Copy / mail-app / Mark-as-sent,
// only a test to the reviewer's own internal inbox; and no control on the page
// starts with "Send".

const COMPANY = { crmCompanyId: 'c-acme', companyName: 'Acme Safety' }
vi.mock('../lib/companyContext', () => ({ useCompany: () => ({ company: COMPANY, select: vi.fn() }) }))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    principal: { crmUserId: 'u1', email: 'sam@altius.test', name: 'Sam', role: 'admin', permissions: ['view', 'operate', 'approve', 'admin'] },
  }),
}))

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = []
const posts = () => calls.filter((c) => c.method === 'POST')

const SENDING_TEST = { mode: 'test', transport: 'capture', ready: true, reason: null, testInbox: 'qa@altius.test', allowList: ['qa@altius.test'] }
const SENDING_OFF = { mode: 'off', transport: 'capture', ready: false, reason: 'Sending is off.', testInbox: null, allowList: [] }

const BATCH = {
  id: 'b1',
  name: 'Ohio rehearsal',
  mode: 'test',
  status: 'running',
  firstSendAt: '2026-09-29T13:00:00.000Z',
  timezone: 'America/New_York',
  sendDays: [1, 2, 3, 4, 5],
  sendStart: '09:00',
  sendEnd: '17:00',
  spacingMinutes: 10,
  dailyCap: 20,
  createdByCrmUserId: 'u1',
  createdAt: '2026-09-28T10:00:00.000Z',
}

const stage = (stageKey: string, pdfRef: string, label: string, over: Record<string, unknown> = {}) => ({
  stageKey,
  pdfRef,
  label,
  track: stageKey === 'initial' ? 'initial' : 'no_reply',
  stageStatus: 'upcoming',
  reason: null,
  window: null,
  actionId: null,
  actionStatus: null,
  statusReason: null,
  scheduledAt: null,
  sentAt: null,
  sentVia: null,
  lastAttempt: null,
  ...over,
})

const BATCH_VIEW = {
  batch: BATCH,
  sending: SENDING_TEST,
  companies: [
    {
      campaignId: 'tc1',
      crmCompanyId: 'c-acme',
      companyName: 'Acme Safety',
      status: 'active',
      statusReason: null,
      intendedRecipient: 'jane@acme.test',
      phase: 'initial',
      stages: [
        stage('initial', '1', 'Initial email', { actionId: 'a1', actionStatus: 'scheduled', stageStatus: 'scheduled', scheduledAt: '2026-09-29T13:00:00.000Z' }),
        stage('noreply_followup', '2.3', 'No-reply follow-up'),
        stage('noreply_report', '2.4', 'No-reply report'),
        stage('expo_invite', '3', 'Expo invite'),
        stage('breakup', '4', 'Break-up'),
      ],
    },
  ],
}

// A several-company send (2026-10-07): real, sent by the person when due.
const SEND_BODY = 'Jane,\n\nAda here, from AltiusNxt.\n\nAda\nada@altius.test'
const SEND_VIEW = {
  batch: { ...BATCH, id: 'b3', name: 'October send', mode: 'manual' },
  companies: [],
  sending: SENDING_TEST,
  emails: [
    { campaignId: 'k1', crmCompanyId: 'c-acme', companyName: 'Acme Safety', recipientEmail: 'jane@acme.test', version: 'v1', actionId: 'x1', state: 'due', statusReason: null, scheduledAt: '2026-10-07T13:00:00.000Z', sentAt: null, subject: 'Who AI recommends instead of Acme Safety for Titan Hard Hat X200?', body: SEND_BODY },
    { campaignId: 'k2', crmCompanyId: 'c-mailbox', companyName: 'Bonnici Stores Ltd', recipientEmail: 'info@bonnicistores.com', version: 'v2', actionId: 'x2', state: 'scheduled', statusReason: null, scheduledAt: '2026-10-08T13:10:00.000Z', sentAt: null, subject: 'Ran a test', body: 'Hi' },
  ],
}

function previewFor(id: string, typed?: string, name?: string) {
  const known: Record<string, { name: string; to: string | null }> = {
    'c-acme': { name: 'Acme Safety', to: 'jane@acme.test' },
    'c-mailbox': { name: 'Bonnici Stores Ltd', to: 'info@bonnicistores.com' },
    'c-noemail': { name: 'Central Cleaning', to: null },
    'c-none': { name: 'Nobody Inc', to: null },
  }
  const k = known[id] ?? { name: id, to: null }
  const noName = id === 'c-none' && !name
  return {
    crmCompanyId: id,
    companyName: k.name,
    version: 'v1',
    recipientEmail: typed ?? k.to,
    recipientEmailSource: typed ? 'sales_entered' : 'decision_maker',
    decisionMaker: null,
    subject: `Who AI recommends instead of ${k.name} for Titan Hard Hat X200?`,
    body: `${noName ? '[Name]' : name ?? 'Jane'},\n\nAda here, from AltiusNxt.`,
    problems: noName ? ['Every placeholder is filled: Still unfilled: [Name].'] : [],
    fillable: noName ? ['name'] : [],
  }
}

const BODY = 'Jane,\n\nAda here, from AltiusNxt.\n\nThanks,\nAda'
function testView(status: string) {
  return {
    crmCompanyId: 'c-acme',
    facts: { companyName: 'Acme Safety', companyDomain: 'acme.test', companySummary: null, decisionMaker: { id: 'dm1', fullName: 'Jane Smith', title: null, email: 'jane@acme.test', profileUrl: null }, product: null, signals: [], discovered: false },
    gate: { ready: true, reason: null },
    sender: { configured: true, firstName: 'Ada', fullName: 'Ada Lovelace', email: 'ada@altius.test', companyName: 'AltiusNxt', signature: '' },
    campaign: { id: 'tc1', status: 'active', statusReason: null, initialVersion: 'v1', versionSource: 'auto_rotation', recipientEmail: 'jane@acme.test', recipientEmailSource: 'decision_maker', startedAt: '2026-09-28T10:00:00.000Z', isTest: true, batchId: 'b1' },
    sequence: {
      phase: 'initial',
      initialSentAt: null,
      next: { stageKey: 'initial', text: '1 Initial email: Scheduled — the test sender sends it to the internal test inbox at its time.', window: null, overdue: false },
      reminders: [],
      stages: [{ stageKey: 'initial', label: 'Initial email', pdfRef: '1', track: 'initial', status: 'scheduled', window: null, reason: null, canPrepare: false }],
    },
    drafts: [
      {
        actionId: 'a1', stageKey: 'initial', label: 'Initial email', pdfRef: '1', version: 'v1', status, statusReason: null,
        recipient: 'jane@acme.test', recipientSource: 'decision_maker', contactName: 'Jane Smith', contactTitle: null,
        subject: 'Hello', body: BODY, draftSubject: 'Hello', draftBody: BODY, edited: false, revision: 1, templateKey: 'initial.v1',
        inputs: {}, attestations: [], attestationDefs: [], requiredInputs: [], needsConfirmedSkus: false, mentionsExpo: false,
        personalization: null, dueStartAt: null, dueEndAt: null, approvedAt: '2026-09-28T11:00:00.000Z', approvedByCrmUserId: 'u1',
        sentAt: null, sentByCrmUserId: null, sentVia: null, scheduledAt: status === 'scheduled' ? '2026-09-29T13:00:00.000Z' : null,
        attempts: [
          { id: 't1', at: '2026-09-28T11:05:00.000Z', kind: 'preview', mode: 'test', status: 'accepted', intendedRecipient: 'jane@acme.test', actualRecipients: ['sam@altius.test'], transport: 'capture', providerMessageId: 'x', error: null },
        ],
        gates: { ok: true, items: [], warnings: [] },
      },
    ],
    callPoints: null,
    replies: [],
    history: [],
  }
}

function stub(opts: { sending?: unknown; draftStatus?: string } = {}) {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url: u, method, body: init.body ? JSON.parse(String(init.body)) : null })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (method === 'POST' && /\/batches$/.test(u)) {
      return json({ batchId: 'b2', created: 1, results: [{ crmCompanyId: 'c-acme', ok: true, campaignId: 'tc9', plannedAt: '2026-09-29T13:00:00.000Z', error: null }] }, 201)
    }
    if (method === 'POST' && /\/batches\/preview$/.test(u)) {
      const b = (init.body ? JSON.parse(String(init.body)) : {}) as { crmCompanyIds: string[]; recipients?: Record<string, string>; names?: Record<string, string> }
      return json({ emails: b.crmCompanyIds.map((id) => previewFor(id, b.recipients?.[id], b.names?.[id])), sending: SENDING_TEST })
    }
    if (method === 'POST' && /\/batches\/send$/.test(u)) {
      const b = (init.body ? JSON.parse(String(init.body)) : {}) as { crmCompanyIds: string[] }
      return json({ batchId: 'b3', scheduled: b.crmCompanyIds.length, results: b.crmCompanyIds.map((id) => ({ crmCompanyId: id, companyName: id, ok: true, scheduledAt: '2026-10-08T13:00:00.000Z', error: null })) }, 201)
    }
    if (method === 'POST' && /\/test-send$/.test(u)) return json({ status: 'accepted', to: ['sam@altius.test'], transport: 'capture', error: null })
    if (method === 'POST') return json({ ok: true })
    if (/\/outreach\/sequence\/sending$/.test(u)) return json(opts.sending ?? SENDING_TEST)
    if (/\/outreach\/sequence\/prospects/.test(u)) return json({ prospects: [] })
    if (/\/batches\/candidates$/.test(u)) {
      return json({
        max: 10,
        candidates: [
          { crmCompanyId: 'c-acme', companyName: 'Acme Safety', companyDomain: 'acme.test', decisionMaker: { fullName: 'Jane Smith', title: null }, intendedRecipient: 'jane@acme.test', recipientSource: 'decision_maker', ready: true, reason: null },
          { crmCompanyId: 'c-mailbox', companyName: 'Bonnici Stores Ltd', companyDomain: 'bonnicistores.com', decisionMaker: { fullName: 'David Bonnici', title: null }, intendedRecipient: 'info@bonnicistores.com', recipientSource: 'company_mailbox', ready: true, reason: null },
          { crmCompanyId: 'c-noemail', companyName: 'Central Cleaning', companyDomain: 'centralcleaning.com.au', decisionMaker: { fullName: 'Joe Camilleri', title: null }, intendedRecipient: null, recipientSource: null, ready: false, reason: 'No email for the decision maker and no verified company mailbox.' },
          { crmCompanyId: 'c-none', companyName: 'Nobody Inc', companyDomain: null, decisionMaker: null, intendedRecipient: null, recipientSource: null, ready: false, reason: 'No shortlisted decision maker.' },
          { crmCompanyId: 'c-busy', companyName: 'Busy Corp', companyDomain: 'busy.test', decisionMaker: { fullName: 'Bo Busy', title: null }, intendedRecipient: 'bo@busy.test', recipientSource: 'decision_maker', ready: true, reason: null, inOutreach: true },
        ],
      })
    }
    if (/\/batches\/b3$/.test(u)) return json(SEND_VIEW)
    if (/\/batches\/b\d$/.test(u)) return json(BATCH_VIEW)
    if (/\/batches$/.test(u)) {
      return json({
        batches: [
          { ...SEND_VIEW.batch, companies: 2, counts: { scheduled: 1, sent: 0, due: 1 } },
          { ...BATCH, companies: 1, counts: { awaitingApproval: 0, scheduled: 1, sent: 0, failed: 0 } },
        ],
        sending: SENDING_TEST,
      })
    }
    if (/\/outreach\/sequence\/companies\/[^/?]+\?campaign=tc1$/.test(u)) return json(testView(opts.draftStatus ?? 'scheduled'))
    if (/\/outreach\/sequence\/companies\//.test(u)) return json({ ...testView('draft'), campaign: null, sequence: null, drafts: [] })
    return json({ error: { code: 'not_found', message: 'none' } }, 404)
  })
}

const noSendControl = () => {
  for (const b of screen.getAllByRole('button')) {
    expect(b.textContent ?? '', 'no send control').not.toMatch(/^\s*(send|release|execute)\b/i)
  }
}

async function openTestCampaign() {
  render(<Outreach />)
  await userEvent.click(await screen.findByRole('button', { name: /^several companies$/i }))
  await userEvent.click(within((await screen.findByText('Ohio rehearsal')).closest('tr')!).getByRole('button', { name: /^open$/i }))
  await userEvent.click(await screen.findByRole('button', { name: /^review$/i }))
  await userEvent.click((await screen.findAllByRole('button', { name: /^open$/i }))[0]!)
  return screen.findByRole('dialog')
}

beforeEach(() => {
  calls = []
})

describe('the sending banner', () => {
  it('says plainly when sending is off', async () => {
    stub({ sending: SENDING_OFF })
    render(<Outreach />)
    expect(await screen.findByText(/email sending: off/i)).toBeInTheDocument()
  })

  it('in test mode, names the internal test inbox and says customers are never emailed', async () => {
    stub()
    render(<Outreach />)
    const banner = await screen.findByText(/test mode\./i)
    expect(banner.closest('p')!.textContent).toMatch(/qa@altius\.test/)
    expect(banner.closest('p')!.textContent).toMatch(/customers are never emailed/i)
  })
})

describe('test batches', () => {
  it('lists batches and shows each company’s emails step by step', async () => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies$/i }))
    expect(await screen.findByText('Ohio rehearsal')).toBeInTheDocument()
    await userEvent.click(within((await screen.findByText('Ohio rehearsal')).closest('tr')!).getByRole('button', { name: /^open$/i }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Scheduled')).toBeInTheDocument()
    expect(within(table).getByText(/intended for jane@acme\.test \(not emailed\)/i)).toBeInTheDocument()
    noSendControl()
  })

  it('still opens an earlier test run, read-only', async () => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies$/i }))
    expect(await screen.findByText('Earlier test run')).toBeInTheDocument()
  })
})

// SEVERAL COMPANIES (2026-10-07): select → addresses → schedule → review → send.
describe('sending to several companies', () => {
  const toReview = async (pick: RegExp[] = [/acme safety/i]) => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /new send/i }))
    for (const re of pick) await userEvent.click(await screen.findByRole('checkbox', { name: re }))
    await userEvent.click(screen.getByRole('button', { name: /next: schedule/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: review/i }))
    await screen.findByText(/I confirm the queries/i)
  }

  it('shows every email exactly as it will be sent, with no draft screens, before anything is created', async () => {
    await toReview([/acme safety/i, /bonnici/i])
    expect(posts().some((c) => /\/batches\/send$/.test(c.url))).toBe(false)
    expect(screen.getAllByText(/who ai recommends instead of/i)).toHaveLength(2)
    expect(screen.getAllByText('Ready')).toHaveLength(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sends only after the one confirmation, with the schedule and the version shown', async () => {
    await toReview([/acme safety/i, /bonnici/i])
    const send = screen.getByRole('button', { name: /^send 2 emails$/i })
    expect(send).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /i confirm the queries/i }))
    await userEvent.click(send)
    await waitFor(() => expect(posts().some((c) => /\/batches\/send$/.test(c.url))).toBe(true))
    const body = posts().find((c) => /\/batches\/send$/.test(c.url))!.body as Record<string, unknown>
    expect(body).toMatchObject({ crmCompanyIds: ['c-acme', 'c-mailbox'], timezone: 'America/New_York', sendDays: [1, 2, 3, 4, 5], sendStart: '09:00', sendEnd: '17:00', spacingMinutes: 10, dailyCap: 20, confirmQueries: true })
    expect(await screen.findByText(/sent to the schedule/i)).toBeInTheDocument()
  })

  it('picks the sending time zone from a list, and sends the one chosen', async () => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /new send/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /acme safety/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: schedule/i }))
    const zone = (await screen.findByText('Sending time zone')).closest('label')!.querySelector('select')!
    expect(zone.value).toBe('America/New_York')
    expect(within(zone).getByRole('option', { name: /^America\/New York \(UTC/ })).toBeInTheDocument()
    await userEvent.selectOptions(zone, 'Asia/Kolkata')
    await userEvent.click(screen.getByRole('button', { name: /next: review/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /i confirm the queries/i }))
    await userEvent.click(screen.getByRole('button', { name: /^send 1 email$/i }))
    await waitFor(() => expect(posts().some((c) => /\/batches\/send$/.test(c.url))).toBe(true))
    expect((posts().find((c) => /\/batches\/send$/.test(c.url))!.body as Record<string, unknown>).timezone).toBe('Asia/Kolkata')
  })

  it('leaves out a company whose email cannot be sent, says why, and lets the greeting name be typed', async () => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /new send/i }))
    await userEvent.type(await screen.findByLabelText(/email address for Nobody Inc/i), 'buyer@nobody.test')
    await userEvent.click(screen.getByRole('checkbox', { name: /nobody inc/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /acme safety/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: schedule/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: review/i }))
    expect(await screen.findByText('Will not be sent')).toBeInTheDocument()
    expect(screen.getByText(/still unfilled: \[name\]/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send 1 email$/i })).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/greeting name for Nobody Inc/i), 'Pat')
    await userEvent.click(screen.getByRole('button', { name: /use this name/i }))
    await waitFor(() => expect(screen.queryByText('Will not be sent')).toBeNull())
    const lastPreview = posts().filter((c) => /\/batches\/preview$/.test(c.url)).pop()!.body as Record<string, unknown>
    expect(lastPreview.names).toEqual({ 'c-none': 'Pat' })
    expect(screen.getByRole('button', { name: /^send 2 emails$/i })).toBeInTheDocument()
  })

  it('will not offer a company already in outreach', async () => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /new send/i }))
    expect(await screen.findByRole('checkbox', { name: /busy corp/i })).toBeDisabled()
    expect(screen.getByText(/already in outreach; continue it under one company/i)).toBeInTheDocument()
  })

  it('when an email is due, opens it in Gmail and marks it sent — the platform sends nothing itself', async () => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies$/i }))
    await userEvent.click((await screen.findAllByRole('button', { name: /^open$/i }))[0]!)
    const table = await screen.findByRole('table')
    const dueRow = within(table).getByText('Acme Safety').closest('tr')!
    const gmail = within(dueRow).getByRole('link', { name: /open in gmail/i })
    expect(gmail.getAttribute('href')).toMatch(/^https:\/\/mail\.google\.com\/mail\/\?view=cm/)
    expect(gmail.getAttribute('href')).toContain(encodeURIComponent('jane@acme.test'))
    await userEvent.click(within(dueRow).getByRole('button', { name: /mark as sent/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/sequence/actions/x1/mark-sent'))).toBe(true))

    const laterRow = within(table).getByText('Bonnici Stores Ltd').closest('tr')!
    expect(within(laterRow).getByText('Scheduled')).toBeInTheDocument()
    expect(within(laterRow).queryByRole('link', { name: /open in gmail/i })).toBeNull()
    expect(within(laterRow).queryByRole('button', { name: /mark as sent/i })).toBeNull()
  })
})

describe('choosing companies for a batch', () => {
  // Two things Sales asked for on this screen: find a company in a long list
  // without scrolling, and correct the address before the drafts are written
  // rather than one draft at a time afterwards.
  const openPicker = async () => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /new send/i }))
    await screen.findByLabelText(/search companies/i)
  }

  /** Schedule, review, confirm, Send — and wait for the send. */
  const sendChosen = async () => {
    await userEvent.click(screen.getByRole('button', { name: /next: schedule/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: review/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /i confirm the queries/i }))
    await userEvent.click(screen.getByRole('button', { name: /^send \d+ emails?$/i }))
    await waitFor(() => expect(posts().some((c) => /\/batches\/send$/.test(c.url))).toBe(true))
  }

  it('narrows the list by company name', async () => {
    await openPicker()
    await userEvent.type(screen.getByLabelText(/search companies/i), 'bonnici')
    expect(screen.getByText('Bonnici Stores Ltd')).toBeInTheDocument()
    expect(screen.queryByText('Acme Safety')).toBeNull()
    expect(screen.queryByText('Central Cleaning')).toBeNull()
  })

  it('searches the decision maker and the email address too', async () => {
    await openPicker()
    const box = screen.getByLabelText(/search companies/i)
    await userEvent.type(box, 'camilleri')
    expect(screen.getByText('Central Cleaning')).toBeInTheDocument()

    await userEvent.clear(box)
    await userEvent.type(box, 'jane@acme')
    expect(screen.getByText('Acme Safety')).toBeInTheDocument()
    expect(screen.queryByText('Central Cleaning')).toBeNull()
  })

  it('says so plainly when nothing matches', async () => {
    await openPicker()
    await userEvent.type(screen.getByLabelText(/search companies/i), 'zzzz')
    expect(screen.getByText(/no company matches/i)).toBeInTheDocument()
  })

  it('shows the address that was found, and where it came from', async () => {
    await openPicker()
    expect(screen.getByLabelText(/email address for Acme Safety/i)).toHaveValue('jane@acme.test')
    expect(screen.getByLabelText(/email address for Bonnici Stores Ltd/i)).toHaveValue('info@bonnicistores.com')
    expect(screen.getByText('company mailbox')).toBeInTheDocument()
    expect(screen.getByText('from Decision Makers')).toBeInTheDocument()
  })

  it('sends a corrected address with the batch, and only for the companies chosen', async () => {
    await openPicker()
    const box = screen.getByLabelText(/email address for Acme Safety/i)
    await userEvent.clear(box)
    await userEvent.type(box, 'purchasing@acme.test')
    await userEvent.click(screen.getByRole('checkbox', { name: /acme safety/i }))
    await sendChosen()
    const body = posts().find((c) => /\/batches\/send$/.test(c.url))!.body as Record<string, unknown>
    expect(body.crmCompanyIds).toEqual(['c-acme'])
    expect(body.recipients).toEqual({ 'c-acme': 'purchasing@acme.test' })
  })

  it('sends no recipients at all when nothing was retyped', async () => {
    await openPicker()
    await userEvent.click(screen.getByRole('checkbox', { name: /acme safety/i }))
    await sendChosen()
    expect((posts().find((c) => /\/batches\/send$/.test(c.url))!.body as Record<string, unknown>).recipients).toBeUndefined()
  })

  it('lets a typed address bring in a company no address was found for', async () => {
    await openPicker()
    // Nothing was found, so it cannot be chosen yet.
    expect(screen.getByRole('checkbox', { name: /central cleaning/i })).toBeDisabled()
    const row = screen.getByLabelText(/email address for Central Cleaning/i).closest('li')!
    expect(within(row).getByText(/nothing was found — type one to include this company/i)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/email address for Central Cleaning/i), 'joe@centralcleaning.com.au')
    expect(screen.getByRole('checkbox', { name: /central cleaning/i })).toBeEnabled()

    await userEvent.click(screen.getByRole('checkbox', { name: /central cleaning/i }))
    await sendChosen()
    const body = posts().find((c) => /\/batches\/send$/.test(c.url))!.body as Record<string, unknown>
    expect(body.crmCompanyIds).toEqual(['c-noemail'])
    expect(body.recipients).toEqual({ 'c-noemail': 'joe@centralcleaning.com.au' })
  })

  it('will not accept something that is not an email address', async () => {
    await openPicker()
    await userEvent.type(screen.getByLabelText(/email address for Central Cleaning/i), 'not-an-address')
    expect(screen.getByRole('checkbox', { name: /central cleaning/i })).toBeDisabled()
  })

  // A COMPANY WITH NO SHORTLISTED DECISION MAKER (2026-10-01).
  //
  // Sales asked to be able to reach these too, with an address they found
  // themselves. The status text stays exactly as it was; the address box is
  // the same one every other company has.
  it('keeps the "No shortlisted decision maker" status, and offers the same address box', async () => {
    await openPicker()
    expect(screen.getByText(/no shortlisted decision maker\./i)).toBeInTheDocument()
    expect(screen.getByLabelText(/email address for Nobody Inc/i)).toHaveValue('')
  })

  it('cannot be chosen until an address is typed, and can be once one is', async () => {
    await openPicker()
    expect(screen.getByRole('checkbox', { name: /nobody inc/i })).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/email address for Nobody Inc/i), 'not-an-address')
    expect(screen.getByRole('checkbox', { name: /nobody inc/i })).toBeDisabled()
    await userEvent.clear(screen.getByLabelText(/email address for Nobody Inc/i))
    await userEvent.type(screen.getByLabelText(/email address for Nobody Inc/i), 'buyer@nobody.test')
    expect(screen.getByRole('checkbox', { name: /nobody inc/i })).toBeEnabled()
  })

  it('sends the typed address with the batch, so Outreach writes to it', async () => {
    await openPicker()
    await userEvent.type(screen.getByLabelText(/email address for Nobody Inc/i), 'buyer@nobody.test')
    await userEvent.click(screen.getByRole('checkbox', { name: /nobody inc/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: schedule/i }))
    await userEvent.click(screen.getByRole('button', { name: /next: review/i }))
    // No named contact: the greeting name is typed at Review, then it can be sent.
    await userEvent.type(await screen.findByLabelText(/greeting name for Nobody Inc/i), 'Pat')
    await userEvent.click(screen.getByRole('button', { name: /use this name/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /i confirm the queries/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^send 1 email$/i }))
    await waitFor(() => expect(posts().some((c) => /\/batches\/send$/.test(c.url))).toBe(true))
    const body = posts().find((c) => /\/batches\/send$/.test(c.url))!.body as Record<string, unknown>
    expect(body.crmCompanyIds).toEqual(['c-none'])
    expect(body.recipients).toEqual({ 'c-none': 'buyer@nobody.test' })
    expect(body.names).toEqual({ 'c-none': 'Pat' })
  })
})

describe('a test email under review', () => {
  it('offers no Copy, mail-app or Mark-as-sent — only the test schedule and a test to your own inbox', async () => {
    stub()
    const dialog = await openTestCampaign()
    expect(calls.some((c) => /companies\/c-acme\?campaign=tc1$/.test(c.url))).toBe(true)
    expect(within(dialog).queryByRole('button', { name: /mark as sent/i })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /copy email/i })).toBeNull()
    expect(within(dialog).queryByRole('link', { name: /open in mail app/i })).toBeNull()
    expect(within(dialog).getByText(/is\s+not emailed/i)).toBeInTheDocument()
    // The recorded preview shows where it actually went and who it was meant for.
    expect(within(dialog).getByText('sam@altius.test')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /test email to my inbox/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/sequence/actions/a1/test-send'))).toBe(true))
    expect(await within(dialog).findByText(/delivered to sam@altius\.test/i)).toBeInTheDocument()
    noSendControl()
  })

  it('a failed test send can be retried, which reschedules it', async () => {
    stub({ draftStatus: 'failed' })
    const dialog = await openTestCampaign()
    await userEvent.click(within(dialog).getByRole('button', { name: /retry test/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/sequence/actions/a1/reschedule-test'))).toBe(true))
  })

  it('offers no test email at all while sending is off', async () => {
    stub({ sending: SENDING_OFF })
    const dialog = await openTestCampaign()
    expect(within(dialog).queryByRole('button', { name: /test email to my inbox/i })).toBeNull()
  })
})
