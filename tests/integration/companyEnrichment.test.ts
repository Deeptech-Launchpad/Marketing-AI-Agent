import { describe, expect, it } from 'vitest'

// STAGE 2 integration tests. Real marketing database, real SSRF-guarded
// fetcher. The CRM-backed test additionally needs NXT Sales running.
//
// Nothing here writes to NXT Sales — enrichment is read-only against the CRM.

async function dbReady(): Promise<string | null> {
  try {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.$queryRaw`SELECT 1`
    return null
  } catch (err) {
    return `marketing database unavailable: ${(err as Error).message}`
  }
}

async function crmReady(): Promise<string | null> {
  if (process.env.CRM_DRIVER !== 'real') return `CRM_DRIVER is "${process.env.CRM_DRIVER}", not "real"`
  try {
    const res = await fetch(`${process.env.NXT_SALES_BASE_URL ?? 'http://localhost:4000'}/health`, {
      signal: AbortSignal.timeout(4000),
    })
    return res.ok ? null : `NXT Sales returned HTTP ${res.status}`
  } catch (err) {
    return `NXT Sales unreachable: ${(err as Error).message}`
  }
}

const dbSkip = await dbReady()
const crmSkip = dbSkip ?? (await crmReady())

const describeIfDb = dbSkip ? describe.skip : describe
const describeIfCrm = crmSkip ? describe.skip : describe

if (dbSkip) console.warn(`\n[enrichment] SKIPPED — ${dbSkip}\n`)
else if (crmSkip) console.warn(`\n[enrichment/crm] SKIPPED — ${crmSkip}\n`)

async function tenantId(): Promise<string> {
  const { prisma } = await import('../../src/platform/db.js')
  const t = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  return t.id
}

describeIfDb('Stage 2 — SSRF protection stays on', () => {
  it('refuses private, loopback and metadata addresses', async () => {
    const { fetchPage } = await import('../../src/research/pageFetch.js')
    const tid = await tenantId()

    // The addresses that matter: the host's own services, the private network,
    // and the cloud metadata endpoint.
    for (const target of [
      'http://127.0.0.1:5432',
      'http://localhost:4100',
      'http://10.0.0.1',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1',
      'http://[::1]:4100',
    ]) {
      const r = await fetchPage(target, { tenantId: tid, runId: null })
      expect(r.ok, `${target} must be refused`).toBe(false)
      expect(r.reason).toMatch(/not publicly reachable|could not be resolved|valid http/i)
    }
  }, 120_000)

  it('refuses non-http schemes rather than repairing them', async () => {
    const { fetchPage } = await import('../../src/research/pageFetch.js')
    const tid = await tenantId()
    for (const target of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com']) {
      const r = await fetchPage(target, { tenantId: tid, runId: null })
      expect(r.ok).toBe(false)
    }
  }, 60_000)
})

describeIfDb('Stage 2 — fetch failure handling', () => {
  it('records an unresolvable host as a result, not an exception', async () => {
    const { fetchPage } = await import('../../src/research/pageFetch.js')
    const tid = await tenantId()

    // A prospect with a dead domain is normal. It must degrade to a recorded
    // outcome so one bad site cannot fail a batch.
    const r = await fetchPage('https://this-domain-does-not-exist-9f2a7b.example', {
      tenantId: tid,
      runId: null,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  }, 60_000)
})

describeIfCrm('Stage 2 — real NXT Sales company enrichment', () => {
  it('enriches a real company and preserves evidence for every technology', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { queueCompanyEnrichment, runCompanyEnrichment } = await import(
      '../../src/enrichment/companyEnrichment.js'
    )
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const page = await getCrm().searchCompanies({ limit: 5 })
    const withDomain = page.items.find((c) => c.domain)
    expect(withDomain, 'expected at least one real company with a domain').toBeTruthy()

    const { id } = await queueCompanyEnrichment({
      tenantId: tid,
      crmCompanyId: withDomain!.id,
      requestedByCrmUserId: 'test-user',
    })
    await runCompanyEnrichment(id)

    const row = await prisma.companyEnrichment.findUniqueOrThrow({ where: { id } })

    // Any terminal status is acceptable — a real site may be down. What is NOT
    // acceptable is being stuck, or claiming a technology with no proof.
    expect(['enriched', 'unreachable', 'no_website']).toContain(row.status)
    expect(row.companyName).toBe(withDomain!.name)

    const techs = (row.technologies ?? []) as Array<{ name: string; category: string; evidence: string }>
    techs.forEach((t) => {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.evidence.length).toBeGreaterThan(0)
    })
    expect(row.technologyCount).toBe(techs.length)

    // Provenance must be present and must never claim an AI inference: this
    // stage calls no model.
    const prov = (row.provenance ?? []) as Array<{ label: string }>
    expect(prov.length).toBeGreaterThan(0)
    expect(prov.some((p) => p.label === 'ai_inference')).toBe(false)

    await prisma.companyEnrichment.delete({ where: { id } })
  }, 180_000)

  it('reports UNKNOWN, not null, for unverifiable fields', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { queueCompanyEnrichment, runCompanyEnrichment } = await import(
      '../../src/enrichment/companyEnrichment.js'
    )
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const page = await getCrm().exportCompanies({ limit: 200 })
    const noSite = page.items.find((c) => !c.domain && !c.endPdpUrl)

    if (!noSite) {
      // Not a failure — the sample simply had no such company.
      expect(page.items.length).toBeGreaterThan(0)
      return
    }

    const { id } = await queueCompanyEnrichment({
      tenantId: tid,
      crmCompanyId: noSite.id,
      requestedByCrmUserId: 'test-user',
    })
    await runCompanyEnrichment(id)

    const row = await prisma.companyEnrichment.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('no_website')
    const signals = row.signals as Record<string, unknown>
    expect(signals.websiteStatus).toBe('no_website')
    expect(signals.finalUrl).toBe('UNKNOWN')
    expect(row.technologyCount).toBe(0)

    await prisma.companyEnrichment.delete({ where: { id } })
  }, 180_000)

  it('re-running appends a new attempt instead of corrupting the previous one', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { queueCompanyEnrichment, runCompanyEnrichment } = await import(
      '../../src/enrichment/companyEnrichment.js'
    )
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const page = await getCrm().searchCompanies({ limit: 3 })
    const target = page.items.find((c) => c.domain) ?? page.items[0]!

    const first = await queueCompanyEnrichment({
      tenantId: tid,
      crmCompanyId: target.id,
      requestedByCrmUserId: 'test-user',
    })
    await runCompanyEnrichment(first.id)
    const before = await prisma.companyEnrichment.findUniqueOrThrow({ where: { id: first.id } })

    const second = await queueCompanyEnrichment({
      tenantId: tid,
      crmCompanyId: target.id,
      requestedByCrmUserId: 'test-user',
    })
    await runCompanyEnrichment(second.id)

    // The earlier attempt is untouched — its evidence survives verbatim.
    const after = await prisma.companyEnrichment.findUniqueOrThrow({ where: { id: first.id } })
    expect(after.status).toBe(before.status)
    expect(JSON.stringify(after.technologies)).toBe(JSON.stringify(before.technologies))
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())

    const all = await prisma.companyEnrichment.findMany({
      where: { tenantId: tid, crmCompanyId: target.id },
    })
    expect(all.length).toBeGreaterThanOrEqual(2)

    await prisma.companyEnrichment.deleteMany({ where: { id: { in: [first.id, second.id] } } })
  }, 240_000)
})
