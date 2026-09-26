import { StatusBadge } from './primitives'
import type { UiStatus } from '../../lib/types'

// ─────────────────────────────────────────────────────────────────────────
// The engine run vocabulary.
//
// Every engine on this platform has the same handful of honest answers to
// "did it run": it has not, it is waiting for the worker, it is working, it
// finished, it finished some of the job, it was deliberately stopped, or it
// broke. The screens used to say these with whatever words each had to hand —
// or, for a queued run behind a worker that was not running, with a row of
// zeros — so the same state read differently on every page. One badge, one
// spelling, drawn with the shared StatusBadge so it matches the rest of the
// interface without a stylesheet of its own.
// ─────────────────────────────────────────────────────────────────────────

export type EngineRunState =
  | 'not_run'
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  /**
   * The human gate: the automated part finished and a person has not yet
   * decided. Neither COMPLETED (nothing was written) nor BLOCKED (nothing is
   * wrong), so it gets its own word rather than borrowing the wrong one.
   */
  | 'awaiting_approval'

const META: Record<EngineRunState, { status: UiStatus; label: string }> = {
  not_run: { status: 'idle', label: 'NOT RUN' },
  // 'review' draws a still clock. A queued run must not spin: the spinner is
  // the "running" signal, and a run waiting on a dead worker is not running.
  queued: { status: 'review', label: 'QUEUED' },
  running: { status: 'running', label: 'RUNNING' },
  completed: { status: 'complete', label: 'COMPLETED' },
  partial: { status: 'blocked', label: 'PARTIAL' },
  blocked: { status: 'blocked', label: 'BLOCKED' },
  failed: { status: 'error', label: 'FAILED' },
  awaiting_approval: { status: 'review', label: 'AWAITING APPROVAL' },
}

export function EngineStatusBadge({
  state,
  size = 'md',
  detail,
}: {
  state: EngineRunState
  size?: 'sm' | 'md'
  /** A hover explanation, in the backend's words where there are any. */
  detail?: string
}) {
  const meta = META[state]
  const badge = <StatusBadge status={meta.status} label={meta.label} size={size} />
  return detail ? <span title={detail}>{badge}</span> : badge
}
