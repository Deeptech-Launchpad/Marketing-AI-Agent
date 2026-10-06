import { env } from '../../config/env.js'
import type { CandidateDraft, ProviderStatus } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'

// SOURCE — Hunter.io Domain Search.
//
// Hunter crawls the public web and records the email addresses it finds, along
// with the pages it found them on. That last part is what makes it usable
// here: every address arrives with `sources[]` — a URI, the date it was
// extracted, and whether it is still on the page — so a contact detail this
// engine reports can be checked by opening the page it came from.
//
// TWO THINGS THIS PROVIDER DELIBERATELY WILL NOT DO.
//
// 1. IT DOES NOT CALL /v2/email-finder.
//
//    That endpoint takes a name and a domain and returns the address the
//    person WOULD have if the organisation's pattern held — Hunter tells you
//    the pattern it inferred ("{first}.{last}", "{last}", and so on) and hands
//    back a synthesised address with a score. It is a well-built guess, and a
//    guess is exactly what this platform has committed never to present as a
//    contact detail. Only addresses Hunter actually OBSERVED, with sources,
//    become candidates here.
//
// 2. IT DOES NOT TURN A GENERIC MAILBOX INTO A PERSON.
//
//    Hunter marks each address `personal` or `generic`. info@, sales@, admin@
//    are generic: real, useful, and nobody. Stage 4 answers "who at this
//    company owns product data", and a shared inbox is not an answer to that.
//    Generic addresses are counted and named in the result's reason line so an
//    operator can see they exist, and they are not emitted as candidates.
//
// QUOTA. The configured plan is metered in SEARCHES, and a domain search costs
// one whether it returns fifty addresses or none. So this provider makes at
// most ONE request per company per run, never retries, and reports what the
// account has left — a discovery engine that silently burns a monthly
// allowance is worse than one that cannot run.

/**
 * The largest page any Hunter plan will serve without failing the request.
 *
 * The Free plan's ceiling. Higher tiers allow more, and asking for more here
 * would buy nothing: this stage wants the people at a company, not its mailing
 * list.
 */
const MAX_PAGE = 10

interface HunterSource {
  domain?: string
  uri?: string
  extracted_on?: string
  last_seen_on?: string
  still_on_page?: boolean
}

interface HunterEmail {
  value?: string
  type?: string
  confidence?: number
  first_name?: string | null
  last_name?: string | null
  position?: string | null
  seniority?: string | null
  department?: string | null
  linkedin?: string | null
  phone_number?: string | null
  verification?: { date?: string | null; status?: string | null } | null
  sources?: HunterSource[]
}

interface HunterDomainSearch {
  data?: {
    domain?: string
    organization?: string | null
    pattern?: string | null
    accept_all?: boolean
    emails?: HunterEmail[]
  }
  meta?: { results?: number }
  errors?: Array<{ id?: string; code?: number; details?: string }>
}

/** The date a source states, as a Date, or null when it states none. */
function sourceDate(s: HunterSource): Date | null {
  const raw = s.last_seen_on ?? s.extracted_on
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export class HunterProvider implements DecisionMakerProvider {
  readonly name = 'hunter'
  readonly sourceType = 'data_provider'

  available(ctx?: DmProviderContext): { status: ProviderStatus; reason?: string } {
    if (!env.HUNTER_API_KEY) {
      return {
        status: 'unauthorized',
        reason: 'HUNTER_API_KEY is not set, so no Hunter search was made.',
      }
    }
    // Hunter searches by DOMAIN. Without a verified one there is nothing to
    // search by, and searching by company name would return whichever
    // organisation happened to match the string.
    if (ctx && !ctx.companyDomain) {
      return {
        status: 'unavailable',
        reason:
          'No verified website domain for this company. Hunter searches by domain; matching on a company name instead would return whichever organisation shared the name.',
      }
    }
    return { status: 'available' }
  }

  async search(ctx: DmProviderContext): Promise<DmProviderResult> {
    const started = Date.now()
    const domain = ctx.companyDomain!

    const url = new URL('/v2/domain-search', env.HUNTER_API_BASE)
    url.searchParams.set('domain', domain)
    // Bounded by the caller's cap AND by the smallest page any Hunter plan
    // serves. Asking for more than the plan allows does not clamp — Hunter
    // fails the whole request with "results are limited to 10 email addresses
    // on your current plan" — and since the rule here is one request with no
    // retry, an over-large ask costs the entire lookup. Ten named people at
    // one company is well past what this stage needs anyway.
    url.searchParams.set('limit', String(Math.min(Math.max(ctx.maxResults, 1), MAX_PAGE)))
    url.searchParams.set('api_key', env.HUNTER_API_KEY)

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })

    const remaining = res.headers.get('x-ratelimit-remaining')
    const body = (await res.json().catch(() => ({}))) as HunterDomainSearch

    if (!res.ok) {
      const detail = body.errors?.[0]?.details ?? `Hunter returned HTTP ${res.status}.`
      // 401/403 is a fact about our account; 429 is a fact about our usage.
      // Neither is a fact about the company, and the status says which.
      const status: ProviderStatus =
        res.status === 401 || res.status === 403
          ? 'unauthorized'
          : res.status === 429
            ? 'rate_limited'
            : 'error'
      return {
        provider: this.name,
        status,
        candidates: [],
        reason: detail,
        metadata: { httpStatus: res.status, domain },
        durationMs: Date.now() - started,
      }
    }

    // A 200 whose body is not Hunter's data (an HTML error page, a truncated
    // reply) answers nothing about the company. It used to become "Hunter holds
    // no email address for this domain" — a provider fault presented as a
    // finding (2026-10-06).
    if (!body || typeof body !== 'object' || !('data' in body)) {
      return {
        provider: this.name,
        status: 'error',
        candidates: [],
        reason: 'Hunter answered, but not with the data it normally returns, so its result is unknown.',
        metadata: { httpStatus: res.status, domain },
        durationMs: Date.now() - started,
      }
    }

    const data = body.data ?? {}
    const emails = data.emails ?? []
    const generic = emails.filter((e) => e.type === 'generic')
    const named = emails.filter(
      (e) => e.type === 'personal' && e.value && (e.first_name?.trim() || e.last_name?.trim()),
    )

    const candidates: CandidateDraft[] = named.map((e) => {
      const fullName = [e.first_name, e.last_name].filter(Boolean).join(' ').trim()
      const sources = (e.sources ?? []).filter((s) => s.uri)

      return {
        fullName,
        rawTitle: e.position?.trim() || null,
        // Hunter states the organisation it holds for the domain. That is its
        // claim about the employer, and the engine's own company-match step
        // decides what to do with it.
        statedCompany: data.organization?.trim() || domain,
        profileUrl: e.linkedin?.trim() || null,
        providerPersonId: e.value ?? null,
        // Observed, never derived. An address only reaches this line because
        // Hunter saw it on a page, and the pages are carried below.
        email: e.value ?? null,
        phone: e.phone_number?.trim() || null,
        location: null,
        evidence: sources.slice(0, 4).map((s) => ({
          provider: this.name,
          sourceType: 'data_provider' as const,
          sourceUrl: s.uri ?? null,
          snippet:
            `Hunter recorded ${e.value} on ${s.uri}` +
            `${s.extracted_on ? `, extracted ${s.extracted_on}` : ''}` +
            `${s.still_on_page === false ? ' (no longer on that page)' : ''}.`,
          observedAt: sourceDate(s),
          supports: ['name', 'contact', ...(e.position ? (['title'] as const) : [])] as CandidateEvidenceSupports,
        })),
      }
    })

    // A search that found only shared inboxes is a real answer about this
    // company, and a different one from a search that found nothing at all.
    const reason =
      candidates.length > 0
        ? undefined
        : emails.length === 0
          ? `Hunter holds no email address for ${domain}.`
          : `Hunter holds ${emails.length} address(es) for ${domain}, none of them attributable to a named person` +
            `${generic.length > 0 ? ` (${generic.length} shared mailbox: ${generic.map((g) => g.value).filter(Boolean).slice(0, 3).join(', ')})` : ''}. ` +
            'No address was guessed from the organisation’s email pattern.'

    return {
      provider: this.name,
      status: 'available',
      candidates,
      reason,
      metadata: {
        domain,
        organization: data.organization ?? null,
        addressesHeld: emails.length,
        namedPeople: candidates.length,
        genericMailboxes: generic.length,
        // The shared mailboxes themselves, with the pages Hunter saw them on.
        // Never a person's address; kept so a company mailbox can be offered
        // when the decision maker has no email (companyContactEmail.ts).
        genericMailboxAddresses: generic
          .filter((g) => g.value)
          .slice(0, 10)
          .map((g) => ({ email: g.value!, sources: (g.sources ?? []).map((s) => s.uri).filter((u): u is string => Boolean(u)).slice(0, 3) })),
        // Recorded but NEVER used to synthesise an address. Kept because
        // "Hunter believes this org uses {first}.{last}" is worth knowing when
        // deciding whether to buy a lookup, and worth nothing as a contact.
        emailPatternHunterInferred: data.pattern ?? null,
        acceptAllDomain: data.accept_all ?? null,
        searchesRemaining: remaining ? Number(remaining) : null,
      },
      durationMs: Date.now() - started,
    }
  }
}

/** The evidence `supports` tuple, kept readable at the call site above. */
type CandidateEvidenceSupports = Array<'name' | 'title' | 'company' | 'profile_url' | 'contact'>
