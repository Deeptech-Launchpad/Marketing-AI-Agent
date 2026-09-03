import { describe, expect, it } from 'vitest'
import {
  firstStep,
  isApprovalStep,
  isLegalTransition,
  isTerminalStep,
  nextStep,
  STEP_ORDER,
} from '../../src/orchestrator/stateMachine.js'
import { STEP_HANDLERS } from '../../src/orchestrator/steps/index.js'

describe('state machine', () => {
  it('starts at INTAKE and ends at PACKAGE', () => {
    expect(firstStep()).toBe('INTAKE')
    expect(isTerminalStep('PACKAGE')).toBe(true)
    expect(nextStep('PACKAGE')).toBeNull()
  })

  it('walks the full pipeline in order', () => {
    const walked: string[] = []
    let step: string | null = firstStep()
    while (step) {
      walked.push(step)
      step = nextStep(step as never)
    }
    expect(walked).toEqual([...STEP_ORDER])
  })

  it('has a handler for every step — an unmapped step must not be a silent no-op', () => {
    for (const step of STEP_ORDER) {
      expect(typeof STEP_HANDLERS[step]).toBe('function')
    }
  })

  it('marks both human gates as approval steps', () => {
    expect(isApprovalStep('APPROVAL_STRATEGY')).toBe(true)
    expect(isApprovalStep('APPROVAL_CONTENT')).toBe(true)
    expect(isApprovalStep('STRATEGY')).toBe(false)
  })

  it('throws on an unknown step rather than returning null', () => {
    expect(() => nextStep('NOT_A_STEP' as never)).toThrow()
  })
})

describe('transitions', () => {
  it('allows only the next step forward', () => {
    expect(isLegalTransition('INTAKE', 'ICP_SYNTHESIS')).toBe(true)
    expect(isLegalTransition('INTAKE', 'STRATEGY')).toBe(false)
    expect(isLegalTransition('INTAKE', 'PACKAGE')).toBe(false)
  })

  it('allows a backward jump only to a regeneration target', () => {
    // What "changes requested" produces.
    expect(isLegalTransition('APPROVAL_STRATEGY', 'STRATEGY')).toBe(true)
    expect(isLegalTransition('APPROVAL_CONTENT', 'CONTENT_GENERATE')).toBe(true)
    // Not a regeneration target.
    expect(isLegalTransition('APPROVAL_CONTENT', 'SEGMENT_RESOLVE')).toBe(false)
    expect(isLegalTransition('STRATEGY', 'INTAKE')).toBe(false)
  })

  it('requires a fresh run to begin at the first step', () => {
    expect(isLegalTransition(null, 'INTAKE')).toBe(true)
    expect(isLegalTransition(null, 'STRATEGY')).toBe(false)
  })
})
