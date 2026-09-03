import { env } from '../../config/env.js'
import type { CandidateDraft } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'
import type { ProviderStatus } from '../types.js'

// SOURCE — Apollo.io People Search.
//
// NO APOLLO CREDENTIALS EXIST IN THIS ENVIRONMENT. This adapter is written
// against the real `POST /mixed_people/search` contract and reports
// `unauthorized` until APOLLO_API_KEY is set, so obtaining a subscription is a
// config change rather than a code change.
//
// Deliberately NOT done: Apollo's data is also reachable through third-party
// scraper Actors that bypass its paywall. That is the same act as using the
// product without paying for it, and the Stage 4 access rules prohibit
// bypassing platform restrictions. So this adapter waits for a real key.
//
// Also deliberate: email reveal is NOT requested. Apollo bills credits to
// unmask an email, and this stage identifies WHO to approach — it does not
// need their inbox to do that.

interface ApolloPerson {
  id?: string
  name?: string
  first_name?: string
  last_name?: string
  title?: string
  linkedin_url?: string
  city?: string
  state?: string
  country?: string
  organization?: { name?: string; website_url?: string; primary_domain?: string }
  organization_name?: string
}

interface ApolloResponse {
  people?: ApolloPerson[]
  pagination?: { total_entries?: number }
}

/**
 * Titles the search asks Apollo for. This narrows the API call; it does NOT
 * decide relevance — every returned title is re-checked by the local role
 * taxonomy, because a provider matching "director" loosely is exactly the
 * failure this stage is built to avoid.
 */
const SEARCH_TITLES = [
  'VP Ecommerce',
  'Head of Ecommerce',
  'Director of Ecommerce',
  'Chief Merchandising Officer',
  'Director of Merchandising',
  'Director of Product Data',
  'Product Data Manager',
  'Product Information Manager',
  'PIM Manager',
  'Catalog Manager',
  'Director of Catalog',
  'Head of Digital',
  'Master Data Manager',
]

export class ApolloProvider implements DecisionMakerProvider {
  readonly name = 'apollo'
  readonly sourceType = 'data_provider'

  available(ctx?: DmProviderContext): { status: ProviderStatus; reason?: string } {
    if (!env.APOLLO_API_KEY) {
      return {
        status: 'unauthorized',
        reason:
          'APOLLO_API_KEY is not set. No Apollo.io account or API credential exists in this environment, ' +
          'and Apollo people-search data is not obtainable without one. Apollo data reachable via ' +
          'third-party scrapers was NOT used, because that bypasses the provider paywall.',
      }
    }
    if (ctx && !ctx.companyDomain) {
      return {
        status: 'unavailable',
        reason:
          'Apollo people-search is scoped by organization domain, and this company has no verified ' +
          'website domain from Stage 2 enrichment. Searching by name alone returns people at ' +
          'similarly-named companies.',
      }
    }
    return { status: 'available' }
  }

  async search(ctx: DmProviderContext): Promise<DmProviderResult> {
    const started = Date.now()

    const res = await fetch(`${env.APOLLO_API_BASE}/mixed_people/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': env.APOLLO_API_KEY,
      },
      body: JSON.stringify({
        q_organization_domains: [ctx.companyDomain],
        person_titles: SEARCH_TITLES,
        page: 1,
        per_page: Math.min(ctx.maxResults, 25),
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (res.status === 401 || res.status === 403) {
      return {
        provider: this.name,
        status: 'unauthorized',
        candidates: [],
        reason: `Apollo rejected the credential (HTTP ${res.status}).`,
        durationMs: Date.now() - started,
      }
    }
    if (res.status === 429) {
      return {
        provider: this.name,
        status: 'rate_limited',
        candidates: [],
        reason: 'Apollo returned HTTP 429.',
        durationMs: Date.now() - started,
      }
    }
    if (!res.ok) {
      return {
        provider: this.name,
        status: 'error',
        candidates: [],
        reason: `Apollo returned HTTP ${res.status}.`,
        durationMs: Date.now() - started,
      }
    }

    const body = (await res.json()) as ApolloResponse
    const people = Array.isArray(body.people) ? body.people : []

    const candidates: CandidateDraft[] = people
      .map((p) => toDraft(p, this.name))
      .filter((d): d is CandidateDraft => d !== null)

    return {
      provider: this.name,
      status: candidates.length ? 'available' : 'no_results',
      candidates,
      reason: candidates.length ? undefined : 'Apollo returned no people with a usable name at this domain.',
      durationMs: Date.now() - started,
      metadata: { returned: people.length, totalEntries: body.pagination?.total_entries ?? null },
    }
  }
}

function toDraft(p: ApolloPerson, provider: string): CandidateDraft | null {
  const fullName = (p.name ?? [p.first_name, p.last_name].filter(Boolean).join(' ')).trim()
  // A person without a name is not a candidate. It is not completed from an
  // email local-part or anything else.
  if (!fullName) return null

  const statedCompany = p.organization?.name ?? p.organization_name ?? null
  const title = p.title?.trim() || null
  const location = [p.city, p.state, p.country].filter(Boolean).join(', ') || null

  const supports: Array<'name' | 'title' | 'company' | 'profile_url' | 'contact'> = ['name']
  if (title) supports.push('title')
  if (statedCompany) supports.push('company')
  if (p.linkedin_url) supports.push('profile_url')

  return {
    fullName,
    rawTitle: title,
    statedCompany,
    profileUrl: p.linkedin_url ?? null,
    providerPersonId: p.id ? `apollo:${p.id}` : null,
    // Apollo returns email only behind a paid reveal, which is not requested.
    email: null,
    phone: null,
    location,
    evidence: [
      {
        provider,
        sourceType: 'data_provider',
        sourceUrl: p.linkedin_url ?? null,
        snippet: [
          `Apollo record: ${fullName}`,
          title ? `title "${title}"` : 'no title stated',
          statedCompany ? `at "${statedCompany}"` : 'no employer stated',
        ].join(' | '),
        // Apollo does not date its records, so there is no observation date to
        // record. Left null rather than stamped with "now", which would claim
        // the underlying fact is current when only the lookup is.
        observedAt: null,
        supports,
      },
    ],
  }
}
