import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PilotPanel } from './PilotPanel'
import type { Overview } from './types'

// WHERE the opt-out review is reachable. It used to be mounted only while the pilot was running / in review, so once the pilot was approved
// (stage "daily" - the only stage in which the owner may switch recording on) no screen offered it. Now an administrator reaches it in the daily
// stage too; with recording OFF it is read-only. The panel itself is a stand-in here; its behaviour is tested in OptOutReview.test.tsx.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../lib/api', () => ({ api }))
vi.mock('./OptOutReview', () => ({ OptOutReview: ({ admin }: { admin: boolean }) => <div data-testid="optout-review">opt-out review (admin={String(admin)})</div> }))

const overview = (stage: Overview['stage']): Overview =>
  ({
    stage,
    counts: new Proxy({}, { get: () => 0 }), // every counter is 0
    pilot: { run: stage === 'no_company_list' || stage === 'pilot_not_requested' ? null : { id: 'r1', status: stage === 'pilot_running' ? 'running' : 'completed', total: 100, startedAt: null, finishedAt: null, failureReason: null }, counts: { total: 0, queued: 0, running: 0, done: 0, failed: 0, incomplete: 0, warm: 0, earlySignal: 0, cold: 0, insufficientData: 0, humanReview: 0, other: 0 }, approvedAt: stage === 'daily' ? '2026-11-09T00:00:00Z' : null, approvedBy: stage === 'daily' ? 'admin-1' : null, canApprove: false },
    settings: { pilotSize: 100 },
  }) as unknown as Overview

const act = vi.fn(async () => undefined)
const renderPanel = (stage: Overview['stage'], admin: boolean) => render(<PilotPanel o={overview(stage)} admin={admin} act={act} busy={null} refreshKey={0} />)

beforeEach(() => {
  api.get.mockReset()
  api.get.mockResolvedValue({ evaluations: [] })
})

describe('the opt-out review is reachable for administrators in every stage in which proposals can exist', () => {
  it('DAILY stage (pilot approved): an administrator sees it', async () => {
    renderPanel('daily', true)
    expect(await screen.findByTestId('optout-review')).toBeTruthy()
    expect(screen.getByText(/admin=true/)).toBeTruthy()
  })

  it('DAILY stage: a non-administrator does not get the panel', async () => {
    renderPanel('daily', false)
    await screen.findByText(/Approved/)
    expect(screen.queryByTestId('optout-review')).toBeNull()
  })

  it.each(['pilot_running', 'pilot_review'] as const)('%s: still there, as before', async (stage) => {
    renderPanel(stage, true)
    expect(await screen.findByTestId('optout-review')).toBeTruthy()
    await waitFor(() => expect(api.get).toHaveBeenCalled())
  })

  it.each(['no_company_list', 'pilot_not_requested'] as const)('%s: nothing has been evaluated, so no panel', (stage) => {
    renderPanel(stage, true)
    expect(screen.queryByTestId('optout-review')).toBeNull()
  })
})
