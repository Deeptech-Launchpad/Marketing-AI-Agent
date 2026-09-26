import { describe, expect, it } from 'vitest'

// STAGE 1 integration tests against the REAL restored NXT Sales development
// database, through the live REST API. Read-only throughout.
//
// Skips with a printed reason when the CRM or the marketing database is not
// reachable, rather than passing hollowly.

const BASE = process.env.NXT_SALES_BASE_URL ?? 'http://localhost:4000'

async function ready(): Promise<string | null> {
  if (process.env.CRM_DRIVER !== 'real') return `CRM_DRIVER is "${process.env.CRM_DRIVER}", not "real"`
  if (!process.env.NXT_SALES_SERVICE_USER_ID) return 'NXT_SALES_SERVICE_USER_ID is not set'
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return `NXT Sales returned HTTP ${res.status}`
  } catch (err) {
    return `NXT Sales unreachable at ${BASE}: ${(err as Error).message}`
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

if (skipReason) {
  // eslint-disable-next-line no-console
  console.warn(`\n[prospect-discovery] SKIPPED — ${skipReason}\n`)
}

describeIfReady('Stage 1 — prospect discovery against real NXT Sales', () => {
  let tenantId: string

  async function tenant(): Promise<string> {
    if (tenantId) return tenantId
    const { prisma } = await import('../../src/platform/db.js')
    const t = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
    tenantId = t.id
    return tenantId
  }

  it('resolves "infrastructure" to real CRM industry values and real companies', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { getLlm } = await import('../../src/llm/index.js')
    const { mapConceptToIndustries } = await import('../../src/campaign/conceptMapper.js')

    const crm = getCrm()
    const vocab = (await crm.getDropdownOptions('company.industry')).map((o) => o.value)

    const mapping = await mapConceptToIndustries({
      concept: 'infrastructure',
      vocabulary: vocab,
      llm: getLlm(),
      tenantId: await tenant(),
    })

    // Every applied value must be a real CRM value — never invented.
    expect(mapping.applied.length).toBeGreaterThan(0)
    mapping.applied.forEach((v) => expect(vocab).toContain(v))

    const page = await crm.exportCompanies({ industries: mapping.applied, hasDeal: false })
    expect(page.items.length).toBeGreaterThan(0)
    // Every returned company genuinely carries one of the applied industries.
    page.items.forEach((c) => expect(mapping.applied).toContain(c.industry ?? ''))
  }, 180_000)

  it('never returns a company outside the CRM (no invented prospects)', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const crm = getCrm()

    const page = await crm.exportCompanies({
      industries: ['Construction, Building Materials'],
      hasDeal: false,
    })

    // Cross-check a sample straight back against the CRM by id.
    for (const c of page.items.slice(0, 5)) {
      const fetched = await crm.getCompany(c.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.name).toBe(c.name)
    }
  }, 180_000)

  it('excludes recycle-binned records', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const crm = getCrm()

    // NXT Sales filters deletedAt server-side on every list route. 15,158 rows
    // exist; 22 are binned; a read must never see more than 15,136.
    const all = await crm.searchCompanies({ limit: 1 })
    expect(all.total).toBeLessThanOrEqual(15_136)
  }, 60_000)

  it('applies suppression and the audience cap, and reports both', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { resolveAudience } = await import('../../src/campaign/audienceResolver.js')
    const { prisma, newId } = await import('../../src/platform/db.js')

    const tid = await tenant()
    const segmentId = newId()
    await prisma.segment.create({
      data: {
        id: segmentId,
        tenantId: tid,
        name: 'test: cap + suppression',
        definition: {} as never,
      },
    })

    const resolved = await resolveAudience({
      tenantId: tid,
      segmentId,
      query: { industries: ['Construction, Building Materials'], hasDeal: false } as never,
      crm: getCrm(),
      limit: 25,
    })

    expect(resolved.capApplied).toBe(25)
    expect(resolved.totalIncluded).toBeLessThanOrEqual(25)
    expect(resolved.totalMatched).toBeGreaterThan(25)
    expect(resolved.truncated).toBe(true)

    // Every member carries a specific, defensible reason.
    const members = await prisma.audienceMember.findMany({ where: { snapshotId: resolved.snapshotId } })
    expect(members.length).toBe(resolved.totalIncluded)
    members.forEach((m) => {
      expect(m.includeReason).toMatch(/Selected because/)
      expect(m.includeReason).toContain('passed suppression')
      expect(m.crmCompanyId).toBeTruthy()
    })

    await prisma.segment.delete({ where: { id: segmentId } })
  }, 240_000)

  it('returns zero for a concept the CRM has no industry for', async () => {
    const { getCrm } = await import('../../src/crm/index.js')

    // An invented value must match nothing. If this ever returns rows the
    // industries[] encoding has silently stopped filtering.
    const page = await getCrm().exportCompanies({
      industries: ['Deep Sea Mining & Submersibles'],
      hasDeal: false,
    })
    expect(page.items).toHaveLength(0)
  }, 60_000)

  // ── How many companies a run is asked for ───────────────────────────────
  //
  // The count had one source: whatever the parser read out of the objective's
  // wording. "Find a cleaning supplier in Malta" reads as a request for ONE,
  // which is how a discovery run came to return a single company with no way
  // to say otherwise. The operator's number is now recorded on the search row
  // and wins over that reading — so it has to survive the round trip, and
  // absence has to stay distinguishable from a request for one.

  it('records the count the operator asked for on the search row', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { startProspectSearch } = await import('../../src/prospects/prospectDiscovery.js')
    const tid = await tenant()

    const { id } = await startProspectSearch({
      tenantId: tid,
      objective: 'test: cleaning suppliers in Malta',
      requestedCount: 25,
      requestedByCrmUserId: 'test-user',
    })
    const row = await prisma.prospectSearch.findUniqueOrThrow({ where: { id } })
    expect(row.requestedCount).toBe(25)

    await prisma.prospectSearch.delete({ where: { id } })
  }, 60_000)

  it('leaves the count null when none was stated, so the wording still decides', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { startProspectSearch } = await import('../../src/prospects/prospectDiscovery.js')
    const tid = await tenant()

    const { id } = await startProspectSearch({
      tenantId: tid,
      objective: 'test: no count stated',
      requestedByCrmUserId: 'test-user',
    })
    const row = await prisma.prospectSearch.findUniqueOrThrow({ where: { id } })
    // Null, not 1. A search that asked for nothing and a search that asked for
    // one company must not resolve to the same audience.
    expect(row.requestedCount).toBeNull()

    await prisma.prospectSearch.delete({ where: { id } })
  }, 60_000)

  it('returns the number asked for, not one, when the CRM holds more', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { resolveAudience } = await import('../../src/campaign/audienceResolver.js')
    const { prisma, newId } = await import('../../src/platform/db.js')

    const tid = await tenant()
    const segmentId = newId()
    await prisma.segment.create({
      data: { id: segmentId, tenantId: tid, name: 'test: shortlist of five', definition: {} as never },
    })

    const resolved = await resolveAudience({
      tenantId: tid,
      segmentId,
      query: { industries: ['Construction, Building Materials'], hasDeal: false } as never,
      crm: getCrm(),
      limit: 5,
    })

    expect(resolved.capApplied).toBe(5)
    expect(resolved.totalIncluded).toBe(5)

    await prisma.segment.delete({ where: { id: segmentId } })
  }, 240_000)
})
