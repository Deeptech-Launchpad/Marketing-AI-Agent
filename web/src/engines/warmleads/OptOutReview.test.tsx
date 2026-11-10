import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OptOutReview } from './OptOutReview'
import type { OptOutReviewItem } from './types'

// The pilot reviewer sees what WOULD be suppressed: masked address, day, status and the NXT Sales activity to open - never an address or text.
// The sender of an email cannot be verified, so an ADMINISTRATOR approves each proposal (only when recording is on); the request carries ids only.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../lib/api', () => ({ api }))

const item = (over: Partial<OptOutReviewItem> = {}): OptOutReviewItem => ({
  kind: 'proposal',
  crmCompanyId: 'c1',
  companyName: 'Acme Traders',
  evaluationId: 'e1',
  evaluatedAt: '2026-11-04T01:00:00.000Z',
  status: 'dry_run',
  masked: 'r***@acme.example',
  receivedOn: '2026-11-03',
  activityId: 'act_8f2',
  companyClassification: 'warm',
  fingerprint: 'abcdef0123456789',
  phrase: 'UNSUBSCRIBE',
  reason: 'The email consists only of the standard request “UNSUBSCRIBE”, sent from one address that is not ours, with no other request, address or colleague in it. That is all this proposal rests on: the sender is not authenticated.',
  summary: 'x',
  approvedBy: null,
  ...over,
})

beforeEach(() => {
  api.get.mockReset()
  api.post.mockReset()
})

describe('opt-outs found in replies (pilot review)', () => {
  it('lists each one with its masked address, day, status and NXT activity - and says nothing was written', async () => {
    api.get.mockResolvedValue({ items: [item(), item({ kind: 'not_recorded', masked: null, status: 'needs_person', activityId: 'act_9', evaluationId: 'e2', companyName: 'Beta Ltd' })], recordingEnabled: false })
    render(<OptOutReview enabled refreshKey={0} />)
    await waitFor(() => expect(screen.getByText(/Opt-outs found in replies \(2\)/)).toBeTruthy())
    expect(screen.getByText('Acme Traders')).toBeTruthy()
    expect(screen.getAllByText(/Dry run — nothing was written/).length).toBeGreaterThan(0)
    expect(screen.getByText('r***@acme.example')).toBeTruthy()
    expect(screen.getByText('act_8f2')).toBeTruthy()
    expect(screen.getAllByText(/received 2026-11-03/)).toHaveLength(2)
    expect(screen.getByText(/Opt-out, not recorded automatically: A person decides/)).toBeTruthy()
    expect(screen.getByText(/Even with recording switched on, nobody is suppressed automatically: an administrator approves each one/)).toBeTruthy()
    expect(api.get).toHaveBeenCalledWith('/warm-leads/pilot/opt-outs', expect.anything())
  })

  it('says so when no opt-out was found, and reads nothing when it is not enabled', async () => {
    api.get.mockResolvedValue({ items: [], recordingEnabled: false })
    const { unmount } = render(<OptOutReview enabled refreshKey={0} />)
    await waitFor(() => expect(screen.getByText(/No opt-out was found in any reply/)).toBeTruthy())
    unmount()
    api.get.mockClear()
    const { container } = render(<OptOutReview enabled={false} refreshKey={0} />)
    expect(container.textContent).toBe('')
    expect(api.get).not.toHaveBeenCalled()
  })

  it('there is NO approve button for a non-admin, or while recording is switched off, or for a line that is not a proposal', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval' })], recordingEnabled: true })
    const a = render(<OptOutReview enabled refreshKey={0} admin={false} />)
    await waitFor(() => expect(screen.getByText('Acme Traders')).toBeTruthy())
    expect(screen.queryByText(/Approve…/)).toBeNull()
    a.unmount()

    api.get.mockResolvedValue({ items: [item()], recordingEnabled: false })
    const b = render(<OptOutReview enabled refreshKey={0} admin />)
    await waitFor(() => expect(screen.getByText('Acme Traders')).toBeTruthy())
    expect(screen.queryByText(/Approve…/)).toBeNull()
    b.unmount()

    api.get.mockResolvedValue({ items: [item({ kind: 'not_recorded', status: 'needs_person' }), item({ status: 'recorded', approvedBy: 'u9', activityId: 'act_1' })], recordingEnabled: true })
    render(<OptOutReview enabled refreshKey={0} admin />)
    await waitFor(() => expect(screen.getByText(/approved by u9/)).toBeTruthy())
    expect(screen.queryByText(/Approve…/)).toBeNull()
  })

  it('an administrator approves ONE proposal only after confirming an independent check; the request carries ids and the confirmation - never an address', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval' })], recordingEnabled: true })
    api.post.mockResolvedValue({ message: 'r***@acme.example was added to the suppression list.' })
    render(<OptOutReview enabled refreshKey={0} admin />)
    fireEvent.click(await screen.findByText(/Approve…/))
    expect(api.post).not.toHaveBeenCalled() // one click is not enough
    const confirmButton = await screen.findByText('Yes — add r***@acme.example to the suppression list')
    // the button is disabled until the administrator confirms the independent verification
    expect((confirmButton.closest('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirmButton)
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect((confirmButton.closest('button') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirmButton)
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post).toHaveBeenCalledWith('/warm-leads/opt-outs/approve', { crmCompanyId: 'c1', activityId: 'act_8f2', confirm: true, independentlyVerified: true })
    expect(JSON.stringify(api.post.mock.calls)).not.toMatch(/@/)
    await waitFor(() => expect(screen.getByText(/was added to the suppression list/)).toBeTruthy())
  })

  it('shows everything an approver needs: company, its classification, masked address, activity id and date, SENDER NOT AUTHENTICATED, and the exact reason', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval' })], recordingEnabled: true, pendingCount: 1, complete: true })
    render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(screen.getByText(/company is currently:/).textContent).toMatch(/Warm/i)
    expect(screen.getByText('r***@acme.example')).toBeTruthy()
    expect(screen.getByText('act_8f2')).toBeTruthy()
    expect(screen.getByText(/received 2026-11-03/)).toBeTruthy()
    expect(screen.getByText('SENDER NOT AUTHENTICATED')).toBeTruthy()
    expect(screen.getByText(/Why this was proposed: The email consists only of the standard request “UNSUBSCRIBE”/)).toBeTruthy()
  })

  it('an existing customer / active opportunity gets an explicit warning', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval', companyClassification: 'existing_customer' }), item({ status: 'awaiting_approval', activityId: 'act_2', evaluationId: 'e2', crmCompanyId: 'c2', companyName: 'Beta', companyClassification: 'active_opportunity' })], recordingEnabled: true })
    render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(screen.getByText(/EXISTING CUSTOMER/)).toBeTruthy()
    expect(screen.getByText(/ACTIVE OPPORTUNITY/)).toBeTruthy()
  })

  it('shows the total number still pending, and warns loudly if the list is not complete', async () => {
    api.get.mockResolvedValue({ items: [item(), item({ activityId: 'act_2', evaluationId: 'e2' })], recordingEnabled: false, pendingCount: 2, complete: false })
    render(<OptOutReview enabled refreshKey={0} />)
    await screen.findByText(/2 pending/)
    expect(screen.getByRole('alert').textContent).toMatch(/NOT complete/)
  })

  it('a long list is shown 25 at a time, with a count of what remains', async () => {
    api.get.mockResolvedValue({ items: Array.from({ length: 60 }, (_, i) => item({ activityId: `act_${i}`, evaluationId: `e${i}`, crmCompanyId: `c${i}`, companyName: `Co ${i}` })), recordingEnabled: false, pendingCount: 60, complete: true })
    render(<OptOutReview enabled refreshKey={0} />)
    await screen.findByText(/60 pending/)
    expect(screen.getAllByText(/SENDER NOT AUTHENTICATED/)).toHaveLength(25)
    fireEvent.click(screen.getByText('Show more (35 remaining)'))
    expect(screen.getAllByText(/SENDER NOT AUTHENTICATED/)).toHaveLength(50)
  })

  it('an old proposal without a fingerprint cannot be approved from here', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval', fingerprint: null })], recordingEnabled: true })
    render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(screen.queryByText(/Approve…/)).toBeNull()
    expect(screen.getByText(/has to be evaluated again first/)).toBeTruthy()
  })

  it('Cancel asks nothing; a refusal from the server is shown in words and nothing else changes', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval' })], recordingEnabled: true })
    api.post.mockRejectedValue(new Error('That email is no longer a plain standalone opt-out from one safe sender'))
    render(<OptOutReview enabled refreshKey={0} admin />)
    fireEvent.click(await screen.findByText(/Approve…/))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.getByText(/Approve…/)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(/Approve…/))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(await screen.findByText(/Yes — add/))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/no longer a plain standalone opt-out/))
  })
})
