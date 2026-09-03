import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EVENT_ACTOR, EVENT_ACTORS, ENGAGEMENT_EVENT_TYPES } from '../../src/engagement/types.js'
import { actorOf } from '../../src/engagement/timeline.js'

// HARDENING — the actor classification is a data contract, not a convention.
//
// The defect these tests exist to prevent: the interface carried a second,
// regex-based copy of EVENT_ACTOR. It classified infrastructure events — a
// bounce, a delivery receipt — as AltiusNXT actions, so a wrong email address
// rendered in the lane labelled "AltiusNXT actions" as though we had done
// something. Invisible while no system events existed; wrong the moment one did.
//
// The fix is that the API publishes the actor. These tests hold that shut from
// both ends: the backend must classify every event type exactly once, and the
// frontend must not grow a classifier of its own again.

// ── 1. THE MAP IS COMPLETE AND CLOSED ──────────────────────────────────────

describe('EVENT_ACTOR is the single classification', () => {
  it('classifies every declared event type', () => {
    for (const t of ENGAGEMENT_EVENT_TYPES) {
      expect(EVENT_ACTOR[t], t).toBeDefined()
      expect(EVENT_ACTORS, t).toContain(EVENT_ACTOR[t])
    }
  })

  it('has no entry for an event type that does not exist', () => {
    for (const k of Object.keys(EVENT_ACTOR)) {
      expect(ENGAGEMENT_EVENT_TYPES as readonly string[], k).toContain(k)
    }
  })

  it('resolves through one helper', () => {
    for (const t of ENGAGEMENT_EVENT_TYPES) expect(actorOf(t)).toBe(EVENT_ACTOR[t])
  })

  it('falls back conservatively for an unknown type', () => {
    // Attributing an unknown act to the prospect would overstate engagement,
    // so the fallback is the reading that cannot inflate a score... which is
    // why the map is exhaustive and this is only a guard.
    expect(actorOf('some_event_that_does_not_exist')).toBe('prospect')
  })
})

// ── 2. SYSTEM EVENTS BELONG TO NEITHER PARTY ───────────────────────────────

describe('infrastructure events are neither ours nor theirs', () => {
  const systemTypes = (ENGAGEMENT_EVENT_TYPES as readonly string[]).filter((t) => EVENT_ACTOR[t as never] === 'system')

  it('classifies the infrastructure events as system', () => {
    expect(systemTypes.length).toBeGreaterThan(0)
    // A bounce is the clearest case: it is a fact about an address, not an act
    // by a person.
    expect(systemTypes).toContain('email_bounced')
  })

  it('a system event is never classified as prospect', () => {
    for (const t of systemTypes) expect(actorOf(t), t).not.toBe('prospect')
  })

  it('a system event is never classified as altiusnxt', () => {
    for (const t of systemTypes) expect(actorOf(t), t).not.toBe('altiusnxt')
  })

  it('so it can land in neither lane', () => {
    // The lanes filter on an exact actor match. This is the assertion the UI
    // now depends on, expressed against the same rule the UI reads.
    const events = (ENGAGEMENT_EVENT_TYPES as readonly string[]).map((t) => ({ eventType: t, actor: actorOf(t) }))
    const prospectLane = events.filter((e) => e.actor === 'prospect')
    const ourLane = events.filter((e) => e.actor === 'altiusnxt')
    for (const t of systemTypes) {
      expect(prospectLane.some((e) => e.eventType === t), `${t} in prospect lane`).toBe(false)
      expect(ourLane.some((e) => e.eventType === t), `${t} in AltiusNXT lane`).toBe(false)
    }
    // And every event still belongs to exactly one bucket.
    expect(prospectLane.length + ourLane.length + systemTypes.length).toBe(ENGAGEMENT_EVENT_TYPES.length)
  })
})

// ── 3. THE FRONTEND MUST NOT RE-DERIVE IT ──────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('the interface does not classify actors itself', () => {
  // fileURLToPath, not URL.pathname: the repository path contains a space,
  // which pathname returns percent-encoded.
  const WEB = fileURLToPath(new URL('../../web/src', import.meta.url))
  const files = walk(WEB)

  it('finds the frontend sources', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('contains no local actorOf implementation', () => {
    const offenders = files.filter((f) => /function\s+actorOf\b|const\s+actorOf\s*=/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.replace(WEB, ''))).toEqual([])
  })

  it('does not pattern-match event types to decide an actor', () => {
    // The removed implementation tested event-type prefixes with a regex.
    // Any return of an actor literal from a source file is the shape to catch.
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /return\s+'(?:altiusnxt|prospect|system)'/.test(src)
    })
    expect(offenders.map((f) => f.replace(WEB, ''))).toEqual([])
  })

  it('reads the actor from the API instead', () => {
    const engagement = files.find((f) => f.endsWith('Engagement.tsx'))!
    const src = readFileSync(engagement, 'utf8')
    expect(src).toMatch(/e\.actor === 'prospect'/)
    expect(src).toMatch(/e\.actor === 'altiusnxt'/)
    // The old test that swept system events into our lane.
    expect(src).not.toMatch(/!==\s*'prospect'/)
  })

  it('declares actor on the event contract', () => {
    const types = files.find((f) => f.endsWith('lib/types.ts') || f.endsWith('lib\\types.ts'))!
    expect(readFileSync(types, 'utf8')).toMatch(/actor: EventActor/)
  })
})
