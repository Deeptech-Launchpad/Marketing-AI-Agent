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
  /**
   * True when `company` is a DiscoveredCompany (found on the open web, not
   * yet in NXT Sales) rather than a real CRM record — `company.id` is that
   * row's id, held in the CRM-shaped contract as a placeholder. A provider
   * that only makes sense against an actual CRM record checks this instead
   * of finding out the hard way that every CRM call it makes fails.
   */
  isDiscovered?: boolean
}

/**
 * A stored signal this run has OBSERVED TO BE NO LONGER TRUE.
 *
 * Some signals are historical events — "a buyer role was posted on 3 August" —
 * and stay true forever; a later run must never withdraw one. Others are
 * statements about the PRESENT: the website cannot be reached, this platform
 * is in use. When a later observation contradicts one of those, the old signal
 * is not merely old, it is WRONG, and leaving it active presents a false fact
 * as current evidence.
 *
 * That is what happened to Ultra Taps. Three runs recorded "Company website
 * could not be reached" during a spell when the host really was resetting
 * connections. The site recovered, the next run read it successfully and
 * emitted nothing — and all three stale negatives stayed `active`, still
 * chipped "counts against outreach", on a company whose site loads fine.
 *
 * Superseding is deliberately NOT deletion. The signal keeps its evidence and
 * its date; it is marked expired and carries the observation that overtook it,
 * so the record still shows that the site was once unreachable.
 */
export interface SignalSupersession {
  /** Exactly which signal type is contradicted. Never a wildcard. */
  signalType: string
  /**
   * Only signals observed BEFORE this instant are superseded. A signal
   * observed after the contradicting evidence is newer information and stands.
   */
  observedBefore: Date
  /** The observation that overtook it, in words, kept on the expired row. */
  reason: string
  /**
   * Optional narrowing: only rows whose stored metadata this returns true for
   * are withdrawn. Lets a provider withdraw the specific rows of a type it can
   * show to be false, rather than every row of that type.
   */
  appliesTo?: (metadata: unknown) => boolean
}

export interface ProviderResult {
  provider: string
  ok: boolean
  signals: IntentSignalDraft[]
  /**
   * Stored signals this run has directly observed to be false. Applied by the
   * engine, never by the provider, so one uniform rule governs withdrawal.
   */
  supersedes?: SignalSupersession[]
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

/**
 * A provider that did not run because configuration switched it off. Recorded,
 * but distinct from a provider that tried and failed.
 */
export function isNotConfigured(result: { ok: boolean; metadata?: Record<string, unknown> | null }): boolean {
  return !result.ok && result.metadata?.notConfigured === true
}

/**
 * A provider that did not run because the company record gives it nothing to
 * read (no website, no name). Also an expected outcome, not a failure.
 */
export function isNotApplicable(result: { ok: boolean; metadata?: Record<string, unknown> | null }): boolean {
  return !result.ok && result.metadata?.notApplicable === true
}

/** A provider that tried to run and could not: the only kind that makes a run partial. */
export function isRealFailure(result: { ok: boolean; metadata?: Record<string, unknown> | null }): boolean {
  return !result.ok && !isNotConfigured(result) && !isNotApplicable(result)
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
      // Unavailability is decided by configuration (a token, an opt-in flag, a
      // capable Actor), not by anything that went wrong on this run. Marked so
      // readers can say "not configured" instead of "failed".
      metadata: { notConfigured: true },
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
