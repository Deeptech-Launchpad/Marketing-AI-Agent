import { env } from '../../config/env.js'
import type { Availability, DeliveryContext, DeliveryResult, OutreachProvider } from './provider.js'

// CHANNEL — CALL.
//
// This is the one channel that completes end to end here, because its output is
// INTERNAL: a task for an SDR, with talking points drawn from the approved
// audit. No external provider is needed to create work for our own team.
//
// NO AUTOMATED DIALLING IS PERFORMED, and no dialler is wired up. A CallHippo
// credential does exist in the NXT Sales application, and it is deliberately
// not used here for three reasons: it belongs to a different application, it is
// annotated in that app as read-only for call logs and recordings, and Task
// #982 explicitly says not to place automated calls unless an approved calling
// provider already exists for this purpose. Borrowing another service's
// credential to dial a prospect would be exactly the kind of shortcut this
// project has refused at every previous stage.
//
// So the call task is created as internal work and the human places the call.

export class CallTaskProvider implements OutreachProvider {
  readonly name = 'call_task'
  readonly channel = 'call' as const

  availability(): Availability {
    if (env.OUTREACH_CALL_TASK_PROVIDER && env.OUTREACH_CALL_TASK_PROVIDER !== 'internal') {
      return {
        status: 'not_configured',
        reason: `OUTREACH_CALL_TASK_PROVIDER is "${env.OUTREACH_CALL_TASK_PROVIDER}" but no adapter is implemented for it.`,
        remediation: 'Implement that provider adapter, or set OUTREACH_CALL_TASK_PROVIDER=internal to store call tasks in this platform.',
      }
    }
    // Creating an internal task needs nothing external.
    return { status: 'available' }
  }

  async deliver(ctx: DeliveryContext): Promise<DeliveryResult> {
    const started = Date.now()

    // A call task is real work that a person will pick up, so a rehearsal must
    // not create one.
    if (ctx.dryRun) {
      return {
        status: 'available',
        delivered: false,
        reason: 'Dry run: the call task and its talking points were composed but no task was created.',
        durationMs: Date.now() - started,
      }
    }

    // The "delivery" is the task itself, which the engine persists as the
    // action's message. Nothing leaves this system and nobody is contacted
    // until an SDR picks it up and dials.
    return {
      status: 'available',
      delivered: true,
      manualRequired: true,
      providerMessageId: `call-task:${ctx.actionId}`,
      providerResponse: {
        taskType: 'sales_call',
        company: ctx.target.companyName,
        askFor: ctx.target.contactName ?? '(no named contact identified)',
        talkingPoints: ctx.message.blocks.talkingPoints ? 'included' : 'none',
      },
      reason: 'Call task created for an SDR. No call was placed by this platform.',
      durationMs: Date.now() - started,
    }
  }
}
