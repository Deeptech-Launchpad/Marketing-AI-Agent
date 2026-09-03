import { createHash } from 'node:crypto'
import { env } from '../config/env.js'
import type { OutreachChannel } from './types.js'

// TASK #982 — the cadence, as data.
//
// A sequence is a list of rows, not a chain of if-statements. Changing the
// timing, dropping a channel or inserting a step is a configuration change, and
// the engine reads the same table whether a campaign has three steps or seven.
//
// Nothing here sends. A step becomes due; the worker then re-checks
// suppression, provider availability and validation before anything happens,
// because all three can change between planning a step and it falling due.

export interface SequenceStepDefinition {
  stepNumber: number
  channel: OutreachChannel
  /** Days after the campaign starts. Configurable per deployment. */
  dayOffset: number
  purpose: string
  /** Only run this step if the previous one reached one of these statuses. */
  requiresPreviousStatus?: string[]
  /** Skip the step entirely unless the channel is explicitly enabled. */
  requiresChannelEnabled?: boolean
}

/**
 * The default cadence.
 *
 * Offsets come from configuration so the shape can be tuned without a code
 * change. The dependencies between steps are the interesting part: a follow-up
 * that fires after a first email that never sent is a message referring to a
 * conversation that did not happen.
 */
export function defaultSequence(): SequenceStepDefinition[] {
  return [
    {
      stepNumber: 1,
      channel: 'email',
      dayOffset: env.OUTREACH_DAY_EMAIL_1,
      purpose: 'Introduce what the audit found on their own product pages.',
    },
    {
      stepNumber: 2,
      channel: 'linkedin',
      dayOffset: env.OUTREACH_DAY_LINKEDIN,
      purpose: 'Connection note referencing the same finding, for manual sending.',
    },
    {
      stepNumber: 3,
      channel: 'call',
      dayOffset: env.OUTREACH_DAY_CALL,
      purpose: 'SDR call task with talking points drawn from the approved audit.',
    },
    {
      stepNumber: 4,
      channel: 'email_followup',
      dayOffset: env.OUTREACH_DAY_EMAIL_2,
      purpose: 'Follow-up carrying the personalised Workbench link.',
      // A follow-up only makes sense if the first email actually went.
      requiresPreviousStatus: ['sent'],
    },
    {
      stepNumber: 5,
      channel: 'whatsapp',
      dayOffset: env.OUTREACH_DAY_WHATSAPP,
      purpose: 'Alternative channel for explicitly eligible accounts only.',
      requiresChannelEnabled: true,
    },
  ]
}

export function scheduledAtFor(campaignStart: Date, dayOffset: number): Date {
  return new Date(campaignStart.getTime() + dayOffset * 86_400_000)
}

/**
 * A stable identity for one intended action.
 *
 * Two attempts that produce the same key are the same action, so a retried
 * queue job, a double-clicked button and a re-run campaign all converge on one
 * row rather than three sends.
 *
 * The template VERSION is part of the key on purpose: changing the wording
 * makes it a different message, and treating it as the same one would either
 * suppress a legitimate resend or silently deliver new copy under an old
 * action's audit trail.
 */
export function idempotencyKey(parts: {
  campaignId: string
  crmCompanyId: string
  channel: OutreachChannel
  stepNumber: number
  destination: string | null
  templateKey: string
  templateVersion: string
}): string {
  const canonical = [
    parts.campaignId,
    parts.crmCompanyId,
    parts.channel,
    String(parts.stepNumber),
    (parts.destination ?? 'no-destination').toLowerCase().trim(),
    parts.templateKey,
    parts.templateVersion,
  ].join('|')
  return createHash('sha256').update(canonical).digest('hex')
}

/** Whether a step may run, given how the previous one ended. */
export function stepIsEligible(
  def: SequenceStepDefinition,
  previousStatus: string | null,
  channelEnabled: boolean,
): { eligible: boolean; reason?: string } {
  if (def.requiresChannelEnabled && !channelEnabled) {
    return {
      eligible: false,
      reason: `The ${def.channel} channel is not enabled, and eligibility for it is a business decision rather than a default.`,
    }
  }

  if (def.requiresPreviousStatus) {
    if (previousStatus === null) {
      return { eligible: false, reason: 'The preceding step has not run yet.' }
    }
    if (!def.requiresPreviousStatus.includes(previousStatus)) {
      return {
        eligible: false,
        reason: `This step requires the preceding step to be ${def.requiresPreviousStatus.join(' or ')}, but it is "${previousStatus}". A follow-up must not reference a message that never went.`,
      }
    }
  }

  return { eligible: true }
}
