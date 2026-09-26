import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { audit } from '../platform/audit.js'
import { prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { enqueue, QUEUE_DM_DISCOVER } from '../platform/queue.js'
import { markDecisionMakerRunEnqueueFailed, queueDecisionMakerDiscovery } from './discovery.js'

// NEW LEAD → DECISION-MAKER DISCOVERY, AUTOMATICALLY.
//
// NXT Sales emits no event when a company is created, and this service may not
// change NXT Sales. So the worker ASKS, on a schedule: which companies were
// created within the lookback window, and which of those has never been
// searched? Each such company gets exactly one ordinary discovery run.
//
// What this adds is WHEN a search starts, and nothing else. The run it queues
// is the same run the "Find decision makers" button queues — same providers,
// same verification, same ranking — so an automatic search cannot believe
// anything a manual one would not.
//
// Bounded three ways, because every search spends budget:
//   · only companies created inside DM_AUTO_DISCOVER_LOOKBACK_HOURS count;
//   · a company that has EVER been searched is skipped (checked under a lock);
//   · at most DM_AUTO_DISCOVER_MAX_PER_CHECK searches start per check, and the
//     rest are picked up by the next one.
//
// Read-only against the CRM. Nothing here writes to NXT Sales.

/** How many of the newest companies one check reads. */
const CRM_PAGE_SIZE = 100
/** Upper bound on pages one check reads. */
const CRM_MAX_PAGES = 5

export interface LeadWatchResult {
  enabled: boolean
  /** Companies created inside the lookback window. */
  newLeads: number
  /** Of those, already searched at some point (manually or automatically). */
  alreadySearched: number
  /** Searches started by this check. */
  queued: Array<{ crmCompanyId: string; companyName: string; dmRunId: string }>
  /** New, never-searched leads left for the next check by the per-check cap. */
  deferred: number
  reason?: string
}

export async function checkForNewLeads(now: Date = new Date()): Promise<LeadWatchResult> {
  const empty = { newLeads: 0, alreadySearched: 0, queued: [], deferred: 0 }
  if (!env.DM_AUTO_DISCOVER_ENABLED) {
    return { enabled: false, ...empty, reason: 'DM_AUTO_DISCOVER_ENABLED is off.' }
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: env.DEFAULT_TENANT_SLUG }, select: { id: true } })
  if (!tenant) {
    return { enabled: true, ...empty, reason: `No tenant with slug "${env.DEFAULT_TENANT_SLUG}" exists yet.` }
  }

  // NXT Sales' default list order is pinned first, then newest-created, so the
  // newest leads are on the first page. Pinned older companies are removed by
  // the creation-date filter below.
  //
  // A busy day can create more than one page of companies, so further pages
  // are read while the oldest company on the last page is still inside the
  // window — bounded by CRM_MAX_PAGES.
  const since = now.getTime() - env.DM_AUTO_DISCOVER_LOOKBACK_HOURS * 3_600_000
  const items: Array<{ id: string; name: string; createdAt: string }> = []
  for (let p = 1; p <= CRM_MAX_PAGES; p++) {
    const page = await getCrm().searchCompanies({ page: p, limit: CRM_PAGE_SIZE })
    items.push(...page.items)
    if (page.items.length < CRM_PAGE_SIZE) break
    const oldest = Date.parse(page.items[page.items.length - 1]!.createdAt)
    if (!Number.isFinite(oldest) || oldest < since) break
  }
  const seen = new Set<string>()
  const fresh = items.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    const created = Date.parse(c.createdAt)
    return Number.isFinite(created) && created >= since && created <= now.getTime()
  })
  if (!fresh.length) return { enabled: true, ...empty }

  const searched = await prisma.decisionMakerRun.findMany({
    where: { tenantId: tenant.id, crmCompanyId: { in: fresh.map((c) => c.id) } },
    select: { crmCompanyId: true },
    distinct: ['crmCompanyId'],
  })
  const searchedIds = new Set(searched.map((r) => r.crmCompanyId))
  // Oldest first, so a lead deferred by the cap is not starved by newer ones.
  const pending = fresh
    .filter((c) => !searchedIds.has(c.id))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

  const queued: LeadWatchResult['queued'] = []
  let alreadySearched = searchedIds.size

  for (const company of pending.slice(0, env.DM_AUTO_DISCOVER_MAX_PER_CHECK)) {
    const { id, reused } = await queueDecisionMakerDiscovery({
      tenantId: tenant.id,
      crmCompanyId: company.id,
      // The service account this agent already uses to read NXT Sales: the
      // search was requested by the system, not by a person.
      requestedByCrmUserId: env.NXT_SALES_SERVICE_USER_ID,
      onlyIfNeverSearched: true,
    })
    if (reused) {
      // A search started between the read above and the lock — manual or
      // another check. That search stands; nothing is repeated.
      alreadySearched += 1
      continue
    }
    try {
      await enqueue(QUEUE_DM_DISCOVER, { dmRunId: id })
    } catch (err) {
      // The run exists but no job does. Close it as failed rather than leave
      // a "queued" row nothing will ever pick up.
      await markDecisionMakerRunEnqueueFailed(id, err)
      logger.warn({ err: (err as Error).message, crmCompanyId: company.id, dmRunId: id }, 'lead watch: enqueue failed')
      continue
    }
    queued.push({ crmCompanyId: company.id, companyName: company.name, dmRunId: id })

    await audit({
      tenantId: tenant.id,
      actorType: 'system',
      action: 'decision_makers.auto_queued',
      resourceType: 'DecisionMakerRun',
      resourceId: id,
      summary: `New lead "${company.name}" queued for decision-maker discovery`,
      metadata: { crmCompanyId: company.id, leadCreatedAt: company.createdAt },
    })
  }

  const result: LeadWatchResult = {
    enabled: true,
    newLeads: fresh.length,
    alreadySearched,
    queued,
    deferred: Math.max(0, pending.length - env.DM_AUTO_DISCOVER_MAX_PER_CHECK),
  }
  logger.info(
    { newLeads: result.newLeads, alreadySearched, queued: queued.length, deferred: result.deferred },
    'lead watch: checked for new leads',
  )
  return result
}
