import { describe, expect, it } from 'vitest'
import { computePayloadHash } from '../../src/approval/payloadHash.js'

describe('computePayloadHash', () => {
  it('is stable regardless of key order', () => {
    const a = computePayloadHash({ b: 2, a: 1, nested: { y: 2, x: 1 } })
    const b = computePayloadHash({ a: 1, b: 2, nested: { x: 1, y: 2 } })
    expect(a).toBe(b)
  })

  it('changes when any value changes', () => {
    const base = computePayloadHash({ audience: { included: 500 } })
    expect(computePayloadHash({ audience: { included: 501 } })).not.toBe(base)
  })

  it('changes when a field is added — approving a subset must not pass', () => {
    const base = computePayloadHash({ strategy: 'x' })
    expect(computePayloadHash({ strategy: 'x', extraAsset: 'y' })).not.toBe(base)
  })

  it('preserves array order — a reordered sequence is a different plan', () => {
    const a = computePayloadHash({ steps: [1, 2, 3] })
    const b = computePayloadHash({ steps: [3, 2, 1] })
    expect(a).not.toBe(b)
  })

  it('produces a 64-char sha256 hex digest', () => {
    expect(computePayloadHash({ any: 'thing' })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('handles dates deterministically', () => {
    const d = new Date('2026-01-01T00:00:00.000Z')
    expect(computePayloadHash({ at: d })).toBe(computePayloadHash({ at: new Date(d.getTime()) }))
  })
})
