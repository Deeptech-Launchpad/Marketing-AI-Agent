import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { ThemeProvider } from '../lib/theme'
import { PendingApprovals } from './CrmApprovals'

// The engine's motion signatures read the active theme, so the real provider
// wraps every render rather than the signature being mocked away — the
// animation is part of what this screen is meant to show.
const render = (ui: ReactElement) => rtlRender(<ThemeProvider>{ui}</ThemeProvider>)

// THE HUMAN DECISION SCREEN.
//
// These render the real component and judge it by the REQUESTS IT MAKES. That
// matters more than what it displays: the safety properties of this screen are
// "it never names an approver" and "it cannot compose a CRM payload", and both
// are only observable on the wire.

const APPROVER = {
  crmUserId: 'user-approver',
  email: 'approver@altiusnxt.test',
  name: 'A Reviewer',
  tenantId: 't1',
  role: 'approver' as const,
  permissions: ['view' as const, 'approve' as const],
}

let auth = { can: (p: string) => APPROVER.permissions.includes(p as never), principal: APPROVER }
vi.mock('../lib/auth', () => ({ useAuth: () => auth }))

interface Call {
  url: string
  method: string
  body: Record<string, unknown> | null
}
let calls: Call[] = []

const PENDING = {
  syncId: 'sync-1',
  qualificationId: 'qual-1',
  crmCompanyId: 'cmp-1',
  companyName: 'Northwind Industrial',
  state: 'awaiting_user_approval',
  stateLabel: 'Prepared — waiting for a person to decide',
  qualification: { status: 'qualified_unassigned', score: 87, reason: 'Score 87 meets the threshold of 70.' },
  owner: { crmUserId: null, status: 'unassigned' },
  validation: { ok: true },
  preparedAt: '2026-09-01T10:00:00.000Z',
  requestedByCrmUserId: 'user-preparer',
  youPreparedThis: false,
  expectedUpdatedAt: '2026-09-01T10:00:00.000Z',
}

/** Serves the queue, and whatever the decision endpoints should answer. */
function stubApi(decision: { status: number; body: unknown } = { status: 200, body: {} }) {
  calls = []
  let queueReads = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ url: String(url), method, body })

    if (String(url).includes('/approvals/pending')) {
      queueReads++
      return new Response(JSON.stringify({ pending: [PENDING], count: 1, note: 'nothing sent' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(decision.body), {
      status: decision.status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return { queueReads: () => calls.filter((c) => c.url.includes('/approvals/pending')).length }
}

const decisions = () => calls.filter((c) => c.method === 'POST')

beforeEach(() => {
  auth = { can: (p: string) => APPROVER.permissions.includes(p as never), principal: APPROVER }
})

async function openReview() {
  render(<PendingApprovals accent="#4f8cff" />)
  const row = await screen.findByText('Northwind Industrial')
  await userEvent.click(row)
  return row
}

describe('the pending queue', () => {
  it('renders real pending records from the API', async () => {
    stubApi()
    render(<PendingApprovals accent="#4f8cff" />)

    expect(await screen.findByText('Northwind Industrial')).toBeInTheDocument()
    expect(screen.getByText('87')).toBeInTheDocument()
    expect(screen.getByText(/qualified unassigned/i)).toBeInTheDocument()
    expect(screen.getByText(/validated/i)).toBeInTheDocument()
    // Prepared-by is shown so a reviewer can see whose work they are checking.
    expect(screen.getByText('user-preparer')).toBeInTheDocument()
  })

  it('does not leak the evidence chain into the list', async () => {
    stubApi()
    const { container } = render(<PendingApprovals accent="#4f8cff" />)
    await screen.findByText('Northwind Industrial')
    const text = container.textContent ?? ''
    for (const leaked of ['payload', 'externalKey', 'findings', 'contributions']) {
      expect(text.toLowerCase()).not.toContain(leaked.toLowerCase())
    }
  })

  it('shows an empty state rather than a broken table when nothing is waiting', async () => {
    calls = []
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ pending: [], count: 0, note: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    render(<PendingApprovals accent="#4f8cff" />)
    expect(await screen.findByText(/nothing waiting for a decision/i)).toBeInTheDocument()
  })

  it('explains an unauthorized session instead of showing an error blob', async () => {
    calls = []
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Unauthorized.' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    render(<PendingApprovals accent="#4f8cff" />)
    expect(await screen.findByText(/not signed in/i)).toBeInTheDocument()
  })
})

describe('approving', () => {
  it('posts to the approve endpoint and shows the backend result', async () => {
    stubApi({
      status: 200,
      body: {
        syncId: 'sync-1',
        state: 'synced',
        stateLabel: 'Synchronised with the CRM',
        decision: 'approved',
        decidedByCrmUserId: 'user-approver',
        reason: 'Updated intentScore and qualificationStatus on the Company record.',
        resources: [{ resource: 'company', result: 'updated', reason: 'Updated 2 fields.' }],
      },
    })
    await openReview()
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(decisions()).toHaveLength(1))
    expect(decisions()[0]!.url).toContain('/crm-sync/approvals/sync-1/approve')
    expect(decisions()[0]!.method).toBe('POST')

    // The result is the backend's words, not a hopeful message of our own.
    expect(await screen.findByText(/Updated intentScore and qualificationStatus/)).toBeInTheDocument()
    // The label appears twice by design: once as the decision badge, once as
    // the verdict on the sync flow. Both are the backend's state label.
    expect(screen.getAllByText(/Synchronised with the CRM/).length).toBeGreaterThan(0)
  })

  it('NEVER sends an approver identity', async () => {
    stubApi({ status: 200, body: { syncId: 'sync-1', state: 'synced', stateLabel: 'ok', decision: 'approved', decidedByCrmUserId: 'x', reason: 'done' } })
    await openReview()
    await userEvent.type(screen.getByLabelText(/note/i), 'Checked the evidence.')
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    await waitFor(() => expect(decisions()).toHaveLength(1))

    const body = decisions()[0]!.body!
    for (const forbidden of [
      'approvedByCrmUserId',
      'crmUserId',
      'userId',
      'decidedByCrmUserId',
      'approver',
      'email',
      'principal',
    ]) {
      expect(Object.keys(body), forbidden).not.toContain(forbidden)
    }
    // Identity is the server's business; the body is a token and a note.
    expect(Object.keys(body).sort()).toEqual(['expectedUpdatedAt', 'note'])
    expect(JSON.stringify(body)).not.toContain(APPROVER.crmUserId)
    expect(JSON.stringify(body)).not.toContain(APPROVER.email)
  })

  it('cannot send any CRM payload field, because none is editable', async () => {
    stubApi({ status: 200, body: { syncId: 'sync-1', state: 'synced', stateLabel: 'ok', decision: 'approved', decidedByCrmUserId: 'x', reason: 'done' } })
    await openReview()

    // There is no input for any of these anywhere in the review panel.
    for (const field of [/intent ?score/i, /qualification ?status/i, /owner ?id/i, /deal/i, /amount/i]) {
      const inputs = screen.queryAllByRole('textbox', { name: field })
      expect(inputs, String(field)).toHaveLength(0)
    }
    // The only editable controls are the reviewer's own words.
    const boxes = screen.getAllByRole('textbox')
    expect(boxes).toHaveLength(2)
    for (const b of boxes) expect(['crm-approval-note', 'crm-approval-reason']).toContain(b.id)

    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    await waitFor(() => expect(decisions()).toHaveLength(1))
    const sent = JSON.stringify(decisions()[0]!.body)
    for (const forbidden of ['intentScore', 'qualificationStatus', 'customFields', 'ownerId', 'leadStatus', 'deal', 'amount', 'stage']) {
      expect(sent.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase())
    }
  })

  it('does not claim a CRM write the backend did not report', async () => {
    // The state with CRM_WRITE_ENABLED off: a real approval, an untouched CRM.
    // The interface must show both facts rather than averaging them into a tick.
    stubApi({
      status: 200,
      body: {
        syncId: 'sync-1',
        state: 'blocked_provider_unavailable',
        stateLabel: 'Prepared — CRM synchronisation unavailable',
        decision: 'approved',
        decidedByCrmUserId: 'user-approver',
        reason: 'No resource could be written.',
        resources: [
          { resource: 'company', result: 'not_supported', reason: 'CRM_WRITE_ENABLED is off.' },
        ],
      },
    })
    await openReview()
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    // The decision is reported honestly...
    expect(await screen.findByText('Approved')).toBeInTheDocument()
    // ...and so is the fact that nothing reached the CRM.
    expect(screen.getAllByText(/CRM synchronisation unavailable/).length).toBeGreaterThan(0)
    expect(screen.getByText(/not written/i)).toBeInTheDocument()
    expect(screen.getByText(/No resource could be written/)).toBeInTheDocument()
    expect(screen.queryByText(/^updated$/i), 'must not claim the CRM was updated').toBeNull()
  })

  it('refreshes the queue after a decision', async () => {
    const { queueReads } = stubApi({
      status: 200,
      body: { syncId: 'sync-1', state: 'synced', stateLabel: 'ok', decision: 'approved', decidedByCrmUserId: 'x', reason: 'done' },
    })
    await openReview()
    const before = queueReads()
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    await waitFor(() => expect(queueReads()).toBeGreaterThan(before))
  })
})

describe('rejecting', () => {
  it('requires a reason before the button does anything', async () => {
    stubApi()
    await openReview()

    const reject = screen.getByRole('button', { name: /^reject$/i })
    expect(reject).toBeDisabled()
    await userEvent.click(reject)
    expect(decisions(), 'a rejection without a reason must not be sent').toHaveLength(0)

    await userEvent.type(screen.getByLabelText(/reason/i), 'Evidence is out of date.')
    expect(reject).toBeEnabled()
  })

  it('sends the reason and shows the rejected state', async () => {
    stubApi({
      status: 200,
      body: {
        syncId: 'sync-1',
        state: 'rejected_by_user',
        stateLabel: 'Declined by a reviewer',
        decision: 'rejected',
        decidedByCrmUserId: 'user-approver',
        reason: 'Evidence is out of date.',
      },
    })
    await openReview()
    await userEvent.type(screen.getByLabelText(/reason/i), 'Evidence is out of date.')
    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }))

    await waitFor(() => expect(decisions()).toHaveLength(1))
    expect(decisions()[0]!.url).toContain('/reject')
    expect(decisions()[0]!.body).toEqual({
      expectedUpdatedAt: PENDING.expectedUpdatedAt,
      reason: 'Evidence is out of date.',
    })
    expect((await screen.findAllByText(/Declined by a reviewer/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Evidence is out of date\./).length).toBeGreaterThan(0)
  })
})

describe('decisions that cannot be applied', () => {
  it('explains a stale review and says nothing was written', async () => {
    stubApi({
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'This handoff has changed since you loaded it. Reload it and review the current package before deciding.',
        },
      },
    })
    await openReview()
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(await screen.findByText(/changed while you were reading it/i)).toBeInTheDocument()
    expect(screen.getByText(/Nothing was written to NXT Sales/i)).toBeInTheDocument()
  })

  it('explains an already-decided handoff', async () => {
    stubApi({
      status: 409,
      body: { error: { code: 'conflict', message: 'This handoff is "synced", not awaiting a decision.' } },
    })
    await openReview()
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(await screen.findByText(/already decided/i)).toBeInTheDocument()
    expect(screen.getByText(/not awaiting a decision/i)).toBeInTheDocument()
  })

  it('refuses self-approval in the interface, before any request', async () => {
    calls = []
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({ pending: [{ ...PENDING, youPreparedThis: true }], count: 1, note: '' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    render(<PendingApprovals accent="#4f8cff" />)
    await userEvent.click(await screen.findByText('Northwind Industrial'))

    expect(screen.getByText(/you prepared this handoff/i)).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: /^approve$/i })
    expect(approve).toBeDisabled()
    await userEvent.click(approve)
    expect(decisions()).toHaveLength(0)
  })

  it('hides the decision from a viewer without the approve permission', async () => {
    stubApi()
    auth = { can: () => false, principal: { ...APPROVER, role: 'viewer' as never, permissions: ['view' as const] } }
    await openReview()

    expect(screen.getByText(/you cannot sign this off/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeDisabled()
  })
})
