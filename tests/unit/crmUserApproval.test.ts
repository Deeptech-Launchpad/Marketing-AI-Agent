import { describe, expect, it } from 'vitest'
import { SYNC_STATES } from '../../src/crmsync/types.js'
import { writeCapability, assertWritable } from '../../src/crmsync/writeGate.js'

// CONFIRMED DECISION 4 — CRM updates require a human decision.
//
//   AI qualifies the lead
//     → a USER reviews it
//     → the USER decides
//     → only then is NXT Sales updated
//
// The gate is structural: `syncQualification` writes nothing without a
// `userApproval` carrying an approver id, and the only function that supplies
// one is `approveSync`. These tests hold that shape in place.

describe('the review states exist and mean distinct things', () => {
  it('has a state for waiting on a person', () => {
    expect(SYNC_STATES).toContain('awaiting_user_approval')
  })

  it('records a decline as its own state, not as an absence', () => {
    // "A reviewer looked at this and said no" is a different fact from
    // "nothing has happened yet", and the difference is what someone needs
    // months later when asking why a qualified lead never reached the CRM.
    expect(SYNC_STATES).toContain('rejected_by_user')
  })

  it('keeps waiting-for-a-person apart from waiting-for-a-provider', () => {
    expect(SYNC_STATES).toContain('blocked_provider_unavailable')
    expect(SYNC_STATES).toContain('awaiting_user_approval')
    // Collapsing them would make "nobody has reviewed this" indistinguishable
    // from "no adapter can deliver it", which need opposite actions.
    expect(new Set(SYNC_STATES).size).toBe(SYNC_STATES.length)
  })
})

describe('the approval is structural, not advisory', () => {
  const src = () =>
    import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/crmsync/service.ts', import.meta.url), 'utf8'),
    )

  it('delivery is unreachable without a userApproval', async () => {
    const s = await src()
    // The branch order is what enforces it: no approval, no attemptDelivery.
    const gate = s.indexOf('} else if (!options.userApproval) {')
    const deliver = s.indexOf('await attemptDelivery(')
    expect(gate).toBeGreaterThan(-1)
    expect(deliver).toBeGreaterThan(gate)
  })

  it('only approveSync supplies an approval', async () => {
    const s = await src()
    const suppliers = [...s.matchAll(/userApproval:\s*\{/g)]
    expect(suppliers).toHaveLength(1)
    const before = s.slice(0, suppliers[0]!.index)
    expect(before).toMatch(/export async function approveSync/)
  })

  it('an approval must name its approver', async () => {
    const s = await src()
    expect(s).toMatch(/approvedByCrmUserId: string/)
    // The approval object carries the approver and the moment, together.
    expect(s).toMatch(/userApproval:\s*\{\s*approvedByCrmUserId,\s*approvedAt: new Date\(\)/)
  })

  it('approving something not awaiting a decision is refused', async () => {
    const s = await src()
    expect(s).toMatch(/if \(record\.state !== 'awaiting_user_approval'\)/)
    expect(s).toMatch(/not awaiting a decision/)
  })

  it('both decisions are audited against the person who made them', async () => {
    const s = await src()
    expect(s).toMatch(/crm_sync\.approved_by_user/)
    expect(s).toMatch(/crm_sync\.rejected_by_user/)
    expect(s).toMatch(/actorType: 'user'/)
  })
})

describe('the confirmed field keys and the write scope', () => {
  it('writes stay off by default even with the keys configured', () => {
    // Decision 2 supplies the keys; decision 4 says a person must still decide.
    // Configuring a destination is not permission to write to it.
    const c = writeCapability()
    expect(c.enabled).toBe(false)
  })

  it('still refuses owner, deal stage and deal value', () => {
    expect(() => assertWritable({ ownerId: 'x' })).toThrow(/Owner reassignment/)
    expect(() => assertWritable({ stage: 'Won' })).toThrow()
    expect(() => assertWritable({ dealValue: 1 })).toThrow()
  })

  it('permits exactly the confirmed additive payload', () => {
    expect(() =>
      assertWritable({ customFields: { intentScore: 100, qualificationStatus: 'qualified' } }),
    ).not.toThrow()
  })
})
