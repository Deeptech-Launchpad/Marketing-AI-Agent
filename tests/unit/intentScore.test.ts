import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EVENT_ACTOR, ENGAGEMENT_EVENT_TYPES } from '../../src/engagement/types.js'
import {
  CALCULATION_VERSION,
  DEFAULT_POLICY,
  decayMultiplier,
  levelFor,
  ruleIndex,
  validatePolicy,
} from '../../src/intentscore/policy.js'
import {
  ageInDays,
  byChannel,
  calculateScore,
  roundHalfAwayFromZero,
  type ScorableEvent,
} from '../../src/intentscore/score.js'
import type { ScoringPolicy } from '../../src/intentscore/types.js'

// TASK #984 unit tests.
//
// The properties that decide whether a score can be trusted: it is bounded, it
// is deterministic, every point names an event, our own activity cannot
// contribute, repeats cannot inflate it, and a delivery failure is not treated
// as disinterest.

const T0 = new Date('2026-08-28T12:00:00Z')

let seq = 0
function ev(eventType: string, opts: Partial<ScorableEvent> = {}): ScorableEvent {
  seq++
  return {
    id: opts.id ?? `evt-${String(seq).padStart(4, '0')}`,
    eventType,
    channel: opts.channel ?? 'workbench',
    occurredAt: opts.occurredAt ?? new Date(T0.getTime() - 3600_000),
    sessionRef: opts.sessionRef ?? 'session-a',
  }
}

function score(events: ScorableEvent[], policy: ScoringPolicy = DEFAULT_POLICY, evaluatedAt = T0) {
  return calculateScore({ tenantId: 't1', crmCompanyId: 'c1', events, policy, evaluatedAt })
}

describe('the policy itself', () => {
  it('is structurally valid', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([])
  })

  it('is declared PROVISIONAL, not business-approved', () => {
    // The whole honesty of this feature rests on this flag.
    expect(DEFAULT_POLICY.status).toBe('provisional')
    expect(DEFAULT_POLICY.notes.join(' ')).toMatch(/NOT BUSINESS-APPROVED/i)
  })

  it('makes no predictive or machine-learning claim', () => {
    const text = [DEFAULT_POLICY.description, ...DEFAULT_POLICY.notes].join(' ').toLowerCase()
    expect(text).not.toMatch(/machine learning is used|predicts that|probability of (conversion|purchase|closing)/)
    // And says so explicitly.
    expect(text).toMatch(/no machine learning is involved/)
  })

  it('is frozen, so a runtime edit cannot rewrite a historical result', () => {
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true)
  })

  it('scores prospect acts only', () => {
    expect(DEFAULT_POLICY.scoringActors).toEqual(['prospect'])
  })

  it('has no rule for any act AltiusNXT performs', () => {
    // Belt and braces: even if the actor filter were widened, our own acts have
    // no weight to contribute.
    for (const rule of DEFAULT_POLICY.rules) {
      expect(EVENT_ACTOR[rule.eventType], `${rule.eventType} is not a prospect or system act`).not.toBe('altiusnxt')
    }
  })

  it('only references event types that actually exist', () => {
    for (const rule of DEFAULT_POLICY.rules) {
      expect(ENGAGEMENT_EVENT_TYPES).toContain(rule.eventType)
    }
  })

  it('rejects a malformed policy rather than scoring oddly', () => {
    const gap: ScoringPolicy = {
      ...DEFAULT_POLICY,
      decayBands: [
        { fromDays: 0, toDays: 2, multiplier: 1, label: 'a' },
        { fromDays: 5, toDays: null, multiplier: 0, label: 'b' },
      ],
    }
    expect(validatePolicy(gap).join(' ')).toMatch(/gap or overlap/)

    const duplicated: ScoringPolicy = {
      ...DEFAULT_POLICY,
      rules: [...DEFAULT_POLICY.rules, DEFAULT_POLICY.rules[0]!],
    }
    expect(validatePolicy(duplicated).length).toBeGreaterThan(0)
  })

  it('has exactly one rule per event type', () => {
    const index = ruleIndex(DEFAULT_POLICY)
    expect(index.size).toBe(DEFAULT_POLICY.rules.length)
  })
})

describe('arithmetic helpers', () => {
  it('floors age to whole days', () => {
    expect(ageInDays(new Date('2026-08-28T00:00:00Z'), T0)).toBe(0)
    expect(ageInDays(new Date('2026-08-27T11:00:00Z'), T0)).toBe(1)
    expect(ageInDays(new Date('2026-07-28T12:00:00Z'), T0)).toBe(31)
    // An event in the future is age zero, not negative.
    expect(ageInDays(new Date('2026-09-01T00:00:00Z'), T0)).toBe(0)
  })

  it('rounds symmetrically around zero', () => {
    // Math.round(-2.5) is -2, which would make a penalty quietly gentler than
    // the equivalent reward.
    expect(roundHalfAwayFromZero(2.5)).toBe(3)
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3)
    expect(roundHalfAwayFromZero(0.4)).toBe(0)
  })

  it('puts each age in exactly one decay band', () => {
    expect(decayMultiplier(DEFAULT_POLICY, 0).multiplier).toBe(1)
    expect(decayMultiplier(DEFAULT_POLICY, 1).multiplier).toBe(1)
    expect(decayMultiplier(DEFAULT_POLICY, 2).multiplier).toBe(0.8)
    expect(decayMultiplier(DEFAULT_POLICY, 7).multiplier).toBe(0.8)
    expect(decayMultiplier(DEFAULT_POLICY, 8).multiplier).toBe(0.5)
    expect(decayMultiplier(DEFAULT_POLICY, 30).multiplier).toBe(0.5)
    expect(decayMultiplier(DEFAULT_POLICY, 31).multiplier).toBe(0)
    expect(decayMultiplier(DEFAULT_POLICY, 4000).multiplier).toBe(0)
  })

  it('maps scores to levels without gaps', () => {
    expect(levelFor(DEFAULT_POLICY, 0)).toBe('LOW')
    expect(levelFor(DEFAULT_POLICY, 29)).toBe('LOW')
    expect(levelFor(DEFAULT_POLICY, 30)).toBe('MEDIUM')
    expect(levelFor(DEFAULT_POLICY, 69)).toBe('MEDIUM')
    expect(levelFor(DEFAULT_POLICY, 70)).toBe('HIGH')
    expect(levelFor(DEFAULT_POLICY, 100)).toBe('HIGH')
  })
})

describe('scoring', () => {
  it('scores a company with no events as zero', () => {
    const r = score([])
    expect(r.rawScore).toBe(0)
    expect(r.normalizedScore).toBe(0)
    expect(r.level).toBe('LOW')
    expect(r.contributions).toEqual([])
    expect(r.contactability.status).toBe('unknown')
  })

  it('adds up a full Workbench visit', () => {
    const r = score([
      ev('audit_report_qr_scanned', { channel: 'audit_report' }),
      ev('workbench_link_opened'),
      ev('workbench_registration_completed'),
      ev('workbench_viewed'),
      ev('workbench_before_viewed'),
      ev('workbench_after_viewed'),
      ev('workbench_comparison_used'),
      ev('workbench_evidence_viewed'),
      ev('workbench_cta_clicked'),
    ])
    // 5 + 10 + 20 + 10 + 5 + 10 + 15 + 10 + 25, all at full freshness.
    expect(r.rawScore).toBe(110)
    expect(r.normalizedScore).toBe(100)
    expect(r.clamped).toBe(true)
    expect(r.level).toBe('HIGH')
  })

  it('never exceeds the maximum or falls below the minimum', () => {
    // A prospect who came back twice and worked through the whole demo each
    // time. Well over 100 raw, across event types that each stay within their
    // own caps — so this exercises bounding rather than a single runaway rule.
    const visit = (s: string) =>
      [
        'audit_report_qr_scanned',
        'workbench_link_opened',
        'workbench_registration_completed',
        'workbench_viewed',
        'workbench_before_viewed',
        'workbench_after_viewed',
        'workbench_comparison_used',
        'workbench_evidence_viewed',
        'workbench_cta_clicked',
      ].map((t, i) => ev(t, { sessionRef: s, id: `${s}-${i}` }))

    const high = score([...visit('s1'), ...visit('s2')])
    expect(high.rawScore).toBeGreaterThan(100)
    expect(high.normalizedScore).toBe(100)
    // Normalisation is never hidden: the raw total stays on the record.
    expect(high.clamped).toBe(true)
    expect(high.level).toBe('HIGH')

    const low = score([ev('email_unsubscribed', { channel: 'email' })])
    expect(low.rawScore).toBe(-30)
    expect(low.normalizedScore).toBe(0)
    expect(low.clamped).toBe(true)
    expect(low.level).toBe('LOW')
  })

  it('gives every contribution an engagement event reference', () => {
    const r = score([ev('workbench_cta_clicked'), ev('email_sent', { channel: 'email' })])
    expect(r.contributions.length).toBe(2)
    for (const c of r.contributions) {
      expect(c.engagementEventId).toBeTruthy()
      expect(c.ruleId).toBeTruthy()
      expect(c.reason.length).toBeGreaterThan(10)
    }
  })
})

describe('prospect actions versus our own', () => {
  it('ignores everything AltiusNXT did', () => {
    const r = score([
      ev('email_sent', { channel: 'email' }),
      ev('call_task_created', { channel: 'call' }),
      ev('call_task_completed', { channel: 'call' }),
      ev('outreach_action_blocked', { channel: 'linkedin' }),
      ev('linkedin_draft_created', { channel: 'linkedin' }),
      ev('call_outcome_recorded', { channel: 'call' }),
    ])
    expect(r.rawScore).toBe(0)
    expect(r.normalizedScore).toBe(0)
    // They are still listed, with the reason — not silently dropped.
    expect(r.contributions.length).toBe(6)
    for (const c of r.contributions) {
      expect(c.adjustedPoints).toBe(0)
      expect(c.excluded).toBe(true)
      // Under the default policy our own acts have NO RULE at all, so they are
      // stopped before the actor filter is even consulted. Two independent
      // defences, and this is the outer one.
      expect(c.reason).toMatch(/no rule for/i)
    }
  })

  it('blocks our own acts even if a policy wrongly gives them points', () => {
    // The inner defence: the actor filter. Unreachable with the default policy
    // because no rule exists for our acts, so it is proven against a policy
    // that deliberately adds one.
    const careless: ScoringPolicy = {
      ...DEFAULT_POLICY,
      version: 'v-careless-test',
      rules: [
        ...DEFAULT_POLICY.rules,
        {
          ruleId: 'r.email_sent_mistake',
          eventType: 'email_sent',
          points: 50,
          dimension: 'interest',
          decay: 'standard',
          maxPerSession: null,
          maxOccurrences: null,
          maxContribution: null,
          note: 'A mistake, deliberately introduced by this test.',
        },
      ],
    }

    const r = score([ev('email_sent', { channel: 'email' })], careless)
    expect(r.rawScore).toBe(0)
    expect(r.contributions[0]!.reason).toMatch(/performed by altiusnxt/i)
  })

  it('counts a prospect act in the same batch', () => {
    const r = score([
      ev('email_sent', { channel: 'email' }),
      ev('workbench_cta_clicked'),
    ])
    expect(r.rawScore).toBe(25)
    expect(r.eventsConsidered).toBe(2)
    expect(r.eventsScored).toBe(1)
    expect(r.eventsExcluded).toBe(1)
  })
})

describe('negative signals', () => {
  it('treats an unsubscribe as a real negative interest signal', () => {
    const r = score([ev('workbench_cta_clicked'), ev('email_unsubscribed', { channel: 'email' })])
    expect(r.rawScore).toBe(-5)
    expect(r.normalizedScore).toBe(0)
    expect(r.contactability.status).toBe('blocked')
  })

  it('does NOT let a bounce reduce interest', () => {
    // A bounce means an address failed. The person may never have seen the
    // message, so it says nothing about their interest.
    const withBounce = score([ev('workbench_cta_clicked'), ev('email_bounced', { channel: 'email' })])
    const without = score([ev('workbench_cta_clicked', { id: 'evt-cta-only' })])

    expect(withBounce.rawScore).toBe(without.rawScore)
    expect(withBounce.rawScore).toBe(25)
    // It is recorded as a contactability problem instead.
    expect(withBounce.contactability.status).toBe('degraded')
    expect(withBounce.contactability.reasons.join(' ')).toMatch(/bounced/i)
    const bounce = withBounce.contributions.find((c) => c.eventType === 'email_bounced')!
    expect(bounce.dimension).toBe('contactability')
    expect(bounce.adjustedPoints).toBe(0)
  })

  it('keeps an unsubscribe at full weight however old it is', () => {
    // A withdrawal of consent does not become less true with age.
    const old = score([ev('email_unsubscribed', { channel: 'email', occurredAt: new Date('2026-01-01T00:00:00Z') })])
    expect(old.rawScore).toBe(-30)
    expect(old.contributions[0]!.freshnessMultiplier).toBe(1)
  })
})

describe('freshness', () => {
  it('reduces an aging contribution by the configured multiplier', () => {
    const day = (n: number) => new Date(T0.getTime() - n * 86_400_000)

    expect(score([ev('workbench_cta_clicked', { occurredAt: day(0) })]).rawScore).toBe(25)
    expect(score([ev('workbench_cta_clicked', { occurredAt: day(3) })]).rawScore).toBe(20) // 25 * 0.8
    expect(score([ev('workbench_cta_clicked', { occurredAt: day(10) })]).rawScore).toBe(13) // 25 * 0.5 -> 12.5 -> 13
    expect(score([ev('workbench_cta_clicked', { occurredAt: day(60) })]).rawScore).toBe(0)
  })

  it('records the base, the multiplier and the adjusted value separately', () => {
    const r = score([ev('workbench_cta_clicked', { occurredAt: new Date(T0.getTime() - 3 * 86_400_000) })])
    const c = r.contributions[0]!
    expect(c.basePoints).toBe(25)
    expect(c.freshnessMultiplier).toBe(0.8)
    expect(c.adjustedPoints).toBe(20)
    expect(c.ageDays).toBe(3)
  })

  it('is deterministic — the same asOf always gives the same score', () => {
    const events = [
      ev('workbench_registration_completed', { id: 'a', occurredAt: new Date('2026-08-20T09:00:00Z') }),
      ev('workbench_cta_clicked', { id: 'b', occurredAt: new Date('2026-08-26T09:00:00Z') }),
    ]
    const first = score(events, DEFAULT_POLICY, T0)
    const second = score(events, DEFAULT_POLICY, T0)
    expect(second.rawScore).toBe(first.rawScore)
    expect(second.resultHash).toBe(first.resultHash)
  })

  it('gives a different score at a different asOf, as ageing requires', () => {
    const events = [ev('workbench_cta_clicked', { id: 'a', occurredAt: new Date('2026-08-28T09:00:00Z') })]
    const sameDay = score(events, DEFAULT_POLICY, T0)
    const weeksLater = score(events, DEFAULT_POLICY, new Date('2026-09-20T12:00:00Z'))
    expect(sameDay.rawScore).toBe(25)
    expect(weeksLater.rawScore).toBe(13)
  })
})

describe('repeat limits', () => {
  it('caps a low-value act so reloading cannot inflate the score', () => {
    // 100 page views must not become 1000 points.
    const many = Array.from({ length: 100 }, (_, i) => ev('workbench_viewed', { id: `v${i}` }))
    const r = score(many)
    expect(r.rawScore).toBe(10)
    expect(r.eventsScored).toBe(1)
    expect(r.eventsExcluded).toBe(99)
  })

  it('counts two genuine comparison switches, and stops at the cap', () => {
    // Task #983 records each switch as a separate act; the policy decides how
    // many of them score.
    const three = [
      ev('workbench_comparison_used', { id: 'c1' }),
      ev('workbench_comparison_used', { id: 'c2' }),
      ev('workbench_comparison_used', { id: 'c3' }),
    ]
    const r = score(three)
    expect(r.rawScore).toBe(30)
    expect(r.eventsScored).toBe(2)
    expect(r.contributions[2]!.reason).toMatch(/beyond the limit/i)
  })

  it('applies the per-session cap per session, not globally', () => {
    const r = score([
      ev('workbench_viewed', { id: 'a', sessionRef: 's1' }),
      ev('workbench_viewed', { id: 'b', sessionRef: 's1' }),
      ev('workbench_viewed', { id: 'c', sessionRef: 's2' }),
    ])
    // Two separate visits each score once; the repeat inside a visit does not.
    expect(r.rawScore).toBe(20)
  })

  it('honours a total points ceiling for an event type', () => {
    const opens = Array.from({ length: 5 }, (_, i) => ev('email_opened', { id: `o${i}`, channel: 'email' }))
    const r = score(opens)
    // 3 points each, ceiling 9.
    expect(r.rawScore).toBe(9)
  })

  it('consumes cap slots oldest first, whatever order the rows arrive in', () => {
    const early = ev('workbench_comparison_used', { id: 'zzz', occurredAt: new Date(T0.getTime() - 7200_000) })
    const late = ev('workbench_comparison_used', { id: 'aaa', occurredAt: new Date(T0.getTime() - 60_000) })
    const third = ev('workbench_comparison_used', { id: 'mmm', occurredAt: new Date(T0.getTime() - 30_000) })

    const forwards = score([early, late, third])
    const backwards = score([third, late, early])
    expect(backwards.resultHash).toBe(forwards.resultHash)
    // The two earliest won the slots.
    const counted = forwards.contributions.filter((c) => c.adjustedPoints > 0).map((c) => c.engagementEventId)
    expect(counted).toEqual(['zzz', 'aaa'])
  })
})

describe('duplicate handling', () => {
  it('does not add extra deduplication of its own', () => {
    // Task #983 already decided what counts as one act. Two distinct event
    // rows are two acts, and the only thing that may reduce them is a declared
    // policy cap.
    const r = score([
      ev('workbench_comparison_used', { id: 'x1' }),
      ev('workbench_comparison_used', { id: 'x2' }),
    ])
    expect(r.eventsScored).toBe(2)
    expect(r.rawScore).toBe(30)
  })

  it('scores the same event id once even if handed it twice', () => {
    const single = ev('workbench_cta_clicked', { id: 'same' })
    const r = score([single, { ...single }])
    // The second occurrence hits the per-session cap of one.
    expect(r.rawScore).toBe(25)
  })
})

describe('channel context', () => {
  it('keeps the channel on every contribution and groups by it', () => {
    const r = score([
      ev('workbench_cta_clicked', { channel: 'workbench' }),
      ev('audit_report_qr_scanned', { channel: 'audit_report' }),
      ev('email_clicked', { channel: 'email' }),
    ])
    expect(byChannel(r.contributions)).toEqual({ workbench: 25, audit_report: 5, email: 12 })
  })
})

describe('versioning', () => {
  it('records the policy version, its status and the calculation version', () => {
    const r = score([ev('workbench_cta_clicked')])
    expect(r.policyVersion).toBe(DEFAULT_POLICY.version)
    expect(r.policyStatus).toBe('provisional')
    expect(r.calculationVersion).toBe(CALCULATION_VERSION)
  })

  it('produces a different result under different weights', () => {
    const doubled: ScoringPolicy = {
      ...DEFAULT_POLICY,
      version: 'v2-test',
      rules: DEFAULT_POLICY.rules.map((r) => ({ ...r, points: r.points * 2 })),
    }
    const events = [ev('workbench_cta_clicked', { id: 'k' })]
    expect(score(events, DEFAULT_POLICY).rawScore).toBe(25)
    expect(score(events, doubled).rawScore).toBe(50)
    // And the two are distinguishable after the fact.
    expect(score(events, doubled).policyVersion).toBe('v2-test')
  })

  it('excludes evaluatedAt from the fingerprint, so a no-op rerun is recognised', () => {
    const events = [ev('workbench_cta_clicked', { id: 'k', occurredAt: T0 })]
    const a = score(events, DEFAULT_POLICY, T0)
    const b = score(events, DEFAULT_POLICY, new Date(T0.getTime() + 60_000))
    expect(b.resultHash).toBe(a.resultHash)
  })
})

// ── Mechanical guarantees ───────────────────────────────────────────────────

describe('structural guarantees of the scoring module', () => {
  const DIR = fileURLToPath(new URL('../../src/intentscore/', import.meta.url))

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  }

  const files = walk(DIR)

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(3)
  })

  it('never writes to NXT Sales', () => {
    for (const file of files) {
      expect(code(file), file).not.toMatch(/getCrm\(|crmPort|updateCompany|createActivity|createDeal/)
    }
  })

  it('never triggers outreach', () => {
    for (const file of files) {
      expect(code(file), file).not.toMatch(/executeAction|createCampaign|sendMessage|mintLink/)
    }
  })

  it('never writes an engagement event, so scoring cannot loop back into capture', () => {
    for (const file of files) {
      expect(code(file), file).not.toMatch(/engagementEvent\.(create|update|delete|upsert)/)
      expect(code(file), file).not.toMatch(/recordEvent|recordBatch/)
    }
  })

  it('uses no AI model for the numbers', () => {
    for (const file of files) {
      expect(code(file), file).not.toMatch(/gemini|generateContent|llmPort|getLlm/i)
    }
  })

  it('contains no alerting, routing or opportunity creation', () => {
    for (const file of files) {
      expect(code(file), file).not.toMatch(/\b(alert|notify|assignTo|routeTo|createOpportunity|slack|webhookOut)\b/i)
    }
  })

  it('makes no predictive claim in its identifiers', () => {
    // Identifiers only. Prose is stripped as well as comments, because a
    // DISCLAIMER is not a claim — the policy says in as many words that it
    // "predicts nothing", and a check that flagged its own denial would push
    // the honest sentence out of the code.
    const banned = /\b(predict\w*|probability|likelihood\w*|conversionRate|closeProbability|mlScore|modelScore)\b/i
    for (const file of files) {
      const identifiers = code(file)
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      const match = identifiers.match(banned)
      expect(match?.[0], `${file} uses "${match?.[0]}" as an identifier`).toBeUndefined()
    }
  })

  it('keeps every numeric weight in the policy, not scattered through the engine', () => {
    // score.ts is the arithmetic; it must not contain its own constants.
    const engine = code(join(DIR, 'score.ts'))
    // Strip the legitimate time and rounding constants.
    const stripped = engine
      .replace(/86_400_000/g, '')
      .replace(/\b[01]\b/g, '')
    const stray = stripped.match(/[^\w.](\d{2,})[^\w]/g) ?? []
    expect(stray, `score.ts contains stray numeric constants: ${stray.join(', ')}`).toEqual([])
  })
})

describe('the traceability rule', () => {
  it('cannot produce a contribution without an engagement event id', () => {
    const r = score([
      ev('workbench_cta_clicked'),
      ev('email_sent', { channel: 'email' }),
      ev('email_bounced', { channel: 'email' }),
      ev('workbench_viewed'),
    ])
    expect(r.contributions.length).toBe(4)
    for (const c of r.contributions) {
      expect(c.engagementEventId, 'a contribution has no event reference').toBeTruthy()
      expect(typeof c.engagementEventId).toBe('string')
      expect(c.engagementEventId.length).toBeGreaterThan(0)
    }
  })

  it('answers why a score is what it is', () => {
    const r = score([
      ev('workbench_registration_completed', { id: 'reg' }),
      ev('workbench_cta_clicked', { id: 'cta' }),
    ])
    expect(r.rawScore).toBe(45)
    const lines = r.contributions.map((c) => `${c.eventType} ${c.adjustedPoints}`)
    expect(lines).toContain('workbench_registration_completed 20')
    expect(lines).toContain('workbench_cta_clicked 25')
  })
})
