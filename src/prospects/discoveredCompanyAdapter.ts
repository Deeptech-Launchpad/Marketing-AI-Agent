import { getCrm } from '../crm/index.js'
import type { CrmCompany } from '../crm/types.js'
import { hostOf, normalizeCompanyName, significantTokens } from '../decisionmakers/companyMatch.js'
import { registrableDomain } from '../enrichment/siteIdentity.js'
import { prisma } from '../platform/db.js'

// A DiscoveredCompany read as the CRM-shaped contract every provider already
// expects, so Enrichment, Intent Signals, Decision Maker Discovery and
// Outreach can run against a company found on the open web without a second
// code path.
//
// Every field this app has no answer for yet is null or empty — never
// guessed. `id` is the DiscoveredCompany's own id, which is also what a run's
// `crmCompanyId` column holds for a run against one of these (see that
// model's comment on the placeholder convention in prisma/schema.prisma).

interface DiscoveredLike {
  id: string
  companyName: string
  domain: string | null
  websiteUrl?: string | null
}

export function companyFromDiscovered(d: DiscoveredLike): CrmCompany {
  return {
    id: d.id,
    name: d.companyName,
    email: null,
    emails: [],
    phone: null,
    domain: discoveredWebsiteDomain(d),
    industry: null,
    country: null,
    cms: null,
    leadStatus: null,
    status: null,
    remarks: null,
    notes: null,
    endPdpUrl: null,
    contactPersons: [],
    linkedProfiles: [],
    ownerId: null,
    ownerName: null,
    dealCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * The company's OWN website domain, or null.
 *
 * The fit assessment states `domain` only when the page it read confirmed it
 * was the company's own site, and that always wins. Without one, the page
 * the company was read from is used only when its registrable domain is spelt
 * entirely from the company's own name ("magidglove.com" for "Magid Glove &
 * Safety") — so a news article or a directory listing the search happened to
 * find is never taken for the company's website. Anything else is null: a
 * website is never guessed from a name.
 */
export function discoveredWebsiteDomain(d: { companyName: string; domain: string | null; websiteUrl?: string | null }): string | null {
  if (d.domain?.trim()) return d.domain.trim()
  const host = hostOf(d.websiteUrl ?? null)
  if (!host) return null
  const site = registrableDomain(host)
  const label = site.split('.')[0]?.replace(/-/g, '') ?? ''
  return label && isSpeltFromName(label, d.companyName) ? site : null
}

/** True when `label` is made only of the company's own name words, one of them distinctive. */
/**
 * Words companies add to their name to make a web address: protoindustrial.com
 * for "PROTO", graingerdirect.com, acmesupplyusa.com. Allowed around the name,
 * never instead of it — a distinctive word of the name must still be there.
 */
const SITE_WORDS = ['industrial', 'industries', 'supply', 'supplies', 'direct', 'usa', 'us', 'online', 'store', 'shop', 'group', 'tools', 'products', 'mfg', 'inc', 'corp', 'co', 'global', 'intl']

function isSpeltFromName(label: string, companyName: string): boolean {
  const nameWords = [...new Set(normalizeCompanyName(companyName).split(/\s+/).filter((w) => w.length >= 2))]
  const distinctive = significantTokens(companyName)
  if (distinctive.length > 0) {
    if (!distinctive.some((t) => label.includes(t))) return false
  } else if (label !== nameWords.join('')) {
    // A name made only of generic words ("Global Industrial") is accepted
    // only as its exact spelling, never as a partial one.
    return false
  }
  const words = [...nameWords, ...SITE_WORDS]

  // Can `label` be cut, left to right, into words of the name?
  const reachable = new Array<boolean>(label.length + 1).fill(false)
  reachable[0] = true
  for (let i = 0; i < label.length; i++) {
    if (!reachable[i]) continue
    for (const w of words) if (label.startsWith(w, i)) reachable[i + w.length] = true
  }
  return reachable[label.length] === true
}

/**
 * The company a pipeline run is about, wherever it lives.
 *
 * An id that names a DiscoveredCompany resolves to the platform's own record
 * (found on the open web, not yet in NXT Sales); any other id is read from NXT
 * Sales. Every engine that used to ask the CRM alone asks this instead, so a
 * company selected from "Find New Company" is not reported as "not found in
 * NXT Sales" by each engine in turn.
 */
export async function resolvePipelineCompany(
  tenantId: string,
  id: string,
): Promise<{ company: CrmCompany; discoveredCompanyId: string | null } | null> {
  const discovered = await prisma.discoveredCompany.findFirst({
    where: { id, tenantId },
    select: { id: true, companyName: true, domain: true, websiteUrl: true },
  })
  if (discovered) return { company: companyFromDiscovered(discovered), discoveredCompanyId: discovered.id }

  const company = await getCrm().getCompany(id)
  return company ? { company, discoveredCompanyId: null } : null
}

/** The DiscoveredCompany id this pipeline id names, or null when it is a CRM id. */
export async function discoveredCompanyIdFor(tenantId: string, id: string): Promise<string | null> {
  const discovered = await prisma.discoveredCompany.findFirst({ where: { id, tenantId }, select: { id: true } })
  return discovered?.id ?? null
}
