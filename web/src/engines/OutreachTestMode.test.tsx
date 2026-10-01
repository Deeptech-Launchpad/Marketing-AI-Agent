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
        ],
      })
    }
    if (/\/batches\/b\d$/.test(u)) return json(BATCH_VIEW)
    if (/\/batches$/.test(u)) return json({ batches: [{ ...BATCH, companies: 1, counts: { awaitingApproval: 0, scheduled: 1, sent: 0, failed: 0 } }], sending: SENDING_TEST })
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
  await userEvent.click(await screen.findByRole('button', { name: /^several companies \(test run\)$/i }))
  await userEvent.click(await screen.findByRole('button', { name: /^open$/i }))
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
    await userEvent.click(await screen.findByRole('button', { name: /^several companies \(test run\)$/i }))
    expect(await screen.findByText('Ohio rehearsal')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^open$/i }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Scheduled')).toBeInTheDocument()
    expect(within(table).getByText(/intended for jane@acme\.test \(not emailed\)/i)).toBeInTheDocument()
    noSendControl()
  })

  it('creates a batch only from ready companies, with the schedule, after a review step', async () => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies \(test run\)$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /new test batch/i }))
    const boxes = await screen.findAllByRole('checkbox', { name: /acme safety|nobody inc/i })
    expect(boxes.find((b) => /nobody/i.test(b.closest('label')!.textContent ?? ''))).toBeDisabled()
    await userEvent.click(boxes.find((b) => /acme/i.test(b.closest('label')!.textContent ?? ''))!)
    await userEvent.click(screen.getByRole('button', { name: /^review$/i }))
    expect(posts()).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: /create test batch/i }))
    await waitFor(() => expect(posts().some((c) => /\/outreach\/sequence\/batches$/.test(c.url))).toBe(true))
    const body = posts().find((c) => /\/batches$/.test(c.url))!.body as Record<string, unknown>
    expect(body).toMatchObject({ crmCompanyIds: ['c-acme'], timezone: 'America/New_York', sendDays: [1, 2, 3, 4, 5], sendStart: '09:00', sendEnd: '17:00', spacingMinutes: 10, dailyCap: 20 })
    expect(await screen.findByText(/test batch created/i)).toBeInTheDocument()
  })
})

describe('choosing companies for a batch', () => {
  // Two things Sales asked for on this screen: find a company in a long list
  // without scrolling, and correct the address before the drafts are written
  // rather than one draft at a time afterwards.
  const openPicker = async () => {
    stub()
    render(<Outreach />)
    await userEvent.click(await screen.findByRole('button', { name: /^several companies \(test run\)$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /new test batch/i }))
    await screen.findByLabelText(/search companies/i)
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
    await userEvent.click(screen.getByRole('button', { name: /^review$/i }))
    await userEvent.click(screen.getByRole('button', { name: /create test batch/i }))

    await waitFor(() => expect(posts().some((c) => /\/batches$/.test(c.url))).toBe(true))
    const body = posts().find((c) => /\/batches$/.test(c.url))!.body as Record<string, unknown>
    expect(body.crmCompanyIds).toEqual(['c-acme'])
    expect(body.recipients).toEqual({ 'c-acme': 'purchasing@acme.test' })
  })

  it('sends no recipients at all when nothing was retyped', async () => {
    await openPicker()
    await userEvent.click(screen.getByRole('checkbox', { name: /acme safety/i }))
    await userEvent.click(screen.getByRole('button', { name: /^review$/i }))
    await userEvent.click(screen.getByRole('button', { name: /create test batch/i }))

    await waitFor(() => expect(posts().some((c) => /\/batches$/.test(c.url))).toBe(true))
    expect((posts().find((c) => /\/batches$/.test(c.url))!.body as Record<string, unknown>).recipients).toBeUndefined()
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
    await userEvent.click(screen.getByRole('button', { name: /^review$/i }))
    await userEvent.click(screen.getByRole('button', { name: /create test batch/i }))

    await waitFor(() => expect(posts().some((c) => /\/batches$/.test(c.url))).toBe(true))
    const body = posts().find((c) => /\/batches$/.test(c.url))!.body as Record<string, unknown>
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
    await userEvent.click(screen.getByRole('button', { name: /^review$/i }))
    await userEvent.click(screen.getByRole('button', { name: /create test batch/i }))

    await waitFor(() => expect(posts().some((c) => /\/batches$/.test(c.url))).toBe(true))
    const body = posts().find((c) => /\/batches$/.test(c.url))!.body as Record<string, unknown>
    expect(body.crmCompanyIds).toEqual(['c-none'])
    expect(body.recipients).toEqual({ 'c-none': 'buyer@nobody.test' })
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
