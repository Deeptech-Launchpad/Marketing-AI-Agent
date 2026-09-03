import type { CrmCompany } from '../crm/types.js'
import { prisma, newId } from '../platform/db.js'

// Suppression. NXT Sales has no equivalent concept at all, so this is the only
// thing standing between a resolved audience and contacting someone who has
// asked not to be contacted, or who is mid-deal and should not receive cold
// outreach.
//
// Phase 1 sends nothing, but the audience is resolved WITH suppression applied
// so that the counts a reviewer approves are the real ones — not a number that
// would shrink later once sending is built.

const RECENT_CONTACT_DAYS = 30

export interface SuppressionDecision {
  suppressed: boolean
  reason?: string
}

export interface SuppressionContext {
  entries: Array<{ matchType: string; matchValue: string; reason: string }>
  recentlyContacted: Set<string>
  activeDealCompanyIds: Set<string>
}

function normaliseDomain(v: string | null): string {
  if (!v) return ''
  return v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
}

/**
 * Loads everything needed to judge a whole audience once, rather than querying
 * per company. An audience is hundreds of rows; per-row queries here would be
 * the same N+1 shape NXT Sales' bulk importer had to be fixed for.
 */
export async function loadSuppressionContext(params: {
  tenantId: string
  campaignId?: string | null
  activeDealCompanyIds: Set<string>
  recentlyContacted: Set<string>
}): Promise<SuppressionContext> {
  const rows = await prisma.suppressionEntry.findMany({
    where: {
      tenantId: params.tenantId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      AND: [
        {
          OR: [
            { scope: 'global' },
            ...(params.campaignId ? [{ scope: 'campaign', campaignId: params.campaignId }] : []),
          ],
        },
      ],
    },
    select: { matchType: true, matchValue: true, reason: true },
  })

  return {
    entries: rows.map((r) => ({
      matchType: r.matchType,
      matchValue: r.matchValue.trim().toLowerCase(),
      reason: r.reason,
    })),
    recentlyContacted: params.recentlyContacted,
    activeDealCompanyIds: params.activeDealCompanyIds,
  }
}

export function judge(company: CrmCompany, ctx: SuppressionContext): SuppressionDecision {
  if (ctx.activeDealCompanyIds.has(company.id)) {
    return { suppressed: true, reason: 'Company has an open deal — owned by sales, not marketing outreach.' }
  }
  if (ctx.recentlyContacted.has(company.id)) {
    return { suppressed: true, reason: `Contacted within the last ${RECENT_CONTACT_DAYS} days.` }
  }

  const domain = normaliseDomain(company.domain)
  const emails = [company.email, ...company.emails].filter(Boolean).map((e) => e!.trim().toLowerCase())

  for (const entry of ctx.entries) {
    if (entry.matchType === 'company' && entry.matchValue === company.id.toLowerCase()) {
      return { suppressed: true, reason: entry.reason }
    }
    if (entry.matchType === 'domain' && domain && entry.matchValue === domain) {
      return { suppressed: true, reason: entry.reason }
    }
    if (entry.matchType === 'email' && emails.includes(entry.matchValue)) {
      return { suppressed: true, reason: entry.reason }
    }
  }

  return { suppressed: false }
}

export const RECENT_CONTACT_WINDOW_DAYS = RECENT_CONTACT_DAYS

export async function addEntry(input: {
  tenantId: string
  scope: 'global' | 'campaign'
  matchType: 'company' | 'domain' | 'email'
  matchValue: string
  reason: string
  campaignId?: string | null
  createdByCrmUserId?: string | null
}): Promise<{ id: string }> {
  const row = await prisma.suppressionEntry.upsert({
    where: {
      tenantId_scope_matchType_matchValue: {
        tenantId: input.tenantId,
        scope: input.scope,
        matchType: input.matchType,
        matchValue: input.matchValue.trim().toLowerCase(),
      },
    },
    create: {
      id: newId(),
      tenantId: input.tenantId,
      scope: input.scope,
      matchType: input.matchType,
      matchValue: input.matchValue.trim().toLowerCase(),
      reason: input.reason,
      campaignId: input.campaignId ?? null,
      createdByCrmUserId: input.createdByCrmUserId ?? null,
    },
    update: { reason: input.reason },
    select: { id: true },
  })
  return row
}
