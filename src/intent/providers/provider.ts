import type { CrmCompany } from '../../crm/types.js'
import type { IntentSignalDraft } from '../types.js'

// The provider boundary.
//
//   intent collector -> provider -> normalized signal
//
// Every collection source implements this and nothing else. The engine knows
// about IntentProvider; it does not know that Apify exists, which Actor is in
// use, or whether jobs come from a scraper or the company's own careers page.
// Swapping or adding a provider is a new file and one registry entry.
//
// A provider's ONLY job is to return evidence. It does not assign confidence,
// compute freshness, deduplicate, or score — those are engine concerns applied
// uniformly, so one provider cannot flatter its own findings.

export interface ProviderContext {
  tenantId: string
  company: CrmCompany
  /** Bounds external work per company. Providers must respect it. */
  maxResults: number
}

export interface ProviderResult {
  provider: string
  ok: boolean
  signals: IntentSignalDraft[]
  /** Why nothing came back, when nothing came back. */
  reason?: string
  /** Provider-specific facts worth keeping for debugging and cost audit. */
  metadata?: Record<string, unknown>
  durationMs: number
  /** External spend attributable to this call, when the provider bills. */
  costUsd?: number
}

export interface IntentProvider {
  readonly name: string
  readonly category: string
  /**
   * Whether this provider can run at all right now — missing token, missing
   * website, disabled by config. Reported rather than silently skipped.
   */
  available(): { ok: boolean; reason?: string }
  collect(ctx: ProviderContext): Promise<ProviderResult>
}

/** Wraps a provider so one failing source cannot fail the whole collection. */
export async function runProvider(
  provider: IntentProvider,
  ctx: ProviderContext,
): Promise<ProviderResult> {
  const started = Date.now()
  const availability = provider.available()
  if (!availability.ok) {
    return {
      provider: provider.name,
      ok: false,
      signals: [],
      reason: availability.reason ?? 'unavailable',
      durationMs: 0,
    }
  }

  try {
    return await provider.collect(ctx)
  } catch (err) {
    return {
      provider: provider.name,
      ok: false,
      signals: [],
      reason: (err as Error).message,
      durationMs: Date.now() - started,
    }
  }
}
