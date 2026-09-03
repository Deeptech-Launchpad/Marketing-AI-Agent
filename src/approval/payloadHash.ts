import crypto from 'node:crypto'

// Approve-what-you-saw enforcement.
//
// The reviewer is shown a payload; the hash of that exact payload is stored on
// the Approval row; the decision request must echo it back. If the payload
// changed in between — a regenerated asset, a re-resolved audience — the hash
// no longer matches and the decision is rejected with 409 rather than silently
// approving something nobody read.
//
// In Phase 1 nothing external happens on approval, so this is not yet load
// bearing. It is built now precisely so it has been exercised for real before
// Phase 4 makes it the precondition for sending anything.

/**
 * Deterministic serialisation: object keys are sorted recursively, so two
 * structurally identical payloads always hash the same regardless of the order
 * JSON.stringify happened to emit them in.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalise((value as Record<string, unknown>)[key])
  }
  return sorted
}

export function computePayloadHash(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalise(payload))).digest('hex')
}
