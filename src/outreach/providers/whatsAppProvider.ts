import { env } from '../../config/env.js'
import type { Availability, DeliveryContext, DeliveryResult, OutreachProvider } from './provider.js'

// CHANNEL — WHATSAPP / OTHER.
//
// NO WHATSAPP PROVIDER IS CONFIGURED, and this channel is DISABLED BY DEFAULT
// regardless. Task #982 says eligibility for an alternative channel belongs to
// business configuration, and that where that configuration is absent the
// default is disabled — so `OUTREACH_WHATSAPP_ENABLED` defaults to false and no
// eligibility rule is invented here.
//
// That matters more for WhatsApp than for the other channels. It is a personal
// messaging app; an unsolicited business message on it lands differently from
// an email, and in several jurisdictions it carries consent requirements that
// this platform has no record of satisfying. "High-value account" is a
// commercial judgement someone has to make and configure, not something to
// infer from a deal count.
//
// The adapter exists so that a configured provider is a config change. It never
// falls back to another channel: silently sending an email because WhatsApp was
// unavailable would be substituting a channel the recipient never agreed to.

export class WhatsAppProvider implements OutreachProvider {
  readonly name = 'whatsapp'
  readonly channel = 'whatsapp' as const

  availability(): Availability {
    if (!env.OUTREACH_WHATSAPP_ENABLED) {
      return {
        status: 'disabled_by_policy',
        reason:
          'The WhatsApp channel is disabled. Eligibility for an alternative channel is a business decision, and no ' +
          'eligibility rule has been configured — so the default is off rather than an invented "high-value" threshold.',
        remediation:
          'Define the eligibility criteria with the business, configure OUTREACH_WHATSAPP_MIN_DEAL_VALUE (or an explicit account list), then set OUTREACH_WHATSAPP_ENABLED=true.',
      }
    }
    if (!env.WHATSAPP_PROVIDER || env.WHATSAPP_PROVIDER === 'none') {
      return {
        status: 'not_configured',
        reason: 'The channel is enabled but no WhatsApp Business provider is configured (WHATSAPP_PROVIDER is unset).',
        remediation: 'Configure an approved WhatsApp Business API provider and its credentials.',
      }
    }
    return {
      status: 'not_configured',
      reason: `WHATSAPP_PROVIDER is "${env.WHATSAPP_PROVIDER}" but no transport is implemented for it.`,
      remediation: 'Implement the transport for that provider before enabling sending.',
    }
  }

  async deliver(ctx: DeliveryContext): Promise<DeliveryResult> {
    // Unreachable while availability() refuses. Explicit rather than thrown, so
    // wiring a real provider surfaces one clear next step.
    return {
      status: 'not_configured',
      delivered: false,
      reason: 'No WhatsApp transport is implemented. Nothing was sent and no other channel was substituted.',
      failureKind: 'policy',
      durationMs: 0,
    }
  }
}
