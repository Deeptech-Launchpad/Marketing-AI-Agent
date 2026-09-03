import { env } from '../../config/env.js'
import type { Availability, DeliveryContext, DeliveryResult, OutreachProvider } from './provider.js'

// CHANNEL — LINKEDIN.
//
// NO LINKEDIN CREDENTIALS EXIST IN THIS ENVIRONMENT, and this adapter will not
// obtain LinkedIn access any other way. That decision was made and documented
// in Task #978 and it holds here, where the stakes are higher: #978 only wanted
// to READ a profile, whereas this channel would ACT on the platform.
//
//   The Apify account attached to this project can reach LinkedIn automation
//   Actors. They work by driving LinkedIn without LinkedIn's authorisation.
//   Routing an action through a third party does not change what the action is,
//   and automating connection requests or messages that way risks the
//   prospect's account as well as ours.
//
// The compliant route is the LinkedIn Partner Program, which gates messaging
// behind an approved application. Until LINKEDIN_ACCESS_TOKEN is present with a
// messaging scope, this provider reports `draft_only`.
//
// `draft_only` is not a failure. The message is still composed, validated and
// stored, and the action is marked as requiring manual execution — an SDR opens
// the profile and sends it themselves. That distinction is the whole point of
// the status: the platform is honest that a human did the sending.

export class LinkedInProvider implements OutreachProvider {
  readonly name = 'linkedin'
  readonly channel = 'linkedin' as const

  availability(): Availability {
    if (!env.LINKEDIN_ACCESS_TOKEN) {
      return {
        status: 'draft_only',
        reason:
          'No LinkedIn API credential is configured. LinkedIn messaging requires an approved Partner Program application; ' +
          'there is no self-service credential. Third-party LinkedIn automation Actors ARE reachable from the configured ' +
          'Apify account and are deliberately NOT used, because automating the platform without authorisation breaches its ' +
          'terms and puts the recipient at risk as well as us.',
        remediation:
          'Obtain LinkedIn Partner Program access with a messaging scope and set LINKEDIN_ACCESS_TOKEN, then implement the specific endpoint that approval grants.',
      }
    }
    // A token alone does not grant messaging. Until the specific approved
    // endpoint is implemented, the honest status is still draft-only.
    return {
      status: 'draft_only',
      reason:
        'A LinkedIn access token is present, but no approved messaging endpoint is implemented. Automated sending stays off until the scope that application actually grants is wired explicitly.',
      remediation: 'Implement the messaging endpoint your approved application grants, then enable it for this channel.',
    }
  }

  /**
   * Produces a draft for a human to send.
   *
   * Nothing leaves this system. The result is a message and a profile URL, and
   * `manualRequired` tells the engine to mark the action accordingly.
   */
  async deliver(ctx: DeliveryContext): Promise<DeliveryResult> {
    const started = Date.now()

    if (!ctx.target.destination) {
      return {
        status: 'unsupported_action',
        delivered: false,
        reason: 'No LinkedIn profile URL is stored for this contact, and one is never inferred from a name.',
        failureKind: 'invalid_destination',
        durationMs: Date.now() - started,
      }
    }

    return {
      status: 'draft_only',
      delivered: false,
      manualRequired: true,
      reason:
        'Composed as a draft for manual sending. Open the profile and send it by hand — this platform does not act on LinkedIn.',
      providerResponse: { profileUrl: ctx.target.destination, characters: ctx.message.length },
      durationMs: Date.now() - started,
    }
  }
}
