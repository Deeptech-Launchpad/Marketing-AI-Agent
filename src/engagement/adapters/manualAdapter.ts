import { prisma } from '../../platform/db.js'
import { BadRequestError, NotFoundError } from '../../platform/errors.js'
import { recordEvent, type RecordResult } from '../store.js'
import type { EngagementEventType } from '../types.js'

// TASK #983 — a person on our team confirming they did something.
//
// WHY THIS EXISTS
//
// Two of the five outreach channels have no automated observability on this
// installation. LinkedIn is drafted and sent by a human because scraping and
// automation were refused in Task #982; the call channel produces an internal
// SDR task because no approved call provider is wired in. Neither produces a
// webhook, so the only truthful way those acts enter the history is a person
// stating that they happened.
//
// WHAT THAT MEANS FOR THE RECORD
//
// A manual confirmation is evidence of a DIFFERENT KIND from a server
// observation, and it is labelled as such: the source is `manual_confirmation`
// and the evidence names the person who confirmed it. Nobody reading the
// timeline should have to guess whether "connection request sent" was observed
// or asserted.
//
// WHAT IS STILL NOT ALLOWED
//
// A person may confirm THEIR OWN act. They may not assert an act of the
// PROSPECT'S: there is no manual "they opened it", no "they seemed
// interested", no outcome that turns into a rating. `call_outcome_recorded`
// stores what was said in free text and nothing that could be sorted on.

/** Acts a person may confirm. Closed, and all of them are acts of ours. */
const CONFIRMABLE: Record<string, { eventType: EngagementEventType; verb: string }> = {
  linkedin_sent: {
    eventType: 'linkedin_action_manually_confirmed',
    verb: 'sent the LinkedIn message',
  },
  call_completed: {
    eventType: 'call_task_completed',
    verb: 'completed the call task',
  },
  call_outcome: {
    eventType: 'call_outcome_recorded',
    verb: 'recorded the outcome of the call',
  },
}

export const CONFIRMABLE_ACTS = Object.keys(CONFIRMABLE)

export interface ManualConfirmationInput {
  tenantId: string
  /** The authenticated reviewer. Never read from the request body. */
  crmUserId: string
  actorName: string | null
  act: string
  outreachActionId: string
  /** Free text. Stored verbatim, never parsed into a category or a level. */
  note?: string | null
  /** When the person says it happened. Trusted — they are an internal user. */
  occurredAt?: Date | null
}

export async function confirmManualAct(input: ManualConfirmationInput, now = new Date()): Promise<RecordResult> {
  const spec = CONFIRMABLE[input.act]
  if (!spec) {
    throw new BadRequestError(
      `"${input.act}" is not a confirmable act. Expected one of: ${CONFIRMABLE_ACTS.join(', ')}.`,
    )
  }

  const action = await prisma.outreachAction.findFirst({
    where: { id: input.outreachActionId, tenantId: input.tenantId },
    select: { id: true, crmCompanyId: true, companyName: true, channel: true, campaignId: true },
  })
  if (!action) throw new NotFoundError('That outreach action does not exist.')

  // A confirmation must match the channel it claims. Confirming a LinkedIn
  // send against a call task would put a false act on the timeline.
  const expectedChannel = input.act.startsWith('linkedin') ? 'linkedin' : 'call'
  if (action.channel !== expectedChannel) {
    throw new BadRequestError(
      `That action is a ${action.channel} action, so "${input.act}" cannot be confirmed against it.`,
    )
  }

  const who = input.actorName ?? input.crmUserId

  return recordEvent(
    {
      eventType: spec.eventType,
      source: 'manual_confirmation',
      tenantId: input.tenantId,
      crmCompanyId: action.crmCompanyId,
      outreachActionId: action.id,
      occurredAt: input.occurredAt ?? null,
      evidence: {
        what: `${who} ${spec.verb} for ${action.companyName ?? 'this company'}.`,
        where: `outreach campaign ${action.campaignId}`,
        // Named plainly so nobody mistakes an assertion for an observation.
        how: 'Stated by a member of our team. This was not observed by the platform.',
        referenceKind: 'outreach_action',
        referenceId: action.id,
      },
      metadata: {
        confirmedByCrmUserId: input.crmUserId,
        channel: action.channel,
        act: input.act,
        // Verbatim. Not classified, not scored, not turned into a disposition.
        ...(input.note ? { note: input.note.slice(0, 200) } : {}),
      },
    },
    now,
  )
}
