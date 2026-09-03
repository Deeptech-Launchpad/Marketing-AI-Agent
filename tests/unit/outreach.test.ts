import { describe, expect, it } from 'vitest'
import { composeMessage, type PersonalizationInput } from '../../src/outreach/personalize.js'
import { renderTemplate, templateByKey, templateFor, TEMPLATES } from '../../src/outreach/templates.js'
import { defaultSequence, idempotencyKey, scheduledAtFor, stepIsEligible } from '../../src/outreach/sequence.js'
import { runProvider, type OutreachProvider } from '../../src/outreach/providers/provider.js'
import { EmailFollowUpProvider, EmailProvider } from '../../src/outreach/providers/emailProvider.js'
import { LinkedInProvider } from '../../src/outreach/providers/linkedInProvider.js'
import { CallTaskProvider } from '../../src/outreach/providers/callTaskProvider.js'
import { WhatsAppProvider } from '../../src/outreach/providers/whatsAppProvider.js'
import { channelStatus, providerFor } from '../../src/outreach/engine.js'
import { findUnsupportedClaims } from '../../src/websiteaudit/claimGuard.js'
import { CHANNEL_LIMITS, RETRYABLE_FAILURES, TERMINAL_STATUSES, type OutreachTarget } from '../../src/outreach/types.js'

// TASK #982 — personalisation, sequencing, idempotency, providers.
//
// The assertions that matter are the refusals: a message that cannot invent a
// statistic, a channel that will not substitute another when it is unavailable,
// and an action that cannot send twice.

const target = (over: Partial<OutreachTarget> = {}): OutreachTarget => ({
  contactName: 'Dana Whitfield',
  contactTitle: 'Ecommerce Manager',
  decisionMakerId: 'dm_1',
  destination: 'dana@acme.example',
  destinationKind: 'email',
  companyName: 'Acme Industrial',
  crmCompanyId: 'co_1',
  ...over,
})

const input = (over: Partial<PersonalizationInput> = {}): PersonalizationInput => ({
  channel: 'email',
  target: target(),
  companyName: 'Acme Industrial',
  topFinding: {
    id: 'f_1',
    title: 'Specifications not present on inspected product pages',
    metric: 'A specification block was observed on 3 of 12 inspected product pages.',
    finding: 'A specification block could not be found on 9 of the 12 inspected product pages.',
    recommendation: 'Publish a consistent specification block on each product page.',
    sourceUrl: 'https://acme.example/p/bolt-1',
  },
  sample: { pagesInspected: 25, productPagesInspected: 12 },
  workbenchUrl: null,
  workbenchProductName: null,
  intentSignals: [],
  senderName: 'Jey',
  senderCompany: 'AltiusNXT',
  auditRunId: 'run_1',
  ...over,
})

// ── PERSONALISATION ────────────────────────────────────────────────────────

describe('message personalisation', () => {
  it('uses the contact first name, and greets neutrally without one', () => {
    expect(composeMessage(input()).body).toMatch(/^Hi Dana,/)
    expect(composeMessage(input({ target: target({ contactName: null }) })).body).toMatch(/^Hello,/)
  })

  it('does not turn a parenthesised nickname into a greeting', () => {
    const m = composeMessage(input({ target: target({ contactName: 'Bronc (Phillip) Kau' }) }))
    expect(m.body).toMatch(/^Hi Bronc,/)
  })

  it('quotes the finding and its sample-scoped metric verbatim', () => {
    const m = composeMessage(input())
    expect(m.body).toContain('9 of the 12 inspected product pages')
    expect(m.body).toContain('3 of 12 inspected product pages')
  })

  it('carries the evidence that justifies the claim', () => {
    const m = composeMessage(input())
    const finding = m.evidence.find((e) => e.kind === 'catalog_finding')!
    expect(finding.referenceId).toBe('f_1')
    expect(finding.sourceUrl).toBe('https://acme.example/p/bolt-1')
  })

  it('REFUSES to compose a message containing an unsupported claim', () => {
    // The template author, not the model, is the risk here — the guard catches
    // either.
    expect(() =>
      composeMessage(
        input({
          topFinding: {
            id: 'f_x',
            title: 'x',
            metric: 'Your catalogue is losing 35% of revenue.',
            finding: 'x',
            recommendation: 'x',
            sourceUrl: null,
          },
        }),
      ),
    ).toThrow(/Refusing to store unsupported claim/)
  })

  it('produces no unsupported claim on any channel', () => {
    const channels = ['email', 'email_followup', 'linkedin', 'call', 'whatsapp'] as const
    channels.forEach((channel) => {
      const m = composeMessage(input({ channel, target: target({ destination: null }) }))
      const prose = `${m.subject ?? ''} ${m.body}`
      expect(findUnsupportedClaims(prose), `${channel}: ${prose}`).toEqual([])
    })
  })

  it('says plainly when no product page was assessable, rather than inventing one', () => {
    const m = composeMessage(input({ topFinding: null }))
    expect(m.body).toMatch(/did not find a product page we could assess/)
  })

  it('keeps a LinkedIn note inside the platform character limit', () => {
    const m = composeMessage(input({ channel: 'linkedin' }))
    expect(m.length).toBeLessThanOrEqual(CHANNEL_LIMITS.linkedin.maxBody)
  })

  it('includes a compliance footer on email', () => {
    const m = composeMessage(input())
    expect(m.body).toMatch(/unsubscribe/i)
  })

  it('never puts an internal identifier in the copy', () => {
    const m = composeMessage(input())
    expect(m.body).not.toMatch(/tenantId|crmCompanyId|auditRunId|dm_1|co_1/)
  })
})

describe('call task talking points', () => {
  const m = composeMessage(
    input({
      channel: 'call',
      target: target({ destination: null, destinationKind: 'internal_task' }),
      intentSignals: [{ id: 's1', summary: 'An open deal exists on this company.', sourceUrl: null }],
      workbenchUrl: 'https://demo.example/workbench/abc123',
    }),
  )

  it('numbers the points and leads with the sample', () => {
    expect(m.blocks.talkingPoints).toMatch(/^1\. We reviewed 25 page\(s\)/)
  })

  it('gives the SDR the exact measurement to quote', () => {
    expect(m.blocks.talkingPoints).toMatch(/Quote the measurement directly: A specification block was observed on 3 of 12/)
  })

  it('always ends with the scope caveat', () => {
    // An SDR who overstates the sample on a call does more damage than a weak
    // opening, so this point is always last.
    expect(m.blocks.talkingPoints.trim()).toMatch(/covers the pages we inspected, not their whole catalogue\.$/)
  })

  it('says who to ask for, or says that nobody was identified', () => {
    expect(m.blocks.askFor).toMatch(/Ask for Dana Whitfield \(Ecommerce Manager\)/)
    const anon = composeMessage(input({ channel: 'call', target: target({ contactName: null, destination: null }) }))
    expect(anon.blocks.askFor).toMatch(/No product-data owner was identified/)
  })
})

// ── TEMPLATES ──────────────────────────────────────────────────────────────

describe('templates', () => {
  it('registers one template per channel, each versioned', () => {
    const channels = new Set(TEMPLATES.map((t) => t.channel))
    expect(channels.size).toBe(5)
    TEMPLATES.forEach((t) => expect(t.version).toMatch(/^v\d+$/))
  })

  it('reports a missing required block instead of rendering a gap', () => {
    const t = templateFor('email')
    const r = renderTemplate(t, { greeting: 'Hi,' })
    expect(r.missing).toContain('cta')
    expect(r.missing).toContain('signature')
  })

  it('drops an empty optional block without complaint', () => {
    const t = templateFor('email')
    const r = renderTemplate(t, {
      subject: 'S',
      greeting: 'Hi,',
      auditHook: 'H',
      finding: 'F',
      value: '',
      cta: 'C',
      signature: 'Sig',
      compliance: 'Comp',
    })
    expect(r.missing).toEqual([])
    expect(r.body).not.toMatch(/\n\n\n/)
  })

  it('resolves a template by key and version', () => {
    expect(templateByKey('email.audit_intro', 'v1')).toBeTruthy()
    expect(templateByKey('email.audit_intro', 'v99')).toBeNull()
  })
})

// ── SEQUENCE AND IDEMPOTENCY ───────────────────────────────────────────────

describe('sequence', () => {
  it('is data, covering all five channels in order', () => {
    const seq = defaultSequence()
    expect(seq.map((s) => s.channel)).toEqual(['email', 'linkedin', 'call', 'email_followup', 'whatsapp'])
    expect(seq.map((s) => s.dayOffset)).toEqual([...seq.map((s) => s.dayOffset)].sort((a, b) => a - b))
  })

  it('schedules by day offset from the campaign start', () => {
    const start = new Date('2026-09-01T09:00:00Z')
    expect(scheduledAtFor(start, 4).toISOString()).toBe('2026-09-05T09:00:00.000Z')
  })

  it('will not run a follow-up when the first message never went', () => {
    const followUp = defaultSequence().find((s) => s.channel === 'email_followup')!
    expect(stepIsEligible(followUp, 'blocked_provider_unavailable', true).eligible).toBe(false)
    expect(stepIsEligible(followUp, 'blocked_provider_unavailable', true).reason).toMatch(
      /must not reference a message that never went/,
    )
    expect(stepIsEligible(followUp, 'sent', true).eligible).toBe(true)
  })

  it('skips a channel that is not explicitly enabled', () => {
    const wa = defaultSequence().find((s) => s.channel === 'whatsapp')!
    const r = stepIsEligible(wa, 'sent', false)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/business decision rather than a default/)
  })
})

describe('idempotency', () => {
  const base = {
    campaignId: 'c1',
    crmCompanyId: 'co1',
    channel: 'email' as const,
    stepNumber: 1,
    destination: 'a@b.example',
    templateKey: 'email.audit_intro',
    templateVersion: 'v1',
  }

  it('is stable for the same intended action', () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey(base))
  })

  it('ignores destination casing and surrounding space', () => {
    expect(idempotencyKey({ ...base, destination: '  A@B.Example ' })).toBe(idempotencyKey(base))
  })

  const differs: Array<[string, Partial<typeof base>]> = [
    ['campaign', { campaignId: 'c2' }],
    ['company', { crmCompanyId: 'co2' }],
    ['channel', { channel: 'linkedin' }],
    ['step', { stepNumber: 2 }],
    ['destination', { destination: 'other@b.example' }],
    // New wording is a different message, and treating it as the same one would
    // deliver new copy under an old action's audit trail.
    ['template version', { templateVersion: 'v2' }],
  ]
  differs.forEach(([what, patch]) => {
    it(`is different when the ${what} differs`, () => {
      expect(idempotencyKey({ ...base, ...patch })).not.toBe(idempotencyKey(base))
    })
  })

  it('handles an action with no destination', () => {
    expect(idempotencyKey({ ...base, destination: null })).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── PROVIDERS ──────────────────────────────────────────────────────────────

describe('provider availability in THIS environment', () => {
  it('email is not configured, and says what is missing', () => {
    const a = new EmailProvider().availability()
    expect(a.status).toBe('not_configured')
    expect(a.reason).toMatch(/No email provider is configured/)
    expect(a.remediation).toBeTruthy()
  })

  it('the follow-up shares the email transport status', () => {
    expect(new EmailFollowUpProvider().availability().status).toBe(new EmailProvider().availability().status)
  })

  it('LinkedIn is draft-only, and records that automation was refused', () => {
    const a = new LinkedInProvider().availability()
    expect(a.status).toBe('draft_only')
    expect(a.reason).toMatch(/Partner Program/)
    // The decision not to use reachable scraping Actors is written down, because
    // a decision nobody recorded gets quietly reversed.
    expect(a.reason).toMatch(/deliberately NOT used/)
  })

  it('the call task provider works, because its output is internal', () => {
    expect(new CallTaskProvider().availability().status).toBe('available')
  })

  it('WhatsApp is disabled by policy, not merely unconfigured', () => {
    const a = new WhatsAppProvider().availability()
    expect(a.status).toBe('disabled_by_policy')
    expect(a.reason).toMatch(/business decision/)
  })

  it('every channel reports a status and a reason when it cannot act', () => {
    channelStatus().forEach((c) => {
      expect(c.provider).toBeTruthy()
      if (c.status !== 'available') expect(c.reason, c.channel).toBeTruthy()
    })
  })
})

describe('provider isolation', () => {
  const stub = (over: Partial<OutreachProvider> = {}): OutreachProvider => ({
    name: 'stub',
    channel: 'email',
    availability: () => ({ status: 'available' }),
    deliver: async () => ({ status: 'available', delivered: true, durationMs: 1 }),
    ...over,
  })

  const ctx = {
    tenantId: 't',
    actionId: 'a',
    channel: 'email' as const,
    target: target(),
    message: composeMessage(input()),
    dryRun: false,
  }

  it('classifies a thrown 429 as retryable', async () => {
    const r = await runProvider(
      stub({ deliver: async () => { throw new Error('Request failed with status 429') } }),
      ctx,
    )
    expect(r.failureKind).toBe('rate_limited')
    expect(RETRYABLE_FAILURES).toContain(r.failureKind!)
  })

  it('classifies an auth failure as permanent, so it is not retried forever', async () => {
    const r = await runProvider(
      stub({ deliver: async () => { throw new Error('401 unauthorized') } }),
      ctx,
    )
    expect(r.failureKind).toBe('unauthorized')
    expect(RETRYABLE_FAILURES).not.toContain(r.failureKind!)
  })

  it('classifies a timeout as transient', async () => {
    const r = await runProvider(stub({ deliver: async () => { throw new Error('socket hang up') } }), ctx)
    expect(r.failureKind).toBe('transient')
  })

  it('treats an unknown failure as permanent rather than retrying blindly', async () => {
    const r = await runProvider(stub({ deliver: async () => { throw new Error('malformed payload') } }), ctx)
    expect(r.failureKind).toBe('permanent')
  })

  it('does not call deliver when the provider cannot act', async () => {
    let called = false
    await runProvider(
      stub({
        availability: () => ({ status: 'not_configured', reason: 'no key' }),
        deliver: async () => {
          called = true
          return { status: 'available' as const, delivered: true, durationMs: 0 }
        },
      }),
      ctx,
    )
    expect(called).toBe(false)
  })

  it('still calls deliver for a draft-only provider, because a draft is useful', async () => {
    let called = false
    await runProvider(
      stub({
        availability: () => ({ status: 'draft_only', reason: 'manual' }),
        deliver: async () => {
          called = true
          return { status: 'draft_only' as const, delivered: false, manualRequired: true, durationMs: 0 }
        },
      }),
      ctx,
    )
    expect(called).toBe(true)
  })
})

describe('providers never send in this environment', () => {
  const ctx = (channel: 'email' | 'linkedin' | 'call' | 'whatsapp', dryRun = false) => ({
    tenantId: 't',
    actionId: 'a',
    channel,
    target: target({ destination: channel === 'linkedin' ? 'https://linkedin.example/in/x' : 'a@b.example' }),
    message: composeMessage(input({ channel, target: target({ destination: null }) })),
    dryRun,
  })

  it('email delivers nothing', async () => {
    const r = await new EmailProvider().deliver(ctx('email'))
    expect(r.delivered).toBe(false)
  })

  it('LinkedIn produces a manual draft and sends nothing', async () => {
    const r = await new LinkedInProvider().deliver(ctx('linkedin'))
    expect(r.delivered).toBe(false)
    expect(r.manualRequired).toBe(true)
    expect(r.reason).toMatch(/send it by hand/)
  })

  it('the call task creates internal work and places no call', async () => {
    const r = await new CallTaskProvider().deliver(ctx('call'))
    expect(r.delivered).toBe(true)
    expect(r.manualRequired).toBe(true)
    expect(r.reason).toMatch(/No call was placed by this platform/)
  })

  it('a dry run creates no call task at all', async () => {
    const r = await new CallTaskProvider().deliver(ctx('call', true))
    expect(r.delivered).toBe(false)
    expect(r.reason).toMatch(/Dry run/)
  })

  it('WhatsApp refuses and does NOT fall back to another channel', async () => {
    const r = await new WhatsAppProvider().deliver(ctx('whatsapp'))
    expect(r.delivered).toBe(false)
    expect(r.reason).toMatch(/no other channel was substituted/)
  })
})

describe('channel rules', () => {
  it('requires a person for every channel that contacts one', () => {
    expect(CHANNEL_LIMITS.email.requiresPerson).toBe(true)
    expect(CHANNEL_LIMITS.linkedin.requiresPerson).toBe(true)
    // A call task is internal work; it needs no external destination.
    expect(CHANNEL_LIMITS.call.requiresDestination).toBe(false)
  })

  it('treats sent and suppressed as terminal so nothing re-fires', () => {
    expect(TERMINAL_STATUSES).toContain('sent')
    expect(TERMINAL_STATUSES).toContain('blocked_suppressed')
    expect(TERMINAL_STATUSES).toContain('cancelled')
  })

  it('maps every channel to a provider', () => {
    ;(['email', 'linkedin', 'call', 'email_followup', 'whatsapp'] as const).forEach((c) => {
      expect(providerFor(c).channel).toBe(c)
    })
  })
})

describe('voice and grammar in generated copy', () => {
  it('addresses the SDR in the third person on a call task', () => {
    // A call task is internal work about a prospect. "your website" in it reads
    // as though the SDR owned the site.
    const m = composeMessage(input({ channel: 'call', target: target({ destination: null }) }))
    expect(m.blocks.context).toMatch(/on their website/)
    expect(m.blocks.context).not.toMatch(/your website/)
  })

  it('addresses the prospect in the second person on an email', () => {
    const m = composeMessage(input())
    expect(m.body).toMatch(/on your website/)
  })

  it('turns a headline finding title into a readable clause', () => {
    const m = composeMessage(
      input({
        channel: 'linkedin',
        topFinding: {
          id: 'f',
          title: 'Brand not stated on inspected product pages',
          metric: 'A brand was stated on 0 of 12 inspected product pages.',
          finding: 'x',
          recommendation: 'x',
          sourceUrl: null,
        },
      }),
    )
    // "noticed brand not stated" is not a sentence.
    expect(m.body).toMatch(/noticed that the brand was not stated/)
    expect(m.body).not.toMatch(/noticed brand not stated/)
  })

  it('keeps the rewritten clause inside the LinkedIn character limit', () => {
    const m = composeMessage(input({ channel: 'linkedin' }))
    expect(m.length).toBeLessThanOrEqual(CHANNEL_LIMITS.linkedin.maxBody)
  })
})

describe('audit-run evidence', () => {
  it('every message is traceable to the audit that licensed it', () => {
    const m = composeMessage(input())
    const run = m.evidence.find((e) => e.kind === 'audit_run')!
    expect(run.referenceId).toBe('run_1')
  })

  it('carries evidence even when the audit produced no finding', () => {
    // The case this exists for: a prospect whose website was unreachable. The
    // call task is the most warranted channel there, and it was being blocked
    // for having nothing to cite.
    const m = composeMessage(input({ channel: 'call', topFinding: null, target: target({ destination: null }) }))
    expect(m.evidence.length).toBeGreaterThan(0)
    expect(m.evidence.some((e) => e.kind === 'audit_run')).toBe(true)
  })
})
