import { afterEach, describe, expect, it, vi } from 'vitest'
import { HunterProvider } from '../../src/emailverification/providers/hunterProvider.js'
import { VerifaliaProvider } from '../../src/emailverification/providers/verifaliaProvider.js'
import {
  inspectSyntax,
  isPersonalAddress,
  isRoleAccount,
  runVerificationProvider,
} from '../../src/emailverification/providers/provider.js'
import { getVerificationPolicy, isStale } from '../../src/emailverification/policy.js'
import { assertOutreachReady, verifyEmail, verificationProviderNames } from '../../src/emailverification/service.js'
import type { VerificationRecord } from '../../src/emailverification/types.js'

// Team Answer, Section 4 — the email verification layer.
//
// The rule under test throughout: "Do NOT guess email addresses. An address
// must be verified before the system treats it as outreach-ready."
//
// Neither provider has a credential in this environment, so the adapters are
// exercised against captured response shapes. That validates the mapping —
// which is the part that can be wrong — without pretending a call was made.

afterEach(() => vi.unstubAllGlobals())

// ── 1. NOTHING IS READY WITHOUT VERIFICATION ───────────────────────────────

describe('the outreach-ready gate', () => {
  it('refuses an address that has never been verified', () => {
    const g = assertOutreachReady(null)
    expect(g.ready).toBe(false)
    expect(g.needsVerification).toBe(true)
    expect(g.reason).toMatch(/never been verified/)
  })

  it('refuses when no provider is configured, and says so plainly', async () => {
    const record = await verifyEmail('jane.doe@acme-industrial.com')
    expect(record.result).toBe('unverified')
    expect(record.status).toBe('not_configured')
    expect(record.outreachReady).toBe(false)
    expect(record.reason).toMatch(/HUNTER_API_KEY or VERIFALIA/)
    // The crucial one: a missing provider must never read as a verdict.
    expect(record.result).not.toBe('deliverable')
  })

  it('permits only a deliverable address', () => {
    const base: VerificationRecord = {
      email: 'a@acme.com',
      result: 'deliverable',
      status: 'completed',
      riskReasons: [],
      provider: 'hunter',
      verifiedAt: new Date(),
      reason: 'ok',
      evidence: null,
      outreachReady: true,
    }
    expect(assertOutreachReady(base).ready).toBe(true)
    expect(assertOutreachReady({ ...base, result: 'risky' }).ready).toBe(false)
    expect(assertOutreachReady({ ...base, result: 'unknown' }).ready).toBe(false)
    expect(assertOutreachReady({ ...base, result: 'undeliverable' }).ready).toBe(false)
  })

  it('treats "unknown" as not-ready rather than as a soft yes', () => {
    const g = assertOutreachReady({
      email: 'a@acme.com', result: 'unknown', status: 'completed', riskReasons: [],
      provider: 'hunter', verifiedAt: new Date(), reason: '', evidence: null, outreachReady: false,
    })
    expect(g.ready).toBe(false)
    expect(g.needsVerification).toBe(false)
  })

  it('expires a verification once it is older than the revalidation window', () => {
    const policy = getVerificationPolicy()
    const old = new Date(Date.now() - (policy.revalidateAfterDays + 1) * 86_400_000)
    const g = assertOutreachReady({
      email: 'a@acme.com', result: 'deliverable', status: 'completed', riskReasons: [],
      provider: 'hunter', verifiedAt: old, reason: '', evidence: null, outreachReady: true,
    })
    expect(g.ready).toBe(false)
    expect(g.needsVerification).toBe(true)
    expect(g.reason).toMatch(/People change jobs/)
    expect(isStale(old, policy)).toBe(true)
    expect(isStale(new Date(), policy)).toBe(false)
  })
})

// ── 2. WHAT NEEDS NO PROVIDER ──────────────────────────────────────────────

describe('local checks', () => {
  it('rejects addresses that cannot be addresses', () => {
    for (const bad of ['', 'no-at-sign', 'a@', '@b.com', 'a b@c.com', 'a..b@c.com', 'a@c']) {
      expect(inspectSyntax(bad).valid, bad).toBe(false)
    }
  })

  it('accepts the awkward-but-real shapes', () => {
    for (const good of ["j.o'brien@acme.co.uk", 'jane+crm@acme-industrial.com', 'j_d@sub.acme.io']) {
      expect(inspectSyntax(good).valid, good).toBe(true)
    }
  })

  it('never calls syntax "verified"', () => {
    expect(inspectSyntax('a@b.com').reason).toMatch(/not deliverability/i)
  })

  it('refuses a personal address as policy, before any provider sees it', async () => {
    const r = await verifyEmail('jane.doe@gmail.com')
    expect(r.outreachReady).toBe(false)
    expect(r.provider).toBeNull()
    expect(r.reason).toMatch(/work addresses only/)
    expect(isPersonalAddress('x@yahoo.co.uk')).toBe(true)
    expect(isPersonalAddress('x@acme-industrial.com')).toBe(false)
  })

  it('flags role accounts', () => {
    expect(isRoleAccount('info@acme.com')).toBe(true)
    expect(isRoleAccount('sales@acme.com')).toBe(true)
    expect(isRoleAccount('jane.doe@acme.com')).toBe(false)
  })
})

// ── 3. THE ADAPTERS ────────────────────────────────────────────────────────

describe('Hunter adapter', () => {
  it('reports not_configured with an actionable reason', () => {
    const a = new HunterProvider().available()
    expect(a.status).toBe('not_configured')
    expect(a.reason).toMatch(/HUNTER_API_KEY/)
    expect(a.reason!.length).toBeGreaterThan(60)
  })

  it('maps every documented verdict, against captured response shapes', async () => {
    const cases: Array<[string, string]> = [
      ['valid', 'deliverable'],
      ['invalid', 'undeliverable'],
      ['accept_all', 'risky'],
      ['disposable', 'risky'],
      ['unknown', 'unknown'],
    ]
    for (const [verdict, expected] of cases) {
      vi.stubGlobal('fetch', async () =>
        new Response(JSON.stringify({ data: { status: verdict, score: 80, mx_records: true, regexp: true } }), {
          status: 200,
        }),
      )
      const p = new HunterProvider()
      vi.spyOn(p, 'available').mockReturnValue({ status: 'completed' })
      const out = await p.verify('jane@acme-industrial.com')
      expect(out.result, verdict).toBe(expected)
      expect(out.evidence?.providerVerdict).toBe(verdict)
      expect(out.evidence?.raw).toBeTruthy()
    }
  })

  it('turns a rejected credential into unverified, never into a verdict', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
    const p = new HunterProvider()
    vi.spyOn(p, 'available').mockReturnValue({ status: 'completed' })
    const out = await runVerificationProvider(p, 'jane@acme-industrial.com')
    expect(out.status).toBe('unauthorized')
    expect(out.result).toBe('unverified')
  })

  it('classifies a 429 as rate_limited so it is retried, not treated as invalid', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 429 }))
    const p = new HunterProvider()
    vi.spyOn(p, 'available').mockReturnValue({ status: 'completed' })
    const out = await runVerificationProvider(p, 'jane@acme-industrial.com')
    expect(out.status).toBe('rate_limited')
    expect(out.result).toBe('unverified')
  })
})

describe('Verifalia adapter', () => {
  it('reports not_configured with an actionable reason', () => {
    const a = new VerifaliaProvider().available()
    expect(a.status).toBe('not_configured')
    expect(a.reason).toMatch(/VERIFALIA_USERNAME/)
  })

  it('maps the classification, and keeps the status as evidence', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          entries: {
            data: [{ status: 'ServerIsCatchAll', classification: 'Risky', isRoleAccount: true, inputData: 'a@b.com' }],
          },
        }),
        { status: 200 },
      ),
    )
    const p = new VerifaliaProvider()
    vi.spyOn(p, 'available').mockReturnValue({ status: 'completed' })
    const out = await p.verify('info@acme-industrial.com')
    expect(out.result).toBe('risky')
    expect(out.riskReasons).toContain('catch_all')
    expect(out.riskReasons).toContain('role_account')
    expect(out.evidence?.raw).toMatchObject({ status: 'ServerIsCatchAll' })
  })

  it('does not invent a verdict when the job returns no entry', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ entries: { data: [] } }), { status: 200 }))
    const p = new VerifaliaProvider()
    vi.spyOn(p, 'available').mockReturnValue({ status: 'completed' })
    const out = await p.verify('jane@acme-industrial.com')
    expect(out.result).toBe('unknown')
    expect(out.reason).toMatch(/returned no entry/)
  })
})

// ── 4. POLICY ──────────────────────────────────────────────────────────────

describe('verification policy', () => {
  it('is versioned and marked provisional, because the business has not ruled on risky', () => {
    const p = getVerificationPolicy()
    expect(p.version).toBe('ev1-provisional')
    expect(p.status).toBe('provisional')
    expect(p.outreachReadyResults).toEqual(['deliverable'])
    expect(p.notes.join(' ')).toMatch(/does not state how a "risky" address should be treated/)
  })

  it('aligns revalidation with the confirmed 90-day re-enrichment cadence', () => {
    expect(getVerificationPolicy().revalidateAfterDays).toBe(90)
  })

  it('registers both named providers', () => {
    expect(verificationProviderNames().sort()).toEqual(['hunter', 'verifalia'])
  })
})
