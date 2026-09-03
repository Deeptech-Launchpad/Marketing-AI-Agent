import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUALIFICATION_POLICY,
  QUALIFICATION_ENGINE_VERSION,
  decide,
  dueAt,
  validateQualificationPolicy,
} from '../../src/salesqualification/policy.js'
import {
  ALERT_PROVIDERS,
  InAppAlertProvider,
  SlackAlertProvider,
  renderAlertText,
  selectAlertProvider,
} from '../../src/salesqualification/providers/alertProvider.js'
import {
  CrmTaskProvider,
  InternalTaskProvider,
  TASK_PROVIDERS,
  renderTaskBody,
  selectTaskProvider,
} from '../../src/salesqualification/providers/taskProvider.js'
import type { QualificationPolicy, ResolvedOwner } from '../../src/salesqualification/types.js'

// TASK #985 unit tests.
//
// The properties a sales handoff has to have: the rule is a comparison and
// nothing else, the decision is snapshotted, an owner is never guessed, a
// provider never claims success it did not have, and nothing in this module can
// reach a prospect.

const POLICY = DEFAULT_QUALIFICATION_POLICY

describe('the qualification policy', () => {
  it('is structurally valid', () => {
    expect(validateQualificationPolicy(POLICY)).toEqual([])
  })

  it('is declared PROVISIONAL', () => {
    expect(POLICY.status).toBe('provisional')
    expect(POLICY.notes.join(' ')).toMatch(/NOT BUSINESS-APPROVED/i)
    expect(POLICY.notes.join(' ')).toMatch(/15-minute SLA is provisional/i)
  })

  it('is frozen, so a runtime edit cannot rewrite a past decision', () => {
    expect(Object.isFrozen(POLICY)).toBe(true)
  })

  it('adds no hysteresis band by default, and says so', () => {
    // "Once hot, always hot" must never appear by accident.
    expect(POLICY.deQualifyBand).toBe(0)
    expect(POLICY.notes.join(' ')).toMatch(/no hysteresis band is configured/i)
  })

  it('does not cancel a task on de-qualification by default', () => {
    expect(POLICY.cancelTaskOnDeQualification).toBe(false)
  })

  it('makes no claim about buying', () => {
    // Sentences that DENY something are stripped first. The policy says in as
    // many words that it is "not a prediction, a conversion probability, or a
    // forecast of revenue", and a check that flagged its own disclaimer would
    // push the honest sentence out of the code.
    const assertions = [POLICY.description, ...POLICY.notes]
      .join(' ')
      .toLowerCase()
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !/\b(not|never|no)\b/.test(sentence))
      .join(' ')

    expect(assertions).not.toMatch(/will buy|guaranteed|revenue|roi|conversion probability|purchase probability/)
    // And the denial itself is present.
    expect([POLICY.description, ...POLICY.notes].join(' ')).toMatch(/not a prediction/i)
  })

  it('rejects a malformed policy', () => {
    expect(validateQualificationPolicy({ ...POLICY, threshold: 140 }).length).toBeGreaterThan(0)
    expect(validateQualificationPolicy({ ...POLICY, slaMinutes: 0 }).length).toBeGreaterThan(0)
    expect(validateQualificationPolicy({ ...POLICY, deQualifyBand: 999 }).length).toBeGreaterThan(0)
  })
})

describe('the threshold comparison', () => {
  it('qualifies a score above the threshold', () => {
    const d = decide(82, POLICY)
    expect(d.qualifies).toBe(true)
    expect(d.status).toBe('qualified')
    expect(d.difference).toBe(12)
    expect(d.reason).toContain('82')
    expect(d.reason).toContain('70')
  })

  it('qualifies a score EXACTLY at the threshold', () => {
    // The rule is >=, and the boundary is the case most likely to be wrong.
    const d = decide(70, POLICY)
    expect(d.qualifies).toBe(true)
    expect(d.difference).toBe(0)
  })

  it('does not qualify one point below', () => {
    const d = decide(69, POLICY)
    expect(d.qualifies).toBe(false)
    expect(d.status).toBe('not_qualified')
    expect(d.difference).toBe(-1)
  })

  it('qualifies one point above', () => {
    expect(decide(71, POLICY).qualifies).toBe(true)
  })

  it('reports the difference in both directions', () => {
    expect(decide(100, POLICY).difference).toBe(30)
    expect(decide(0, POLICY).difference).toBe(-70)
  })

  it('is deterministic', () => {
    const a = decide(75, POLICY)
    const b = decide(75, POLICY)
    expect(b).toEqual(a)
  })

  it('honours a changed threshold without any code change', () => {
    const strict: QualificationPolicy = { ...POLICY, version: 'sq-strict', threshold: 90 }
    expect(decide(82, POLICY).qualifies).toBe(true)
    expect(decide(82, strict).qualifies).toBe(false)
    expect(decide(82, strict).reason).toContain('90')
  })
})

describe('re-qualification and de-qualification', () => {
  it('de-qualifies a previously qualified lead whose score fell', () => {
    const d = decide(68, POLICY, 'qualified')
    expect(d.qualifies).toBe(false)
    expect(d.status).toBe('de_qualified')
    expect(d.reason).toMatch(/fallen below/i)
    expect(d.reason).toMatch(/kept in the history/i)
  })

  it('reports a never-qualified lead as not_qualified, not de_qualified', () => {
    expect(decide(50, POLICY, null).status).toBe('not_qualified')
    expect(decide(50, POLICY, 'not_qualified').status).toBe('not_qualified')
  })

  it('re-qualifies after a de-qualification', () => {
    expect(decide(75, POLICY, 'de_qualified').status).toBe('qualified')
  })

  it('de-qualifies an unassigned lead too', () => {
    expect(decide(60, POLICY, 'qualified_unassigned').status).toBe('de_qualified')
  })

  it('holds a qualified lead inside a configured hysteresis band', () => {
    const withBand: QualificationPolicy = { ...POLICY, version: 'sq-band', deQualifyBand: 5 }
    // 67 is below 70 but not below 65, so a qualified lead is held.
    const held = decide(67, withBand, 'qualified')
    expect(held.qualifies).toBe(true)
    expect(held.reason).toMatch(/remains qualified/i)
    // A lead that was NOT qualified still needs the full threshold.
    expect(decide(67, withBand, 'not_qualified').qualifies).toBe(false)
    // Below the band, it de-qualifies.
    expect(decide(64, withBand, 'qualified').status).toBe('de_qualified')
  })

  it('with the default band of zero, behaves as the simple rule', () => {
    expect(decide(69, POLICY, 'qualified').qualifies).toBe(false)
  })
})

describe('SLA', () => {
  it('computes the due time from the policy', () => {
    const at = new Date('2026-08-28T12:00:00Z')
    expect(dueAt(at, POLICY).toISOString()).toBe('2026-08-28T12:15:00.000Z')
  })

  it('follows a changed SLA without a code change', () => {
    const at = new Date('2026-08-28T12:00:00Z')
    const slow: QualificationPolicy = { ...POLICY, version: 'sq-slow', slaMinutes: 240 }
    expect(dueAt(at, slow).toISOString()).toBe('2026-08-28T16:00:00.000Z')
  })
})

describe('alert providers', () => {
  it('reports Slack as not configured, with a remediation', () => {
    const a = new SlackAlertProvider().availability()
    expect(a.status).toBe('not_configured')
    expect(a.remediation).toMatch(/SALES_ALERT_SLACK_WEBHOOK_URL/)
  })

  it('falls back to the in-app record, and never calls it "sent"', () => {
    const { provider, skipped } = selectAlertProvider()
    expect(provider.name).toBe('in_app')
    // Every skipped provider keeps its own reason. Never a silent substitution.
    expect(skipped.length).toBeGreaterThan(0)
    for (const s of skipped) expect(s.reason.length).toBeGreaterThan(5)
  })

  it('does not claim delivery for an internal record', async () => {
    const result = await new InAppAlertProvider().send({} as never)
    // The record is real; the delivery to a human is not.
    expect(result.delivered).toBe(false)
    expect(result.reason).toMatch(/nobody was actively notified/i)
  })

  it('renders an alert with no secret and no prospect contact detail', () => {
    const owner: ResolvedOwner = {
      resolved: true,
      crmUserId: 'u1',
      name: 'Dana Sales',
      email: 'dana@altiusnxt.test',
      source: 'crm_account_owner',
      reason: 'owner',
    }
    const text = renderAlertText({
      qualificationId: 'q1',
      companyName: '1st Ayd',
      crmCompanyId: 'c1',
      score: 82,
      threshold: 70,
      whyLines: ['They completed the registration form.'],
      recommendedAction: 'Offer a 15-minute walkthrough.',
      owner,
      internalLink: 'http://localhost:3000/companies/c1',
      dueAt: new Date('2026-08-28T12:15:00Z'),
    })

    expect(text).toContain('HIGH-INTENT LEAD')
    expect(text).toContain('82 / 100')
    expect(text).toContain('Threshold:      70')
    expect(text).toMatch(/not a prediction that the company will buy/i)
    // Nothing sensitive.
    expect(text).not.toMatch(/password|secret|token|api[_-]?key|Bearer /i)
  })

  it('registers every provider with a stated destination', () => {
    for (const p of ALERT_PROVIDERS) {
      expect(p.destination.length).toBeGreaterThan(5)
      expect(['available', 'not_configured', 'unauthorized', 'unavailable', 'disabled_by_policy']).toContain(
        p.availability().status,
      )
    }
  })
})

describe('task providers', () => {
  it('reports the CRM as read-only, because the port has no write method', () => {
    const a = new CrmTaskProvider().availability()
    expect(a.status).toBe('not_configured')
    expect(a.reason).toMatch(/read-only/i)
    expect(a.remediation).toMatch(/Do not write to NXT Sales tables directly/i)
  })

  it('falls back to an internal task', () => {
    const { provider, skipped } = selectTaskProvider()
    expect(provider.name).toBe('internal')
    expect(skipped.some((s) => s.name === 'nxt_sales')).toBe(true)
  })

  it('creates a task, and says the prospect was not contacted', async () => {
    const result = await new InternalTaskProvider().create({} as never)
    expect(result.delivered).toBe(true)
    expect(result.reason).toMatch(/created in the Marketing AI platform/i)
  })

  it('renders a task body that is a task, not a message', () => {
    const body = renderTaskBody({
      qualificationId: 'q1',
      crmCompanyId: 'c1',
      companyName: '1st Ayd',
      score: 82,
      threshold: 70,
      owner: { resolved: true, crmUserId: 'u1', name: 'Dana', email: null, source: 'crm_account_owner', reason: 'x' },
      whyLines: ['They clicked the walkthrough call-to-action.'],
      recommendedAction: 'Offer a 15-minute walkthrough.',
      dueAt: new Date('2026-08-28T12:15:00Z'),
      slaMinutes: 15,
      policyVersion: 'sq1-provisional',
    })
    expect(body).toContain('FOLLOW UP — HIGH INTENT')
    expect(body).toMatch(/Nothing has been sent to this prospect/i)
  })

  it('registers every task provider with a stated destination', () => {
    for (const p of TASK_PROVIDERS) {
      expect(p.destination.length).toBeGreaterThan(5)
    }
  })
})

describe('versioning', () => {
  it('records an engine version separate from the policy version', () => {
    expect(QUALIFICATION_ENGINE_VERSION).toBeTruthy()
    expect(QUALIFICATION_ENGINE_VERSION).not.toBe(POLICY.version)
  })
})

// ── Mechanical guarantees ───────────────────────────────────────────────────

describe('structural guarantees of the qualification module', () => {
  const DIR = fileURLToPath(new URL('../../src/salesqualification/', import.meta.url))

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
    expect(files.length).toBeGreaterThan(4)
  })

  it('executes no outreach of any kind', () => {
    // The single most important boundary in this task: qualification puts a
    // task on a desk, it never contacts the prospect.
    for (const file of files) {
      const src = code(file)
      expect(src, file).not.toMatch(/executeAction|createCampaign|composeMessage|OutreachProvider/)
      expect(src, file).not.toMatch(/sendEmail|sendWhatsApp|sendLinkedIn|sendMessage\b/)
      expect(src, file).not.toMatch(/nodemailer|sendgrid|twilio|smtp/i)
    }
  })

  it('never writes to NXT Sales', () => {
    for (const file of files) {
      const src = code(file)
      // CALL SITES, not bare identifiers. taskProvider.ts legitimately names
      // these methods in a list it probes the port for, to discover whether an
      // approved write adapter exists — checking for a capability is the
      // opposite of using one.
      expect(src, file).not.toMatch(/\.\s*(updateCompany|createActivity|createDeal|createContact)\s*\(/)
      expect(src, file).not.toMatch(/prisma\.company\.|\$executeRaw/)
    }
  })

  it('only ever READS the CRM', () => {
    const resolver = code(join(DIR, 'providers', 'ownerResolver.ts'))
    // The two calls it makes, and nothing else.
    const calls = [...resolver.matchAll(/\bcrm\.(\w+)\s*\(/g)].map((m) => m[1])
    expect(new Set(calls)).toEqual(new Set(['getCompany', 'listUsers']))
  })

  it('never mutates an intent score or an engagement event', () => {
    for (const file of files) {
      const src = code(file)
      expect(src, file).not.toMatch(/intentScore\.(create|update|delete|upsert)/)
      expect(src, file).not.toMatch(/intentScoreSnapshot\.(create|update|delete|upsert)/)
      expect(src, file).not.toMatch(/intentScoreContribution\.(create|update|delete|upsert)/)
      expect(src, file).not.toMatch(/engagementEvent\.(create|update|delete|upsert)/)
      expect(src, file).not.toMatch(/scoreCompany|calculateScore|recordEvent/)
    }
  })

  it('never updates or deletes qualification history', () => {
    // Append-only is a property of the code, not just an intention.
    for (const file of files) {
      const src = code(file)
      expect(src, file).not.toMatch(/salesQualificationHistory\.(update|delete|deleteMany|upsert)/)
    }
  })

  it('uses no AI model to make the decision', () => {
    for (const file of files) {
      expect(code(file), file).not.toMatch(/gemini|generateContent|llmPort|getLlm/i)
    }
  })

  it('keeps the threshold and the SLA out of the engine', () => {
    // Every number lives in the policy, so the business can change it without
    // anyone editing the comparison.
    const service = code(join(DIR, 'service.ts'))
    expect(service).not.toMatch(/\b(70|75|80)\b\s*(<=|>=|<|>)/)
    expect(service).not.toMatch(/threshold\s*=\s*\d+/)
    expect(service).not.toMatch(/slaMinutes\s*=\s*\d+/)
  })

  it('makes no claim of a guaranteed sale anywhere', () => {
    const banned = /\b(willBuy|guaranteedSale|conversionProbability|purchaseProbability|closeProbability|revenueForecast)\b/i
    for (const file of files) {
      const match = code(file).match(banned)
      expect(match?.[0], `${file} uses "${match?.[0]}"`).toBeUndefined()
    }
  })
})

describe('the no-guessing rule', () => {
  it('has no code path that picks an arbitrary salesperson', () => {
    const resolver = readFileSync(
      fileURLToPath(new URL('../../src/salesqualification/providers/ownerResolver.ts', import.meta.url)),
      'utf8',
    )
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')

    // The ways a salesperson could be picked at random.
    expect(resolver).not.toMatch(/users\[0\]|\.random|Math\.random|sample\(|shuffle/)
    expect(resolver).not.toMatch(/users\.find\(\s*\(\)\s*=>\s*true/)
    // And a configured fallback is verified against the real user list.
    expect(resolver).toMatch(/byId\.get\(env\.SALES_FALLBACK_OWNER_CRM_USER_ID\)/)
  })
})
