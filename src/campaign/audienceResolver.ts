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
  /**
   * When true, companies with an open deal are NOT suppressed. Default false:
   * an open deal belongs to sales. Set only when the requester explicitly asked
   * to include existing opportunities.
   */
  includeOpenDeals?: boolean
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

/** Parallel contact-history reads per batch; the CRM client rate-limits beneath this. */
const CONTACT_CHECK_CONCURRENCY = 10

/** NXT Sales matches filter values case-insensitively, so the ranking must too. */
function inList(value: string | null, list: string[] | undefined): boolean {
  if (!value || !list?.length) return false
  const v = value.trim().toLowerCase()
  return list.some((x) => x.trim().toLowerCase() === v)
}

/**
 * Facts the CRM record itself carries that make a company more actionable for
 * the next stages. Each is a present/absent check on the company's own fields
 * — nothing is inferred, and none of them claims anything about the company's
 * needs. They are what distinguishes one filter-matching company from another.
 */
function recordSignals(company: CrmCompany): string[] {
  const signals: string[] = []
  if (company.domain?.trim()) signals.push('a website')
  if (company.endPdpUrl?.trim()) signals.push('a product page URL')
  if (company.contactPersons.some((c) => c?.trim())) signals.push('a named contact person')
  if (company.email?.trim() || company.emails.some((e) => e?.trim())) signals.push('an email address')
  if (company.linkedProfiles.some((l) => l?.trim())) signals.push('a LinkedIn profile')
  return signals
}

/**
 * Why THIS company is in the list. Built from the filters that actually matched
 * it, so every row can be defended individually rather than by pointing at the
 * query. Deliberately states only what was matched — it never characterises the
 * company or claims it has a problem.
 */
function explain(company: CrmCompany, query: CrmCompanyQuery, openDealsExcluded = true): string {
  const parts: string[] = []
  if (inList(company.industry, query.industries)) {
    parts.push(`industry "${company.industry}" is one of the ${query.industries!.length} requested value(s)`)
  }
  if (inList(company.country, query.countries)) {
    parts.push(`country "${company.country}" is one of the requested value(s)`)
  }
  if (inList(company.leadStatus, query.leadStatuses)) {
    parts.push(`lead status "${company.leadStatus}" matched`)
  }
  if (inList(company.cms, query.cmsValues)) {
    parts.push(`platform "${company.cms}" matched`)
  }
  if (query.hasDeal === false) parts.push('no deal on record in the CRM')
  else if (openDealsExcluded) parts.push('no open opportunity in the CRM')
  parts.push('passed suppression')
  const signals = recordSignals(company)
  const ranked = signals.length
    ? ` Ranked on the CRM record having ${signals.join(', ')}.`
    : ' The CRM record carries no website, product page, contact person, email or LinkedIn profile, so it ranks below records that do.'
  return `Selected because ${parts.join('; ')}.${ranked}`
}

/**
 * Ranking aid for when the audience must be capped — it decides WHICH of the
 * matches survive the cap, never whether a company matches at all.
 *
 * Filter matches are worth more than record completeness, but on a filtered
 * export every company matches the filters equally, so it is the record
 * signals that actually order the list. Ties fall back to name.
 */
export function score(company: CrmCompany, query: CrmCompanyQuery): number {
  let s = 0
  if (inList(company.industry, query.industries)) s += 3
  if (inList(company.country, query.countries)) s += 2
  if (inList(company.cms, query.cmsValues)) s += 2
  s += recordSignals(company).length
  return s
}

export async function resolveAudience(input: ResolveInput): Promise<ResolveResult> {
  const { crm, query, tenantId } = input

  // /export applies the SAME filter builder as the list route, unpaginated —
  // so the snapshot is exactly what a user would see on screen for the same
  // filters, which is the property that makes it auditable.
  const matched = await crm.exportCompanies(query)

  // Companies with an open deal belong to sales, not to cold marketing — unless
  // the requester explicitly asked for existing opportunities.
  const includeOpenDeals = input.includeOpenDeals === true
  const activeDealCompanyIds = new Set<string>()
  if (!includeOpenDeals) {
    const deals = await crm.exportDeals()
    deals
      .filter((d) => d.companyId && !['Won', 'Lost'].includes(d.stage))
      .forEach((d) => activeDealCompanyIds.add(d.companyId!))
  }

  // Recent-contact history is a per-company CRM call, so it is checked AFTER
  // ranking and only for the companies about to be chosen. The shared context
  // therefore carries an empty set; the contact check is applied below.
  const ctx = await loadSuppressionContext({
    tenantId,
    campaignId: input.campaignId ?? null,
    activeDealCompanyIds,
    recentlyContacted: new Set<string>(),
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

  // Walk the RANKED list, checking contact history, until the cap is filled.
  // A company that drops out is replaced by the next-ranked one, so the list
  // is never short because of CRM order, and never includes an unchecked row.
  const cutoff = Date.now() - RECENT_CONTACT_WINDOW_DAYS * 86_400_000
  const included: Array<{ company: CrmCompany; score: number }> = []
  let cursor = 0
  while (included.length < cap && cursor < eligible.length) {
    const batch = eligible.slice(cursor, cursor + Math.min(cap - included.length, CONTACT_CHECK_CONCURRENCY))
    cursor += batch.length
    const contacted = await Promise.all(
      batch.map(async ({ company }) => {
        const activities = await crm.listActivities({ companyId: company.id, type: 'email' })
        return activities.some((a) => new Date(a.createdAt).getTime() >= cutoff)
      }),
    )
    batch.forEach((row, i) => {
      if (contacted[i]) totalSuppressed++
      else if (included.length < cap) included.push(row)
    })
  }
  // Companies never reached remain eligible but uncounted: that is truncation.
  const truncated = cursor < eligible.length

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
          includeReason: explain(company, query, !includeOpenDeals),
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
      includeReason: explain(company, query, !includeOpenDeals),
    })),
  }
}
