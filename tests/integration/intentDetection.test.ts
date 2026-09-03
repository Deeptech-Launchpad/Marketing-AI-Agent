import { describe, expect, it } from 'vitest'

// STAGE 3 integration tests against the REAL restored NXT Sales development
// database. Read-only: no CRM writes, no outreach, no publishing.
//
// The Apify-backed provider is exercised only through its availability
// contract here — spending real credit belongs in the deliberate validation
// run, not in a suite that may be run repeatedly.

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
if (skipReason) console.warn(`\n[intent] SKIPPED — ${skipReason}\n`)

async function tenantId(): Promise<string> {
  const { prisma } = await import('../../src/platform/db.js')
  const t = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  return t.id
}

describeIfReady('Stage 3 — intent detection against real NXT Sales', () => {
  it('collects CRM signals for a real company with every signal carrying evidence', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { CrmSignalProvider } = await import('../../src/intent/providers/crmProvider.js')
    const { runProvider } = await import('../../src/intent/providers/provider.js')

    // A company WITH a deal, so there is something for the provider to find.
    const deals = await getCrm().exportDeals()
    const linked = deals.find((d) => d.companyId)
    expect(linked, 'expected at least one deal linked to a company').toBeTruthy()

    const company = await getCrm().getCompany(linked!.companyId!)
    expect(company).not.toBeNull()

    const r = await runProvider(new CrmSignalProvider(), {
      tenantId: await tenantId(),
      company: company!,
      maxResults: 10,
    })

    expect(r.ok).toBe(true)
    expect(r.signals.length).toBeGreaterThan(0)
    r.signals.forEach((s) => {
      expect(s.evidence.length).toBeGreaterThan(8)
      expect(s.interpretation.length).toBeGreaterThan(0)
      expect(s.sourceType).toBe('crm_record')
      // Interpretation must never assert a need.
      expect(s.interpretation.toLowerCase()).not.toMatch(/\bdefinitely needs\b|\bneeds our\b/)
    })
    // A company with an open deal must produce a NEGATIVE signal.
    expect(r.signals.some((s) => s.polarity === 'negative')).toBe(true)
  }, 120_000)

  it('reuses Stage 2 enrichment and refuses to invent technology signals', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { TechnologySignalProvider } = await import('../../src/intent/providers/technologyProvider.js')
    const { runProvider } = await import('../../src/intent/providers/provider.js')
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const enriched = await prisma.companyEnrichment.findFirst({
      where: { tenantId: tid, status: 'enriched' },
      orderBy: { createdAt: 'desc' },
    })

    if (!enriched) {
      // Stage 2 has not run here. The provider must SAY so, not return nothing.
      const page = await getCrm().searchCompanies({ limit: 1 })
      const r = await runProvider(new TechnologySignalProvider(), {
        tenantId: tid,
        company: page.items[0]!,
        maxResults: 10,
      })
      expect(r.ok).toBe(false)
      expect(r.reason).toMatch(/enrichment/i)
      return
    }

    const company = await getCrm().getCompany(enriched.crmCompanyId)
    if (!company) return

    const r = await runProvider(new TechnologySignalProvider(), {
      tenantId: tid,
      company,
      maxResults: 10,
    })

    expect(r.ok).toBe(true)
    // Every technology signal must trace back to stored Stage 2 evidence.
    r.signals
      .filter((s) => s.signalCategory === 'technology')
      .forEach((s) => {
        expect(s.evidence.length).toBeGreaterThan(8)
        expect(s.sourceType).toBe('company_website')
      })
    expect((r.metadata as Record<string, unknown>).note).toMatch(/NOT DETECTED/)
  }, 120_000)

  it('runs end to end, deduplicates events, and stores no composite score', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { queueIntentDetection, runIntentDetection } = await import(
      '../../src/intent/intentDetection.js'
    )
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const page = await getCrm().searchCompanies({ limit: 1 })
    const company = page.items[0]!

    const { id } = await queueIntentDetection({
      tenantId: tid,
      crmCompanyId: company.id,
      requestedByCrmUserId: 'test-user',
    })
    await runIntentDetection(id)

    const run = await prisma.intentDetectionRun.findUniqueOrThrow({
      where: { id },
      include: { signals: true },
    })

    expect(run.status).toBe('completed')
    expect(run.companyName).toBe(company.name)
    // Per-provider outcomes recorded, so "few signals" can be told apart from
    // "a provider was unavailable".
    const results = run.providerResults as Array<{ provider: string; ok: boolean }>
    expect(results.length).toBe(4)

    // No composite intent score exists anywhere on the run or its signals.
    expect(Object.keys(run)).not.toContain('intentScore')
    run.signals.forEach((s) => {
      expect(Object.keys(s)).not.toContain('score')
      expect(['high', 'medium', 'low']).toContain(s.confidence)
      expect(['fresh', 'aging', 'stale', 'unknown']).toContain(s.freshness)
      expect(['positive', 'negative', 'neutral']).toContain(s.polarity)
      expect(s.eventFingerprint.length).toBe(32)
    })

    // Fingerprints are unique within a run: duplicates were collapsed, not stored.
    const fps = run.signals.map((s) => s.eventFingerprint)
    expect(new Set(fps).size).toBe(fps.length)

    await prisma.intentDetectionRun.delete({ where: { id } })
  }, 240_000)

  it('stops retrying instead of looping against a paid provider', async () => {
    const { runIntentDetection } = await import('../../src/intent/intentDetection.js')
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { env } = await import('../../src/config/env.js')

    const tid = await tenantId()
    const id = newId()
    await prisma.intentDetectionRun.create({
      data: {
        id,
        tenantId: tid,
        crmCompanyId: 'does-not-exist',
        requestedByCrmUserId: 'test-user',
        status: 'queued',
        retryCount: env.INTENT_MAX_RETRIES,
      },
    })

    await runIntentDetection(id)

    const run = await prisma.intentDetectionRun.findUniqueOrThrow({ where: { id } })
    expect(run.status).toBe('failed')
    expect(run.failureReason).toMatch(/INTENT_MAX_RETRIES/)

    await prisma.intentDetectionRun.delete({ where: { id } })
  }, 60_000)

  it('records a company that vanished from the CRM as failed, not stuck', async () => {
    const { runIntentDetection } = await import('../../src/intent/intentDetection.js')
    const { prisma, newId } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const id = newId()
    await prisma.intentDetectionRun.create({
      data: {
        id,
        tenantId: tid,
        crmCompanyId: 'recycle-binned-or-missing',
        requestedByCrmUserId: 'test-user',
        status: 'queued',
      },
    })

    await runIntentDetection(id)

    const run = await prisma.intentDetectionRun.findUniqueOrThrow({ where: { id } })
    expect(run.status).toBe('failed')
    expect(run.failureReason).toMatch(/not found/i)

    await prisma.intentDetectionRun.delete({ where: { id } })
  }, 60_000)
})
