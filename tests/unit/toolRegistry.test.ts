import { describe, expect, it } from 'vitest'
import { STEP_ORDER } from '../../src/orchestrator/stateMachine.js'
import { TOOLS, getTool, toolNames } from '../../src/orchestrator/tools/registry.js'

// The registry is one half of the injection firewall (the dispatcher is the
// other). These assertions encode the Phase 1 safety contract itself, so if
// someone adds a write tool without meaning to, this suite fails.

describe('tool registry — Phase 1 safety contract', () => {
  it('contains NO write tools at all', () => {
    const writeTools = Object.values(TOOLS).filter((t) => t.sideEffectClass !== 'read')
    expect(writeTools.map((t) => t.name)).toEqual([])
  })

  it('scopes every tool to specific steps', () => {
    for (const tool of Object.values(TOOLS)) {
      expect(tool.allowedInSteps.length).toBeGreaterThan(0)
      for (const step of tool.allowedInSteps) {
        expect(STEP_ORDER).toContain(step)
      }
    }
  })

  it('gives the RESEARCH step no route to CRM data', () => {
    // The worked example from the dispatcher comment: untrusted page content is
    // read in RESEARCH, so RESEARCH must not be able to reach a CRM tool.
    const reachable = Object.values(TOOLS)
      .filter((t) => t.allowedInSteps.includes('RESEARCH'))
      .map((t) => t.name)

    expect(reachable.some((n) => n.startsWith('crm.'))).toBe(false)
    expect(reachable).toContain('research.fetchPage')
  })

  it('marks third-party text as untrusted', () => {
    expect(TOOLS['research.fetchPage']!.outputTrust).toBe('untrusted')
    expect(TOOLS['research.webSearch']!.outputTrust).toBe('untrusted')
    // Email bodies were written by external correspondents, not by us.
    expect(TOOLS['crm.getEmailSummary']!.outputTrust).toBe('untrusted')
    expect(TOOLS['crm.exportDeals']!.outputTrust).toBe('trusted')
  })

  it('bounds every tool with a timeout', () => {
    for (const tool of Object.values(TOOLS)) {
      expect(tool.timeoutMs).toBeGreaterThan(0)
    }
  })
})

describe('getTool', () => {
  it('resolves known tools', () => {
    expect(getTool('crm.exportDeals')?.name).toBe('crm.exportDeals')
  })

  it('returns null for unknown names', () => {
    expect(getTool('crm.deleteEverything')).toBeNull()
    expect(getTool('')).toBeNull()
  })

  it('does not resolve inherited Object properties', () => {
    // A model-supplied name must never reach a prototype member.
    expect(getTool('constructor')).toBeNull()
    expect(getTool('__proto__')).toBeNull()
    expect(getTool('toString')).toBeNull()
  })

  it('exposes a stable name list', () => {
    expect(toolNames()).toContain('rag.search')
    expect(toolNames().length).toBe(Object.keys(TOOLS).length)
  })
})
