import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  approvable: true,
  approvalBlockedReason: null,
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
    expect(api.get).toHaveBeenCalledWith('/warm-leads/pilot/opt-outs?limit=50', expect.anything())
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
    // the checkbox alone is not enough: HOW it was verified must be chosen as well
    expect((confirmButton.closest('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirmButton)
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('How the request was verified'), { target: { value: 'phone_call_known_number' } })
    expect((confirmButton.closest('button') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirmButton)
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post).toHaveBeenCalledWith('/warm-leads/opt-outs/approve', { crmCompanyId: 'c1', activityId: 'act_8f2', confirm: true, independentlyVerified: true, verificationMethod: 'phone_call_known_number' })
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

  it('a long list is fetched a page at a time from the SERVER: "Show more" asks for more, and the total is shown', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => item({ activityId: `act_${i}`, evaluationId: `e${i}`, crmCompanyId: `c${i}`, companyName: `Co ${i}` }))
    api.get.mockImplementation(async (url: string) => (url.endsWith('limit=50') ? { items: page(50), total: 120, shown: 50, pendingCount: 120, complete: true, recordingEnabled: false } : { items: page(100), total: 120, shown: 100, pendingCount: 120, complete: true, recordingEnabled: false }))
    render(<OptOutReview enabled refreshKey={0} />)
    await screen.findByText(/120 pending/)
    expect(screen.getAllByText(/SENDER NOT AUTHENTICATED/)).toHaveLength(50)
    expect(api.get).toHaveBeenCalledWith('/warm-leads/pilot/opt-outs?limit=50', expect.anything())
    fireEvent.click(screen.getByText('Show more (70 remaining)'))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/warm-leads/pilot/opt-outs?limit=100', expect.anything()))
    await waitFor(() => expect(screen.getAllByText(/SENDER NOT AUTHENTICATED/)).toHaveLength(100))
  })

  it('what was found but not listed (per-check caps) is COUNTED and said out loud - never dropped silently', async () => {
    api.get.mockResolvedValue({ items: [item()], total: 1, shown: 1, pendingCount: 31, omitted: { proposals: 30, notRecorded: 4 }, complete: true, recordingEnabled: false })
    render(<OptOutReview enabled refreshKey={0} />)
    await screen.findByText(/31 pending/)
    expect(screen.getByText(/30 further opt-out sender\(s\) and 4 further opt-out message\(s\)/).textContent).toMatch(/nothing was dropped silently/)
  })

  it('an older proposal that cannot be checked (no fingerprint) cannot be approved from here', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval', approvable: false, approvalBlockedReason: 'no_fingerprint' })], recordingEnabled: true })
    render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(screen.queryByText(/Approve…/)).toBeNull()
    expect(screen.getByText(/has to be evaluated again first/)).toBeTruthy()
  })

  it('a changed fingerprint key shows a clear RE-REVIEW message (not a generic error) and no Approve button', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval', approvable: false, approvalBlockedReason: 'key_changed' })], recordingEnabled: true })
    render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(screen.queryByText(/Approve…/)).toBeNull()
    expect(screen.getByText(/Re-review needed: the fingerprint key was changed/)).toBeTruthy()
    expect(screen.getByText(/Evaluate the company again and review the NEW proposal/)).toBeTruthy()
  })

  it('a missing fingerprint key blocks approval and says why', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval', approvable: false, approvalBlockedReason: 'key_not_configured' })], recordingEnabled: true })
    render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(screen.queryByText(/Approve…/)).toBeNull()
    expect(screen.getByText(/fingerprint key is not configured/)).toBeTruthy()
  })

  it('recording OFF: an administrator sees the proposals READ-ONLY, with an explicit explanation of why approval is disabled', async () => {
    api.get.mockResolvedValue({ items: [item({ approvable: false, approvalBlockedReason: 'switch_off' })], recordingEnabled: false })
    render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(screen.getByText(/Approval is disabled/)).toBeTruthy()
    expect(screen.getByText(/WARM_LEADS_RECORD_OPT_OUTS/)).toBeTruthy()
    expect(screen.getByText(/read-only/)).toBeTruthy()
    expect(screen.queryByText(/Approve…/)).toBeNull()
  })

  it('nothing the server keeps secret ever appears on the screen or in a request', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval' })], recordingEnabled: true })
    const { container } = render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(container.textContent).not.toMatch(/\b[0-9a-f]{16}\b/) // no fingerprint-looking value
    expect(container.textContent).not.toMatch(/fp |fingerprint:/i)
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
    fireEvent.change(screen.getByLabelText('How the request was verified'), { target: { value: 'other_trusted_channel' } })
    fireEvent.click(await screen.findByText(/Yes — add/))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/no longer a plain standalone opt-out/))
  })
})

// ── the administrator can look at the EXACT address of one proposal, to verify it through a trusted channel ──────────────────────────────────────
describe('revealing the exact address of one proposal', () => {
  const REVEALED = { address: 'ravi@acme.example', masked: 'r***@acme.example', authenticated: false, notice: 'This address comes from the From line of the email, which anyone can forge. Reading it is NOT verification: confirm it through a channel you already trust.' }
  const open = async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval' })], recordingEnabled: true })
    const view = render(<OptOutReview enabled refreshKey={0} admin />)
    fireEvent.click(await screen.findByText(/Approve…/))
    return view
  }

  it('the list itself stays masked: the exact address is not on screen until it is asked for, and it is asked for inside the approval form only', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval' })], recordingEnabled: true })
    const { container } = render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(screen.queryByText(/Show the exact address/)).toBeNull() // not offered on the list
    fireEvent.click(screen.getByText(/Approve…/))
    expect(await screen.findByText(/Show the exact address/)).toBeTruthy()
    expect(container.textContent).not.toContain('ravi@acme.example')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('"Show the exact address" asks the server with IDS ONLY, then shows the address with the plain warning that it is unauthenticated', async () => {
    api.post.mockResolvedValue(REVEALED)
    const { container } = await open()
    fireEvent.click(await screen.findByText(/Show the exact address/))
    await waitFor(() => expect(screen.getByText('ravi@acme.example')).toBeTruthy())
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith('/warm-leads/opt-outs/reveal', { crmCompanyId: 'c1', activityId: 'act_8f2' })
    expect(container.textContent).toMatch(/unauthenticated From line/)
    expect(container.textContent).toMatch(/Reading it is NOT verification/)
    expect(container.textContent).toMatch(/recorded in the audit log, without the address/)
  })

  it('seeing the address does not unlock the approval: the independent-verification checkbox AND a method are still required', async () => {
    api.post.mockResolvedValue(REVEALED)
    await open()
    fireEvent.click(await screen.findByText(/Show the exact address/))
    await screen.findByText('ravi@acme.example')
    const yes = screen.getByText('Yes — add r***@acme.example to the suppression list').closest('button') as HTMLButtonElement
    expect(yes.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(yes.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('How the request was verified'), { target: { value: 'email_to_address_on_file' } })
    expect(yes.disabled).toBe(false)
  })

  it('offers exactly the server\'s verification methods, and no free-text field', async () => {
    await open()
    const options = [...(screen.getByLabelText('How the request was verified') as HTMLSelectElement).options].map((o) => o.value)
    expect(options).toEqual(['', 'phone_call_known_number', 'email_to_address_on_file', 'account_owner_confirmed', 'meeting_or_video_call', 'other_trusted_channel'])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('the address is hidden again by Hide, by Cancel, after an approval, and when the list reloads', async () => {
    api.post.mockResolvedValue(REVEALED)
    const { rerender } = await open()
    const show = async () => {
      fireEvent.click(await screen.findByText(/Show the exact address/))
      await screen.findByText('ravi@acme.example')
    }
    await show()
    fireEvent.click(screen.getByText('Hide'))
    expect(screen.queryByText('ravi@acme.example')).toBeNull()
    await show()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('ravi@acme.example')).toBeNull()
    fireEvent.click(screen.getByText(/Approve…/))
    await show()
    rerender(<OptOutReview enabled refreshKey={1} admin />) // the list reloads
    await waitFor(() => expect(screen.queryByText('ravi@acme.example')).toBeNull())
    // after an approval
    api.post.mockReset()
    api.post.mockResolvedValueOnce(REVEALED).mockResolvedValueOnce({ message: 'r***@acme.example was added to the suppression list.' })
    await show() // the form is still open after the reload
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('How the request was verified'), { target: { value: 'meeting_or_video_call' } })
    fireEvent.click(screen.getByText(/Yes — add/))
    await waitFor(() => expect(screen.getByText(/was added to the suppression list/)).toBeTruthy())
    expect(screen.queryByText('ravi@acme.example')).toBeNull()
  })

  it('the address disappears by itself after two minutes', async () => {
    api.post.mockResolvedValue(REVEALED)
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      await open()
      fireEvent.click(await screen.findByText(/Show the exact address/))
      await screen.findByText('ravi@acme.example')
      const scheduled = timers.mock.calls.filter((c) => c[1] === 120_000)
      expect(scheduled).toHaveLength(1)
      act(() => (scheduled[0]![0] as () => void)())
      expect(screen.queryByText('ravi@acme.example')).toBeNull()
    } finally {
      timers.mockRestore()
    }
  })

  it('a refusal from the server is shown in words, with no address', async () => {
    api.post.mockRejectedValue(new Error('NXT Sales does not link that email to any company, so it cannot be tied to this company and was not approved.'))
    const { container } = await open()
    fireEvent.click(await screen.findByText(/Show the exact address/))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/does not link that email to any company/))
    expect(container.textContent).not.toContain('@acme.example​')
    expect(screen.queryByText('ravi@acme.example')).toBeNull()
  })

  it('a non-admin, or recording switched off, gets no reveal control at all', async () => {
    api.get.mockResolvedValue({ items: [item({ status: 'awaiting_approval' })], recordingEnabled: true })
    const a = render(<OptOutReview enabled refreshKey={0} admin={false} />)
    await screen.findByText('Acme Traders')
    expect(screen.queryByText(/Show the exact address/)).toBeNull()
    a.unmount()
    api.get.mockResolvedValue({ items: [item()], recordingEnabled: false })
    render(<OptOutReview enabled refreshKey={0} admin />)
    await screen.findByText('Acme Traders')
    expect(screen.queryByText(/Show the exact address/)).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })
})
