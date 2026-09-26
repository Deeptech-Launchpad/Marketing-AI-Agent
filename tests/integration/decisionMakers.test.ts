import { describe, expect, it } from 'vitest'

// STAGE 4 integration tests against the REAL restored NXT Sales development
// database. Read-only: no CRM writes, no outreach, no publishing.
//
// The paid person-data providers have no credentials in this environment, so
// they are exercised through their availability contract only. Nothing here
// spends a credit.

async function ready(): Promise<string | null> {
  if (process.env.CRM_DRIVER !== 'real') return `CRM_DRIVER is "${process.env.CRM_DRIVER}", not "real"`
  try {
    const res = await fetch(`${process.env.NXT_SALES_BASE_URL ?? 'http://localhost:4000'}/health`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return `NXT Sales returned HTTP ${res.status}`
  } catch (err) {
    return `NXT Sales unreachable: ${(err as Error).message}`
  }
  try {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    return `marketing database unavailable: ${(err as Error).message}`
  }
  return null
}

const skipReason = await ready()
const describeIfReady = skipReason ? describe.skip : describe
if (skipReason) console.warn(`\n[decision-makers] SKIPPED — ${skipReason}\n`)

async function tenantId(): Promise<string> {
  const { prisma } = await import('../../src/platform/db.js')
  const t = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  return t.id
}

/** A real company that actually has contact persons recorded. */
async function companyWithContacts() {
  const { getCrm } = await import('../../src/crm/index.js')
  const page = await getCrm().searchCompanies({ limit: 200 })
  return page.items.find((c) => c.contactPersons.length > 0) ?? null
}

describeIfReady('Stage 4 — decision-maker discovery against real NXT Sales', () => {
  it('extracts candidates from real CRM contact records, with evidence on each', async () => {
    const { CrmContactProvider } = await import('../../src/decisionmakers/providers/crmContactProvider.js')
    const { runDmProvider } = await import('../../src/decisionmakers/providers/provider.js')

    const company = await companyWithContacts()
    expect(company, 'expected at least one company with contactPersons in the first 200').toBeTruthy()

    const r = await runDmProvider(new CrmContactProvider(), {
      tenantId: await tenantId(),
      company: company!,
      companyDomain: company!.domain,
      maxResults: 20,
    })

    expect(r.status).toBe('available')
    expect(r.candidates.length).toBeGreaterThan(0)
    r.candidates.forEach((c) => {
      expect(c.fullName.length).toBeGreaterThan(2)
      // Every claim carries the literal CRM row that produced it.
      expect(c.evidence[0]!.snippet).toMatch(/contactPersons entry/)
      expect(c.evidence[0]!.sourceType).toBe('crm_record')
      // An address reaches a candidate ONLY from a stored value that names
      // them. The rule is no longer "never carry an email" — that threw away
      // real per-person addresses NXT Sales already held — but "never carry
      // one this person's name does not appear in", which is what the local
      // part is checked against.
      if (c.email) {
        const local = c.email.split('@')[0]!.toLowerCase().replace(/[^a-z]/g, '')
        const surname = c.fullName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean).pop()!
        expect(local, `${c.email} must name ${c.fullName}`).toContain(surname)
        // And a shared mailbox is nobody's, however real it is.
        expect(local).not.toMatch(/^(info|sales|admin|accounts|enquiries|contact|office|support)$/)
      }
      // The company switchboard is still never attributed to a person.
      expect(c.phone).toBeNull()
    })
  }, 120_000)

  it('runs end to end and records a per-provider status for every source', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { queueDecisionMakerDiscovery, runDecisionMakerDiscovery, providerNames } = await import(
      '../../src/decisionmakers/discovery.js'
    )
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const company = (await companyWithContacts()) ?? (await getCrm().searchCompanies({ limit: 1 })).items[0]!

    const { id } = await queueDecisionMakerDiscovery({
      tenantId: tid,
      crmCompanyId: company.id,
      requestedByCrmUserId: 'test-user',
    })
    await runDecisionMakerDiscovery(id)

    const run = await prisma.decisionMakerRun.findUniqueOrThrow({
      where: { id },
      include: { candidates: true },
    })

    expect(run.status).toBe('completed')
    expect(run.companyName).toBe(company.name)

    // Every provider reports, including the ones that cannot run. This is what
    // makes an empty result readable rather than ambiguous.
    const results = run.providerResults as Array<{ provider: string; status: string; reason: string | null }>
    expect(results.map((r) => r.provider)).toEqual(providerNames())
    results.forEach((r) => {
      expect(['available', 'unavailable', 'unauthorized', 'rate_limited', 'no_results', 'error']).toContain(r.status)
      if (r.status !== 'available') expect(r.reason, `${r.provider} gave no reason`).toBeTruthy()
    })

    // The four paid providers must be blocked, not silently empty.
    const blocked = results.filter((r) => ['apollo', 'zoominfo', 'rocketreach', 'linkedin_reference'].includes(r.provider))
    expect(blocked.length).toBe(4)
    blocked.forEach((b) => expect(b.status).toBe('unauthorized'))

    // Nothing was spent.
    expect(Number(run.costUsd)).toBe(0)

    // A run with no shortlist must SAY why.
    if (run.candidateCount === 0) {
      expect(run.noResultsReason).toMatch(/No verified decision maker found/)
    }

    run.candidates.forEach((c) => {
      expect(['verified', 'probable', 'unverified', 'rejected']).toContain(c.companyMatch)
      expect(['high', 'medium', 'low']).toContain(c.confidence)
      expect(['contactable', 'withheld_by_policy', 'profile_only', 'none']).toContain(c.contactability)
      expect(['shortlisted', 'excluded']).toContain(c.outcome)
      // A stored address that names the candidate may be carried; anything
      // that does not name them, and the company phone number, may not.
      if (c.email) {
        const local = c.email.split('@')[0]!.toLowerCase().replace(/[^a-z]/g, '')
        const surname = c.fullName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean).pop()!
        expect(local, `${c.email} must name ${c.fullName}`).toContain(surname)
      }
      expect(c.phone).toBeNull()
      // A shortlisted candidate always has a matched role and a rank.
      if (c.outcome === 'shortlisted') {
        expect(c.rolePriority).not.toBeNull()
        expect(c.rank).not.toBeNull()
        expect((c.rankReasons as string[]).length).toBeGreaterThan(0)
      } else {
        expect(c.exclusionReason).toBeTruthy()
      }
    })

    await prisma.decisionMakerRun.delete({ where: { id } })
  }, 240_000)

  it('never shortlists more than the configured cap', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { env } = await import('../../src/config/env.js')
    const { getCrm } = await import('../../src/crm/index.js')
    const { queueDecisionMakerDiscovery, runDecisionMakerDiscovery } = await import(
      '../../src/decisionmakers/discovery.js'
    )

    const tid = await tenantId()
    // A company with many recorded contacts, so the cap is actually exercised.
    const page = await getCrm().searchCompanies({ limit: 200 })
    const busiest = page.items.sort((a, b) => b.contactPersons.length - a.contactPersons.length)[0]!

    const { id } = await queueDecisionMakerDiscovery({
      tenantId: tid,
      crmCompanyId: busiest.id,
      requestedByCrmUserId: 'test-user',
    })
    await runDecisionMakerDiscovery(id)

    const run = await prisma.decisionMakerRun.findUniqueOrThrow({ where: { id } })
    expect(run.candidateCount).toBeLessThanOrEqual(env.DM_MAX_CANDIDATES)

    await prisma.decisionMakerRun.delete({ where: { id } })
  }, 240_000)

  it('records a company that vanished from the CRM as failed, not stuck', async () => {
    const { runDecisionMakerDiscovery } = await import('../../src/decisionmakers/discovery.js')
    const { prisma, newId } = await import('../../src/platform/db.js')

    const id = newId()
    await prisma.decisionMakerRun.create({
      data: {
        id,
        tenantId: await tenantId(),
        crmCompanyId: 'recycle-binned-or-missing',
        requestedByCrmUserId: 'test-user',
        status: 'queued',
      },
    })

    await runDecisionMakerDiscovery(id)

    const run = await prisma.decisionMakerRun.findUniqueOrThrow({ where: { id } })
    expect(run.status).toBe('failed')
    expect(run.failureReason).toMatch(/not found/i)

    await prisma.decisionMakerRun.delete({ where: { id } })
  }, 60_000)

  it('stops retrying rather than looping', async () => {
    const { runDecisionMakerDiscovery } = await import('../../src/decisionmakers/discovery.js')
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { env } = await import('../../src/config/env.js')

    const id = newId()
    await prisma.decisionMakerRun.create({
      data: {
        id,
        tenantId: await tenantId(),
        crmCompanyId: 'does-not-exist',
        requestedByCrmUserId: 'test-user',
        status: 'queued',
        retryCount: env.DM_MAX_RETRIES,
      },
    })

    await runDecisionMakerDiscovery(id)

    const run = await prisma.decisionMakerRun.findUniqueOrThrow({ where: { id } })
    expect(run.status).toBe('failed')
    expect(run.failureReason).toMatch(/DM_MAX_RETRIES/)

    await prisma.decisionMakerRun.delete({ where: { id } })
  }, 60_000)
})
