import { env } from '../config/env.js'
import type { CrmPort } from '../crm/index.js'
import type { CrmCompany, CrmCompanyQuery } from '../crm/types.js'
import { prisma, newId } from '../platform/db.js'
import { judge, loadSuppressionContext, RECENT_CONTACT_WINDOW_DAYS } from './suppressionService.js'

// Turns a query into an immutable, explainable audience snapshot.
//
// No LLM is involved in this step at all: the model proposed the filters, but
// resolving them, applying suppression and capping the result is deterministic
// code. That separation is what makes the audience defensible.

export interface ResolveInput {
  tenantId: string
  segmentId: string
  campaignId?: string | null
  query: CrmCompanyQuery
  crm: CrmPort
  /**
   * A caller-requested ceiling ("find 100 companies"). Can only LOWER the
   * limit: env.MAX_AUDIENCE_SIZE remains the hard safety cap, and a request for
   * 5,000 still yields at most that.
   */
  limit?: number
}

export interface ResolveResult {
  snapshotId: string
  totalMatched: number
  totalSuppressed: number
  totalIncluded: number
  truncated: boolean
  /** The ceiling actually applied, after reconciling any request with the cap. */
  capApplied: number
  sample: Array<{
    crmCompanyId: string
    companyName: string
    industry: string | null
    country: string | null
    includeReason: string
  }>
}

/**
 * Scores a company against the requested filters. Purely a ranking aid for when
 * the audience must be capped — it decides WHICH of the matches survive the
 * cap, never whether a company matches at all.
 */
/**
 * Why THIS company is in the list. Built from the filters that actually matched
 * it, so every row can be defended individually rather than by pointing at the
 * query. Deliberately states only what was matched — it never characterises the
 * company or claims it has a problem.
 */
function explain(company: CrmCompany, query: CrmCompanyQuery): string {
  const parts: string[] = []
  if (query.industries?.length && company.industry) {
    parts.push(`industry "${company.industry}" is one of the ${query.industries.length} requested value(s)`)
  }
  if (query.countries?.length && company.country) {
    parts.push(`country "${company.country}" is one of the requested value(s)`)
  }
  if (query.leadStatuses?.length && company.leadStatus) {
    parts.push(`lead status "${company.leadStatus}" matched`)
  }
  if (query.cmsValues?.length && company.cms) {
    parts.push(`platform "${company.cms}" matched`)
  }
  if (query.hasDeal === false) parts.push('no open opportunity in the CRM')
  parts.push('passed suppression')
  return parts.length ? `Selected because ${parts.join('; ')}.` : 'Matched the segment filters and passed suppression.'
}

function score(company: CrmCompany, query: CrmCompanyQuery): number {
  let s = 0
  if (query.industries?.length && company.industry && query.industries.includes(company.industry)) s += 3
  if (query.countries?.length && company.country && query.countries.includes(company.country)) s += 2
  if (query.cmsValues?.length && company.cms && query.cmsValues.includes(company.cms)) s += 2
  if (company.linkedProfiles.length) s += 1
  if (company.email || company.emails.length) s += 1
  if (company.endPdpUrl) s += 1
  return s
}

export async function resolveAudience(input: ResolveInput): Promise<ResolveResult> {
  const { crm, query, tenantId } = input

  // /export applies the SAME filter builder as the list route, unpaginated —
  // so the snapshot is exactly what a user would see on screen for the same
  // filters, which is the property that makes it auditable.
  const matched = await crm.exportCompanies(query)

  // Companies with an open deal belong to sales, not to cold marketing.
  const deals = await crm.exportDeals()
  const activeDealCompanyIds = new Set(
    deals.filter((d) => d.companyId && !['Won', 'Lost'].includes(d.stage)).map((d) => d.companyId!),
  )

  // Recent-contact suppression. Checked only for companies that actually
  // matched, and only for those with any email history worth checking.
  const cutoff = Date.now() - RECENT_CONTACT_WINDOW_DAYS * 86_400_000
  const recentlyContacted = new Set<string>()
  const contactCandidates = matched.items.slice(0, env.MAX_AUDIENCE_SIZE * 2)
  for (const company of contactCandidates) {
    const activities = await crm.listActivities({ companyId: company.id, type: 'email' })
    if (activities.some((a) => new Date(a.createdAt).getTime() >= cutoff)) {
      recentlyContacted.add(company.id)
    }
  }

  const ctx = await loadSuppressionContext({
    tenantId,
    campaignId: input.campaignId ?? null,
    activeDealCompanyIds,
    recentlyContacted,
  })

  const eligible: Array<{ company: CrmCompany; score: number }> = []
  let totalSuppressed = 0

  for (const company of matched.items) {
    const decision = judge(company, ctx)
    if (decision.suppressed) {
      totalSuppressed++
      continue
    }
    eligible.push({ company, score: score(company, query) })
  }

  eligible.sort((a, b) => b.score - a.score || a.company.name.localeCompare(b.company.name))

  // Math.min so a caller can ask for fewer, never for more than the safety cap.
  const cap = Math.min(input.limit ?? env.MAX_AUDIENCE_SIZE, env.MAX_AUDIENCE_SIZE)
  const truncated = eligible.length > cap
  const included = eligible.slice(0, cap)

  const snapshotId = newId()
  await prisma.$transaction(async (tx) => {
    await tx.audienceSnapshot.create({
      data: {
        id: snapshotId,
        tenantId,
        segmentId: input.segmentId,
        queryUsed: query as never,
        totalMatched: matched.items.length,
        totalSuppressed,
        totalIncluded: included.length,
        truncated,
      },
    })
    if (included.length) {
      await tx.audienceMember.createMany({
        data: included.map(({ company, score: s }) => ({
          id: newId(),
          tenantId,
          snapshotId,
          crmCompanyId: company.id,
          // Denormalised on purpose: the snapshot must stay readable after the
          // CRM record is edited, reassigned or recycle-binned.
          companyName: company.name,
          domain: company.domain,
          industry: company.industry,
          country: company.country,
          cms: company.cms,
          ownerCrmUserId: company.ownerId,
          includeReason: explain(company, query),
          score: s,
        })),
      })
    }
  })

  return {
    snapshotId,
    totalMatched: matched.items.length,
    totalSuppressed,
    totalIncluded: included.length,
    truncated,
    capApplied: cap,
    sample: included.slice(0, 10).map(({ company }) => ({
      crmCompanyId: company.id,
      companyName: company.name,
      industry: company.industry,
      country: company.country,
      includeReason: explain(company, query),
    })),
  }
}
