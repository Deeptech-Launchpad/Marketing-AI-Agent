import { describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { Outreach } from './Outreach'
import { HELP } from './outreach/help'
import { emailStatus } from './outreach/status'

// THE OUTREACH SCREEN, READ BY SOMEONE NEW TO IT (2026-09-29).
//
// The steps are shown with this company's step highlighted; "who we are
// emailing" states the decision maker, the address and the verified product
// link (or plainly that there is none); every status reads in plain words; and
// each (i) opens a short explanation with what to do next.

const COMPANY = { crmCompanyId: 'c-acme', companyName: 'Acme Safety' }
vi.mock('../lib/companyContext', () => ({ useCompany: () => ({ company: COMPANY, select: vi.fn() }) }))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ can: () => true, principal: { crmUserId: 'u1', email: 'sam@altius.test', name: 'Sam', role: 'admin', permissions: ['view', 'operate', 'approve'] } }),
}))

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

const BODY = 'Jane,\n\nAda here, from AltiusNxt.\n\nThanks,\nAda'
function view(productPageUrl: string | null, draftStatus = 'draft') {
  return {
    crmCompanyId: 'c-acme',
    facts: {
      companyName: 'Acme Safety',
      companyDomain: 'acme.test',
      companySummary: null,
      decisionMaker: { id: 'dm1', fullName: 'Jane Smith', title: 'Head of eCommerce', email: 'jane@acme.test', profileUrl: null },
      product: null,
      productPageUrl,
      productPageNote: productPageUrl ? null : 'Prospects found no genuine product page on acme.test',
      signals: [],
      discovered: true,
    },
    gate: { ready: true, reason: null },
    sender: { configured: true, firstName: 'Ada', fullName: 'Ada Lovelace', email: 'ada@altius.test', companyName: 'AltiusNxt', signature: '' },
    campaign: { id: 'camp1', status: 'active', statusReason: null, initialVersion: 'v2', versionSource: 'auto_rotation', recipientEmail: 'jane@acme.test', recipientEmailSource: 'decision_maker', startedAt: '2026-09-29T10:00:00.000Z', isTest: false, batchId: null },
    sequence: {
      phase: 'initial',
      initialSentAt: null,
      next: { stageKey: 'initial', text: '1 Initial email: Review and approve the draft.', window: null, overdue: false },
      reminders: [],
      stages: [{ stageKey: 'initial', label: 'Initial email', pdfRef: '1', track: 'initial', status: 'drafted', window: null, reason: null, canPrepare: false }],
    },
    drafts: [
      {
        actionId: 'a1', stageKey: 'initial', label: 'Initial email', pdfRef: '1', version: 'v2', status: draftStatus, statusReason: null,
        recipient: 'jane@acme.test', recipientSource: 'decision_maker', contactName: 'Jane Smith', contactTitle: 'Head of eCommerce',
        subject: 'Hello', body: BODY, draftSubject: 'Hello', draftBody: BODY, edited: false, revision: 1, templateKey: 'initial.v2',
        inputs: {}, attestations: [], attestationDefs: [], requiredInputs: [], needsConfirmedSkus: false, mentionsExpo: false,
        personalization: {
          resolution: productPageUrl
            ? [{ placeholder: 'productPageUrl', value: productPageUrl, source: 'verified', factId: 'product.url' }]
            : [{ placeholder: 'productPageUrl', value: null, source: 'No verified product page — the product page line was left out.', factId: null }],
          unresolved: [],
        },
        dueStartAt: null, dueEndAt: null, approvedAt: null, approvedByCrmUserId: null, sentAt: null, sentByCrmUserId: null,
        gates: { ok: false, items: [{ key: 'attestations', ok: false, label: 'Sales confirmed the AI-engine test', detail: 'Tick it.' }], warnings: [] },
      },
    ],
    callPoints: null,
    replies: [],
    history: [],
  }
}

function stub(body: unknown) {
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (/\/sending$/.test(u)) return json({ mode: 'off', transport: 'smtp', ready: false, reason: 'off', testInbox: null, allowList: [] })
    if (/\/prospects/.test(u)) return json({ prospects: [] })
    if (/\/companies\//.test(u)) return json(body)
    return json({})
  })
}

describe('the outreach screen explains itself', () => {
  it('shows the steps with this company on "Review & edit"', async () => {
    stub(view('https://acme.test/p/x200'))
    render(<Outreach />)
    const steps = await screen.findByLabelText('Outreach steps')
    const now = within(steps).getByText('Review & edit').closest('li')!
    expect(now).toHaveAttribute('aria-current', 'step')
  })

  it('states who is emailed and links the verified product page', async () => {
    stub(view('https://acme.test/p/x200'))
    render(<Outreach />)
    const panel = (await screen.findByText(/who we are emailing/i)).closest('section')!
    expect(within(panel).getByText('Jane Smith · Head of eCommerce')).toBeInTheDocument()
    expect(within(panel).getByText(/jane@acme\.test/)).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'https://acme.test/p/x200' })).toHaveAttribute('href', 'https://acme.test/p/x200')
  })

  it('says plainly when there is no verified product page — and shows no link', async () => {
    stub(view(null))
    render(<Outreach />)
    const panel = (await screen.findByText(/who we are emailing/i)).closest('section')!
    expect(within(panel).getByText(/Prospects found no genuine product page/)).toBeInTheDocument()
    expect(within(panel).queryByRole('link')).toBeNull()
  })

  it('an (i) opens a short explanation with the next step, and closes with Escape', async () => {
    stub(view('https://acme.test/p/x200'))
    render(<Outreach />)
    await screen.findByText(/who we are emailing/i)
    const [btn] = screen.getAllByRole('button', { name: /what is product page\?/i })
    await userEvent.click(btn!)
    const note = screen.getByRole('note')
    expect(note.textContent).toContain(HELP.productPage.what)
    expect(note.textContent).toMatch(/Next:/)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('names the email status in plain words', async () => {
    stub(view('https://acme.test/p/x200'))
    render(<Outreach />)
    expect((await screen.findAllByText('Waiting for approval')).length).toBeGreaterThan(0)
  })
})

describe('status words', () => {
  it('covers every state an email can be in', () => {
    expect(emailStatus('draft').label).toBe('Waiting for approval')
    expect(emailStatus('ready_to_send').label).toBe('Ready to send')
    expect(emailStatus('scheduled').label).toBe('Scheduled')
    expect(emailStatus('sent').label).toBe('Sent')
    expect(emailStatus('failed').label).toBe('Failed')
    expect(emailStatus('cancelled', 'The prospect replied.').label).toBe('Stopped — they replied')
    expect(emailStatus('cancelled', 'Stopped by Sales.').label).toBe('Cancelled')
  })
})
