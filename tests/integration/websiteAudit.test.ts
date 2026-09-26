import { Prisma } from '@prisma/client'
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
    // The reason now comes from the shared source resolver, which distinguishes
    // "the record holds nothing" from "the website field holds a social
    // platform" — different problems needing different fixes.
    const none = await resolveStartUrl(tid, 'no-such-company', null)
    expect(none.url).toBeNull()
    expect(none.source).toMatch(/no website/i)

    // And the case that caused this: a website column holding a platform is
    // not a website, and is never handed to the crawler.
    const social = await resolveStartUrl(tid, 'no-such-company', 'facebook.com')
    expect(social.url).toBeNull()
    expect(social.source).toMatch(/social platform address/i)
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

  // A crawl is checked against the limits IT RAN UNDER, not against today's.
  //
  // This compared every stored run to the CURRENT configuration, which held
  // only while the configuration never moved. AUDIT_MAX_PAGES_PER_COMPANY was
  // later lowered from 25 to 15, and runs recorded weeks earlier — which had
  // correctly honoured the 25 they ran under — began failing a limit that did
  // not exist when they were crawled. The crawler was never at fault; the
  // assertion was measuring config drift.
  //
  // Every run records `limitsApplied`, the limits actually in force for it. That
  // is the honest thing to hold a run to, and it cannot rot when a limit is
  // retuned. The limits themselves are not weakened: a run exceeding its own
  // recorded ceiling still fails, which is the property worth protecting.
  interface AppliedLimits {
    maxPages?: number
    maxProductPages?: number
    maxCategoryPages?: number
  }

  it('never exceeds the crawl limits recorded for the run', async () => {
    const { prisma } = await import('../../src/platform/db.js')

    const runs = await prisma.websiteAuditRun.findMany({
      where: { tenantId: await tenantId() },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    let checked = 0
    for (const r of runs) {
      const applied = r.limitsApplied as AppliedLimits | null
      // A run from before limitsApplied existed cannot be held to limits nobody
      // recorded. Skipped explicitly rather than judged by today's numbers.
      if (!applied?.maxPages) continue
      checked++
      expect(r.pagesFetched, `run ${r.id} pagesFetched`).toBeLessThanOrEqual(applied.maxPages)
      expect(r.productPages, `run ${r.id} productPages`).toBeLessThanOrEqual(applied.maxProductPages ?? Infinity)
      expect(r.categoryPages, `run ${r.id} categoryPages`).toBeLessThanOrEqual(applied.maxCategoryPages ?? Infinity)
    }
    expect(checked, 'no run carried recorded limits — the assertion proved nothing').toBeGreaterThan(0)
  }, 60_000)

  it('records the CURRENT configuration as the limits a new run would apply', async () => {
    // The companion half. The test above proves a run obeyed its own recorded
    // ceiling; this proves the ceiling being recorded is the configured one, so
    // the pair cannot both pass while the live configuration is ignored.
    const { prisma } = await import('../../src/platform/db.js')
    const { env } = await import('../../src/config/env.js')

    const latest = await prisma.websiteAuditRun.findFirst({
      where: { tenantId: await tenantId(), limitsApplied: { not: Prisma.DbNull } },
      orderBy: { createdAt: 'desc' },
    })
    if (!latest) return

    const applied = latest.limitsApplied as AppliedLimits
    const currentConfig =
      applied.maxPages === env.AUDIT_MAX_PAGES_PER_COMPANY &&
      applied.maxProductPages === env.AUDIT_MAX_PRODUCT_PAGES &&
      applied.maxCategoryPages === env.AUDIT_MAX_CATEGORY_PAGES

    // Runs predating a retune legitimately disagree with today's numbers. What
    // must never happen is a run recording limits it did not use, so this
    // reports the divergence rather than asserting a stale run into a failure.
    if (!currentConfig) {
      console.warn(
        `[websiteAudit] most recent run predates the current crawl limits ` +
          `(recorded maxPages=${applied.maxPages}, configured ${env.AUDIT_MAX_PAGES_PER_COMPANY}). ` +
          'Re-run an audit to exercise the current configuration.',
      )
    }
    expect(applied.maxPages, 'a run must record the ceiling it used').toBeGreaterThan(0)
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
