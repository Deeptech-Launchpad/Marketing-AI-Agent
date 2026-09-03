import { env } from '../../config/env.js'
import type { CandidateDraft, ProviderStatus } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'

// SOURCE — ZoomInfo Contact Search.
//
// NO ZOOMINFO CREDENTIALS EXIST IN THIS ENVIRONMENT. ZoomInfo has no
// self-service API tier at all: access requires a negotiated enterprise
// contract, and there is no key to obtain by signing up. This adapter is
// written against the documented two-step flow (authenticate, then search) and
// reports `unauthorized` until credentials are configured.

interface ZoomInfoContact {
  id?: number | string
  firstName?: string
  lastName?: string
  jobTitle?: string
  companyName?: string
  companyWebsite?: string
  city?: string
  state?: string
  country?: string
  lastUpdatedDate?: string
  externalUrls?: Array<{ type?: string; url?: string }>
}

export class ZoomInfoProvider implements DecisionMakerProvider {
  readonly name = 'zoominfo'
  readonly sourceType = 'data_provider'

  private token: { value: string; expiresAt: number } | null = null

  available(ctx?: DmProviderContext): { status: ProviderStatus; reason?: string } {
    const hasBasic = Boolean(env.ZOOMINFO_USERNAME && env.ZOOMINFO_PASSWORD)
    const hasPki = Boolean(env.ZOOMINFO_USERNAME && env.ZOOMINFO_CLIENT_ID && env.ZOOMINFO_PRIVATE_KEY)
    if (!hasBasic && !hasPki) {
      return {
        status: 'unauthorized',
        reason:
          'No ZoomInfo credentials are set (needs ZOOMINFO_USERNAME with either ZOOMINFO_PASSWORD, or ' +
          'ZOOMINFO_CLIENT_ID + ZOOMINFO_PRIVATE_KEY for PKI auth). ZoomInfo has no self-service API tier: ' +
          'access requires an enterprise contract, so this cannot be unblocked by signing up.',
      }
    }
    if (ctx && !ctx.companyDomain) {
      return {
        status: 'unavailable',
        reason: 'ZoomInfo contact search is scoped by company website, and no verified domain is known for this company.',
      }
    }
    return { status: 'available' }
  }

  /** ZoomInfo issues a JWT valid for one hour; it is reused until it expires. */
  private async authenticate(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value

    const res = await fetch(`${env.ZOOMINFO_API_BASE}/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        env.ZOOMINFO_PASSWORD
          ? { username: env.ZOOMINFO_USERNAME, password: env.ZOOMINFO_PASSWORD }
          : {
              username: env.ZOOMINFO_USERNAME,
              clientId: env.ZOOMINFO_CLIENT_ID,
              privateKey: env.ZOOMINFO_PRIVATE_KEY,
            },
      ),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`ZoomInfo authentication failed with HTTP ${res.status}.`)

    const body = (await res.json()) as { jwt?: string }
    if (!body.jwt) throw new Error('ZoomInfo authentication returned no JWT.')

    this.token = { value: body.jwt, expiresAt: Date.now() + 55 * 60_000 }
    return body.jwt
  }

  async search(ctx: DmProviderContext): Promise<DmProviderResult> {
    const started = Date.now()
    const jwt = await this.authenticate()

    const res = await fetch(`${env.ZOOMINFO_API_BASE}/search/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        companyWebsite: ctx.companyDomain,
        jobTitle: 'ecommerce OR merchandising OR "product data" OR "product information" OR catalog',
        rpp: Math.min(ctx.maxResults, 25),
        page: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (res.status === 401 || res.status === 403) {
      return {
        provider: this.name,
        status: 'unauthorized',
        candidates: [],
        reason: `ZoomInfo rejected the credential (HTTP ${res.status}).`,
        durationMs: Date.now() - started,
      }
    }
    if (res.status === 429) {
      return {
        provider: this.name,
        status: 'rate_limited',
        candidates: [],
        reason: 'ZoomInfo returned HTTP 429.',
        durationMs: Date.now() - started,
      }
    }
    if (!res.ok) {
      return {
        provider: this.name,
        status: 'error',
        candidates: [],
        reason: `ZoomInfo returned HTTP ${res.status}.`,
        durationMs: Date.now() - started,
      }
    }

    const body = (await res.json()) as { data?: ZoomInfoContact[] }
    const contacts = Array.isArray(body.data) ? body.data : []

    const candidates = contacts
      .map((c) => toDraft(c, this.name))
      .filter((d): d is CandidateDraft => d !== null)

    return {
      provider: this.name,
      status: candidates.length ? 'available' : 'no_results',
      candidates,
      reason: candidates.length ? undefined : 'ZoomInfo returned no contacts matching those titles at this company.',
      durationMs: Date.now() - started,
      metadata: { returned: contacts.length },
    }
  }
}

function toDraft(c: ZoomInfoContact, provider: string): CandidateDraft | null {
  const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
  if (!fullName) return null

  const title = c.jobTitle?.trim() || null
  const linkedin = c.externalUrls?.find((u) => /linkedin/i.test(u.type ?? u.url ?? ''))?.url ?? null
  const observedAt = c.lastUpdatedDate ? new Date(c.lastUpdatedDate) : null

  const supports: Array<'name' | 'title' | 'company' | 'profile_url' | 'contact'> = ['name']
  if (title) supports.push('title')
  if (c.companyName) supports.push('company')
  if (linkedin) supports.push('profile_url')

  return {
    fullName,
    rawTitle: title,
    statedCompany: c.companyName ?? null,
    profileUrl: linkedin,
    providerPersonId: c.id ? `zoominfo:${c.id}` : null,
    // Contact enrichment is a separate, billed ZoomInfo endpoint and is not called.
    email: null,
    phone: null,
    location: [c.city, c.state, c.country].filter(Boolean).join(', ') || null,
    evidence: [
      {
        provider,
        sourceType: 'data_provider',
        sourceUrl: linkedin,
        snippet: [
          `ZoomInfo contact: ${fullName}`,
          title ? `title "${title}"` : 'no title stated',
          c.companyName ? `at "${c.companyName}"` : 'no employer stated',
        ].join(' | '),
        observedAt: observedAt && !Number.isNaN(observedAt.getTime()) ? observedAt : null,
        supports,
      },
    ],
  }
}
