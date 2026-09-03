import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clampOccurredAt,
  dedupeKey,
  freshness,
  normalize,
  sanitizeMetadata,
} from '../../src/engagement/normalize.js'
import {
  DEDUPE_POLICY,
  ENGAGEMENT_EVENT_TYPES,
  EVENT_CHANNEL,
  isKnownEventType,
  isPublicEventType,
  PUBLIC_EVENT_TYPES,
} from '../../src/engagement/types.js'
import { eventTypeForStatus } from '../../src/engagement/adapters/outreachAdapter.js'
import { PROVIDER_EVENT_MAP, verifySignature } from '../../src/engagement/adapters/emailWebhookAdapter.js'

// TASK #983 unit tests.
//
// These cover the four things that decide whether an engagement record is
// trustworthy: the vocabulary is closed, timestamps cannot be dictated by an
// untrusted caller, deduplication merges repeats without erasing distinct acts,
// and nothing anywhere is a score.

const BASE = {
  eventType: 'workbench_cta_clicked' as const,
  source: 'workbench_app' as const,
  tenantId: 't1',
  crmCompanyId: 'c1',
  evidence: { what: 'clicked', where: null, how: 'served a redirect', referenceKind: null, referenceId: null },
}

describe('event vocabulary', () => {
  it('is closed — an invented type is not accepted', () => {
    expect(isKnownEventType('workbench_cta_clicked')).toBe(true)
    expect(isKnownEventType('prospect_is_interested')).toBe(false)
    expect(isKnownEventType('hot_lead')).toBe(false)
    expect(isKnownEventType('')).toBe(false)
  })

  it('gives every event type a channel and a dedupe policy', () => {
    for (const type of ENGAGEMENT_EVENT_TYPES) {
      expect(EVENT_CHANNEL[type], `${type} has no channel`).toBeTruthy()
      expect(DEDUPE_POLICY[type], `${type} has no dedupe policy`).toBeTruthy()
    }
  })

  it('lets a public visitor generate only workbench and QR acts', () => {
    expect(isPublicEventType('workbench_cta_clicked')).toBe(true)
    // A browser must never be able to assert these.
    expect(isPublicEventType('email_bounced')).toBe(false)
    expect(isPublicEventType('outreach_action_created')).toBe(false)
    expect(isPublicEventType('call_outcome_recorded')).toBe(false)
    expect(isPublicEventType('email_opened')).toBe(false)
  })

  it('keeps the public list a strict subset of the whitelist', () => {
    for (const type of PUBLIC_EVENT_TYPES) {
      expect(ENGAGEMENT_EVENT_TYPES).toContain(type)
    }
  })

  it('names observed acts, never inferred states', () => {
    // A vocabulary check with teeth: any type reading as a judgement about the
    // prospect would be a scoring concept smuggled into the fact table.
    const judgement = /(interest|intent|score|hot|warm|cold|qualified|likely|ready_to_buy|engaged)/i
    for (const type of ENGAGEMENT_EVENT_TYPES) {
      expect(judgement.test(type), `"${type}" reads as a judgement, not an observed act`).toBe(false)
    }
  })
})

describe('timestamps', () => {
  const now = new Date('2026-08-28T12:00:00Z')

  it('accepts a trusted source verbatim', () => {
    const claimed = new Date('2026-08-20T09:00:00Z')
    const r = clampOccurredAt(claimed, now, true)
    expect(r.occurredAt).toEqual(claimed)
    expect(r.adjusted).toBeNull()
  })

  it('clamps a future timestamp from an untrusted source', () => {
    const claimed = new Date('2027-01-01T00:00:00Z')
    const r = clampOccurredAt(claimed, now, false)
    expect(r.occurredAt).toEqual(now)
    expect(r.adjusted).toMatch(/future/i)
  })

  it('tolerates ordinary clock skew rather than clamping it', () => {
    const claimed = new Date('2026-08-28T12:02:00Z')
    const r = clampOccurredAt(claimed, now, false)
    expect(r.occurredAt).toEqual(claimed)
    expect(r.adjusted).toBeNull()
  })

  it('clamps a timestamp backdated beyond the configured window', () => {
    const claimed = new Date('2020-01-01T00:00:00Z')
    const r = clampOccurredAt(claimed, now, false)
    expect(r.occurredAt).toEqual(now)
    expect(r.adjusted).toMatch(/older than/i)
  })

  it('falls back to the time of receipt when no timestamp is given', () => {
    expect(clampOccurredAt(null, now, false).occurredAt).toEqual(now)
    expect(clampOccurredAt(new Date('nonsense'), now, false).occurredAt).toEqual(now)
  })

  it('records occurredAt and receivedAt separately', () => {
    const result = normalize({ ...BASE, source: 'provider_webhook', occurredAt: new Date('2026-08-28T11:00:00Z') }, now)
    expect(result.event.occurredAt).toEqual(new Date('2026-08-28T11:00:00Z'))
    expect(result.receivedAt).toEqual(now)
    expect(result.event.occurredAt.getTime()).toBeLessThan(result.receivedAt.getTime())
  })
})

describe('freshness', () => {
  const now = new Date('2026-08-28T12:00:00Z')

  it('labels by age and always reports the raw hours alongside', () => {
    expect(freshness(new Date('2026-08-28T11:00:00Z'), now)).toEqual({ label: 'fresh', ageHours: 1 })
    expect(freshness(new Date('2026-08-26T12:00:00Z'), now).label).toBe('recent')
    expect(freshness(new Date('2026-06-01T12:00:00Z'), now).label).toBe('old')
  })

  it('says "unknown" rather than guessing for a future timestamp', () => {
    expect(freshness(new Date('2026-09-01T00:00:00Z'), now).label).toBe('unknown')
  })
})

describe('deduplication', () => {
  const now = new Date('2026-08-28T12:00:00Z')

  it('collapses repeats of a once_per_session act within one visit', () => {
    const a = dedupeKey({
      eventType: 'workbench_viewed',
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's1',
      referenceId: 'demo1',
      occurredAt: now,
    })
    const b = dedupeKey({
      eventType: 'workbench_viewed',
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's1',
      referenceId: 'demo1',
      occurredAt: new Date('2026-08-28T12:40:00Z'),
    })
    expect(a).toBe(b)
  })

  it('keeps two different visits separate', () => {
    const a = dedupeKey({
      eventType: 'workbench_viewed',
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's1',
      referenceId: 'demo1',
      occurredAt: now,
    })
    const b = dedupeKey({
      eventType: 'workbench_viewed',
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's2',
      referenceId: 'demo1',
      occurredAt: now,
    })
    expect(a).not.toBe(b)
  })

  it('does NOT merge two genuinely separate clicks', () => {
    // The core rule: a repeatable act minutes apart is two acts, and merging
    // them would erase something the prospect actually did.
    const first = dedupeKey({
      eventType: 'workbench_cta_clicked',
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's1',
      referenceId: 'demo1',
      occurredAt: now,
    })
    const later = dedupeKey({
      eventType: 'workbench_cta_clicked',
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's1',
      referenceId: 'demo1',
      occurredAt: new Date('2026-08-28T12:05:00Z'),
    })
    expect(first).not.toBe(later)
  })

  it('collapses a double submit of the same click', () => {
    const a = dedupeKey({
      eventType: 'workbench_cta_clicked',
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's1',
      referenceId: 'demo1',
      occurredAt: now,
    })
    const b = dedupeKey({
      eventType: 'workbench_cta_clicked',
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's1',
      referenceId: 'demo1',
      occurredAt: new Date(now.getTime() + 900),
    })
    expect(a).toBe(b)
  })

  it("treats a provider's own event id as the authority on redelivery", () => {
    const first = dedupeKey({
      eventType: 'email_opened',
      tenantId: 't1',
      crmCompanyId: 'c1',
      providerEventId: 'evt_123',
      occurredAt: now,
    })
    const redelivered = dedupeKey({
      eventType: 'email_opened',
      tenantId: 't1',
      crmCompanyId: 'c1',
      providerEventId: 'evt_123',
      // A redelivery hours later is still the same act.
      occurredAt: new Date('2026-08-28T18:00:00Z'),
    })
    expect(first).toBe(redelivered)
  })

  it('never lets one company’s events collide with another’s', () => {
    const a = dedupeKey({ eventType: 'workbench_viewed', tenantId: 't1', crmCompanyId: 'c1', sessionRef: 's1', occurredAt: now })
    const b = dedupeKey({ eventType: 'workbench_viewed', tenantId: 't1', crmCompanyId: 'c2', sessionRef: 's1', occurredAt: now })
    const c = dedupeKey({ eventType: 'workbench_viewed', tenantId: 't2', crmCompanyId: 'c1', sessionRef: 's1', occurredAt: now })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('keeps different event types apart in the same session', () => {
    const viewed = dedupeKey({ eventType: 'workbench_viewed', tenantId: 't1', crmCompanyId: 'c1', sessionRef: 's1', occurredAt: now })
    const before = dedupeKey({ eventType: 'workbench_before_viewed', tenantId: 't1', crmCompanyId: 'c1', sessionRef: 's1', occurredAt: now })
    expect(viewed).not.toBe(before)
  })

  it('does not merge two different acts that share an event type', () => {
    // Switching to "before" and switching to "after" are both
    // `workbench_comparison_used`, in one session, inside one repeat-window.
    // Without the discriminator the second switch would vanish.
    const args = {
      eventType: 'workbench_comparison_used' as const,
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's1',
      referenceId: 'demo1',
      occurredAt: now,
    }
    const toBefore = dedupeKey({ ...args, dedupeDiscriminator: 'before' })
    const toAfter = dedupeKey({ ...args, dedupeDiscriminator: 'after' })
    expect(toBefore).not.toBe(toAfter)

    // The same switch twice is still one act.
    expect(dedupeKey({ ...args, dedupeDiscriminator: 'before' })).toBe(toBefore)
  })

  it('records one link-open per visit, not one per page load', () => {
    // Every navigation inside the demo re-renders this route, so a repeat
    // window would have made the count depend on how fast someone clicked.
    expect(DEDUPE_POLICY.workbench_link_opened).toBe('once_per_session')
    const args = {
      eventType: 'workbench_link_opened' as const,
      tenantId: 't1',
      crmCompanyId: 'c1',
      sessionRef: 's1',
      referenceId: 'demo1',
    }
    expect(dedupeKey({ ...args, occurredAt: now })).toBe(
      dedupeKey({ ...args, occurredAt: new Date('2026-08-28T12:30:00Z') }),
    )
  })
})

describe('metadata minimisation', () => {
  it('keeps small scalars and drops everything structural', () => {
    const out = sanitizeMetadata({
      panel: 'before',
      count: 3,
      ok: true,
      nothing: null,
      // A whole provider payload, which is what this rule exists to stop.
      payload: { headers: { cookie: 'secret' } },
      list: [1, 2, 3],
      'bad key!': 'x',
    })
    expect(out).toEqual({ panel: 'before', count: 3, ok: true, nothing: null })
    expect(out.payload).toBeUndefined()
    expect(out.list).toBeUndefined()
  })

  it('truncates long strings', () => {
    const out = sanitizeMetadata({ note: 'x'.repeat(5000) })
    expect(String(out.note).length).toBe(200)
  })

  it('caps how many keys are stored', () => {
    const raw: Record<string, unknown> = {}
    for (let i = 0; i < 100; i++) raw[`k${i}`] = i
    expect(Object.keys(sanitizeMetadata(raw)).length).toBeLessThanOrEqual(12)
  })
})

describe('normalization', () => {
  it('derives the channel from the type rather than trusting a caller', () => {
    expect(normalize(BASE).event.channel).toBe('workbench')
    expect(normalize({ ...BASE, eventType: 'email_bounced', source: 'provider_webhook' }).event.channel).toBe('email')
    expect(normalize({ ...BASE, eventType: 'call_task_created', source: 'outreach_engine' }).event.channel).toBe('call')
  })

  it('lets the outreach engine name the channel its action ran on', () => {
    // The generic lifecycle types span every channel. Hard-mapping them to
    // email made a blocked LinkedIn action read as email activity, and made
    // the summary report LinkedIn as "not observed" while such actions existed.
    const blocked = { ...BASE, eventType: 'outreach_action_blocked' as const, source: 'outreach_engine' as const }
    expect(normalize({ ...blocked, channel: 'linkedin' }).event.channel).toBe('linkedin')
    expect(normalize({ ...blocked, channel: 'whatsapp' }).event.channel).toBe('whatsapp')
    // A typed event still takes its channel from the table.
    expect(normalize({ ...BASE, eventType: 'email_bounced', source: 'provider_webhook' }).event.channel).toBe('email')
  })

  it('produces a stable dedupe key for the same act', () => {
    const now = new Date('2026-08-28T12:00:00Z')
    const a = normalize({ ...BASE, eventType: 'workbench_viewed', sessionRef: 's1' }, now)
    const b = normalize({ ...BASE, eventType: 'workbench_viewed', sessionRef: 's1' }, now)
    expect(a.event.dedupeKey).toBe(b.event.dedupeKey)
  })
})

describe('webhook signature verification', () => {
  it('refuses everything when no secret is configured', () => {
    // The current state of this installation: no email provider, so no
    // webhook is trusted. A boundary with nothing behind it stays shut.
    const r = verifySignature('{}', 'sha256=deadbeef', String(Math.floor(Date.now() / 1000)))
    expect(r.ok).toBe(false)
    expect(r.rejection).toBe('not_configured')
  })

  it('maps only recognised provider events', () => {
    expect(PROVIDER_EVENT_MAP.bounce).toBe('email_bounced')
    expect(PROVIDER_EVENT_MAP.opened).toBe('email_opened')
    expect(PROVIDER_EVENT_MAP.something_new).toBeUndefined()
  })
})

describe('outreach lifecycle mapping', () => {
  it('emits email_sent only for a status that means sent', () => {
    expect(eventTypeForStatus('sent', 'email')).toBe('email_sent')
    // A draft or a dry run is not a send.
    expect(eventTypeForStatus('ready_to_send', 'email')).toBe('outreach_action_created')
    expect(eventTypeForStatus('draft', 'email')).toBe('outreach_action_created')
  })

  it('records a blocked action as blocked, not as contact', () => {
    for (const status of [
      'blocked_suppressed',
      'blocked_provider_unavailable',
      'blocked_validation_failed',
      'blocked_no_target',
    ]) {
      expect(eventTypeForStatus(status, 'email')).toBe('outreach_action_blocked')
    }
  })

  it('maps manual channels to the work they create', () => {
    expect(eventTypeForStatus('manual_required', 'call')).toBe('call_task_created')
    expect(eventTypeForStatus('manual_required', 'linkedin')).toBe('linkedin_draft_created')
  })

  it('ignores transient states', () => {
    expect(eventTypeForStatus('sending', 'email')).toBeNull()
    expect(eventTypeForStatus('cancelled', 'email')).toBeNull()
  })
})

// ── The rule the whole task turns on ────────────────────────────────────────

describe('no engagement score exists anywhere in Task #983', () => {
  const ENGAGEMENT_DIR = fileURLToPath(new URL('../../src/engagement/', import.meta.url))

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  /** Comments discuss scoring precisely to explain its absence, so they are
   * stripped before the source is searched for an actual field. */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  }

  const files = walk(ENGAGEMENT_DIR)

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(3)
  })

  it('declares no score, rating, level or temperature field', () => {
    const forbidden =
      /\b(engagementScore|score|rating|intentScore|leadScore|temperature|heat|isHot|hotness|qualification|qualified|priorityScore|interestLevel|engagementLevel|propensity)\b\s*[:=?]/i
    const offenders: string[] = []
    for (const file of files) {
      const src = code(file)
      const match = src.match(forbidden)
      if (match) offenders.push(`${file}: ${match[0]}`)
    }
    expect(offenders).toEqual([])
  })

  it('never sums or weights events into a single number', () => {
    const forbidden = /\b(weight|weighted|totalScore|scoreFor|computeScore|calculateScore|rank\s*\()/i
    const offenders: string[] = []
    for (const file of files) {
      const match = code(file).match(forbidden)
      if (match) offenders.push(`${file}: ${match[0]}`)
    }
    expect(offenders).toEqual([])
  })

  it('never writes to NXT Sales or triggers outreach from an engagement event', () => {
    const forbidden = /\b(getCrm\(|crmPort|updateCompany|createActivity|executeAction|enqueue\()/
    const offenders: string[] = []
    for (const file of files) {
      const match = code(file).match(forbidden)
      if (match) offenders.push(`${file}: ${match[0]}`)
    }
    expect(offenders).toEqual([])
  })

  it('the Prisma model has no column a score could be stored in', () => {
    const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url))
    const schema = readFileSync(schemaPath, 'utf8')
    const model = schema.slice(schema.indexOf('model EngagementEvent {'))
    const body = model.slice(0, model.indexOf('\n}'))
    const columns = body
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && /^\s{2}\w+\s+\w/.test(l))
      .map((l) => l.trim().split(/\s+/)[0])

    expect(columns.length).toBeGreaterThan(10)
    for (const column of columns) {
      expect(
        /score|rating|level|temperature|qualif|propensity|interest|priority/i.test(column ?? ''),
        `EngagementEvent.${column} could hold a score`,
      ).toBe(false)
    }
    // freshnessLabel is the one judgement-adjacent column, and it must be
    // accompanied by the raw age so nothing depends on our thresholds.
    expect(columns).toContain('freshnessLabel')
    expect(columns).toContain('ageHours')
  })
})
