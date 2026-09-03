import { afterAll, describe, expect, it } from 'vitest'

// STAGE 5 integration tests against the REAL restored NXT Sales development
// database and real prospect websites. Read-only: no CRM writes, no outreach,
// no publishing.

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
if (skipReason) console.warn(`\n[website-audit] SKIPPED — ${skipReason}\n`)

async function tenantId(): Promise<string> {
  const { prisma } = await import('../../src/platform/db.js')
  const t = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  return t.id
}

describeIfReady('Stage 5 — website audit against real NXT Sales', () => {
  it('resolves a start URL from Stage 2 enrichment in preference to the raw CRM field', async () => {
    const { resolveStartUrl } = await import('../../src/websiteaudit/audit.js')
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()

    // A dedicated enrichment row rather than "whichever is newest": the Stage 2
    // integration file runs in parallel and deletes the rows it creates, so
    // reading a shared row and asserting on it afterwards is a race.
    const { newId } = await import('../../src/platform/db.js')
    const probeCompanyId = `resolve-probe-${newId()}`
    await prisma.companyEnrichment.create({
      data: {
        id: newId(),
        tenantId: tid,
        crmCompanyId: probeCompanyId,
        requestedByCrmUserId: 'test-user',
        status: 'enriched',
        sourceUrl: 'https://enrichment-wins.example/',
      },
    })

    try {
      const r = await resolveStartUrl(tid, probeCompanyId, 'ignored-crm-value.example')
      expect(r.url).toBe('https://enrichment-wins.example/')
      expect(r.source).toMatch(/Stage 2 enrichment/)
    } finally {
      await prisma.companyEnrichment.deleteMany({ where: { crmCompanyId: probeCompanyId } })
    }

    // A company with no website anywhere yields null — never a guessed domain.
    const none = await resolveStartUrl(tid, 'no-such-company', null)
    expect(none.url).toBeNull()
    expect(none.source).toMatch(/no website on record/)
  }, 60_000)

  it('audits a real prospect website and stores evidence for every observation', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { queueWebsiteAudit, runWebsiteAudit } = await import('../../src/websiteaudit/audit.js')
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const page = await getCrm().searchCompanies({ limit: 60 })
    const withSite = page.items.find((c) => c.domain && /^https?:\/\/|\./.test(c.domain))
    expect(withSite, 'expected a company with a website in the first 60').toBeTruthy()

    const { id } = await queueWebsiteAudit({
      tenantId: tid,
      crmCompanyId: withSite!.id,
      requestedByCrmUserId: 'test-user',
    })
    await runWebsiteAudit(id)

    const run = await prisma.websiteAuditRun.findUniqueOrThrow({
      where: { id },
      include: { pages: { include: { observations: true } } },
    })

    expect(['completed', 'partial', 'failed']).toContain(run.status)
    expect(run.companyName).toBe(withSite!.name)

    for (const p of run.pages) {
      expect([
        'fetched',
        'http_error',
        'unreachable',
        'timeout',
        'blocked',
        'non_html',
        'too_large',
        'duplicate',
        'soft_404',
      ]).toContain(p.outcome)
      // A page that failed must say why; a page that succeeded must not
      // pretend to a status it never got.
      if (p.outcome !== 'fetched') expect(p.failureReason ?? (p.typeSignals as string[])?.length).toBeTruthy()

      for (const o of p.observations) {
        expect(['observed', 'not_observed', 'could_not_determine']).toContain(o.status)
        if (o.status === 'observed') {
          // Every observed value carries its evidence.
          expect(o.value).toBeTruthy()
          expect(o.method).toBeTruthy()
          expect(o.sourcePath).toBeTruthy()
          expect(o.fragment).toBeTruthy()
        } else {
          expect(o.value).toBeNull()
        }
      }
    }

    await prisma.websiteAuditRun.delete({ where: { id } })
  }, 300_000)

  it('records a company with no website as a finding, not a failure', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { queueWebsiteAudit, runWebsiteAudit } = await import('../../src/websiteaudit/audit.js')
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const page = await getCrm().searchCompanies({ limit: 200 })
    const noSite = page.items.find((c) => !c.domain)
    if (!noSite) return

    const { id } = await queueWebsiteAudit({
      tenantId: tid,
      crmCompanyId: noSite.id,
      requestedByCrmUserId: 'test-user',
    })
    await runWebsiteAudit(id)

    const run = await prisma.websiteAuditRun.findUniqueOrThrow({ where: { id } })
    expect(run.status).toBe('completed')
    expect(run.failureReason).toMatch(/No website is recorded/)
    expect(run.pagesFetched).toBe(0)

    await prisma.websiteAuditRun.delete({ where: { id } })
  }, 120_000)

  it('records a company that vanished from the CRM as failed, not stuck', async () => {
    const { runWebsiteAudit } = await import('../../src/websiteaudit/audit.js')
    const { prisma, newId } = await import('../../src/platform/db.js')

    const id = newId()
    await prisma.websiteAuditRun.create({
      data: {
        id,
        tenantId: await tenantId(),
        crmCompanyId: 'recycle-binned-or-missing',
        requestedByCrmUserId: 'test-user',
        status: 'queued',
      },
    })
    await runWebsiteAudit(id)

    const run = await prisma.websiteAuditRun.findUniqueOrThrow({ where: { id } })
    expect(run.status).toBe('failed')
    expect(run.failureReason).toMatch(/not found/i)

    await prisma.websiteAuditRun.delete({ where: { id } })
  }, 60_000)

  it('stops retrying rather than looping', async () => {
    const { runWebsiteAudit } = await import('../../src/websiteaudit/audit.js')
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { env } = await import('../../src/config/env.js')

    const id = newId()
    await prisma.websiteAuditRun.create({
      data: {
        id,
        tenantId: await tenantId(),
        crmCompanyId: 'does-not-exist',
        requestedByCrmUserId: 'test-user',
        status: 'queued',
        retryCount: env.AUDIT_MAX_RETRIES,
      },
    })
    await runWebsiteAudit(id)

    const run = await prisma.websiteAuditRun.findUniqueOrThrow({ where: { id } })
    expect(run.status).toBe('failed')
    expect(run.failureReason).toMatch(/AUDIT_MAX_RETRIES/)

    await prisma.websiteAuditRun.delete({ where: { id } })
  }, 60_000)

  it('never exceeds the configured crawl limits against a real site', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { env } = await import('../../src/config/env.js')

    const runs = await prisma.websiteAuditRun.findMany({
      where: { tenantId: await tenantId() },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    runs.forEach((r) => {
      expect(r.pagesFetched).toBeLessThanOrEqual(env.AUDIT_MAX_PAGES_PER_COMPANY)
      expect(r.productPages).toBeLessThanOrEqual(env.AUDIT_MAX_PRODUCT_PAGES)
      expect(r.categoryPages).toBeLessThanOrEqual(env.AUDIT_MAX_CATEGORY_PAGES)
    })
  }, 60_000)
})

describeIfReady('Task #979 — findings, collateral and PDF from a real audit', () => {
  /**
   * Clones the richest real audit run into a disposable one.
   *
   * These tests exercise regeneration, which rewrites findings, the report and
   * its revisions. Doing that to a SHARED run raced the Task #980 and #981
   * files, which read the same row while this one was mid-rewrite — the suite
   * was green most of the time and occasionally not, which is worse than red.
   * Cloning keeps the tests on real prospect evidence and removes the last
   * mutation of shared state in the integration suite.
   */
  const clones: string[] = []

  async function bestRun() {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const tid = await tenantId()

    const source = await prisma.websiteAuditRun.findFirst({
      where: { tenantId: tid, productPages: { gt: 0 } },
      orderBy: { productPages: 'desc' },
    })
    if (!source) return null

    const pages = await prisma.auditedPage.findMany({ where: { auditRunId: source.id } })
    const observations = await prisma.pageObservation.findMany({ where: { auditRunId: source.id } })

    const runId = newId()
    const { id: _r, ...runRest } = source
    await prisma.websiteAuditRun.create({ data: { ...runRest, id: runId } })
    clones.push(runId)

    const pageMap = new Map<string, string>()
    for (const p of pages) {
      const id = newId()
      pageMap.set(p.id, id)
      const { id: _p, ...rest } = p
      await prisma.auditedPage.create({ data: { ...rest, id, auditRunId: runId } })
    }
    for (const o of observations) {
      const { id: _o, ...rest } = o
      await prisma.pageObservation.create({
        data: { ...rest, id: newId(), auditRunId: runId, pageId: pageMap.get(o.pageId)! },
      })
    }

    return prisma.websiteAuditRun.findUniqueOrThrow({ where: { id: runId } })
  }

  afterAll(async () => {
    const { prisma } = await import('../../src/platform/db.js')
    for (const id of clones) {
      await prisma.websiteAuditRun.delete({ where: { id } }).catch(() => undefined)
    }
  })

  it('generates findings, collateral and a PDF from stored observations only', async () => {
    const { generateAuditReport } = await import('../../src/websiteaudit/report.js')
    const { prisma } = await import('../../src/platform/db.js')

    const run = await bestRun()
    if (!run) {
      console.warn('[task979] no real run with product pages yet — run the website audit first')
      return
    }

    const result = await generateAuditReport(run.id)
    expect(result).not.toBeNull()

    const stored = await prisma.auditReport.findUniqueOrThrow({ where: { auditRunId: run.id } })
    expect(stored.status).toBe('ready_for_approval')
    expect(stored.pdfSha256).toBe(result!.pdfSha256)
    expect(stored.pdfBytesSize).toBeGreaterThan(1000)
    expect(stored.pdfPageCount).toBeGreaterThanOrEqual(3)

    const findings = await prisma.catalogFinding.findMany({ where: { auditRunId: run.id } })
    expect(findings.length).toBe(result!.findings.length)

    // Every stored finding is traceable to real observation rows on real URLs.
    for (const f of findings) {
      const evidence = f.evidence as Array<{ observationId: string; sourceUrl: string }>

      // A finding ABOUT AN ABSENCE can legitimately cite nothing when there was
      // nothing to cite: `no_product_pages_identified` draws its evidence from
      // page titles, and a site where every page was unreachable (an expired
      // certificate, a TLS timeout) produces no observations at all. Demanding
      // evidence there would force the audit to invent some.
      if (f.code !== 'no_product_pages_identified') {
        expect(evidence.length, f.code).toBeGreaterThan(0)
      }
      expect(f.metric, f.code).toMatch(/\d+ of \d+ inspected/)
      expect(f.metric, f.code).not.toMatch(/%/)

      const realIds = evidence.map((e) => e.observationId).filter((id) => !id.startsWith('page:'))
      if (realIds.length) {
        const found = await prisma.pageObservation.count({ where: { id: { in: realIds } } })
        expect(found, `${f.code} cites observations that do not exist`).toBe(realIds.length)
      }
    }
  }, 180_000)

  it('re-running the report replaces rather than duplicates, and is stable', async () => {
    const { generateAuditReport } = await import('../../src/websiteaudit/report.js')
    const { prisma } = await import('../../src/platform/db.js')

    const run = await bestRun()
    if (!run) return

    const first = await generateAuditReport(run.id)
    const countAfterFirst = await prisma.catalogFinding.count({ where: { auditRunId: run.id } })
    const second = await generateAuditReport(run.id)
    const countAfterSecond = await prisma.catalogFinding.count({ where: { auditRunId: run.id } })

    expect(countAfterSecond).toBe(countAfterFirst)
    expect(second!.findings.map((f) => f.code)).toEqual(first!.findings.map((f) => f.code))
    // Same stored evidence in, byte-identical PDF out.
    expect(second!.pdfSha256).toBe(first!.pdfSha256)
  }, 180_000)

  it('keeps historical reports: one per audit run, never overwritten across runs', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const tid = await tenantId()

    const reports = await prisma.auditReport.findMany({
      where: { tenantId: tid },
      select: { auditRunId: true, crmCompanyId: true, generatedAt: true, auditDate: true },
    })
    // The unique constraint is per RUN, so re-auditing a company later adds a
    // report beside the old one rather than replacing it.
    expect(new Set(reports.map((r) => r.auditRunId)).size).toBe(reports.length)
  }, 60_000)

  it('generates no unsupported claim against real prospect data', async () => {
    const { findUnsupportedClaims } = await import('../../src/websiteaudit/claimGuard.js')
    const { prisma } = await import('../../src/platform/db.js')

    const tid = await tenantId()
    const findings = await prisma.catalogFinding.findMany({ where: { tenantId: tid } })
    const reports = await prisma.auditReport.findMany({ where: { tenantId: tid }, select: { collateral: true } })

    findings.forEach((f) => {
      const prose = [f.title, f.metric, f.finding, f.impact, f.recommendation].join(' ')
      expect(findUnsupportedClaims(prose), `${f.code}: ${prose}`).toEqual([])
    })

    reports.forEach((r) => {
      const c = r.collateral as Record<string, unknown> | null
      if (!c) return
      // Evidence fragments are excluded on purpose: a prospect's own page may
      // legitimately show a price or a percentage, and the guard applies to
      // prose this system writes, not to what it quotes.
      const prose = [
        c.headline,
        c.summary,
        c.nextStep,
        c.scopeNote,
        ...((c.businessImpact as string[]) ?? []),
        ...((c.recommendedImprovementAreas as string[]) ?? []),
      ]
        .filter(Boolean)
        .join(' \n ')
      expect(findUnsupportedClaims(prose)).toEqual([])
    })
  }, 60_000)
})
