import { beforeEach, describe, expect, it, vi } from 'vitest'

// recordOutcome with opt-outs: the EVALUATION NEVER touches the suppression list (owner decision of 2026-11-10 - the sender of an email is not
// authenticated, so no email-derived proposal may be written automatically). With the switch off the stored line is a dry run; with it on the stored line
// says a person must approve it; in both cases nothing is read from or written to the suppression list and no retry is scheduled. The database is a
// stand-in whose suppression list FAILS THE TEST on any use.

const h = vi.hoisted(() => {
  const state = {
    evaluationUpdates: [] as Array<Record<string, any>>,
    companyUpdates: [] as Array<Record<string, any>>,
    suppressionTouched: [] as string[],
    company: { id: 'row1', tenantId: 't1', attempts: 1, currentEvaluationId: null, classification: null, score: null, confidence: null, summary: null, evaluatedAt: null } as Record<string, any>,
  }
  const touched = (what: string) => () => {
    state.suppressionTouched.push(what)
    throw new Error(`the evaluation must not touch the suppression list (${what})`)
  }
  return { ...state, touched }
})
vi.mock('../../src/platform/db.js', () => ({
  newId: () => 'id',
  prisma: {
    warmLeadEvaluation: { update: async (a: Record<string, any>) => void h.evaluationUpdates.push(a) },
    warmLeadCompany: {
      findUniqueOrThrow: async () => h.company,
      update: async (a: Record<string, any>) => void h.companyUpdates.push(a),
    },
    suppressionEntry: new Proxy({}, { get: (_t, prop) => h.touched(`suppressionEntry.${String(prop)}`) }),
    auditEvent: new Proxy({}, { get: (_t, prop) => h.touched(`auditEvent.${String(prop)}`) }),
    $transaction: h.touched('$transaction'),
    $queryRaw: h.touched('$queryRaw'),
    $executeRaw: h.touched('$executeRaw'),
  },
}))
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({}) }))

import { env } from '../../src/config/env.js'
import { toActivity } from '../../src/crm/nxtSales/mappers.js'
import { recordOutcome, type Claim } from '../../src/warmleads/companies.js'
import { optOutSignals, proposeOptOuts, signalsToReasons } from '../../src/warmleads/optOut.js'
import { summariseInbound } from '../../src/warmleads/replies.js'
import type { ComputedEvaluation } from '../../src/warmleads/service.js'

// Server-side settings the opt-out code needs (test values only): the dedicated fingerprint key, and which domains are OURS.
env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'unit-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
env.WARM_LEADS_OWN_DOMAINS = 'ours.example'

const NOW = new Date('2026-11-05T01:00:00Z')
const act = (id: string, from: string) =>
  toActivity({ id, type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: '2026-11-03T10:00:00Z', body: 'UNSUBSCRIBE', fromEmail: from, matchedCompanyEmail: from, mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example' }, true, NOW)
const claim: Claim = { companyRowId: 'row1', crmCompanyId: 'c1', evaluationId: 'ev1', runId: 'run1', kind: 'pilot', attempts: 1 }

/** An evaluation as computeEvaluation returns it. */
function computed(senders: string[], opts: { failed?: boolean; record: boolean }): ComputedEvaluation {
  const activities = senders.map((s, i) => act(`act_${i}`, s))
  const assessed = summariseInbound(activities, NOW, undefined, true).assessed
  const decision = proposeOptOuts(assessed, opts.record)
  const reasons = signalsToReasons(optOutSignals({ assessed, decision, persisted: [], record: opts.record }))
  return {
    company: null,
    tier: 'screen',
    website: null,
    deep: 'not_needed',
    enrichmentId: null,
    intentRunId: null,
    costUsd: 0,
    failure: opts.failed ? { message: 'The website could not be read.', reasons } : null,
    result: opts.failed ? null : { classification: 'human_review', score: 55, confidence: 'medium', summary: 'held', reasons },
    refusal: true,
    optOuts: decision.proposals,
    optOutReasons: reasons,
  } as unknown as ComputedEvaluation
}
const stored = () => h.evaluationUpdates.at(-1)!.data.reasons as Array<{ signal: string; summary: string; evidence: string }>
const proposalLines = () => stored().filter((r) => r.signal === 'opt_out_proposal')
const retryUpdate = () => h.companyUpdates.find((u) => u.data.state === 'needs_reevaluation' && u.data.lastError)
const run = (c: ComputedEvaluation) => recordOutcome(claim, c, { bucket: 'pilot', geminiCalls: 0, now: NOW })

beforeEach(() => {
  h.evaluationUpdates.length = 0
  h.companyUpdates.length = 0
  h.suppressionTouched.length = 0
  env.WARM_LEADS_RECORD_OPT_OUTS = false
})

describe('the evaluation never writes to the suppression list: the switch alone writes nothing', () => {
  it('SWITCH OFF: nothing is read or written; the stored reasons stay a dry run; the company is not sent back for a re-check', async () => {
    const r = await run(computed(['a@acme.example'], { record: false }))
    expect(h.suppressionTouched).toEqual([])
    expect(proposalLines()[0]!.summary).toMatch(/DRY RUN: nothing was written/)
    expect(proposalLines()[0]!.evidence).toMatch(/^status: dry_run · NXT activity act_0 · received 2026-11-03 · fp [0-9a-f]{16} · key [0-9a-f]{8} · phrase: UNSUBSCRIBE/)
    expect(r.state).not.toBe('needs_reevaluation')
  })

  it('SWITCH ON: still nothing is written (not even read); the stored line says a person must approve it; no retry is scheduled', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    const r = await run(computed(['a@acme.example', 'b@acme.example'], { record: true }))
    expect(h.suppressionTouched).toEqual([])
    expect(proposalLines().map((l) => /status: (\w+)/.exec(l.evidence)![1])).toEqual(['awaiting_approval', 'awaiting_approval'])
    expect(proposalLines()[0]!.summary).toMatch(/is NOT added yet: the sender of an email cannot be verified, so a person must approve it first/)
    expect(proposalLines().some((l) => /was added/.test(l.summary))).toBe(false)
    expect(retryUpdate()).toBeUndefined() // waiting for a person is not a failure to retry
    expect(r.state).not.toBe('needs_reevaluation')
  })

  it('an evaluation that FAILED (site unreadable) keeps the proposal evidence on its failed row, and still touches nothing', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    await run(computed(['a@acme.example'], { record: true, failed: true }))
    expect(h.suppressionTouched).toEqual([])
    expect(h.evaluationUpdates.at(-1)!.data.status).toBe('failed')
    expect(proposalLines()).toHaveLength(1)
    expect(proposalLines()[0]!.evidence).toMatch(/^status: awaiting_approval · NXT activity act_0 /)
  })

  it('the forged/odd sender cases change nothing: whatever the proposals contain, the evaluation has no way to write', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    const c = computed(['victim@thirdparty.example'], { record: true })
    // even a proposal object that someone tampered with ("verified", "approved") cannot make recordOutcome write: it has no writer to call
    c.optOuts = (c.optOuts ?? []).map((p) => ({ ...p, senderVerified: true, approved: true }) as never)
    await run(c)
    expect(h.suppressionTouched).toEqual([])
  })
})
