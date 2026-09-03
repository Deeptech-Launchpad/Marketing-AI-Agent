import type { StepType } from '../domain/enums.js'

// A fixed pipeline, not a free agent loop.
//
// The model proposes inside a step; the orchestrator decides what happens next.
// That is what makes a run auditable, cost-bounded, resumable — and structurally
// resistant to prompt injection, because untrusted text encountered in RESEARCH
// cannot cause a transition to any other step.

const ORDER: StepType[] = [
  'INTAKE',
  'ICP_SYNTHESIS',
  'SEGMENT_PROPOSE',
  'SEGMENT_RESOLVE',
  'RESEARCH',
  'STRATEGY',
  'APPROVAL_STRATEGY',
  'CONTENT_GENERATE',
  'CONTENT_VALIDATE',
  'APPROVAL_CONTENT',
  'PACKAGE',
]

/** Steps that pause the run and wait for a human decision. */
const APPROVAL_STEPS = new Set<StepType>(['APPROVAL_STRATEGY', 'APPROVAL_CONTENT'])

export function firstStep(): StepType {
  return ORDER[0]!
}

export function nextStep(current: StepType): StepType | null {
  const index = ORDER.indexOf(current)
  if (index === -1) throw new Error(`Unknown step type: ${current}`)
  return ORDER[index + 1] ?? null
}

export function isApprovalStep(step: StepType): boolean {
  return APPROVAL_STEPS.has(step)
}

export function isTerminalStep(step: StepType): boolean {
  return nextStep(step) === null
}

/**
 * A transition is legal only if it is the next step in order, or a backward
 * jump to a regeneration target (which is what "changes requested" produces).
 * Anything else is a bug, and is rejected rather than silently executed.
 */
const REGENERATION_TARGETS = new Set<StepType>(['STRATEGY', 'CONTENT_GENERATE'])

export function isLegalTransition(from: StepType | null, to: StepType): boolean {
  if (from === null) return to === firstStep()
  if (nextStep(from) === to) return true
  if (REGENERATION_TARGETS.has(to) && ORDER.indexOf(to) < ORDER.indexOf(from)) return true
  return false
}

export const STEP_ORDER = ORDER
