import { env } from '../../config/env.js'
import type { CandidateDraft, ProviderStatus } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'

// SOURCE — LinkedIn, via the official API only.
//
// NO LINKEDIN CREDENTIALS EXIST IN THIS ENVIRONMENT, and this provider will
// not obtain LinkedIn data any other way. That decision is worth writing down,
// because a cheaper route was available and was rejected:
//
//   The Apify account attached to this project can reach LinkedIn people-search
//   Actors — harvestapi~linkedin-profile-search and dev_fusion~Linkedin-Profile-
//   Scraper are both pay-per-event and affordable on the current plan. They
//   work by scraping LinkedIn without LinkedIn's authorisation.
//
//   Routing that through a third party does not change what it is. LinkedIn's
//   User Agreement prohibits automated collection, and the Stage 4 access rules
//   say not to scrape LinkedIn where access is unavailable and not to bypass
//   platform restrictions. Paying an intermediary to do the prohibited thing is
//   the prohibited thing. So the Actors are not called.
//
// The only compliant route is the LinkedIn Partner Program, which gates person
// data behind an approved application. Until LINKEDIN_ACCESS_TOKEN is present,
// this provider reports `unauthorized` and returns nothing.
//
// WHAT IT STILL DOES: LinkedIn URLs that OTHER sources hand us (a company site
// linking its own staff, a CRM contact record) are passed through as reference
// links, unvisited. Recording a URL a source published is not scraping.

export class LinkedInReferenceProvider implements DecisionMakerProvider {
  readonly name = 'linkedin_reference'
  readonly sourceType = 'linkedin'

  available(): { status: ProviderStatus; reason?: string } {
    if (!env.LINKEDIN_ACCESS_TOKEN) {
      return {
        status: 'unauthorized',
        reason:
          'LINKEDIN_ACCESS_TOKEN is not set. LinkedIn person data requires an approved LinkedIn Partner ' +
          'Program application; there is no self-service credential. Third-party LinkedIn scraper Actors ' +
          'ARE reachable from the configured Apify account and were deliberately NOT used, because ' +
          'scraping LinkedIn without authorisation violates its terms whether done directly or through ' +
          'an intermediary.',
      }
    }
    return { status: 'available' }
  }

  async search(_ctx: DmProviderContext): Promise<DmProviderResult> {
    // Unreachable while `available()` returns unauthorized. Left explicit
    // rather than thrown, so wiring a real token surfaces one clear next step.
    const started = Date.now()
    return {
      provider: this.name,
      status: 'unavailable',
      candidates: [] as CandidateDraft[],
      reason:
        'A LinkedIn access token is present, but no Partner Program people-search scope is implemented. ' +
        'Implement the specific endpoint your approved application grants before enabling this provider.',
      durationMs: Date.now() - started,
    }
  }
}
