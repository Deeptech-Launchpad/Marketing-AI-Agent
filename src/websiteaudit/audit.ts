import { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { audit as auditLog } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { serializeError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { crawlSite, type CrawlLimits, type CrawlResult } from './crawler.js'
import { generateAuditReport } from './report.js'
import { hostOf } from './urls.js'
import type { AuditStatus } from './types.js'

// TASK #979 — WEBSITE AUDIT ORCHESTRATOR.
//
// Resolves the company's website, runs one bounded crawl, stores what was
// observed, and then hands the stored rows to the analyser that produces the
// findings, the collateral and the PDF.
//
// The crawl itself still reaches no conclusions, and that separation is load
// bearing: observations are recorded without regard to what they will be used
// to argue, and the analysis runs afterwards over stored rows. No call to
// Gemini is made anywhere in this chain — every field recorded here has a
// correct answer that deterministic extraction can reach and cite.
//
// The chain ends at "ready for human approval". Task #980 owns what follows.

export function auditLimits(): CrawlLimits {
  return {
    maxPages: env.AUDIT_MAX_PAGES_PER_COMPANY,
    maxProductPages: env.AUDIT_MAX_PRODUCT_PAGES,
    maxCategoryPages: env.AUDIT_MAX_CATEGORY_PAGES,
    maxBytes: env.AUDIT_MAX_BYTES_PER_COMPANY,
    maxDepth: env.AUDIT_MAX_DEPTH,
  }
}

export async function queueWebsiteAudit(input: {
  tenantId: string
  crmCompanyId: string
  requestedByCrmUserId: string
  prospectSearchId?: string | null
}): Promise<{ id: string }> {
  const id = newId()
  await prisma.websiteAuditRun.create({
    data: {
      id,
      tenantId: input.tenantId,
      crmCompanyId: input.crmCompanyId,
      prospectSearchId: input.prospectSearchId ?? null,
      requestedByCrmUserId: input.requestedByCrmUserId,
      status: 'queued',
    },
  })
  return { id }
}

/**
 * Resolves the URL to start from.
 *
 * Stage 2's enrichment result is preferred over the raw CRM field, because the
 * enrichment `sourceUrl` is a URL that actually responded, whereas the CRM
 * column is whatever someone typed. Nothing is invented: a company with neither
 * yields null and the run reports that rather than guessing a domain from the
 * company name.
 */
export async function resolveStartUrl(
  tenantId: string,
  crmCompanyId: string,
  crmDomain: string | null,
): Promise<{ url: string | null; source: string }> {
  const enrichment = await prisma.companyEnrichment.findFirst({
    where: { tenantId, crmCompanyId, status: 'enriched' },
    orderBy: { createdAt: 'desc' },
    select: { sourceUrl: true },
  })

  if (enrichment?.sourceUrl) {
    return { url: enrichment.sourceUrl, source: 'Stage 2 enrichment (a URL that responded)' }
  }

  const host = hostOf(crmDomain?.startsWith('http') ? crmDomain : `https://${crmDomain ?? ''}`)
  if (host) return { url: `https://${host}`, source: 'NXT Sales company website field' }

  return { url: null, source: 'no website on record' }
}

/** Queue handler. Never throws: failures are recorded on the run row. */
export async function runWebsiteAudit(runId: string): Promise<void> {
  const run = await prisma.websiteAuditRun.findUnique({ where: { id: runId } })
  if (!run) return
  if (run.status === 'completed' || run.status === 'cancelled') return

  const log = logger.child({ auditRunId: runId, crmCompanyId: run.crmCompanyId })

  if (run.retryCount >= env.AUDIT_MAX_RETRIES) {
    await finish(runId, 'failed', { failureReason: `Exceeded AUDIT_MAX_RETRIES (${env.AUDIT_MAX_RETRIES}).` })
    return
  }

  try {
    await prisma.websiteAuditRun.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date(), retryCount: { increment: 1 }, error: Prisma.DbNull },
    })

    const company = await getCrm().getCompany(run.crmCompanyId)
    if (!company) {
      await finish(runId, 'failed', {
        failureReason: 'Company not found in NXT Sales (it may have been recycle-binned).',
      })
      return
    }

    const { url: startUrl, source } = await resolveStartUrl(run.tenantId, run.crmCompanyId, company.domain)
    if (!startUrl) {
      // A company with no website is a normal, reportable outcome — not a
      // failure, and certainly not a reason to guess a domain from its name.
      await finish(runId, 'completed', {
        companyName: company.name,
        failureReason: 'No website is recorded for this company, so there was nothing to audit.',
        limitsApplied: auditLimits() as never,
      })
      return
    }

    const limits = auditLimits()
    const result = await withTimeout(crawlSite(startUrl, limits), env.AUDIT_RUN_TIMEOUT_MS)

    await persistPages(run.tenantId, runId, run.crmCompanyId, result)

    // `partial` is a real outcome, not a softened failure: the homepage was
    // read but a limit or an error stopped the crawl short, and Stage 6 must
    // know the evidence is incomplete before drawing anything from it.
    const status: AuditStatus = !result.homepageReachable
      ? 'failed'
      : result.stats.limitsHit.length || result.stats.httpErrors || result.stats.unreachable
        ? 'partial'
        : 'completed'

    await finish(runId, status, {
      companyName: company.name,
      startUrl,
      rootHost: hostOf(startUrl),
      pagesFetched: result.stats.pagesFetched,
      pagesSkipped: result.stats.pagesSkipped,
      productPages: result.stats.productPages,
      categoryPages: result.stats.categoryPages,
      otherPages: result.stats.otherPages,
      duplicatePages: result.stats.duplicates,
      canonicalDuplicates: result.stats.canonicalDuplicates,
      soft404Pages: result.stats.soft404s,
      httpErrors: result.stats.httpErrors,
      unreachablePages: result.stats.unreachable,
      structuredDataPages: result.stats.structuredDataPages,
      totalBytes: result.stats.totalBytes,
      limitsHit: result.stats.limitsHit as never,
      limitsApplied: { ...limits, startUrlSource: source } as never,
      failureReason: result.failureReason,
    })

    // Task #979 continues here rather than ending at the crawl: the same task
    // is "audit website AND generate site audit report". Analysis runs on the
    // rows just written, so it cannot see anything the audit did not record.
    //
    // It is deliberately NOT allowed to fail the run. The crawl evidence is the
    // durable asset; a report can be regenerated from it at any time via
    // POST /runs/:id/report, so a reporting fault must not discard a good crawl.
    try {
      await generateAuditReport(runId)
    } catch (err) {
      log.error({ err }, 'audit report generation failed; crawl evidence is retained')
      await prisma.websiteAuditRun
        .update({
          where: { id: runId },
          data: {
            failureReason: `Crawl succeeded; report generation failed: ${(err as Error).message?.slice(0, 300)}`,
          },
        })
        .catch(() => undefined)
    }

    await auditLog({
      tenantId: run.tenantId,
      actorType: 'agent',
      action: 'website.audited',
      resourceType: 'WebsiteAuditRun',
      resourceId: runId,
      // Public web content, held internally. No customer PII is collected
      // by this stage — it reads catalogue pages, not people.
      dataClass: 'internal',
      summary: `${company.name}: ${result.stats.pagesFetched} page(s) inspected, ${result.stats.productPages} product, ${result.stats.categoryPages} category`,
    })

    log.info(
      { status, pages: result.stats.pagesFetched, products: result.stats.productPages, bytes: result.stats.totalBytes },
      'website audit finished',
    )
  } catch (err) {
    log.error({ err }, 'website audit failed')
    await prisma.websiteAuditRun
      .update({
        where: { id: runId },
        data: {
          status: 'failed',
          error: serializeError(err) as never,
          failureReason: (err as Error).message?.slice(0, 500),
          completedAt: new Date(),
        },
      })
      .catch(() => undefined)
  }
}

/** Bounds a run's wall clock so one slow site cannot hold a worker forever. */
async function withTimeout(work: Promise<CrawlResult>, ms: number): Promise<CrawlResult> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The crawl exceeded AUDIT_RUN_TIMEOUT_MS (${ms}ms).`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function finish(runId: string, status: AuditStatus, data: Record<string, unknown>): Promise<void> {
  await prisma.websiteAuditRun.update({
    where: { id: runId },
    data: { status, completedAt: new Date(), ...data } as never,
  })
}

/**
 * Writes pages and their observations.
 *
 * Both tables are append-only within a run, and a re-audit creates a new run,
 * so nothing here can overwrite an earlier crawl's evidence.
 */
async function persistPages(
  tenantId: string,
  runId: string,
  crmCompanyId: string,
  result: CrawlResult,
): Promise<void> {
  for (const page of result.pages) {
    const pageId = newId()
    await prisma.auditedPage.create({
      data: {
        id: pageId,
        tenantId,
        auditRunId: runId,
        crmCompanyId,
        requestedUrl: page.requestedUrl.slice(0, 2000),
        finalUrl: page.finalUrl?.slice(0, 2000) ?? null,
        httpStatus: page.httpStatus,
        contentType: page.contentType?.slice(0, 200) ?? null,
        outcome: page.outcome,
        pageType: page.pageType,
        typeSignals: page.typeSignals as never,
        depth: page.depth,
        bytes: page.bytes,
        wordCount: page.wordCount,
        contentHash: page.contentHash,
        canonicalUrl: page.canonicalUrl?.slice(0, 2000) ?? null,
        duplicateOfUrl: page.duplicateOfUrl?.slice(0, 2000) ?? null,
        redirectChain: page.redirectChain as never,
        truncated: page.truncated,
        failureReason: page.failureReason?.slice(0, 500) ?? null,
        durationMs: page.durationMs,
        fetchedAt: page.fetchedAt,
      },
    })

    if (!page.observations.length) continue

    await prisma.pageObservation.createMany({
      data: page.observations.map((o) => ({
        id: newId(),
        tenantId,
        auditRunId: runId,
        pageId,
        field: o.field,
        status: o.status,
        value: o.value,
        method: o.method,
        sourcePath: o.sourcePath,
        fragment: o.fragment,
      })),
    })
  }
}
