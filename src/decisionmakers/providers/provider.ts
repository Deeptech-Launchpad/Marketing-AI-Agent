import type { CrmCompany } from '../../crm/types.js'
import type { CandidateDraft, ProviderStatus } from '../types.js'

// The Stage 4 provider boundary.
//
//   discovery engine -> DecisionMakerProvider -> CandidateDraft[]
//
// The engine knows this interface and nothing else. It does not know whether a
// person came from Apollo, from a leadership page, or from the CRM. Adding a
// provider is a new file and one registry entry; removing one changes nothing
// else. That matters more than usual here, because four of the five providers
// this stage was specified around have no credentials in this environment —
// they are implemented as real adapters that report WHY they cannot run, so
// buying access later is a config change rather than a rewrite.
//
// A provider returns observations. It never assigns confidence, verifies the
// company, deduplicates or ranks — the engine does all of that uniformly.

export interface DmProviderContext {
  tenantId: string
  company: CrmCompany
  /** Verified website host from Stage 2 enrichment, when there is one. */
  companyDomain: string | null
  /** Bounds external work per company. Providers must respect it. */
  maxResults: number
}

export interface DmProviderResult {
  provider: string
  status: ProviderStatus
  candidates: CandidateDraft[]
  /**
   * Why the provider ended in this status. REQUIRED for every status except
   * `available`, so a blocker can never be mistaken for an empty market.
   */
  reason?: string
  metadata?: Record<string, unknown>
  durationMs: number
  /** External spend attributable to this call, when the provider bills. */
  costUsd?: number
}

export interface DecisionMakerProvider {
  readonly name: string
  /** What kind of source this is, for evidence weighting. */
  readonly sourceType: string
  /**
   * Whether the provider can run right now. Returns the precise blocker:
   * `unauthorized` for missing/denied credentials, `unavailable` for missing
   * input data or a disabled config.
   */
  available(ctx?: DmProviderContext): { status: ProviderStatus; reason?: string }
  search(ctx: DmProviderContext): Promise<DmProviderResult>
}

/**
 * Wraps a provider so one dead source cannot fail a whole discovery run, and
 * so an unavailable provider is RECORDED rather than silently skipped.
 */
export async function runDmProvider(
  provider: DecisionMakerProvider,
  ctx: DmProviderContext,
): Promise<DmProviderResult> {
  const started = Date.now()

  const availability = provider.available(ctx)
  if (availability.status !== 'available') {
    return {
      provider: provider.name,
      status: availability.status,
      candidates: [],
      reason: availability.reason ?? 'Provider reported itself unavailable without a reason.',
      durationMs: 0,
    }
  }

  try {
    const result = await provider.search(ctx)
    // A provider that returns nothing must say so as `no_results`, not as a
    // success with an empty list — the two read very differently in a report.
    if (result.status === 'available' && result.candidates.length === 0) {
      return { ...result, status: 'no_results', reason: result.reason ?? 'Source returned no matching people.' }
    }
    return result
  } catch (err) {
    const message = (err as Error).message
    // Rate limiting is worth distinguishing: it means retry later, whereas an
    // error usually means the integration is wrong.
    const status: ProviderStatus = /\b429\b|rate.?limit|too many requests/i.test(message)
      ? 'rate_limited'
      : 'error'
    return {
      provider: provider.name,
      status,
      candidates: [],
      reason: message,
      durationMs: Date.now() - started,
    }
  }
}
