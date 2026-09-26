import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { captureAvailable, captureHtml, captureUrl, renderUrlHtml } from '../research/pageCapture.js'
import { fetchPageRaw, type RawPageResult } from '../research/pageFetch.js'
import { AFTER_PAGE_RECIPE, brandedEnrichedPdpHtml } from '../workbench/enrichedPdpBrand.js'
import { extractCategoryObservations, extractPageObservations, extractProductObservations } from './extraction.js'
import { wordCount } from './htmlStructure.js'
import { enrichPdp } from './pdpEnrichment.js'
import { assessPdpPage, readEndPdpValue, type PdpAssessment } from './pdpTarget.js'
import type { Observation } from './types.js'
import { resolveCompanySource } from '../crm/companySource.js'
import type { CrmCompany } from '../crm/types.js'
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
 *
 * The CRM field is read through resolveCompanySource rather than directly. A
 * record whose website column holds "facebook.com" has no website, and used to
 * send this crawler to a social platform's front door — which then failed, and
 * was reported as the customer's site being unreadable. A platform is not a
 * website, and that judgement is made in exactly one place now.
 */
export async function resolveStartUrl(
  tenantId: string,
  crmCompanyId: string,
  company: CrmCompany | string | null,
): Promise<{ url: string | null; source: string }> {
  const enrichment = await prisma.companyEnrichment.findFirst({
    where: { tenantId, crmCompanyId, status: 'enriched' },
    orderBy: { createdAt: 'desc' },
    select: { sourceUrl: true },
  })

  if (enrichment?.sourceUrl) {
    return { url: enrichment.sourceUrl, source: 'Stage 2 enrichment (a URL that responded)' }
  }

  // A bare string is still accepted so existing callers and tests that pass a
  // domain keep working; it is classified by the same rules either way.
  const source =
    typeof company === 'string' || company === null
      ? resolveCompanySource({ domain: company, emails: [], linkedProfiles: [] } as unknown as CrmCompany)
      : resolveCompanySource(company)

  if (source.websiteUrl) {
    const host = hostOf(source.websiteUrl)
    if (host) return { url: `https://${host}`, source: 'NXT Sales company website field' }
  }

  return { url: null, source: source.reason ?? 'no website on record' }
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

    // THE END PDP AUDIT. Only the product page recorded in NXT Sales is read.
    // The whole-site crawl below is retained for a future full-website audit
    // and is not reached from here.
    if (env.AUDIT_SCOPE === 'end_pdp') {
      await auditEndPdp(run, company, log)
      return
    }

    const { url: startUrl, source } = await resolveStartUrl(run.tenantId, run.crmCompanyId, company)
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
      // How the crawl was steered, kept with the run so a later run under
      // different configuration is comparable rather than silently different.
      // The sitemap note belongs here for the same reason: "this site
      // publishes no sitemap" is a finding, and a run that looked and found
      // none must be distinguishable from one that never looked.
      limitsApplied: {
        ...limits,
        startUrlSource: source,
        sitemap: {
          sourcesRead: result.sitemap.sourcesRead,
          urlsQueued: result.sitemap.urls.length,
          note: result.sitemap.note,
        },
        // First-party JavaScript read because a page was a client-rendered
        // shell. Empty for a site that renders on the server, which is most of
        // them — and the fact that it was needed is itself worth knowing about
        // a site whose markup names none of its own pages.
        assetsRead: result.stats.assetsRead,
      } as never,
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

/**
 * Audits the End PDP link, and only that page.
 *
 * Three outcomes, all recorded as a completed run with a pdpAssessment:
 *   valid product page → page stored, enriched record built, both pages
 *                        photographed, report generated
 *   link problem       → the issue and the next step for the marketing agent
 *   no link            → a recommendation for how to get one
 */
async function auditEndPdp(
  run: { id: string; tenantId: string; crmCompanyId: string },
  company: CrmCompany,
  log: typeof logger,
): Promise<void> {
  const runId = run.id
  const website = resolveCompanySource(company).websiteUrl
  const read = readEndPdpValue(company.endPdpUrl, website)

  let assessment: PdpAssessment
  let fetched: RawPageResult | null = null
  if ('assessment' in read) {
    assessment = read.assessment
  } else {
    fetched = await fetchPageRaw(read.fetchUrl)
    assessment = assessPdpPage({ endPdpValue: company.endPdpUrl, companyWebsite: website, fetched, fetchUrl: read.fetchUrl })

    // The served HTML showed no product, but the page loaded. Many shops build
    // the product view with JavaScript, so read the page as a browser renders
    // it and decide again. Only the rendered DOM changes; every rule is the same.
    if (
      fetched.ok &&
      (assessment.issue === 'not_a_product_page' || assessment.issue === 'javascript_only') &&
      captureAvailable().ok
    ) {
      const rendered = await renderUrlHtml(fetched.finalUrl ?? read.fetchUrl)
      if (rendered.ok && rendered.html) {
        const renderedFetch: RawPageResult = {
          ...fetched,
          html: rendered.html,
          finalUrl: rendered.finalUrl || fetched.finalUrl,
          bytes: Buffer.byteLength(rendered.html),
        }
        const second = assessPdpPage({
          endPdpValue: company.endPdpUrl,
          companyWebsite: website,
          fetched: renderedFetch,
          fetchUrl: read.fetchUrl,
        })
        if (second.case === 'valid_product') {
          fetched = renderedFetch
          assessment = { ...second, signals: ['Read from the page as rendered by a browser.', ...second.signals] }
        }
      }
    }

    await persistPdpPage(run.tenantId, runId, run.crmCompanyId, fetched, assessment)
  }

  const valid = assessment.case === 'valid_product'
  const pageUrl = assessment.finalUrl ?? assessment.url
  // The page facts are written now so the screens can show which case this is.
  // A valid product page stays "running" until its enriched record, captures
  // and report exist — a run marked completed with none of them would read as
  // an audit that produced nothing.
  const recordPage = valid
    ? (data: Record<string, unknown>) => prisma.websiteAuditRun.update({ where: { id: runId }, data: data as never })
    : (data: Record<string, unknown>) => finish(runId, 'completed', data)
  await recordPage({
    companyName: company.name,
    startUrl: pageUrl,
    rootHost: pageUrl ? hostOf(pageUrl) : null,
    pagesFetched: fetched?.ok ? 1 : 0,
    productPages: valid ? 1 : 0,
    categoryPages: assessment.issue === 'category_page' ? 1 : 0,
    otherPages: fetched?.ok && !valid && assessment.issue !== 'category_page' ? 1 : 0,
    httpErrors: assessment.issue === 'http_error' ? 1 : 0,
    unreachablePages: assessment.issue === 'unreachable' ? 1 : 0,
    totalBytes: fetched?.bytes ?? 0,
    limitsApplied: { scope: 'end_pdp', startUrlSource: 'NXT Sales Company.endPdpUrl' } as never,
    pdpAssessment: assessment as never,
    failureReason: valid ? null : `${assessment.headline}. ${assessment.explanation}`.slice(0, 500),
  })

  if (valid && fetched) {
    const enrichment = await enrichPdp({
      tenantId: run.tenantId,
      runId,
      companyName: company.name,
      html: fetched.html,
      url: pageUrl!,
      productName: assessment.productName ?? '',
    })
    await prisma.websiteAuditRun.update({ where: { id: runId }, data: { pdpEnrichment: enrichment as never } })

    const before = await captureUrl(pageUrl!)
    // The SAME After page the Workbench shows: the company's own branding
    // around the enriched structure. One page, photographed for the report.
    const afterHtml = enrichment.status === 'ready' ? await brandedEnrichedPdpHtml(runId, { forCapture: true }) : null
    const after = afterHtml ? await captureHtml(afterHtml, { baseUrl: pageUrl }) : null
    // Rendering the After page may have found the company's logo and read
    // their pictures, and kept both on the run — so the row is read back
    // rather than written over with the copy held here.
    const rendered = await prisma.websiteAuditRun.findUnique({
      where: { id: runId },
      select: { pdpEnrichment: true },
    })
    await prisma.websiteAuditRun.update({
      where: { id: runId },
      data: {
        pdpBeforeCapture: before.image ?? null,
        pdpAfterCapture: after?.image ?? null,
        // Records that the stored photograph is the BRANDED After page, and
        // how that page was drawn, so a report built from an older run knows
        // to take a fresh one.
        pdpEnrichment: {
          ...((rendered?.pdpEnrichment as object) ?? enrichment),
          afterCaptureBranded: Boolean(after?.image),
          afterCaptureRecipe: AFTER_PAGE_RECIPE,
        } as never,
      },
    })
    if (!before.ok) log.info({ reason: before.reason }, 'original page not captured')

    try {
      await generateAuditReport(runId)
    } catch (err) {
      log.error({ err }, 'audit report generation failed; the PDP evidence is retained')
      await prisma.websiteAuditRun
        .update({
          where: { id: runId },
          data: { failureReason: `PDP audited; report generation failed: ${(err as Error).message?.slice(0, 300)}` },
        })
        .catch(() => undefined)
    }
    await finish(runId, 'completed', {})
  }

  await auditLog({
    tenantId: run.tenantId,
    actorType: 'agent',
    action: 'website.pdp_audited',
    resourceType: 'WebsiteAuditRun',
    resourceId: runId,
    dataClass: 'internal',
    summary: `${company.name}: End PDP ${assessment.case.replace('_', ' ')}${assessment.issue ? ` (${assessment.issue})` : ''}`,
  })
  log.info({ case: assessment.case, issue: assessment.issue }, 'end pdp audit finished')
}

/** Stores the one page the End PDP audit read, with its observations. */
async function persistPdpPage(
  tenantId: string,
  runId: string,
  crmCompanyId: string,
  fetched: RawPageResult,
  assessment: PdpAssessment,
): Promise<void> {
  const html = fetched.html ?? ''
  const url = fetched.finalUrl ?? fetched.requestedUrl
  const pageType = assessment.pageType ?? 'unknown'
  const outcome = fetched.ok ? 'fetched' : fetched.status ? 'http_error' : 'unreachable'
  const observations: Observation[] = html
    ? [
        ...extractPageObservations(html, url),
        ...(assessment.case === 'valid_product'
          ? extractProductObservations(html, url)
          : pageType === 'category' || pageType === 'listing'
            ? extractCategoryObservations(html, url)
            : []),
      ]
    : []

  const pageId = newId()
  await prisma.auditedPage.create({
    data: {
      id: pageId,
      tenantId,
      auditRunId: runId,
      crmCompanyId,
      requestedUrl: fetched.requestedUrl.slice(0, 2000),
      finalUrl: fetched.finalUrl?.slice(0, 2000) ?? null,
      httpStatus: fetched.status,
      contentType: fetched.contentType?.slice(0, 200) ?? null,
      outcome,
      pageType,
      typeSignals: assessment.signals as never,
      depth: 0,
      bytes: fetched.bytes,
      wordCount: html ? wordCount(html) : 0,
      contentHash: html ? createHash('sha256').update(html).digest('hex') : null,
      canonicalUrl: null,
      duplicateOfUrl: null,
      redirectChain: fetched.redirectChain as never,
      truncated: fetched.truncated,
      failureReason: fetched.reason?.slice(0, 500) ?? null,
      durationMs: fetched.durationMs,
      fetchedAt: new Date(),
    },
  })
  if (!observations.length) return
  await prisma.pageObservation.createMany({
    data: observations.map((o) => ({
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
