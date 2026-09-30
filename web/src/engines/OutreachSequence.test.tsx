import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { Outreach } from './Outreach'
import { buildMailto } from './outreach/mailto'

// THE SALES REVIEW SCREEN.
//
// A draft can only be approved once its checklist is complete; an approved
// email is copied or opened in the person's own mail client and then marked
// sent — the page itself never sends; a pasted reply changes nothing until
// Sales confirms the reading; and someone without approval rights is never
// offered Approve.

const COMPANY = { crmCompanyId: 'c-acme', companyName: 'Acme Safety' }
const perms = { value: ['view', 'operate', 'approve'] as string[] }

vi.mock('../lib/companyContext', () => ({ useCompany: () => ({ company: COMPANY, select: vi.fn() }) }))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: (p: string) => perms.value.includes(p),
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'operator', permissions: perms.value },
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

const BODY = "Jane,\n\nAda here, from AltiusNxt.\n\nThanks,\nAda"
const gate = (ok: boolean) => ({
  ok,
  warnings: [],
  items: [
    { key: 'placeholders', ok: true, label: 'Every placeholder is filled', detail: null },
    { key: 'attestations', ok, label: 'Sales confirmed the AI-engine test', detail: ok ? null : 'Tick the confirmation once you have run the test.' },
  ],
})

function draft(over: Record<string, unknown> = {}) {
  return {
    actionId: 'a1',
    stageKey: 'initial',
    label: 'Initial email',
    pdfRef: '1',
    version: 'v1',
    status: 'draft',
    statusReason: null,
    recipient: 'jane@acme.test',
    recipientSource: 'decision_maker',
    contactName: 'Jane Smith',
    contactTitle: 'Head of eCommerce',
    subject: 'Who AI recommends instead of Acme Safety for Hard Hat?',
    body: BODY,
    draftSubject: null,
    draftBody: BODY,
    edited: false,
    revision: 1,
    templateKey: 'initial.v1',
    inputs: {},
    attestations: [],
    attestationDefs: [{ key: 'ai_test', statement: 'I ran the AI-engine test for Acme Safety this week.', maxAgeDays: 7 }],
    requiredInputs: [],
    needsConfirmedSkus: false,
    mentionsExpo: false,
    personalization: { templateSet: 'usa-pdf-2026-09-25', resolution: [{ placeholder: 'company', value: 'Acme Safety', source: 'NXT Sales', factId: 'company.name' }], aiLine: { status: 'none', text: null, factIds: [], reason: null }, signalsConsidered: [], signalsUsed: [], unresolved: [] },
    dueStartAt: null,
    dueEndAt: null,
    approvedAt: null,
    approvedByCrmUserId: null,
    sentAt: null,
    sentByCrmUserId: null,
    gates: gate(false),
    ...over,
  }
}

function view(d: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    crmCompanyId: COMPANY.crmCompanyId,
    facts: {
      companyName: 'Acme Safety',
      companyDomain: 'acme.test',
      companySummary: null,
      decisionMaker: { id: 'dm1', fullName: 'Jane Smith', title: 'Head of eCommerce', email: 'jane@acme.test', profileUrl: null },
      product: null,
      signals: [],
      discovered: false,
    },
    gate: { ready: true, reason: null },
    sender: { configured: true, firstName: 'Ada', fullName: 'Ada Lovelace', email: 'ada@altius.test', companyName: 'AltiusNxt', signature: '' },
    campaign: { id: 'camp1', status: 'active', statusReason: null, initialVersion: 'v1', versionSource: 'auto_rotation', recipientEmail: 'jane@acme.test', recipientEmailSource: 'decision_maker', startedAt: '2026-09-25T10:00:00.000Z' },
    sequence: {
      phase: 'initial',
      initialSentAt: null,
      next: { stageKey: 'initial', text: 'Review and approve the initial email.', window: null, overdue: false },
      reminders: [],
      stages: [{ stageKey: 'initial', label: 'Initial email', pdfRef: '1', track: 'initial', status: 'drafted', window: null, reason: null, canPrepare: false }],
    },
    drafts: d ? [d] : [],
    callPoints: null,
    replies: [],
    history: [],
    ...extra,
  }
}

function stub(body: unknown) {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (method === 'POST') return json({ ok: true })
    if (/\/outreach\/sequence\/prospects/.test(String(url))) return json({ prospects: [] })
    if (/\/outreach\/sequence\/companies\//.test(String(url))) return json(body)
    return json({ error: { code: 'not_found', message: 'none' } }, 404)
  })
}

async function openReview() {
  const buttons = await screen.findAllByRole('button', { name: /review draft/i })
  await userEvent.click(buttons[0]!)
  return screen.findByRole('dialog')
}

beforeEach(() => {
  perms.value = ['view', 'operate', 'approve']
})

describe('reviewing a draft', () => {
  it('keeps Approve disabled until the checklist is complete, and shows why', async () => {
    stub(view(draft()))
    render(<Outreach />)
    const dialog = await openReview()
    expect(within(dialog).getByRole('button', { name: /^approve$/i })).toBeDisabled()
    expect(within(dialog).getByText(/tick the confirmation once you have run the test/i)).toBeInTheDocument()
    // Not approved yet, so there is nothing to mark sent.
    expect(within(dialog).queryByRole('button', { name: /mark as sent/i })).toBeNull()
  })

  it('records the Sales confirmation through the attest endpoint', async () => {
    stub(view(draft()))
    render(<Outreach />)
    const dialog = await openReview()
    await userEvent.click(within(dialog).getByRole('checkbox'))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/sequence/actions/a1/attest'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/attest'))!.body).toEqual({ key: 'ai_test', confirmed: true })
  })

  it('approves through the approve endpoint once the checklist is complete', async () => {
    stub(view(draft({ gates: gate(true), attestations: [{ key: 'ai_test', statement: 's', byCrmUserId: 'u1', at: '2026-09-25T10:00:00.000Z' }] })))
    render(<Outreach />)
    const dialog = await openReview()
    await userEvent.click(within(dialog).getByRole('button', { name: /^approve$/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/sequence/actions/a1/approve'))).toBe(true))
  })

  it('does not offer Approve to someone without approval permission', async () => {
    perms.value = ['view', 'operate']
    stub(view(draft({ gates: gate(true) })))
    render(<Outreach />)
    const dialog = await openReview()
    expect(within(dialog).queryByRole('button', { name: /^approve$/i })).toBeNull()
    expect(within(dialog).getByText(/approval is made by someone with approval permission/i)).toBeInTheDocument()
  })
})

describe('who the email goes to', () => {
  // Sales can always change this. The platform fills it in when it can — the
  // decision maker's own address, or a verified company mailbox — but often it
  // cannot, and Sales may simply know better. Before this was editable the only
  // way to correct an address was to give up on the draft.
  const box = (dialog: HTMLElement) => within(dialog).getByLabelText(/recipient email address/i)

  it('shows the address in an editable box, even when one was already found', async () => {
    stub(view(draft()))
    render(<Outreach />)
    const dialog = await openReview()
    expect(box(dialog)).toHaveValue('jane@acme.test')
    expect(within(dialog).getByText(/from Decision Makers/i)).toBeInTheDocument()
  })

  it('saves a replacement address through the inputs endpoint, and nothing else with it', async () => {
    stub(view(draft()))
    render(<Outreach />)
    const dialog = await openReview()
    await userEvent.clear(box(dialog))
    await userEvent.type(box(dialog), 'purchasing@acme.test')
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/sequence/actions/a1/inputs'))).toBe(true))
    // Only the address: entering it must not resubmit the SKUs or the report figure.
    expect(posts().find((c) => c.url.endsWith('/inputs'))!.body).toEqual({ recipientEmail: 'purchasing@acme.test' })
  })

  it('will not save until the address has actually changed', async () => {
    stub(view(draft()))
    render(<Outreach />)
    const dialog = await openReview()
    expect(within(dialog).getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('offers the box, not a dead end, when nothing was found automatically', async () => {
    stub(view(draft({ recipient: null, recipientSource: null })))
    render(<Outreach />)
    const dialog = await openReview()
    expect(box(dialog)).toHaveValue('')
    expect(within(dialog).getByText(/paste the address you want this to go to/i)).toBeInTheDocument()
  })

  it('stays editable after approval, since an approval can be corrected', async () => {
    stub(
      view(draft({ status: 'ready_to_send', gates: gate(true), approvedAt: '2026-09-25T11:00:00.000Z' }), {
        sequence: {
          phase: 'initial',
          initialSentAt: null,
          next: { stageKey: 'initial', text: 'Send it, then mark it sent.', window: null, overdue: false },
          reminders: [],
          stages: [
            { stageKey: 'initial', label: 'Initial email', pdfRef: '1', track: 'initial', status: 'approved', window: null, reason: null, canPrepare: false },
          ],
        },
      }),
    )
    render(<Outreach />)
    const [open] = await screen.findAllByRole('button', { name: /open email/i })
    await userEvent.click(open!)
    const dialog = await screen.findByRole('dialog')
    expect(box(dialog)).toHaveValue('jane@acme.test')
  })

  it('is read-only for someone who cannot operate', async () => {
    perms.value = ['view']
    stub(view(draft()))
    render(<Outreach />)
    const dialog = await openReview()
    expect(within(dialog).queryByLabelText(/recipient email address/i)).toBeNull()
    expect(within(dialog).getByText(/jane@acme\.test/)).toBeInTheDocument()
  })
})

describe('an approved email is sent by a person', () => {
  const approved = () => view(draft({ status: 'ready_to_send', gates: gate(true), approvedAt: '2026-09-25T11:00:00.000Z' }), {
    sequence: {
      phase: 'initial',
      initialSentAt: null,
      next: { stageKey: 'initial', text: 'Send the approved initial email from your mail client, then mark it sent.', window: null, overdue: false },
      reminders: [],
      stages: [{ stageKey: 'initial', label: 'Initial email', pdfRef: '1', track: 'initial', status: 'approved', window: null, reason: null, canPrepare: false }],
    },
  })

  it('offers Copy, Open in mail app and Mark as sent — and marking sent is the only request', async () => {
    stub(approved())
    render(<Outreach />)
    const [open] = await screen.findAllByRole('button', { name: /open email/i })
    await userEvent.click(open!)
    const dialog = await screen.findByRole('dialog')

    const link = within(dialog).getByRole('link', { name: /open in mail app/i })
    expect(link.getAttribute('href')).toBe(buildMailto('jane@acme.test', 'Who AI recommends instead of Acme Safety for Hard Hat?', BODY))
    expect(within(dialog).getByRole('button', { name: /copy email/i })).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /mark as sent/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/sequence/actions/a1/mark-sent'))).toBe(true))
    for (const c of calls) {
      expect(c.url).not.toMatch(/\/(release|execute)$/)
    }
    for (const b of screen.getAllByRole('button')) {
      expect(b.textContent ?? '', 'no send control').not.toMatch(/^\s*(send|release|execute)\b/i)
    }
  })
})

describe('the mail link', () => {
  it('encodes subject and body without turning spaces into plus signs', () => {
    const href = buildMailto('jane@acme.test', 'Hi & welcome?', 'Line one\nLine 2 = 100%')
    expect(href).toBe('mailto:jane@acme.test?subject=Hi%20%26%20welcome%3F&body=Line%20one%0D%0ALine%202%20%3D%20100%25')
  })
})

describe('replies', () => {
  const withReply = () =>
    view(null, {
      sequence: {
        phase: 'no_reply',
        initialSentAt: '2026-09-20T10:00:00.000Z',
        next: { stageKey: null, text: 'Confirm the pasted reply.', window: null, overdue: false },
        reminders: [],
        stages: [{ stageKey: 'initial', label: 'Initial email', pdfRef: '1', track: 'initial', status: 'done', window: null, reason: null, canPrepare: false }],
      },
      replies: [
        {
          id: 'r1',
          receivedAt: '2026-09-22T09:00:00.000Z',
          text: 'Hi, here are our SKUs: A1, B2, C3, D4, E5',
          modelClassification: 'sent_skus',
          modelEvidenceQuote: 'here are our SKUs',
          modelSkus: ['A1', 'B2', 'C3', 'D4', 'E5'],
          modelChecks: [],
          classification: null,
          classificationSource: null,
          skus: [],
          confirmedAt: null,
          confirmedBy: null,
        },
      ],
    })

  it('shows the AI reading with its quoted evidence, and confirms with the SKUs', async () => {
    stub(withReply())
    render(<Outreach />)
    expect(await screen.findByText(/awaiting confirmation/i)).toBeInTheDocument()
    expect(screen.getByText(/here are our SKUs”/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /confirm reading/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/outreach/sequence/replies/r1/confirm'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/confirm'))!.body).toEqual({ classification: 'sent_skus', skus: ['A1', 'B2', 'C3', 'D4', 'E5'] })
  })

  it('lets Sales override the reading before confirming', async () => {
    stub(withReply())
    render(<Outreach />)
    await userEvent.selectOptions(await screen.findByLabelText(/what kind of reply is it/i), 'follow_up_later')
    await userEvent.click(screen.getByRole('button', { name: /confirm reading/i }))
    await waitFor(() => expect(posts().some((c) => c.url.endsWith('/confirm'))).toBe(true))
    expect(posts().find((c) => c.url.endsWith('/confirm'))!.body).toEqual({ classification: 'follow_up_later' })
  })

  it('will not confirm an unclear reply', async () => {
    stub(withReply())
    render(<Outreach />)
    await userEvent.selectOptions(await screen.findByLabelText(/what kind of reply is it/i), 'unclear')
    expect(screen.getByRole('button', { name: /confirm reading/i })).toBeDisabled()
  })
})
