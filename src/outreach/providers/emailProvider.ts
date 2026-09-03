import { env } from '../../config/env.js'
import type { Availability, DeliveryContext, DeliveryResult, OutreachProvider } from './provider.js'

// CHANNEL — EMAIL.
//
// NO EMAIL PROVIDER IS CONFIGURED IN THIS ENVIRONMENT. There is no SMTP host,
// no SendGrid, Mailgun, Postmark, SES or Resend credential anywhere in the
// service, and no mail library is installed.
//
// There is also NO RECIPIENT ADDRESS, which is the more interesting blocker.
// Task #978 verified sixteen real people at these companies and stored zero
// email addresses, because none of the person-data providers was reachable and
// it refused to pattern-guess one from a name and a domain. That refusal is
// upstream of this file and this file honours it: a company switchboard address
// is not the decision maker's inbox, and sending to it is not the same thing.
//
// So an email action here is blocked twice over, and both reasons are recorded
// separately — buying a mail provider would fix one of them and not the other.
//
// The adapter is written against a generic transport contract so that
// configuring a provider is a config change rather than a rewrite.

export class EmailProvider implements OutreachProvider {
  readonly name = 'email'
  readonly channel = 'email' as const

  availability(): Availability {
    if (!env.EMAIL_PROVIDER || env.EMAIL_PROVIDER === 'none') {
      return {
        status: 'not_configured',
        reason:
          'No email provider is configured (EMAIL_PROVIDER is unset). There is no SMTP host or transactional email credential in this environment, and no mail library is installed.',
        remediation:
          'Set EMAIL_PROVIDER and the matching credentials, and configure OUTREACH_FROM_EMAIL with a verified sending domain.',
      }
    }
    if (!env.OUTREACH_FROM_EMAIL) {
      return {
        status: 'not_configured',
        reason: 'A provider is configured but OUTREACH_FROM_EMAIL is not set, so there is no verified sender.',
        remediation: 'Set OUTREACH_FROM_EMAIL to an address on a domain verified with the provider.',
      }
    }
    return { status: 'available' }
  }

  async deliver(ctx: DeliveryContext): Promise<DeliveryResult> {
    const started = Date.now()

    // Reachable only once a provider is configured. Kept explicit rather than
    // thrown so wiring a real transport is one obvious edit.
    if (!ctx.target.destination) {
      return {
        status: 'unsupported_action',
        delivered: false,
        reason: 'No verified recipient address is stored for this contact, and one is never guessed from a name.',
        failureKind: 'invalid_destination',
        durationMs: Date.now() - started,
      }
    }

    if (ctx.dryRun) {
      return {
        status: 'available',
        delivered: false,
        reason: 'Dry run: the message was composed and validated but not sent.',
        durationMs: Date.now() - started,
      }
    }

    return {
      status: 'unsupported_action',
      delivered: false,
      reason:
        `EMAIL_PROVIDER is "${env.EMAIL_PROVIDER}" but no transport is implemented for it. ` +
        'Implement the transport for that provider before enabling automatic sending.',
      failureKind: 'permanent',
      durationMs: Date.now() - started,
    }
  }
}

/**
 * The follow-up shares the email transport but is its own channel.
 *
 * Composition rather than subclassing: a follow-up is not a kind of first
 * email, it has a different template, a different schedule and its own
 * dependency on the first message having actually gone.
 */
export class EmailFollowUpProvider implements OutreachProvider {
  readonly name = 'email_followup'
  readonly channel = 'email_followup' as const
  private readonly transport = new EmailProvider()

  availability(): Availability {
    return this.transport.availability()
  }

  deliver(ctx: DeliveryContext): Promise<DeliveryResult> {
    return this.transport.deliver(ctx)
  }
}
