import { env } from '../../config/env.js'
import { getCrm } from '../../crm/index.js'
import { prisma } from '../../platform/db.js'
import { normalizeCountry } from '../../intent/jobBoards.js'
import { logger } from '../../platform/logger.js'
import type { ResolvedOwner } from '../types.js'

// TASK #985 — who is responsible for this lead.
//
// THE RULE THAT SHAPES THIS FILE: NEVER GUESS A SALESPERSON.
//
// Assigning a high-intent lead to somebody who is not responsible for it is
// worse than leaving it unassigned. It makes the record look complete, it puts
// work on the wrong desk, and the lead that nobody owns stops being visible as
// a problem. So the chain below is explicit, ordered, and ends in "nobody"
// rather than in a fallback that picks a name.
//
// The resolution order is the one Task #985 specifies:
//   1. the company's own account owner in NXT Sales
//   2. REGION-WISE round-robin within the region's configured sales group
//   3. a configured fallback owner, verified against the real user list
//   4. a configured sales queue
//   5. nothing — reported as qualified_unassigned
//
// Every step verifies its candidate against the live CRM user list. A
// configured id that no longer resolves stops the chain rather than being
// skipped, because a rotation that silently drops a rep is a rotation nobody
// can reason about.
//
// There is no global rotation. A lead whose region has no configured group is
// left unassigned with the reason stated — that is the confirmed rule, and it
// is the only outcome that does not invent a region-to-user mapping.
//
// READ-ONLY. This reads the CRM through the port and writes nothing back.

/**
 * Parses the configured region groups.
 *
 *   "US:idA,idB;GB:idA"  ->  Map { US => [idA, idB], GB => [idA] }
 *
 * Region keys are normalised through the same country resolver the job-board
 * registry uses, so a group written as "USA" matches a company recorded as
 * "United States". A key that is not a recognised country is kept verbatim,
 * which leaves room for a grouping the business defines later without this
 * file inventing one.
 */
export function parseRegionGroups(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of String(raw ?? '').split(';')) {
    const [regionRaw, idsRaw] = part.split(':')
    if (!regionRaw || !idsRaw) continue
    const key = normalizeCountry(regionRaw.trim()) ?? regionRaw.trim().toUpperCase()
    const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    if (!ids.length) continue
    out.set(key, [...(out.get(key) ?? []), ...ids])
  }
  return out
}

export class SalesOwnerResolver {
  readonly name = 'crm-account-owner'

  /**
   * Resolves the responsible person for a company.
   *
   * Every returned owner is VERIFIED to be a real, current CRM user. An
   * `ownerId` that no longer resolves to a user is treated as no owner at all,
   * because routing work to a deleted account is the same failure as guessing.
   */
  async resolve(crmCompanyId: string): Promise<ResolvedOwner> {
    const crm = getCrm()

    let company: Awaited<ReturnType<typeof crm.getCompany>> = null
    try {
      company = await crm.getCompany(crmCompanyId)
    } catch (err) {
      logger.warn({ err, crmCompanyId }, 'sales qualification: could not read the company from the CRM')
      return {
        resolved: false,
        crmUserId: null,
        name: null,
        email: null,
        source: 'none',
        reason: 'The CRM could not be reached to determine the account owner, so no owner was assigned.',
      }
    }

    if (!company) {
      return {
        resolved: false,
        crmUserId: null,
        name: null,
        email: null,
        source: 'none',
        reason: 'That company no longer exists in NXT Sales, so no owner could be determined.',
      }
    }

    let users: Awaited<ReturnType<typeof crm.listUsers>> = []
    try {
      users = await crm.listUsers()
    } catch (err) {
      logger.warn({ err }, 'sales qualification: could not list CRM users')
    }
    const byId = new Map(users.map((u) => [u.id, u]))

    // ── 1. The account owner on the company record ─────────────────────────
    if (company.ownerId) {
      const user = byId.get(company.ownerId)
      if (user) {
        return {
          resolved: true,
          crmUserId: user.id,
          name: user.name,
          email: user.email,
          companyName: company.name,
          source: 'crm_account_owner',
          reason: `${user.name} is the account owner for ${company.name} in NXT Sales.`,
        }
      }
      // An owner id that does not resolve is a dangling reference, not an owner.
      logger.warn(
        { crmCompanyId, ownerId: company.ownerId },
        'sales qualification: company owner id does not match any current CRM user',
      )
    }

    // ── 2. REGION-WISE round-robin ─────────────────────────────────────────
    //
    // The confirmed rule: find the sales group for the company's region, then
    // rotate within that group. Explicitly NOT a global rotation.
    //
    // A region with no configured group leaves the lead unassigned with the
    // reason stated. That is the whole point of the rule — a lead outside the
    // configured regions has no correct owner, and picking one would be the
    // region-to-user mapping this platform is told not to invent.
    //
    // The rotation within a group is by CURRENT LOAD rather than a stored
    // cursor: the rep carrying the fewest open qualifications takes the next
    // lead, ties breaking on the configured order. That distributes evenly,
    // holds no state to drift, and self-corrects after a restart.
    const regionGroups = parseRegionGroups(env.SALES_REGION_ROUND_ROBIN)

    if (regionGroups.size > 0) {
      const region = normalizeCountry(company.country) ?? (company.country ?? '').trim().toUpperCase()
      const rotation = region ? (regionGroups.get(region) ?? []) : []

      if (!region) {
        return {
          resolved: false,
          crmUserId: null,
          name: null,
          email: null,
          companyName: company.name,
          source: 'none',
          reason:
            `${company.name} has no region recorded in NXT Sales, so no regional sales group applies. ` +
            'The lead was left unassigned rather than routed to an arbitrary rep.',
        }
      }

      if (rotation.length === 0) {
        return {
          resolved: false,
          crmUserId: null,
          name: null,
          email: null,
          companyName: company.name,
          source: 'none',
          reason:
            `No sales group is configured for region "${region}" (${company.country}). The lead was left ` +
            'unassigned rather than routed to a rep who is not responsible for that region. Configure the region ' +
            'in SALES_REGION_ROUND_ROBIN to route it.',
        }
      }
      const unknown = rotation.filter((id: string) => !byId.has(id))
      if (unknown.length > 0) {
        // Configured but wrong. Refuse the whole rotation rather than quietly
        // assigning every lead to whichever ids happen to be valid.
        logger.error(
          { unknown, configured: rotation },
          'sales qualification: SALES_REGION_ROUND_ROBIN contains ids that are not current CRM users',
        )
        return {
          resolved: false,
          crmUserId: null,
          name: null,
          email: null,
          companyName: company.name,
          source: 'none',
          reason:
            `The "${region}" sales group is configured, but ${unknown.length} of its ${rotation.length} user ` +
            'ids do not match a current NXT Sales user. No owner was assigned rather than routing the lead to an ' +
            'account that does not exist.',
        }
      }

      const chosen = await this.leastLoaded(rotation, byId)
      const user = byId.get(chosen)!
      return {
        resolved: true,
        crmUserId: user.id,
        name: user.name,
        email: user.email,
        companyName: company.name,
        source: 'round_robin',
        reason:
          `${company.name} has no account owner in NXT Sales, so the lead was assigned to ${user.name} by ` +
          `round-robin within the "${region}" sales group (${rotation.length} rep(s)).`,
      }
    }

    // ── 3. A configured fallback, verified against the real user list ──────
    if (env.SALES_FALLBACK_OWNER_CRM_USER_ID) {
      const user = byId.get(env.SALES_FALLBACK_OWNER_CRM_USER_ID)
      if (user) {
        return {
          resolved: true,
          crmUserId: user.id,
          name: user.name,
          email: user.email,
          companyName: company.name,
          source: 'configured_fallback',
          reason: `${company.name} has no account owner in NXT Sales, so the configured fallback owner ${user.name} was used.`,
        }
      }
      // Configured but wrong: say so rather than falling through silently.
      logger.error(
        { configured: env.SALES_FALLBACK_OWNER_CRM_USER_ID },
        'sales qualification: SALES_FALLBACK_OWNER_CRM_USER_ID is not a current CRM user',
      )
      return {
        resolved: false,
        crmUserId: null,
        name: null,
        email: null,
        companyName: company.name,
        source: 'none',
        reason:
          'A fallback sales owner is configured, but that id does not match any current NXT Sales user. No owner was assigned rather than routing the lead to an account that does not exist.',
      }
    }

    // ── 4. A configured sales queue ────────────────────────────────────────
    if (env.SALES_QUEUE_NAME) {
      return {
        resolved: true,
        crmUserId: null,
        name: env.SALES_QUEUE_NAME,
        email: null,
        companyName: company.name,
        source: 'sales_queue',
        reason: `${company.name} has no account owner, so the lead was placed in the "${env.SALES_QUEUE_NAME}" sales queue.`,
      }
    }

    // ── 5. Nobody. Reported, never invented. ───────────────────────────────
    return {
      resolved: false,
      crmUserId: null,
      name: null,
      email: null,
      companyName: company.name,
      source: 'none',
      reason: `High-intent lead identified, but no responsible sales owner is configured. ${company.name} has no account owner in NXT Sales, and no fallback owner or sales queue is configured.`,
    }
  }

  /**
   * The configured rep currently carrying the fewest open qualifications.
   *
   * Ties break on the configured order, so the result is deterministic for a
   * given database state and the same lead does not bounce between reps on
   * repeated evaluation.
   */
  private async leastLoaded(rotation: string[], byId: Map<string, { id: string }>): Promise<string> {
    const counts = await prisma.salesQualification.groupBy({
      by: ['ownerCrmUserId'],
      where: { ownerCrmUserId: { in: rotation }, status: { in: ['qualified', 'qualified_assigned'] } },
      _count: { _all: true },
    })
    const load = new Map(counts.map((c) => [c.ownerCrmUserId as string, c._count._all]))
    let best = rotation[0]!
    let bestLoad = load.get(best) ?? 0
    for (const id of rotation.slice(1)) {
      const n = load.get(id) ?? 0
      if (n < bestLoad) {
        best = id
        bestLoad = n
      }
    }
    void byId
    return best
  }
}
