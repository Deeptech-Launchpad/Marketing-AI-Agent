import { env } from '../../config/env.js'
import type { ProviderAvailability, ProviderResult, ResolvedOwner } from '../types.js'

// TASK #985 — telling a salesperson, through a provider-neutral boundary.
//
// STATE OF THE WORLD, VERIFIED NOT ASSUMED
//
// This installation has no Slack app, no Teams webhook and no email provider —
// the same finding as Task #982, rechecked. So the only destination that
// genuinely works is an internal notification record in this platform.
//
// THE DISTINCTION THAT MATTERS
//
// Writing an internal record is not the same as interrupting a person. The
// in-app provider therefore reports `recorded_in_app`, never `sent`. Nobody
// reading a qualification should be able to conclude that a salesperson was
// pinged when all that happened was a row being written for a UI that does not
// exist yet.

export interface AlertPayload {
  qualificationId: string
  companyName: string
  crmCompanyId: string
  score: number
  threshold: number
  /** Two or three observed acts, in plain words. */
  whyLines: string[]
  recommendedAction: string
  owner: ResolvedOwner
  /** Internal deep link for the future UI. Never a public or tokenised URL. */
  internalLink: string
  dueAt: Date | null
}

export interface SalesAlertProvider {
  readonly name: string
  /** Where this would deliver to. Shown in the API. */
  readonly destination: string
  availability(): ProviderAvailability
  send(payload: AlertPayload): Promise<ProviderResult>
}

/**
 * The internal notification.
 *
 * Always available, because it depends on nothing but our own database. The
 * caller persists the SalesAlert row; this provider's job is to state honestly
 * what that means — a durable record the application can show, not a push.
 */
export class InAppAlertProvider implements SalesAlertProvider {
  readonly name = 'in_app'
  readonly destination = 'Internal notification inside the Marketing AI platform'

  availability(): ProviderAvailability {
    return { status: 'available' }
  }

  async send(_payload: AlertPayload): Promise<ProviderResult> {
    // Deliberately reports `available` with delivered=false. The record is
    // real; the delivery to a human is not, and the caller maps this to
    // `recorded_in_app` rather than `sent`.
    return {
      status: 'available',
      delivered: false,
      reason:
        'An internal alert record was created and can be read in the platform. No external notification provider is configured, so nobody was actively notified.',
    }
  }
}

/** Slack. Not configured here, and it says so precisely. */
export class SlackAlertProvider implements SalesAlertProvider {
  readonly name = 'slack'
  readonly destination = 'Slack channel'

  availability(): ProviderAvailability {
    if (!env.SALES_ALERT_SLACK_WEBHOOK_URL) {
      return {
        status: 'not_configured',
        reason: 'No Slack webhook URL is configured, so no Slack alert can be sent.',
        remediation: 'Set SALES_ALERT_SLACK_WEBHOOK_URL to an incoming-webhook URL for the sales channel.',
      }
    }
    return { status: 'available' }
  }

  async send(_payload: AlertPayload): Promise<ProviderResult> {
    const a = this.availability()
    if (a.status !== 'available') {
      return { status: a.status, delivered: false, reason: a.reason }
    }
    // Intentionally not implemented against a live workspace. Wiring an
    // outbound HTTP call that has never been exercised would be a claim rather
    // than a capability; the boundary is here for when a webhook exists.
    return {
      status: 'not_configured',
      delivered: false,
      reason:
        'A Slack webhook is configured, but the Slack transport has not been implemented or verified against a real workspace.',
    }
  }
}

/** Email to the sales owner. Blocked by the same absent provider as Task #982. */
export class EmailAlertProvider implements SalesAlertProvider {
  readonly name = 'email'
  readonly destination = 'Email to the resolved sales owner'

  availability(): ProviderAvailability {
    if (env.EMAIL_PROVIDER === 'none') {
      return {
        status: 'not_configured',
        reason: 'No email provider is configured on this installation, so no alert email can be sent.',
        remediation: 'Configure EMAIL_PROVIDER and its credentials.',
      }
    }
    return { status: 'available' }
  }

  async send(_payload: AlertPayload): Promise<ProviderResult> {
    const a = this.availability()
    return { status: a.status, delivered: false, reason: a.reason ?? 'The email alert transport is not implemented.' }
  }
}

/** Registered in preference order. The first available one handles the alert. */
export const ALERT_PROVIDERS: SalesAlertProvider[] = [
  new SlackAlertProvider(),
  new EmailAlertProvider(),
  new InAppAlertProvider(),
]

/**
 * Picks the provider that will actually handle the alert.
 *
 * Never silently substitutes: the chosen provider is recorded on the alert, and
 * every provider that was skipped keeps its own stated reason in the
 * availability report.
 */
export function selectAlertProvider(): { provider: SalesAlertProvider; skipped: Array<{ name: string; reason: string }> } {
  const skipped: Array<{ name: string; reason: string }> = []
  for (const provider of ALERT_PROVIDERS) {
    const a = provider.availability()
    if (a.status === 'available') return { provider, skipped }
    skipped.push({ name: provider.name, reason: a.reason ?? a.status })
  }
  // Unreachable: the in-app provider is always available. Kept so a future
  // change that disables it fails loudly rather than throwing on undefined.
  return { provider: new InAppAlertProvider(), skipped }
}

/**
 * The alert text.
 *
 * Concise, actionable, and free of anything sensitive: no credential, no
 * provider payload, no prospect contact details, and no claim about buying.
 */
export function renderAlertText(payload: AlertPayload): string {
  const lines = [
    'HIGH-INTENT LEAD',
    '',
    `Company:        ${payload.companyName}`,
    `Intent score:   ${payload.score} / 100`,
    `Threshold:      ${payload.threshold}`,
    '',
    'Why this lead was flagged (observed actions):',
    ...payload.whyLines.map((l) => `  - ${l}`),
    '',
    `Recommended next action: ${payload.recommendedAction}`,
    `Sales owner:    ${payload.owner.name ?? 'not assigned'}`,
  ]
  if (payload.dueAt) lines.push(`Follow up by:   ${payload.dueAt.toISOString()}`)
  lines.push(`Open prospect:  ${payload.internalLink}`)
  lines.push('')
  lines.push(
    'This lead crossed a configured threshold based on observed engagement. It is not a prediction that the company will buy.',
  )
  return lines.join('\n')
}
