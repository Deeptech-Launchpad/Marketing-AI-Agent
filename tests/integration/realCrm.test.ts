import { describe, expect, it } from 'vitest'

// Runs against the REAL restored NXT Sales development database, through the
// live REST API. Skips with a printed reason when the CRM is not reachable,
// rather than passing hollowly.
//
// Everything here is read-only: CrmPort has no write methods in Phase 1.
//
//   Prereqs: NXT Sales running on NXT_SALES_BASE_URL against nxt_marketwiz_dev,
//            CRM_DRIVER=real, NXT_SALES_SERVICE_USER_ID set.

const BASE = process.env.NXT_SALES_BASE_URL ?? 'http://localhost:4000'

async function crmReachable(): Promise<string | null> {
  if (process.env.CRM_DRIVER !== 'real') return `CRM_DRIVER is "${process.env.CRM_DRIVER}", not "real"`
  if (!process.env.NXT_SALES_SERVICE_USER_ID) return 'NXT_SALES_SERVICE_USER_ID is not set'
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) })
    return res.ok ? null : `NXT Sales returned HTTP ${res.status}`
  } catch (err) {
    return `NXT Sales unreachable at ${BASE}: ${(err as Error).message}`
  }
}

const skipReason = await crmReachable()
const describeIfCrm = skipReason ? describe.skip : describe

if (skipReason) {
  // eslint-disable-next-line no-console
  console.warn(`\n[real-crm] SKIPPED — ${skipReason}\n`)
}

describeIfCrm('real NXT Sales data', () => {
  it('reports INSUFFICIENT ICP evidence against the real deal pipeline', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { deriveIcpEvidence, INSUFFICIENT_ICP_STATEMENT } = await import('../../src/campaign/icpDeriver.js')

    const ev = await deriveIcpEvidence(getCrm())

    // The real CRM holds 87 deals, 3 won and 14 lost, 26 unlinked. That cannot
    // support an ICP, and the agent must say so rather than inventing one.
    expect(ev.totalDeals).toBeGreaterThan(0)
    expect(ev.sufficiency.sufficient).toBe(false)
    expect(ev.sufficiency.statement).toBe(INSUFFICIENT_ICP_STATEMENT)
    expect(ev.sufficiency.survivingIndustryFacets).toBe(0)
    expect(ev.sufficiency.reasons.length).toBeGreaterThan(0)
  }, 60_000)

  it('exposes a real industry vocabulary to map concepts against', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const options = await getCrm().getDropdownOptions('company.industry')

    expect(options.length).toBeGreaterThan(5)
    // Values the concept mapper must be able to reach for "infrastructure".
    const values = options.map((o) => o.value)
    expect(values).toContain('Plumbing & PVF (Pipe, Valve, Fitting)')
    expect(values).toContain('Construction, Building Materials')
  }, 60_000)

  it('resolves a real audience from explicit industry targeting', async () => {
    const { getCrm } = await import('../../src/crm/index.js')

    const page = await getCrm().exportCompanies({
      industries: ['Construction, Building Materials', 'Plumbing & PVF (Pipe, Valve, Fitting)'],
      hasDeal: false,
    })

    // Real companies, real names — not fixtures.
    expect(page.items.length).toBeGreaterThan(100)
    expect(page.items.every((c) => c.name.length > 0)).toBe(true)
    expect(
      page.items.every((c) =>
        ['Construction, Building Materials', 'Plumbing & PVF (Pipe, Valve, Fitting)'].includes(c.industry ?? ''),
      ),
    ).toBe(true)
  }, 120_000)

  it('returns ZERO for an industry value the CRM does not hold', async () => {
    const { getCrm } = await import('../../src/crm/index.js')

    // An invented value must match nothing. If this ever returns rows, the
    // industries[] array encoding has silently stopped filtering.
    const page = await getCrm().exportCompanies({
      industries: ['Interplanetary Freight & Logistics'],
      hasDeal: false,
    })
    expect(page.items).toHaveLength(0)
  }, 60_000)

  it('proves the industries[] filter actually narrows, rather than being ignored', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const crm = getCrm()

    const all = await crm.searchCompanies({ limit: 1 })
    const filtered = await crm.searchCompanies({ industries: ['Safety & PPE'], limit: 1 })

    expect(all.total).toBeGreaterThan(1000)
    expect(filtered.total).toBeGreaterThan(0)
    // The silent-failure case: a comma-joined encoding returns the unfiltered
    // total and looks perfectly healthy.
    expect(filtered.total).toBeLessThan(all.total)
  }, 60_000)
})
