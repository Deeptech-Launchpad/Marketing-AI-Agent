import { Prisma } from '@prisma/client'
import type { CrmCompany } from '../crm/types.js'
import { resolveCompanySource } from '../crm/companySource.js'
import { claim, type Claim } from '../domain/provenance.js'
import { resolvePipelineCompany } from '../prospects/discoveredCompanyAdapter.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { serializeError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { fetchPage } from '../research/pageFetch.js'
import type { DetectedTechnology, PageSignals } from '../research/htmlToText.js'
import { normalizeUrl } from '../research/ssrfGuard.js'
import { hostnameOf, sameRegistrableSite } from './siteIdentity.js'

// STAGE 2 — ENRICH COMPANY DATA.
//
// Adds company-level signals to a prospect the CRM already holds. It does not
// detect intent, find people, audit a catalog, or contact anyone.
//
// Built on the existing research stack rather than beside it: fetchPage brings
// the SSRF guards, redirect re-validation, byte/time caps, ResearchArtifact
// caching and HTML->text extraction, and detectSignals brings the platform
// fingerprints. The only new detection work is PIM/ERP patterns and evidence
// capture, both added inside the existing fingerprint table.
//
// THE EVIDENCE RULE. A field is only ever one of:
//   [CRM data]      copied from NXT Sales, unchanged
//   [Web data]      observed in the fetched page, stored with the markup that
//                   proved it
//   UNKNOWN         not verifiable
//
// There is no [AI inference] in this stage at all — no model is called. That is
// deliberate: a homepage either contains a Shopify CDN reference or it does
// not, and asking a model to speculate about the rest would manufacture exactly
// the unverified "company data" the stage exists to avoid.

export const UNKNOWN = 'UNKNOWN' as const

export type EnrichmentStatus =
  | 'queued'
  | 'running'
  | 'enriched'
  /**
   * The site was read, but what was read cannot be attributed to this company
   * with confidence — e.g. the address redirected to a different registrable
   * domain. `failureReason` says why.
   */
  | 'partial'
  | 'no_website'
  | 'unreachable'
  | 'failed'

const ACTIVE_STATUSES = ['queued', 'running'] as const

/**
 * How long a queued or running row may block a new run for the same company.
 *
 * A live run takes seconds (one bounded page fetch). A row older than this was
 * stranded — a worker that died mid-job, a job the queue expired — and must not
 * block the company forever.
 */
export const IN_FLIGHT_WINDOW_MS = 30 * 60_000

export const STALE_RUN_REASON =
  'The run did not finish within 30 minutes and was marked failed. The worker may have stopped mid-job; run enrichment again.'

export interface CompanySignals {
  /** [CRM data] */
  industry: string | typeof UNKNOWN
  country: string | typeof UNKNOWN
  domain: string | typeof UNKNOWN
  crmCms: string | typeof UNKNOWN
  /** [Web data] */
  websiteStatus: 'reachable' | 'unreachable' | 'no_website'
  finalUrl: string | typeof UNKNOWN
  pageTitle: string | typeof UNKNOWN
  metaDescription: string | typeof UNKNOWN
  generator: string | typeof UNKNOWN
  hasStructuredData: boolean | typeof UNKNOWN
  hasProductSchema: boolean | typeof UNKNOWN
}

const orUnknown = (v: string | null | undefined): string | typeof UNKNOWN =>
  v && String(v).trim() ? String(v).trim() : UNKNOWN

/**
 * Picks the URL to fetch, preferring the most specific thing the CRM holds.
 *
 * endPdpUrl is a product detail page, which carries more platform markup than a
 * marketing homepage — but it is also more likely to have moved, so `domain` is
 * the fallback rather than the other way round.
 *
 * WHAT CHANGED AND WHY. This used to take the first value that parsed as a URL,
 * which meant a record whose website column reads "facebook.com" sent the
 * fetcher to a social platform's front door. The fetch then failed, and the
 * failure was reported as the CUSTOMER'S website being unreadable — a
 * statement about their business that was never true. A platform is not a
 * website, and resolveCompanySource is the one place that decides which is
 * which.
 *
 * Returns null when the record holds no website. The caller reports that as a
 * record problem rather than as a broken site.
 */
export function chooseWebsite(company: CrmCompany): { url: string; source: string } | null {
  const resolved = resolveCompanySource(company)
  if (!resolved.websiteUrl) return null

  // Field precedence is unchanged: Company.domain first, Company.endPdpUrl as
  // the fallback. What changed is only WHICH values are eligible — a value
  // that names a social platform is no longer a website in either field, so a
  // real product URL is now reached when the domain column holds facebook.com.
  const url = normalizeUrl(resolved.websiteUrl)
  return url ? { url: url.toString(), source: resolved.websiteField ?? 'Company.domain' } : null
}

/**
 * Compares what the CRM believes against what the page shows.
 *
 * Reported, never auto-corrected: Stage 2 does not write to NXT Sales, and a
 * disagreement is a fact for a human to resolve rather than evidence that the
 * page is right and the CRM is wrong.
 */
function cmsAgreement(crmCms: string | null, detected: DetectedTechnology[]): string {
  if (!crmCms) return 'CRM holds no CMS value for this company; nothing to compare.'
  const names = detected.map((d) => d.name.toLowerCase())
  const crm = crmCms.toLowerCase()
  if (!detected.length) return `CRM says "${crmCms}"; the page showed no platform signal to confirm or contradict it.`
  if (names.some((n) => n.includes(crm) || crm.includes(n.split(' ')[0] ?? ''))) {
    return `CRM value "${crmCms}" is consistent with what the page showed.`
  }
  return `DISCREPANCY: CRM says "${crmCms}" but the page showed ${detected.map((d) => d.name).join(', ')}. Not corrected — Stage 2 does not write to the CRM.`
}

export async function queueCompanyEnrichment(input: {
  tenantId: string
  crmCompanyId: string
  requestedByCrmUserId: string
  prospectSearchId?: string | null
}): Promise<{ id: string }> {
  const id = newId()
  await prisma.companyEnrichment.create({
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
 * Fails queued/running rows that have not moved within IN_FLIGHT_WINDOW_MS.
 *
 * Called whenever enrichment for a company is requested or read, so a stranded
 * row is resolved the next time anyone looks rather than spinning forever.
 */
export async function failStaleEnrichments(tenantId: string, crmCompanyIds?: string[]): Promise<number> {
  const cutoff = new Date(Date.now() - IN_FLIGHT_WINDOW_MS)
  const res = await prisma.companyEnrichment.updateMany({
    where: {
      tenantId,
      ...(crmCompanyIds ? { crmCompanyId: { in: crmCompanyIds } } : {}),
      status: { in: [...ACTIVE_STATUSES] },
      updatedAt: { lt: cutoff },
    },
    data: { status: 'failed', failureReason: STALE_RUN_REASON, finishedAt: new Date() },
  })
  return res?.count ?? 0
}

export interface EnrichmentRequestResult {
  id: string
  crmCompanyId: string
  /** True when an in-flight run already existed and was returned instead. */
  existing: boolean
  status: EnrichmentStatus
}

/**
 * Requests enrichment for a batch of companies, safely.
 *
 * - ids are de-duplicated, so one company in a batch twice is one run;
 * - a company with a queued/running row inside the in-flight window gets that
 *   row back instead of a second run (a double click is one run);
 * - a row older than the window is failed first, so it never blocks;
 * - if the job cannot be enqueued, the row just created is marked failed rather
 *   than left 'queued' forever.
 */
export async function requestCompanyEnrichments(input: {
  tenantId: string
  crmCompanyIds: string[]
  requestedByCrmUserId: string
  prospectSearchId?: string | null
  enqueueJob: (enrichmentId: string) => Promise<unknown>
}): Promise<EnrichmentRequestResult[]> {
  const ids = [...new Set(input.crmCompanyIds.map((id) => id.trim()).filter(Boolean))]
  if (!ids.length) return []

  await failStaleEnrichments(input.tenantId, ids)

  const cutoff = new Date(Date.now() - IN_FLIGHT_WINDOW_MS)
  const results: EnrichmentRequestResult[] = []
  for (const crmCompanyId of ids) {
    const inFlight = await prisma.companyEnrichment.findFirst({
      where: {
        tenantId: input.tenantId,
        crmCompanyId,
        status: { in: [...ACTIVE_STATUSES] },
        updatedAt: { gte: cutoff },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    })
    if (inFlight) {
      results.push({ id: inFlight.id, crmCompanyId, existing: true, status: inFlight.status as EnrichmentStatus })
      continue
    }

    const { id } = await queueCompanyEnrichment({
      tenantId: input.tenantId,
      crmCompanyId,
      requestedByCrmUserId: input.requestedByCrmUserId,
      prospectSearchId: input.prospectSearchId ?? null,
    })
    try {
      await input.enqueueJob(id)
      results.push({ id, crmCompanyId, existing: false, status: 'queued' })
    } catch (err) {
      logger.error({ err, enrichmentId: id }, 'enrichment job could not be enqueued')
      await prisma.companyEnrichment
        .update({
          where: { id },
          data: {
            status: 'failed',
            failureReason: 'The enrichment job could not be queued for the worker. Nothing was read; run enrichment again.',
            error: serializeError(err) as never,
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined)
      results.push({ id, crmCompanyId, existing: false, status: 'failed' })
    }
  }
  return results
}

/** Queue handler. Never throws: failures are recorded on the enrichment row. */
export async function runCompanyEnrichment(enrichmentId: string): Promise<void> {
  const row = await prisma.companyEnrichment.findUnique({ where: { id: enrichmentId } })
  if (!row) return

  const log = logger.child({ enrichmentId, crmCompanyId: row.crmCompanyId })

  // A redelivered job must not overwrite a run that already finished (or that
  // was failed as stale): evidence, once recorded, is never silently replaced.
  if (!(ACTIVE_STATUSES as readonly string[]).includes(row.status)) {
    log.info({ status: row.status }, 'enrichment row already terminal; redelivery ignored')
    return
  }

  try {
    await prisma.companyEnrichment.update({
      where: { id: enrichmentId },
      data: { status: 'running', error: Prisma.DbNull },
    })

    // ── 1. Company facts ────────────────────────────────────────────────────
    // From NXT Sales, or — for a company found by "Find New Company" and not
    // yet in the CRM — from the platform's own discovered-company record.
    const found = await resolvePipelineCompany(row.tenantId, row.crmCompanyId)
    if (!found) {
      await finish(enrichmentId, 'failed', {
        // Also as failureReason: the screen and the register read that field,
        // and showed "the worker recorded no reason" (2026-10-06).
        failureReason: 'Company not found in NXT Sales (it may have been recycle-binned).',
        error: { message: 'Company not found in NXT Sales (it may have been recycle-binned).' },
      })
      return
    }
    const { company, discoveredCompanyId } = found

    const provenance: Claim[] = discoveredCompanyId
      ? [
          claim(
            'research',
            `Company "${company.name}" was found by a public web search and is not in NXT Sales yet, so there are no CRM facts to load.`,
          ),
        ]
      : [
          claim('crm_data', `Company "${company.name}" loaded from NXT Sales.`),
          claim('crm_data', `Industry: ${orUnknown(company.industry)}; country: ${orUnknown(company.country)}.`),
        ]

    // ── 2. Website ──────────────────────────────────────────────────────────
    const site = chooseWebsite(company)
    if (!site) {
      // The resolver's own words. "The website field holds a social platform"
      // and "there is no website on the record" are different problems with
      // different fixes, and an operator needs to be told which one they have.
      const resolved = resolveCompanySource(company)
      const noWebsiteReason = discoveredCompanyId
        ? 'The public web search did not confirm a website of this company’s own — only pages about it on other sites — so there is no website to read.'
        : (resolved.reason ?? 'No usable website on the CRM record.')
      provenance.push(claim('crm_data', noWebsiteReason))
      for (const social of resolved.socialSources) {
        provenance.push(
          claim(
            'crm_data',
            `${social.platform} profile kept as a social source for Intent Signals: ${social.url} (from ${social.field}). It is not a website and was not crawled.`,
          ),
        )
      }
      if (resolved.candidateWebsiteUrl) {
        provenance.push(
          claim(
            'crm_data',
            `A company domain is implied by the address on the record (${resolved.candidateWebsiteUrl}), but nothing has verified it. ` +
              'Put a working website on the NXT Sales record to enrich this company.',
          ),
        )
      }
      await finish(enrichmentId, 'no_website', {
        companyName: company.name,
        signals: baseSignals(company, 'no_website'),
        technologies: [],
        // The resolver's reason, stored where the screen reads it, so "the
        // domain column holds a social profile" is not re-worded as "the record
        // carried no domain".
        failureReason: noWebsiteReason,
        provenance,
      })
      log.info('no website on record')
      return
    }
    provenance.push(
      discoveredCompanyId
        ? claim('research', `Website confirmed by the public web search that found this company: ${site.url}`)
        : claim('crm_data', `Website taken from ${site.source}: ${site.url}`),
    )

    // ── 3. Fetch, through the existing SSRF-guarded fetcher ──────────────────
    // fetchPage never throws on an unreachable site; it resolves ok:false so an
    // unreachable prospect is a recorded outcome, not a failed job.
    //
    // A RE-RUN LOOKS AGAIN. The research cache keeps a page for days, which is
    // right for the other engines reading the same homepage, but a person who
    // runs enrichment again for a company already enriched is asking what the
    // site shows NOW. So any run after the company's first bypasses the cache.
    const earlier = await prisma.companyEnrichment.findFirst({
      where: { tenantId: row.tenantId, crmCompanyId: row.crmCompanyId, id: { not: row.id }, createdAt: { lt: row.createdAt } },
      select: { id: true },
    })
    const fresh = Boolean(earlier)
    const page = await fetchPage(site.url, { tenantId: row.tenantId, runId: null, fresh })
    const fetchedAt = page.fetchedAt ? new Date(page.fetchedAt) : new Date()
    const cacheNote = page.cached
      ? ` (served from the research cache: the page was fetched ${page.fetchedAt ?? 'earlier'} and was not re-fetched on this run)`
      : ''

    if (!page.ok) {
      provenance.push(claim('research', `Website could not be read: ${page.reason ?? 'unknown reason'}${cacheNote}`))
      await finish(enrichmentId, 'unreachable', {
        companyName: company.name,
        sourceUrl: site.url,
        signals: { ...baseSignals(company, 'unreachable'), finalUrl: UNKNOWN },
        technologies: [],
        failureReason: page.reason ?? 'unreachable',
        provenance,
      })
      log.info({ reason: page.reason }, 'website unreachable')
      return
    }

    // ── 4. Signals, all observed ────────────────────────────────────────────
    const s = (page.signals ?? {}) as PageSignals
    const technologies = s.technologies ?? []

    const signals: CompanySignals = {
      ...baseSignals(company, 'reachable'),
      finalUrl: orUnknown(page.finalUrl),
      pageTitle: orUnknown(s.title),
      metaDescription: orUnknown(s.metaDescription),
      generator: orUnknown(s.generator),
      hasStructuredData: s.hasStructuredData ?? UNKNOWN,
      hasProductSchema: s.productSchema ?? UNKNOWN,
    }

    provenance.push(
      claim(
        'research',
        page.cached
          ? `Read ${page.finalUrl ?? site.url}${cacheNote}.`
          : `Fetched ${page.finalUrl ?? site.url} at ${fetchedAt.toISOString()}.`,
      ),
    )

    // ── 4b. Did the address leave the company's site? ───────────────────────
    // A redirect to a different registrable domain means the page read belongs
    // to someone else (an acquirer, a parked-domain service, a marketplace).
    // Its markup is NOT this company's technology stack, so it is kept as
    // provenance only and the run is recorded as partial.
    if (page.finalUrl && !sameRegistrableSite(site.url, page.finalUrl)) {
      const from = hostnameOf(site.url) ?? site.url
      const to = hostnameOf(page.finalUrl) ?? page.finalUrl
      const reason = `The website on record (${from}) redirected to a different domain (${to}). What was read there is not attributed to ${company.name}.`
      provenance.push(claim('research', reason))
      technologies.forEach((t) =>
        provenance.push(
          claim('research', `Seen on ${to}, NOT attributed to ${company.name}: ${t.name} (${t.category}) — evidence: ${t.evidence}`),
        ),
      )
      await finish(enrichmentId, 'partial', {
        companyName: company.name,
        sourceUrl: site.url,
        signals,
        technologies: [],
        failureReason: reason,
        provenance,
        fetchedAt,
      })
      log.info({ from, to }, 'website redirected off-site; recorded as partial')
      return
    }

    if (technologies.length) {
      technologies.forEach((t) =>
        provenance.push(claim('research', `${t.name} (${t.category}) — evidence: ${t.evidence}`)),
      )
    } else {
      provenance.push(
        claim(
          'research',
          'No known technology fingerprint matched. This means NOT DETECTED, not "no technology in use" — the platform may simply leave no trace in delivered markup.',
        ),
      )
    }
    provenance.push(claim('crm_data', cmsAgreement(company.cms, technologies)))

    await finish(enrichmentId, 'enriched', {
      companyName: company.name,
      sourceUrl: site.url,
      signals,
      technologies,
      provenance,
      fetchedAt,
    })
    log.info({ technologies: technologies.length, cached: Boolean(page.cached) }, 'enriched')

    await audit({
      tenantId: row.tenantId,
      actorType: 'agent',
      action: 'company.enriched',
      resourceType: 'CompanyEnrichment',
      resourceId: enrichmentId,
      dataClass: 'customer_pii',
      summary: `${company.name}: ${technologies.length} technology signal(s)`,
    })
  } catch (err) {
    log.error({ err }, 'enrichment failed')
    await prisma.companyEnrichment
      .update({
        where: { id: enrichmentId },
        data: {
          status: 'failed',
          failureReason: `The enrichment did not complete: ${String((err as Error)?.message ?? err).slice(0, 400)}`,
          error: serializeError(err) as never,
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined)
  }
}

function baseSignals(company: CrmCompany, websiteStatus: CompanySignals['websiteStatus']): CompanySignals {
  return {
    industry: orUnknown(company.industry),
    country: orUnknown(company.country),
    domain: orUnknown(company.domain),
    crmCms: orUnknown(company.cms),
    websiteStatus,
    finalUrl: UNKNOWN,
    pageTitle: UNKNOWN,
    metaDescription: UNKNOWN,
    generator: UNKNOWN,
    hasStructuredData: UNKNOWN,
    hasProductSchema: UNKNOWN,
  }
}

/**
 * Single terminal write. Re-running enrichment for a company creates a NEW row
 * rather than mutating an old one, so a later run can never silently overwrite
 * evidence an earlier one captured.
 */
async function finish(
  id: string,
  status: EnrichmentStatus,
  data: {
    companyName?: string
    sourceUrl?: string
    signals?: CompanySignals
    technologies?: DetectedTechnology[]
    failureReason?: string
    provenance?: Claim[]
    error?: Record<string, unknown>
    /** When the page was actually fetched — the cache's time for a cached page. */
    fetchedAt?: Date
  },
): Promise<void> {
  await prisma.companyEnrichment.update({
    where: { id },
    data: {
      status,
      companyName: data.companyName ?? null,
      sourceUrl: data.sourceUrl ?? null,
      signals: (data.signals ?? undefined) as never,
      technologies: (data.technologies ?? undefined) as never,
      technologyCount: data.technologies?.length ?? 0,
      failureReason: data.failureReason ?? null,
      provenance: (data.provenance ?? undefined) as never,
      error: (data.error ?? undefined) as never,
      fetchedAt: status === 'enriched' || status === 'partial' ? (data.fetchedAt ?? new Date()) : null,
      finishedAt: new Date(),
    },
  })
}
