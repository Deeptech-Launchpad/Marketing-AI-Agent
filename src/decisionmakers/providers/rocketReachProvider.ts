import { env } from '../../config/env.js'
import type { CandidateDraft, ProviderStatus } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'

// SOURCE — RocketReach Person Search.
//
// NO ROCKETREACH CREDENTIALS EXIST IN THIS ENVIRONMENT. This adapter is
// written against `POST /api/v2/person/search` and reports `unauthorized`
// until ROCKETREACH_API_KEY is set.
//
// Note on contact data: RocketReach's search endpoint returns profiles;
// emails and phones come from a separate lookup that spends credits. That
// lookup is NOT called. Stage 4 answers "who", and "how to reach them" is a
// different question with different consequences.

interface RocketReachProfile {
  id?: number | string
  name?: string
  current_title?: string
  current_employer?: string
  linkedin_url?: string
  location?: string
  profile_pic?: string
}

export class RocketReachProvider implements DecisionMakerProvider {
  readonly name = 'rocketreach'
  readonly sourceType = 'data_provider'

  available(ctx?: DmProviderContext): { status: ProviderStatus; reason?: string } {
    if (!env.ROCKETREACH_API_KEY) {
      return {
        status: 'unauthorized',
        reason:
          'ROCKETREACH_API_KEY is not set. No RocketReach account exists in this environment, and its ' +
          'person-search API requires a paid plan.',
      }
    }
    if (ctx && !ctx.companyDomain && !ctx.company.name) {
      return { status: 'unavailable', reason: 'No company domain or name to scope the search by.' }
    }
    return { status: 'available' }
  }

  async search(ctx: DmProviderContext): Promise<DmProviderResult> {
    const started = Date.now()

    const res = await fetch(`${env.ROCKETREACH_API_BASE}/person/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Api-Key': env.ROCKETREACH_API_KEY,
      },
      body: JSON.stringify({
        start: 1,
        page_size: Math.min(ctx.maxResults, 25),
        query: {
          // Domain is preferred; the name is a weaker scope and is only used
          // when no verified domain exists.
          ...(ctx.companyDomain ? { current_employer_domain: [ctx.companyDomain] } : { current_employer: [ctx.company.name] }),
          current_title: ['ecommerce', 'merchandising', 'product data', 'product information', 'catalog', 'PIM'],
        },
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (res.status === 401 || res.status === 403) {
      return {
        provider: this.name,
        status: 'unauthorized',
        candidates: [],
        reason: `RocketReach rejected the credential (HTTP ${res.status}).`,
        durationMs: Date.now() - started,
      }
    }
    if (res.status === 429) {
      return {
        provider: this.name,
        status: 'rate_limited',
        candidates: [],
        reason: 'RocketReach returned HTTP 429.',
        durationMs: Date.now() - started,
      }
    }
    if (!res.ok) {
      return {
        provider: this.name,
        status: 'error',
        candidates: [],
        reason: `RocketReach returned HTTP ${res.status}.`,
        durationMs: Date.now() - started,
      }
    }

    const body = (await res.json()) as { profiles?: RocketReachProfile[] }
    const profiles = Array.isArray(body.profiles) ? body.profiles : []

    const candidates = profiles
      .map((p) => toDraft(p, this.name))
      .filter((d): d is CandidateDraft => d !== null)

    return {
      provider: this.name,
      status: candidates.length ? 'available' : 'no_results',
      candidates,
      reason: candidates.length ? undefined : 'RocketReach returned no profiles matching those titles at this company.',
      durationMs: Date.now() - started,
      metadata: { returned: profiles.length },
    }
  }
}

function toDraft(p: RocketReachProfile, provider: string): CandidateDraft | null {
  const fullName = p.name?.trim()
  if (!fullName) return null

  const title = p.current_title?.trim() || null
  const supports: Array<'name' | 'title' | 'company' | 'profile_url' | 'contact'> = ['name']
  if (title) supports.push('title')
  if (p.current_employer) supports.push('company')
  if (p.linkedin_url) supports.push('profile_url')

  return {
    fullName,
    rawTitle: title,
    statedCompany: p.current_employer ?? null,
    profileUrl: p.linkedin_url ?? null,
    providerPersonId: p.id ? `rocketreach:${p.id}` : null,
    email: null,
    phone: null,
    location: p.location ?? null,
    evidence: [
      {
        provider,
        sourceType: 'data_provider',
        sourceUrl: p.linkedin_url ?? null,
        snippet: [
          `RocketReach profile: ${fullName}`,
          title ? `title "${title}"` : 'no title stated',
          p.current_employer ? `at "${p.current_employer}"` : 'no employer stated',
        ].join(' | '),
        observedAt: null,
        supports,
      },
    ],
  }
}
