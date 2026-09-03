import type { ComposedMessage, FailureKind, OutreachChannel, OutreachTarget, ProviderStatus } from '../types.js'

// TASK #982 — the provider boundary.
//
//   outreach engine -> OutreachProvider -> a delivery, a draft, or a refusal
//
// The engine knows this interface and nothing else. It does not know whether
// email goes through SES or Postmark, whether LinkedIn is an API or a human
// with a browser, or whether a call is a dialer or a task in someone's queue.
//
// Every adapter must answer `availability()` honestly, including the case where
// the honest answer is "I cannot do this and here is exactly why". Three of the
// five channels in this environment answer that way, and the engine is built to
// carry on around them rather than fail the campaign.

export interface DeliveryContext {
  tenantId: string
  actionId: string
  channel: OutreachChannel
  target: OutreachTarget
  message: ComposedMessage
  /** True for a rehearsal: providers must not perform a real action. */
  dryRun: boolean
}

export interface Availability {
  status: ProviderStatus
  /** Required for every status except `available`. Never a bare "unavailable". */
  reason?: string
  /** What a human would have to do to change this. */
  remediation?: string
}

export interface DeliveryResult {
  status: ProviderStatus
  /** True only when something actually left this system. */
  delivered: boolean
  /** Set when the action is a legitimate draft for a human to execute. */
  manualRequired?: boolean
  /** The provider's own identifier, when it gives one. */
  providerMessageId?: string | null
  /** Sanitised provider response. Never carries a credential. */
  providerResponse?: Record<string, unknown>
  reason?: string
  failureKind?: FailureKind
  costUsd?: number
  durationMs: number
}

export interface OutreachProvider {
  readonly name: string
  readonly channel: OutreachChannel
  /**
   * Whether this provider can act right now.
   *
   * Called before every send and recorded on the action, so a campaign that
   * produced nothing can always be told apart from a campaign whose channels
   * were all unconfigured.
   */
  availability(): Availability
  /** Performs the action, or explains why it did not. Never throws. */
  deliver(ctx: DeliveryContext): Promise<DeliveryResult>
}

/**
 * Wraps a provider so one failing channel cannot fail a campaign.
 *
 * A throw becomes a classified failure. The classification matters more than
 * the message: `transient` will be retried, `permanent` will not, and getting
 * that wrong means either giving up too early or retrying forever against
 * someone else's server.
 */
export async function runProvider(provider: OutreachProvider, ctx: DeliveryContext): Promise<DeliveryResult> {
  const started = Date.now()

  const availability = provider.availability()
  if (availability.status !== 'available' && availability.status !== 'draft_only') {
    return {
      status: availability.status,
      delivered: false,
      reason: availability.reason ?? 'The provider reported itself unavailable without a reason.',
      failureKind: availability.status === 'rate_limited' ? 'rate_limited' : 'policy',
      durationMs: 0,
    }
  }

  try {
    return await provider.deliver(ctx)
  } catch (err) {
    const message = (err as Error).message ?? 'Unknown provider error.'
    const failureKind: FailureKind = /\b429\b|rate.?limit|too many requests/i.test(message)
      ? 'rate_limited'
      : /\b401\b|\b403\b|unauthor|forbidden|credential/i.test(message)
        ? 'unauthorized'
        : /timeout|timed out|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)
          ? 'transient'
          : 'permanent'

    return {
      status: 'provider_unavailable',
      delivered: false,
      reason: message,
      failureKind,
      durationMs: Date.now() - started,
    }
  }
}
