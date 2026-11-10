import { beforeEach, describe, expect, it, vi } from 'vitest'

// A PERSON approves ONE opt-out proposal. The sender of an email is not authenticated, so the switch alone never writes: the server re-derives
// the address from the source email (read only), by the strict rules, and only then writes - naming the approver. The database and the CRM are
// stand-ins; nothing here touches a real suppression list.

const h = vi.hoisted(() => ({
  companies: new Set<string>(),
  rows: [] as Array<Record<string, any>>,
  /** the tenant the stored evaluations belong to: a query for any other tenant finds nothing */
  rowsTenant: 'tenant-A',
  /** everything that was logged */
  logs: [] as unknown[][],
  approvals: [] as Array<{ resourceId: string; actorCrmUserId: string }>,
  rawArgs: [] as unknown[][],
  existing: new Map<string, { expiresAt: Date | null }>(),
  creates: [] as Array<Record<string, any>>,
  classifications: new Map<string, string | null>(),
  failAudit: false,
  audits: [] as Array<Record<string, any>>,
  failWrites: false,
  activities: [] as Array<Record<string, any>>,
  crmCalls: [] as Array<Record<string, any>>,
}))
vi.mock('../../src/platform/db.js', () => {
  const prisma = {
    $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
      h.rawArgs.push(values)
      return values.includes(h.rowsTenant) ? h.rows : []
    },
    // a stand-in transaction: if the callback throws, everything it wrote is undone - as the real database does
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const creates = h.creates.length
      const audits = h.audits.length
      try {
        return await fn(prisma)
      } catch (err) {
        h.creates.length = creates
        h.audits.length = audits
        throw err
      }
    },
    warmLeadCompany: {
      findUnique: async (a: Record<string, any>) => (h.companies.has(`${a.where.tenantId_crmCompanyId.tenantId}|${a.where.tenantId_crmCompanyId.crmCompanyId}`) ? { id: 'row' } : null),
      findMany: async (a: Record<string, any>) => (a.where.crmCompanyId.in as string[]).map((id) => ({ crmCompanyId: id, classification: h.classifications.get(id) ?? null })),
    },
    auditEvent: {
      findMany: async () => h.approvals,
      create: async (a: Record<string, any>) => {
        if (h.failAudit) throw new Error('audit insert failed')
        h.audits.push(a.data)
      },
    },
    suppressionEntry: {
      findUnique: async (a: Record<string, any>) => h.existing.get(a.where.tenantId_scope_matchType_matchValue.matchValue) ?? null,
      createMany: async (a: { data: Array<Record<string, any>> }) => {
        if (h.failWrites) throw new Error('P1001 unreachable')
        h.creates.push(...a.data)
        return { count: a.data.length }
      },
    },
  }
  return { newId: () => 'id', prisma }
})
vi.mock('../../src/platform/logger.js', () => {
  const l: Record<string, unknown> = {}
  for (const n of ['info', 'warn', 'error', 'debug', 'trace', 'fatal']) l[n] = (...a: unknown[]) => void h.logs.push(a)
  l.child = () => l
  return { logger: l, runLogger: () => l }
})
vi.mock('../../src/crm/index.js', () => ({
  getCrm: () => ({
    listActivities: async (q: Record<string, any>) => {
      h.crmCalls.push(q)
      return h.activities
    },
  }),
}))

import { env } from '../../src/config/env.js'
import { toActivity } from '../../src/crm/nxtSales/mappers.js'
import { approveOptOut, revealOptOutAddress, VERIFICATION_METHODS } from '../../src/warmleads/optOutApproval.js'
import { optOutSignals, proposeOptOuts, signalsToReasons } from '../../src/warmleads/optOut.js'
import { summariseInbound } from '../../src/warmleads/replies.js'

// Server-side settings the opt-out code needs (test values only): the dedicated fingerprint key, and which domains are OURS.
env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'unit-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
env.WARM_LEADS_OWN_DOMAINS = 'ours.example'

const NOW = new Date()
const dayAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const raw = (over: Record<string, unknown> = {}) => ({ id: 'act_1', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: dayAgo(3), body: 'UNSUBSCRIBE', fromEmail: 'Ravi <ravi@acme.example>', matchedCompanyEmail: 'ravi@acme.example', mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example', user: { email: 'rep@ours.example' }, ...over })
/** The CRM's current version of the email, through the real mapper. */
const crmHas = (over: Record<string, unknown> = {}) => void (h.activities = [toActivity(raw(over), true)])
/** The proposal as an earlier (dry-run) evaluation stored it: reasons only - never an address. */
function storedProposal(over: Record<string, unknown> = {}) {
  const a = toActivity(raw(over), true)
  const assessed = summariseInbound([a], NOW, undefined, true).assessed
  const reasons = signalsToReasons(optOutSignals({ assessed, decision: proposeOptOuts(assessed, false), persisted: [], record: false }))
  h.rows = [{ id: 'e1', crmCompanyId: 'c1', companyName: 'Acme', evaluatedAt: new Date(), reasons }]
}
const input = { tenantId: 'tenant-A', approverCrmUserId: 'user-7', crmCompanyId: 'c1', activityId: 'act_1', independentlyVerified: true, verificationMethod: 'phone_call_known_number' as const }
const revealInput = { tenantId: 'tenant-A', adminCrmUserId: 'user-7', crmCompanyId: 'c1', activityId: 'act_1' }

beforeEach(() => {
  h.rowsTenant = 'tenant-A'
  h.logs.length = 0
  env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'unit-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
  h.companies = new Set(['tenant-A|c1'])
  h.rows = []
  h.approvals = []
  h.rawArgs.length = 0
  h.existing.clear()
  h.creates.length = 0
  h.classifications.clear()
  h.failAudit = false
  h.audits.length = 0
  h.failWrites = false
  h.activities = []
  h.crmCalls.length = 0
  env.WARM_LEADS_RECORD_OPT_OUTS = true
  storedProposal()
  crmHas()
})

describe('approving one opt-out proposal', () => {
  it('with the switch OFF nothing happens: no read of the CRM, no write', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = false
    await expect(approveOptOut(input)).rejects.toThrow(/switched off/)
    expect(h.crmCalls).toEqual([])
    expect(h.creates).toEqual([])
  })

  it('the address must be EXACTLY the proposed one: a different address with the same first letter and domain (same mask) is refused', async () => {
    crmHas({ fromEmail: 'Rex <rex@acme.example>' }) // masked "r***@acme.example" just like ravi@acme.example
    await expect(approveOptOut(input)).rejects.toThrow(/not the address that was proposed/)
    expect(h.creates).toEqual([])
  })

  it('a stored proposal without the fingerprint cannot be approved (it must be evaluated again first)', async () => {
    h.rows = h.rows.map((r) => ({ ...r, reasons: (r.reasons as Array<Record<string, any>>).map((x) => (typeof x.evidence === 'string' ? { ...x, evidence: x.evidence.replace(/ · fp [0-9a-f]{16}/, '').replace(/ · key [0-9a-f]{8}/, '') } : x)) }))
    await expect(approveOptOut(input)).rejects.toThrow(/stored without a fingerprint/)
    expect(h.creates).toEqual([])
  })

  it('a CHANGED fingerprint key gives a clear RE-REVIEW message (not "not the address"), and the CRM is never read', async () => {
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'a-second-dedicated-key-0123456789abcdef-NOT-A-SECRET' // after the proposal was stored under the first key
    await expect(approveOptOut(input)).rejects.toThrow(/fingerprint key has changed since this proposal was made/)
    await expect(approveOptOut(input)).rejects.toThrow(/evaluate the company again and review the NEW proposal/)
    expect(h.crmCalls).toEqual([])
    expect(h.creates).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('a MISSING fingerprint key fails closed before anything is read; JWT_SECRET is never a substitute', async () => {
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = ''
    await expect(approveOptOut(input)).rejects.toThrow(/fingerprint key \(WARM_LEADS_OPT_OUT_FINGERPRINT_KEY\) is not configured/)
    expect(h.crmCalls).toEqual([])
    expect(h.creates).toEqual([])
  })

  it('an email the CRM returns for ANOTHER company is not used', async () => {
    h.activities = [toActivity(raw({ companyId: 'c9' }), true)]
    await expect(approveOptOut(input)).rejects.toThrow(/different company than the one submitted/)
    expect(h.creates).toEqual([])
  })

  it('WITHOUT the administrator\'s confirmation of an independent check nothing happens: no read of the CRM, no write', async () => {
    await expect(approveOptOut({ ...input, independentlyVerified: false })).rejects.toThrow(/verified independently/)
    await expect(approveOptOut({ ...input, independentlyVerified: undefined as never })).rejects.toThrow(/verified independently/)
    expect(h.crmCalls).toEqual([])
    expect(h.creates).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('ATOMIC: if the audit entry cannot be written the suppression row is rolled back too, and the administrator is told it failed', async () => {
    h.failAudit = true
    await expect(approveOptOut(input)).rejects.toThrow(/could not be recorded/)
    expect(h.creates).toEqual([])
    expect(h.audits).toEqual([])
    // try again once the audit works: exactly one row, once
    h.failAudit = false
    expect((await approveOptOut(input)).status).toBe('recorded')
    expect(h.creates).toHaveLength(1)
    expect(h.audits).toHaveLength(1)
  })

  it('the audit entry records the company\'s classification at the time (a customer / opportunity is visible afterwards)', async () => {
    h.classifications.set('c1', 'existing_customer')
    await approveOptOut(input)
    expect(h.audits[0]!.metadata).toMatchObject({ companyClassification: 'existing_customer' })
  })

  it('the approver must be known', async () => {
    await expect(approveOptOut({ ...input, approverCrmUserId: '' })).rejects.toThrow(/Who approves/)
    expect(h.creates).toEqual([])
  })

  it('a company that is not in THIS tenant\'s list is refused before anything is read - an activity id from elsewhere does not work', async () => {
    await expect(approveOptOut({ ...input, tenantId: 'tenant-B' })).rejects.toThrow(/not in your Warm Leads list/)
    expect(h.crmCalls).toEqual([])
    expect(h.creates).toEqual([])
  })

  it('the stored proposals are read for the CALLER\'S tenant only', async () => {
    await approveOptOut(input)
    expect(h.rawArgs[0]).toContain('tenant-A')
  })

  it('only a STORED PROPOSAL can be approved: an unknown activity, another company\'s activity, or a line that is not a proposal is refused', async () => {
    await expect(approveOptOut({ ...input, activityId: 'act_999' })).rejects.toThrow(/no opt-out proposal/)
    h.companies.add('tenant-A|c2')
    await expect(approveOptOut({ ...input, crmCompanyId: 'c2' })).rejects.toThrow(/no opt-out proposal/)
    // a held-for-a-person line (not recorded automatically) is not a proposal
    storedProposal({ body: 'Please unsubscribe me, but send the catalogue first.' })
    await expect(approveOptOut(input)).rejects.toThrow(/no opt-out proposal/)
    expect(h.creates).toEqual([])
    expect(h.crmCalls).toEqual([])
  })

  it('SUCCESS: the address is worked out from the source email (read only) and ONE row is written, naming the approver, in the caller\'s tenant', async () => {
    const r = await approveOptOut(input)
    expect(r).toMatchObject({ status: 'recorded', masked: 'r***@acme.example', activityId: 'act_1' })
    expect(h.crmCalls).toEqual([{ companyId: 'c1', type: 'email', withBody: true }])
    expect(h.creates).toHaveLength(1)
    const c = h.creates[0]!
    expect(c).toMatchObject({ tenantId: 'tenant-A', scope: 'global', matchType: 'email', matchValue: 'ravi@acme.example', source: 'unsubscribe', createdByCrmUserId: 'user-7' })
    expect(c).not.toHaveProperty('expiresAt')
    expect(c.reason).toMatch(/^Opt-out request in an email reply on \d{4}-\d{2}-\d{2} \(NXT activity act_1\); approved by a person who verified it through a trusted contact channel \(phone_call_known_number\) \(read by Warm Leads\)$/)
  })

  it('it is audited with the masked address and the activity id - never the address', async () => {
    await approveOptOut(input)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]).toMatchObject({ tenantId: 'tenant-A', actorType: 'user', actorCrmUserId: 'user-7', action: 'warmleads.opt_out_approved', resourceType: 'WarmLeadOptOut', resourceId: 'c1|act_1' })
    expect(JSON.stringify(h.audits)).not.toContain('ravi@acme.example')
    expect(h.audits[0]!.summary).toMatch(/r\*\*\*@acme\.example/)
    expect(h.audits[0]!.summary).toMatch(/SENDER NOT AUTHENTICATED/)
    expect(h.audits[0]!.summary).toMatch(/verified independently through a trusted contact channel/)
    expect(h.audits[0]!.metadata).toMatchObject({ independentlyVerifiedConfirmed: true, senderAuthentication: 'not available', phrase: 'UNSUBSCRIBE' })
  })

  it('approving twice is idempotent: the second time the address is "already on the list" and nothing is written again', async () => {
    await approveOptOut(input)
    h.existing.set('ravi@acme.example', { expiresAt: null })
    const again = await approveOptOut(input)
    expect(again.status).toBe('already_listed')
    expect(h.creates).toHaveLength(1)
  })

  it('an existing entry that has EXPIRED is not revived and is not reported as a success - a person renews it', async () => {
    h.existing.set('ravi@acme.example', { expiresAt: new Date(Date.now() - 86_400_000) })
    await expect(approveOptOut(input)).rejects.toThrow(/expired/)
    expect(h.creates).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('a database error is reported as a failure, not as success: nothing is written, nothing is audited', async () => {
    h.failWrites = true
    await expect(approveOptOut(input)).rejects.toThrow(/could not be recorded/)
    expect(h.creates).toEqual([])
    expect(h.audits).toEqual([])
  })
})

describe('a FORGED or changed email cannot be approved', () => {
  it('the source email can no longer be read -> refused', async () => {
    h.activities = []
    await expect(approveOptOut(input)).rejects.toThrow(/can no longer be read/)
    expect(h.creates).toEqual([])
  })

  it('the email in the CRM is no longer a strict standalone opt-out -> refused', async () => {
    crmHas({ body: 'Please stop sending me marketing emails, but I do need a quote for 500 crates.' })
    await expect(approveOptOut(input)).rejects.toThrow(/no longer a plain standalone opt-out/)
    expect(h.creates).toEqual([])
  })

  it('the sender is now a different address than the one the reviewer saw (masked) -> refused', async () => {
    crmHas({ fromEmail: 'Someone Else <sam@acme.example>' })
    await expect(approveOptOut(input)).rejects.toThrow(/not the address that was proposed/)
    expect(h.creates).toEqual([])
  })

  it('the email is outside the 90-day window (no sender data is given for it) -> refused; the address can be added by hand', async () => {
    crmHas({ createdAt: dayAgo(120) })
    await expect(approveOptOut(input)).rejects.toThrow(/no longer a plain standalone opt-out/)
    expect(h.creates).toEqual([])
  })

  it('the sender became ambiguous, one of ours, a colleague, a plus-alias or a robot -> refused', async () => {
    for (const from of ['A <a@x.example>, B <b@x.example>', 'Sales <sales@ours.example>', 'Bob <bob@ours.example>', 'Ravi <ravi+news@acme.example>', 'no-reply@acme.example', "d'souza@acme.example"]) {
      crmHas({ fromEmail: from })
      await expect(approveOptOut(input), from).rejects.toThrow(/no longer a plain standalone opt-out/)
    }
    expect(h.creates).toEqual([])
  })

  it('claims inside the message about its own authenticity change nothing: the proposal still needs the person, and the address is still the From address', async () => {
    crmHas({ body: 'UNSUBSCRIBE', authenticationResults: 'spf=pass dkim=pass dmarc=pass', senderVerified: true, spf: 'pass' })
    const r = await approveOptOut(input)
    expect(r.status).toBe('recorded')
    expect(h.creates[0]!.matchValue).toBe('ravi@acme.example')
  })
})

// ── 1. the activity must be tied to EXACTLY the submitted company, in THIS tenant (fail closed) ───────────────────────────────────────────────
describe('company and tenant binding: null, mismatched and cross-tenant ids are refused', () => {
  const nothingChanged = () => {
    expect(h.creates).toEqual([])
    expect(h.audits).toEqual([])
  }

  it('an email that NXT Sales links to NO company (null, empty or missing) is refused - nothing is written or audited', async () => {
    for (const companyId of [null, '', undefined]) {
      h.activities = [toActivity(raw({ companyId }), true)]
      await expect(approveOptOut(input), String(companyId)).rejects.toThrow(/does not link that email to any company/)
    }
    nothingChanged()
  })

  it('an email linked to ANOTHER company is refused even though its activity id is the proposed one', async () => {
    h.activities = [toActivity(raw({ companyId: 'c9' }), true)]
    await expect(approveOptOut(input)).rejects.toThrow(/different company than the one submitted/)
    nothingChanged()
  })

  it('the match is EXACT: a case or whitespace variant of the company id is a different company', async () => {
    for (const companyId of ['C1', 'c1 ', ' c1', 'c1\n']) {
      h.activities = [{ ...toActivity(raw(), true), companyId }] // set AFTER the mapper (which trims what NXT Sales sends), so the comparison itself is what is tested
      await expect(approveOptOut(input), JSON.stringify(companyId)).rejects.toThrow(/different company than the one submitted/)
    }
    nothingChanged()
  })

  it('the CRM is asked for the SUBMITTED company\'s emails only', async () => {
    h.activities = [toActivity(raw({ companyId: 'c9' }), true)]
    await expect(approveOptOut(input)).rejects.toThrow()
    expect(h.crmCalls).toEqual([{ companyId: 'c1', type: 'email', withBody: true }])
    nothingChanged()
  })

  it('an email with no company is not even PROPOSED: it is listed for a person, with the reason (and an approval of it would be refused anyway)', () => {
    const a = toActivity(raw({ companyId: null }), true)
    const decision = proposeOptOuts(summariseInbound([a], NOW, undefined, true).assessed, false)
    expect(decision.proposals).toEqual([])
    expect(decision.refused).toHaveLength(1)
    expect(decision.refused[0]!.reason).toMatch(/does not link this email to any company/)
    expect(JSON.stringify(decision)).not.toContain('ravi@acme.example')
  })

  it('CROSS-TENANT: tenant B has the same company id on ITS list but no proposal of its own - tenant A\'s proposal and activity cannot be approved or revealed', async () => {
    h.companies.add('tenant-B|c1')
    h.rawArgs.length = 0
    await expect(approveOptOut({ ...input, tenantId: 'tenant-B' })).rejects.toThrow(/no opt-out proposal/)
    await expect(revealOptOutAddress({ ...revealInput, tenantId: 'tenant-B' })).rejects.toThrow(/no opt-out proposal/)
    expect(h.rawArgs.every((v) => v.includes('tenant-B') && !v.includes('tenant-A'))).toBe(true) // the proposals were looked up for tenant B only
    expect(h.crmCalls).toEqual([]) // nothing was read from NXT Sales
    nothingChanged()
  })

  it('CROSS-TENANT: a company that is not on the caller\'s list is refused before any proposal or email is read', async () => {
    await expect(approveOptOut({ ...input, tenantId: 'tenant-C' })).rejects.toThrow(/not in your Warm Leads list/)
    await expect(revealOptOutAddress({ ...revealInput, tenantId: 'tenant-C' })).rejects.toThrow(/not in your Warm Leads list/)
    expect(h.rawArgs).toEqual([])
    expect(h.crmCalls).toEqual([])
    nothingChanged()
  })
})

// ── 2. how it was verified, by whom and when ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the administrator states HOW the request was verified; who, when and how are audited', () => {
  it('a missing, unknown or free-text method is refused before anything is read', async () => {
    for (const verificationMethod of [undefined, '', 'I rang them up', 'PHONE_CALL_KNOWN_NUMBER', 'read the email', { method: 'phone_call_known_number' }]) {
      await expect(approveOptOut({ ...input, verificationMethod: verificationMethod as never }), String(verificationMethod)).rejects.toThrow(/Say how the request was verified/)
    }
    expect(h.crmCalls).toEqual([])
    expect(h.creates).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('every allowed method is accepted and recorded exactly as chosen', async () => {
    expect([...VERIFICATION_METHODS]).toEqual(['phone_call_known_number', 'email_to_address_on_file', 'account_owner_confirmed', 'meeting_or_video_call', 'other_trusted_channel'])
    for (const verificationMethod of VERIFICATION_METHODS) {
      h.audits.length = 0
      expect((await approveOptOut({ ...input, verificationMethod })).status).toBe('recorded')
      expect(h.audits).toHaveLength(1)
      expect(h.audits[0]!.metadata).toMatchObject({ verification: { method: verificationMethod } })
      expect(h.audits[0]!.summary).toContain(`method: ${verificationMethod}`)
    }
  })

  it('the audit entry has the authenticated admin\'s id, the approval time and the structured method - and no message text, subject or address', async () => {
    const before = Date.now()
    await approveOptOut({ ...input, verificationMethod: 'email_to_address_on_file' })
    const [entry] = h.audits as Array<{ actorType: string; actorCrmUserId: string; action: string; dataClass: string; summary: string; metadata: Record<string, any> }>
    expect(entry).toMatchObject({ actorType: 'user', actorCrmUserId: 'user-7', action: 'warmleads.opt_out_approved', dataClass: 'customer_pii' })
    expect(entry!.metadata).toMatchObject({
      approvedByCrmUserId: 'user-7',
      verification: { method: 'email_to_address_on_file', independentlyVerifiedConfirmed: true, attestedByCrmUserId: 'user-7' },
      independentlyVerifiedConfirmed: true,
      senderAuthentication: 'not available',
      crmCompanyId: 'c1',
      activityId: 'act_1',
      phrase: 'UNSUBSCRIBE',
    })
    const at = Date.parse(entry!.metadata.approvedAt as string)
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
    expect(entry!.summary).toMatch(/SENDER NOT AUTHENTICATED/)
    const text = JSON.stringify(h.audits)
    expect(text).not.toContain('ravi@acme.example')
    expect(text).not.toContain('ravi')
    expect(text).not.toContain('Re: hi') // the subject of the customer's email
    // the suppression row names the method too (and still no subject)
    expect(h.creates[0]!.reason).toContain('(email_to_address_on_file)')
    expect(String(h.creates[0]!.reason)).not.toContain('Re: hi')
  })

  it('nothing is LOGGED with the address', async () => {
    await approveOptOut(input)
    const text = JSON.stringify(h.logs)
    expect(text).not.toContain('ravi@acme.example')
    expect(text).toContain('r***@acme.example') // the masked form is what is logged
  })
})

// ── 3. the exact address, for one admin and one proposal ────────────────────────────────────────────────────────────────────────────────────
describe('revealing the exact sender address of ONE proposal to an administrator', () => {
  it('shows the address from the email as freshly re-read from NXT Sales, says plainly that it is not authenticated, and writes nothing to the suppression list', async () => {
    const r = await revealOptOutAddress(revealInput)
    expect(r).toMatchObject({ address: 'ravi@acme.example', masked: 'r***@acme.example', crmCompanyId: 'c1', activityId: 'act_1', phrase: 'UNSUBSCRIBE', authenticated: false })
    expect(r.notice).toMatch(/can forge/)
    expect(r.notice).toMatch(/NOT verification/)
    expect(r.notice).toMatch(/not by replying to this email/)
    expect(h.crmCalls).toEqual([{ companyId: 'c1', type: 'email', withBody: true }]) // a fresh read, READ ONLY
    expect(h.creates).toEqual([])
    // only what the administrator needs: no message text, no subject, no other address
    expect(Object.keys(r).sort()).toEqual(['activityId', 'address', 'authenticated', 'companyClassification', 'companyName', 'crmCompanyId', 'masked', 'notice', 'phrase', 'receivedOn'])
    expect(JSON.stringify(r)).not.toContain('Re: hi')
    expect(JSON.stringify(r)).not.toContain('sales@ours.example')
    expect(JSON.stringify(r)).not.toContain('rep@ours.example')
  })

  it('it reads the email AGAIN every time: a sender changed since the proposal is not revealed as if it were the proposed one', async () => {
    await revealOptOutAddress(revealInput)
    crmHas({ fromEmail: 'Rex <rex@acme.example>' }) // same mask, different address
    await expect(revealOptOutAddress(revealInput)).rejects.toThrow(/not the address that was proposed/)
    expect(h.crmCalls).toHaveLength(2)
  })

  it('the VIEW is audited - who, when, which proposal - and the audit text never contains the address', async () => {
    const before = Date.now()
    await revealOptOutAddress(revealInput)
    expect(h.audits).toHaveLength(1)
    const e = h.audits[0]! as { action: string; actorType: string; actorCrmUserId: string; dataClass: string; resourceType: string; resourceId: string; summary: string; metadata: Record<string, any> }
    expect(e).toMatchObject({ tenantId: 'tenant-A', action: 'warmleads.opt_out_address_revealed', actorType: 'user', actorCrmUserId: 'user-7', dataClass: 'customer_pii', resourceType: 'WarmLeadOptOut', resourceId: 'c1|act_1' })
    expect(Date.parse(e.metadata.revealedAt)).toBeGreaterThanOrEqual(before)
    expect(e.summary).toContain('r***@acme.example')
    expect(JSON.stringify(h.audits)).not.toContain('ravi')
    expect(JSON.stringify(h.audits)).not.toContain('Re: hi')
  })

  it('nothing is logged with the address, and the stored proposal (the evaluation\'s reasons) never held it', async () => {
    await revealOptOutAddress(revealInput)
    expect(JSON.stringify(h.logs)).not.toContain('ravi@acme.example')
    expect(JSON.stringify(h.rows)).not.toContain('ravi@acme.example')
  })

  it('FAILS CLOSED: if the view cannot be recorded in the audit log, the address is not returned', async () => {
    h.failAudit = true
    await expect(revealOptOutAddress(revealInput)).rejects.toThrow(/not shown because this view could not be recorded/)
    expect(h.audits).toEqual([])
    h.failAudit = false
    expect((await revealOptOutAddress(revealInput)).address).toBe('ravi@acme.example')
  })

  it('needs the same conditions as an approval: switch on, a known admin, the key, an unchanged key - and reads nothing otherwise', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = false
    await expect(revealOptOutAddress(revealInput)).rejects.toThrow(/switched off/)
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    await expect(revealOptOutAddress({ ...revealInput, adminCrmUserId: '' })).rejects.toThrow(/Who approves/)
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = ''
    await expect(revealOptOutAddress(revealInput)).rejects.toThrow(/fingerprint key \(WARM_LEADS_OPT_OUT_FINGERPRINT_KEY\) is not configured/)
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'a-second-dedicated-key-0123456789abcdef-NOT-A-SECRET'
    await expect(revealOptOutAddress(revealInput)).rejects.toThrow(/fingerprint key has changed/)
    expect(h.crmCalls).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('refuses what an approval refuses: no stored proposal, no company link, another company, an unreadable or a changed message', async () => {
    await expect(revealOptOutAddress({ ...revealInput, activityId: 'act_999' })).rejects.toThrow(/no opt-out proposal/)
    h.activities = [toActivity(raw({ companyId: null }), true)]
    await expect(revealOptOutAddress(revealInput)).rejects.toThrow(/does not link that email to any company/)
    h.activities = [toActivity(raw({ companyId: 'c9' }), true)]
    await expect(revealOptOutAddress(revealInput)).rejects.toThrow(/different company than the one submitted/)
    h.activities = []
    await expect(revealOptOutAddress(revealInput)).rejects.toThrow(/can no longer be read/)
    crmHas({ body: 'Please stop sending me marketing emails, but I do need a quote for 500 crates.' })
    await expect(revealOptOutAddress(revealInput)).rejects.toThrow(/no longer a plain standalone opt-out/)
    expect(h.audits).toEqual([]) // nothing was shown, so nothing was recorded as shown
  })
})
