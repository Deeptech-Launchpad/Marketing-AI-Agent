import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReportAssistant } from './ReportAssistant'

// THE AUDIT ASSISTANT PANEL.
//
// What must hold on screen, whatever the model returned:
//
//   · a draft with figures the audit does not contain is shown WITH the flag
//   · a blocked edit proposal shows why, and offers no save button
//   · a clean proposal can be saved only by someone who can approve, and
//     saving goes through the existing revision route with a FRESH lock token
//   · nobody without operate permission can talk to it at all

const post = vi.fn()
const get = vi.fn()
vi.mock('../../lib/api', () => ({ api: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } }))

const answer = (over: Record<string, unknown> = {}) => ({
  reply: 'The page does not publish an MPN or a GTIN.',
  drafts: [],
  proposedEdit: null,
  citations: ['A4'],
  warnings: [],
  ...over,
})

beforeEach(() => {
  post.mockReset()
  get.mockReset()
})

const askFirstSuggestion = async () => {
  const user = userEvent.setup()
  await user.click(screen.getAllByRole('button').find((b) => /biggest problems/i.test(b.textContent ?? ''))!)
}

describe('talking to it', () => {
  it('offers grounded starting questions and sends the chosen one to this run', async () => {
    post.mockResolvedValue(answer())
    render(<ReportAssistant runId="run-1" canOperate canApprove />)
    await askFirstSuggestion()

    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0]![0]).toBe('/website-audit/runs/run-1/assistant')
    expect(await screen.findByText(/does not publish an MPN/i)).toBeInTheDocument()
    expect(screen.getByText('A4')).toBeInTheDocument()
  })

  it('is locked for someone without operate permission', () => {
    render(<ReportAssistant runId="run-1" canOperate={false} canApprove={false} />)
    expect(screen.getByText(/needs the operate permission/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/ask about this audit/i)).toBeNull()
  })

  it('shows a failed request as an error rather than a blank answer', async () => {
    post.mockRejectedValue(new Error('The model is unavailable.'))
    render(<ReportAssistant runId="run-1" canOperate canApprove />)
    await askFirstSuggestion()
    expect(await screen.findByText(/the model is unavailable/i)).toBeInTheDocument()
  })
})

describe('drafts are shown with their flags', () => {
  it('flags figures the audit does not contain, on the draft itself', async () => {
    post.mockResolvedValue(
      answer({
        drafts: [
          { kind: 'product_description', title: 'Improved description', content: 'Rated to 90 degrees.', ungroundedFigures: ['90'], claimViolations: [] },
        ],
      }),
    )
    render(<ReportAssistant runId="run-1" canOperate canApprove />)
    await askFirstSuggestion()
    expect(await screen.findByText('Improved description')).toBeInTheDocument()
    expect(screen.getByText(/figures the audit does not contain/i)).toHaveTextContent('"90"')
  })
})

describe('proposed report changes', () => {
  const proposal = (over: Record<string, unknown> = {}) =>
    answer({
      proposedEdit: {
        changeReason: 'Lead with the most important finding.',
        edit: { summary: 'Dimensions were missing on 9 of the 12 inspected product pages.' },
        current: { summary: 'This review covers 15 pages.' },
        blocked: false,
        blockedReasons: [],
        ...over,
      },
    })

  it('shows a blocked proposal with its reasons and no way to save it', async () => {
    post.mockResolvedValue(proposal({ blocked: true, blockedReasons: ['summary: [money] "£40,000" — not supported'] }))
    render(<ReportAssistant runId="run-1" canOperate canApprove />)
    await askFirstSuggestion()
    expect(await screen.findByText(/cannot be saved as proposed/i)).toBeInTheDocument()
    expect(screen.getByText(/£40,000/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save as a new revision/i })).toBeNull()
  })

  it('shows the current and proposed wording side by side', async () => {
    post.mockResolvedValue(proposal())
    render(<ReportAssistant runId="run-1" canOperate canApprove />)
    await askFirstSuggestion()
    expect(await screen.findByText('This review covers 15 pages.')).toBeInTheDocument()
    expect(screen.getByText(/9 of the 12 inspected product pages/)).toBeInTheDocument()
  })

  it('offers no save to someone who cannot approve', async () => {
    post.mockResolvedValue(proposal())
    render(<ReportAssistant runId="run-1" canOperate canApprove={false} />)
    await askFirstSuggestion()
    expect(await screen.findByText(/needs the approve permission/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save as a new revision/i })).toBeNull()
  })

  it('saves through the existing revision route with a fresh lock token', async () => {
    post.mockResolvedValueOnce(proposal())
    get.mockResolvedValue({ lockVersion: 7, currentRevision: 3, canEdit: true })
    post.mockResolvedValueOnce({ revisionNumber: 4, approvable: true, note: 'Revision saved and validated.' })
    const onRevised = vi.fn()

    render(<ReportAssistant runId="run-1" canOperate canApprove onRevised={onRevised} />)
    await askFirstSuggestion()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /save as a new revision/i }))

    await waitFor(() => expect(onRevised).toHaveBeenCalled())
    // Read the concurrency token at the moment of saving, not when answered.
    expect(get).toHaveBeenCalledWith('/website-audit/runs/run-1/approval')
    const [path, body] = post.mock.calls[1] as [string, Record<string, unknown>]
    expect(path).toBe('/website-audit/runs/run-1/report/revise')
    expect(body).toMatchObject({
      edit: { summary: 'Dimensions were missing on 9 of the 12 inspected product pages.' },
      expectedLockVersion: 7,
      expectedRevision: 3,
    })
    expect(String(body.changeReason)).toMatch(/^Audit assistant:/)
    expect(await screen.findByText(/saved as revision 4/i)).toBeInTheDocument()
  })

  it('refuses to save when the report can no longer be edited', async () => {
    post.mockResolvedValueOnce(proposal())
    get.mockResolvedValue({ lockVersion: 7, currentRevision: 3, canEdit: false })
    render(<ReportAssistant runId="run-1" canOperate canApprove />)
    await askFirstSuggestion()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /save as a new revision/i }))
    expect(await screen.findByText(/cannot be edited in its current state/i)).toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(1)
  })
})
