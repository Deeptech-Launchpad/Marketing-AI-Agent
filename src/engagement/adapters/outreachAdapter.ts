import { prisma } from '../../platform/db.js'
import { recordEvent } from '../store.js'
import type { EngagementChannel, EngagementEventType } from '../types.js'

/**
 * The outreach channel an action ran on, as an engagement channel.
 *
 * The two vocabularies differ in one place: Task #982 treats the follow-up as
 * its own channel because it has its own template and cadence, whereas here it
 * is email — a prospect does not experience a follow-up as a different medium.
 */
const CHANNEL_MAP: Record<string, EngagementChannel> = {
  email: 'email',
  email_followup: 'email',
  linkedin: 'linkedin',
  call: 'call',
  whatsapp: 'whatsapp',
}

// TASK #983 — outreach lifecycle as engagement history.
//
// THESE EVENTS ARE ABOUT US, NOT ABOUT THE PROSPECT.
//
// "We created a call task" is not a thing the prospect did, and a timeline that
// mixes the two would let our own activity read as their interest. So these
// types are recorded, but `engagementSummary` counts them under `ourEvents`,
// separately from `prospectEvents`.
//
// They are worth recording anyway: without them a timeline cannot answer "did
// we ever actually reach out before they opened the demo?", which is the first
// question anyone asks of an engagement history.
//
// NOTE ON `email_sent`: Task #982 established that NO email provider is
// configured, so no outreach action has ever reached `sent`. This adapter emits
// `email_sent` only from a real `sentAt` on the row. It does not infer a send
// from a `ready_to_send` status, and it does not treat a draft as a delivery.

/** Derives the lifecycle event a given action status represents. */
export function eventTypeForStatus(status: string, channel: string): EngagementEventType | null {
  switch (status) {
    case 'draft':
    case 'ready_to_send':
      return channel === 'linkedin' ? 'linkedin_draft_created' : channel === 'call' ? 'call_task_created' : 'outreach_action_created'
    case 'scheduled':
      return 'outreach_action_scheduled'
    case 'manual_required':
      // A task waiting for a human is created work, not a blocked action.
      return channel === 'call' ? 'call_task_created' : channel === 'linkedin' ? 'linkedin_draft_created' : 'outreach_action_created'
    case 'blocked_suppressed':
    case 'blocked_provider_unavailable':
    case 'blocked_validation_failed':
    case 'blocked_no_target':
      return 'outreach_action_blocked'
    case 'failed':
      return 'outreach_action_failed'
    case 'sent':
      return 'email_sent'
    default:
      // cancelled, skipped, sending — transient or non-events. Recording them
      // would add noise without adding a fact anyone asks about.
      return null
  }
}

/** Channel names as they read in a sentence, with the right article. */
const CHANNEL_PHRASE: Record<string, string> = {
  email: 'An email',
  email_followup: 'A follow-up email',
  linkedin: 'A LinkedIn',
  call: 'A call',
  whatsapp: 'A WhatsApp',
}

function phrase(channel: string): string {
  return CHANNEL_PHRASE[channel] ?? `A ${channel}`
}

function describe(status: string, channel: string, companyName: string | null): string {
  const company = companyName ?? 'this company'
  const subject = phrase(channel)
  switch (status) {
    case 'sent':
      return `An outreach email was sent to a contact at ${company}.`
    case 'scheduled':
      return `${subject} outreach action for ${company} was scheduled.`
    case 'manual_required':
      return `${subject} action for ${company} was prepared for a person to carry out.`
    case 'failed':
      return `${subject} outreach action for ${company} failed.`
    case 'draft':
    case 'ready_to_send':
      return `${subject} outreach action for ${company} was drafted.`
    default:
      return `${subject} outreach action for ${company} was blocked before any external contact was made.`
  }
}

export interface SyncResult {
  examined: number
  recorded: number
  duplicate: number
  skipped: number
}

/**
 * Records the lifecycle events implied by existing OutreachAction rows.
 *
 * Idempotent: the lifecycle types dedupe `once_ever` on the action id, so this
 * can be called on every campaign run and as a backfill over history without
 * producing a second row for the same action.
 */
export async function syncOutreachActions(
  tenantId: string,
  filter: { actionIds?: string[]; crmCompanyId?: string; campaignId?: string } = {},
  now = new Date(),
): Promise<SyncResult> {
  const actions = await prisma.outreachAction.findMany({
    where: {
      tenantId,
      ...(filter.actionIds ? { id: { in: filter.actionIds } } : {}),
      ...(filter.crmCompanyId ? { crmCompanyId: filter.crmCompanyId } : {}),
      ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    },
    select: {
      id: true,
      crmCompanyId: true,
      companyName: true,
      channel: true,
      status: true,
      statusReason: true,
      scheduledAt: true,
      sentAt: true,
      createdAt: true,
      campaignId: true,
    },
    take: 2000,
  })

  const result: SyncResult = { examined: actions.length, recorded: 0, duplicate: 0, skipped: 0 }

  for (const action of actions) {
    const eventType = eventTypeForStatus(action.status, action.channel)
    if (!eventType) {
      result.skipped++
      continue
    }

    // The action's OWN timestamp, not the time of this sync. A backfill must
    // not stamp last month's work as having happened today.
    const occurredAt = action.sentAt ?? action.createdAt

    const outcome = await recordEvent(
      {
        eventType,
        source: 'outreach_engine',
        // From the ACTION, not from the event type. The generic lifecycle types
        // span every channel, and defaulting them to email made a blocked
        // LinkedIn action read as email activity.
        channel: CHANNEL_MAP[action.channel] ?? 'email',
        tenantId,
        crmCompanyId: action.crmCompanyId,
        outreachActionId: action.id,
        occurredAt,
        evidence: {
          what: describe(action.status, action.channel, action.companyName),
          where: `outreach campaign ${action.campaignId}`,
          how: 'Recorded by the outreach engine from the action it created.',
          referenceKind: 'outreach_action',
          referenceId: action.id,
        },
        metadata: {
          channel: action.channel,
          actionStatus: action.status,
          ...(action.statusReason ? { statusReason: action.statusReason } : {}),
        },
      },
      now,
    )

    if (outcome.status === 'recorded') result.recorded++
    else if (outcome.status === 'duplicate') result.duplicate++
    else result.skipped++
  }

  return result
}
