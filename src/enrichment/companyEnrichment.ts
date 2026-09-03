import { Prisma } from '@prisma/client'
import { getCrm } from '../crm/index.js'
import type { CrmCompany } from '../crm/types.js'
import { claim, type Claim } from '../domain/provenance.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { serializeError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { fetchPage } from '../research/pageFetch.js'
import type { DetectedTechnology, PageSignals } from '../research/htmlToText.js'
import { normalizeUrl } from '../research/ssrfGuard.js'

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
  | 'no_website'
  | 'unreachable'
  | 'failed'

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
 */
export function chooseWebsite(company: CrmCompany): { url: string; source: string } | null {
  const candidates: Array<[string | null, string]> = [
    [company.domain, 'Company.domain'],
    [company.endPdpUrl, 'Company.endPdpUrl'],
  ]
  for (const [value, source] of candidates) {
    if (!value) continue
    const url = normalizeUrl(value)
    if (url) return { url: url.toString(), source }
  }
  return null
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

/** Queue handler. Never throws: failures are recorded on the enrichment row. */
export async function runCompanyEnrichment(enrichmentId: string): Promise<void> {
  const row = await prisma.companyEnrichment.findUnique({ where: { id: enrichmentId } })
  if (!row) return

  const log = logger.child({ enrichmentId, crmCompanyId: row.crmCompanyId })
  const crm = getCrm()

  try {
    await prisma.companyEnrichment.update({
      where: { id: enrichmentId },
      data: { status: 'running', error: Prisma.DbNull },
    })

    // ── 1. CRM facts ────────────────────────────────────────────────────────
    const company = await crm.getCompany(row.crmCompanyId)
    if (!company) {
      await finish(enrichmentId, 'failed', {
        error: { message: 'Company not found in NXT Sales (it may have been recycle-binned).' },
      })
      return
    }

    const provenance: Claim[] = [
      claim('crm_data', `Company "${company.name}" loaded from NXT Sales.`),
      claim('crm_data', `Industry: ${orUnknown(company.industry)}; country: ${orUnknown(company.country)}.`),
    ]

    // ── 2. Website ──────────────────────────────────────────────────────────
    const site = chooseWebsite(company)
    if (!site) {
      provenance.push(claim('crm_data', 'No usable website: neither domain nor product URL is set on the CRM record.'))
      await finish(enrichmentId, 'no_website', {
        companyName: company.name,
        signals: baseSignals(company, 'no_website'),
        technologies: [],
        provenance,
      })
      log.info('no website on record')
      return
    }
    provenance.push(claim('crm_data', `Website taken from ${site.source}: ${site.url}`))

    // ── 3. Fetch, through the existing SSRF-guarded fetcher ──────────────────
    // fetchPage never throws on an unreachable site; it resolves ok:false so an
    // unreachable prospect is a recorded outcome, not a failed job.
    const page = await fetchPage(site.url, { tenantId: row.tenantId, runId: null })

    if (!page.ok) {
      provenance.push(claim('research', `Website could not be read: ${page.reason ?? 'unknown reason'}`))
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

    provenance.push(claim('research', `Fetched ${page.finalUrl ?? site.url}.`))
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
    })
    log.info({ technologies: technologies.length }, 'enriched')

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
        data: { status: 'failed', error: serializeError(err) as never, finishedAt: new Date() },
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
      fetchedAt: status === 'enriched' ? new Date() : null,
      finishedAt: new Date(),
    },
  })
}
