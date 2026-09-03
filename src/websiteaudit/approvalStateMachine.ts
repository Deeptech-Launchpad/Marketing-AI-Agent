// TASK #980 — the approval state machine.
//
// A separate, tiny module because the whole value of this task is that the
// transitions are ENFORCED rather than implied. A status column that any route
// can assign is not a workflow; it is a string that happens to be spelled like
// one.
//
// The rule that shapes it: an approved report is finished. It cannot drift into
// another state by a stray call, and it cannot be edited in place. Getting back
// to review from `approved` requires an explicit reopen, which is its own
// action with its own permission, its own reason, and its own audit event.

export const APPROVAL_STATES = [
  'ready_for_approval',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

export const APPROVAL_ACTIONS = ['start', 'approve', 'request_changes', 'reject', 'reopen'] as const
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number]

/**
 * Every legal move. Anything absent from this table is refused.
 *
 * Deciding straight from `ready_for_approval` is deliberately allowed: a
 * reviewer who reads the report and approves it has reviewed it, and forcing a
 * separate "start" click first would only add a step that teaches people to
 * click through steps.
 */
const TRANSITIONS: Record<ApprovalState, Partial<Record<ApprovalAction, ApprovalState>>> = {
  ready_for_approval: {
    start: 'in_review',
    approve: 'approved',
    request_changes: 'changes_requested',
    reject: 'rejected',
  },
  in_review: {
    approve: 'approved',
    request_changes: 'changes_requested',
    reject: 'rejected',
  },
  changes_requested: {
    // Re-enters review once a new revision exists. Approving straight out of
    // changes_requested is not offered: the changes were requested for a
    // reason, and something should have changed before it is signed off.
    start: 'in_review',
    reject: 'rejected',
  },
  // Terminal. `reopen` is the only way out, and it is an explicit new review
  // cycle rather than a silent edit of a signed-off document.
  approved: {
    reopen: 'in_review',
  },
  rejected: {
    reopen: 'in_review',
  },
}

export interface TransitionResult {
  ok: boolean
  next?: ApprovalState
  reason?: string
}

export function canTransition(from: ApprovalState, action: ApprovalAction): TransitionResult {
  const next = TRANSITIONS[from]?.[action]
  if (!next) {
    const allowed = Object.keys(TRANSITIONS[from] ?? {})
    return {
      ok: false,
      reason:
        `A report in state "${from}" cannot be ${describe(action)}. ` +
        (allowed.length
          ? `Available actions here: ${allowed.join(', ')}.`
          : 'This state is terminal and has no available actions.'),
    }
  }
  return { ok: true, next }
}

function describe(action: ApprovalAction): string {
  switch (action) {
    case 'start':
      return 'moved into review'
    case 'approve':
      return 'approved'
    case 'request_changes':
      return 'sent back for changes'
    case 'reject':
      return 'rejected'
    case 'reopen':
      return 'reopened'
  }
}

/** Actions a UI should offer for a given state, without hard-coding the table. */
export function availableActions(from: ApprovalState): ApprovalAction[] {
  return Object.keys(TRANSITIONS[from] ?? {}) as ApprovalAction[]
}

/** Whether the report content may be revised while in this state. */
export function isEditable(state: ApprovalState): boolean {
  // An approved or rejected report is a record of a decision. Editing it would
  // change what was decided on after the fact.
  return state === 'ready_for_approval' || state === 'in_review' || state === 'changes_requested'
}

export function isTerminal(state: ApprovalState): boolean {
  return state === 'approved' || state === 'rejected'
}
