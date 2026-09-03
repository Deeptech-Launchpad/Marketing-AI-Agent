import { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import type { StepType } from '../domain/enums.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { isRetryable, serializeError } from '../platform/errors.js'
import { runLogger } from '../platform/logger.js'
import { enqueue, QUEUE_RUN_STEP } from '../platform/queue.js'
import { assertWithinBudget } from './budgetGuard.js'
import { firstStep, isLegalTransition, nextStep } from './stateMachine.js'
import { STEP_HANDLERS } from './steps/index.js'
import { buildContext, type RunRef } from './steps/types.js'

// The run loop.
//
// One pg-boss job executes ONE step and then enqueues the next as a fresh job.
// It never recurses in-process and never loops over the whole pipeline, which
// is what makes a crash at any point resumable: the run's last persisted step
// is the truth, and the redelivered job picks up from there.

const MAX_ATTEMPTS = 3
const BACKOFF_MS = 750

export interface StartRunInput {
  tenantId: string
  campaignId: string
  objective: string
  requestedByCrmUserId: string
}

export async function startRun(input: StartRunInput): Promise<{ runId: string }> {
  const runId = newId()

  await prisma.$transaction(async (tx) => {
    await tx.agentRun.create({
      data: {
        id: runId,
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        requestedByCrmUserId: input.requestedByCrmUserId,
        objective: input.objective,
        // Phase 1 has exactly one mode. env.DEFAULT_RUN_MODE is typed to the
        // literal 'dry_run', so a live run is not expressible.
        mode: env.DEFAULT_RUN_MODE,
        status: 'queued',
        budgetTokens: env.BUDGET_MAX_TOKENS_PER_RUN,
        budgetUsd: new Prisma.Decimal(env.BUDGET_MAX_USD_PER_RUN),
      },
    })
    await tx.campaign.update({ where: { id: input.campaignId }, data: { status: 'planning' } })
  })

  await audit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorCrmUserId: input.requestedByCrmUserId,
    runId,
    action: 'run.started',
    resourceType: 'AgentRun',
    resourceId: runId,
    summary: input.objective,
  })

  await enqueue(QUEUE_RUN_STEP, { runId })
  return { runId }
}

/** Queue handler. Executes exactly one step of one run. */
export async function executeNextStep(runId: string): Promise<void> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } })
  if (!run) return

  const log = runLogger(runId)

  // Only queued/running runs advance. A parked, cancelled or finished run that
  // gets a stray redelivery is a no-op rather than a double execution.
  if (run.status !== 'queued' && run.status !== 'running') {
    log.debug({ status: run.status }, 'run not advanceable, skipping')
    return
  }

  const from = (run.currentStepType as StepType | null) ?? null
  // currentStepType is the step to RUN when it was set by a regeneration
  // decision; otherwise it names the last completed step.
  const isRegeneration = run.feedback !== null && from !== null
  const stepType: StepType = from === null ? firstStep() : isRegeneration ? from : (nextStep(from) as StepType)

  if (!stepType) {
    await finish(runId, 'completed')
    return
  }
  if (!isRegeneration && !isLegalTransition(from, stepType)) {
    await fail(runId, null, new Error(`Illegal transition ${from} -> ${stepType}`))
    return
  }

  try {
    await assertWithinBudget(runId)
  } catch (err) {
    await fail(runId, null, err)
    return
  }

  // A step left `running` by a crashed process is closed out before the
  // replacement attempt starts, so the trace shows an abandoned attempt rather
  // than a step that appears to still be in flight forever.
  await prisma.agentStep.updateMany({
    where: { runId, status: 'running' },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      error: { code: 'abandoned', message: 'Step was interrupted; a new attempt was started.' } as never,
    },
  })

  const seq = run.stepCount
  const stepId = newId()

  // Persisted BEFORE the work happens. This write is half of what makes the
  // run resumable; the completion write below is the other half.
  await prisma.$transaction(async (tx) => {
    await tx.agentStep.create({
      data: {
        id: stepId,
        tenantId: run.tenantId,
        runId,
        seq,
        type: stepType,
        status: 'running',
        input: { feedback: run.feedback } as never,
      },
    })
    await tx.agentRun.update({
      where: { id: runId },
      data: {
        status: 'running',
        stepCount: { increment: 1 },
        startedAt: run.startedAt ?? new Date(),
      },
    })
  })

  const ref: RunRef = {
    id: run.id,
    tenantId: run.tenantId,
    campaignId: run.campaignId,
    objective: run.objective,
    requestedByCrmUserId: run.requestedByCrmUserId,
    feedback: run.feedback,
  }

  const handler = STEP_HANDLERS[stepType]
  let attempt = 0

  for (;;) {
    attempt++
    try {
      const result = await handler(buildContext(ref, stepId, stepType))

      if (result.awaitingApproval) {
        // Park the run. The job COMPLETES — a parked run must not hold a worker
        // for however long a human takes to look at it.
        await prisma.$transaction(async (tx) => {
          await tx.agentStep.update({
            where: { id: stepId },
            data: { status: 'awaiting_approval', output: result.output as never },
          })
          await tx.agentRun.update({
            where: { id: runId },
            data: { status: 'awaiting_approval', currentStepType: stepType, feedback: null },
          })
          if (run.campaignId) {
            await tx.campaign.update({
              where: { id: run.campaignId },
              data: { status: 'awaiting_approval' },
            })
          }
        })
        log.info({ stepType, approvalId: result.awaitingApproval.approvalId }, 'run parked for approval')
        return
      }

      await prisma.$transaction(async (tx) => {
        await tx.agentStep.update({
          where: { id: stepId },
          data: { status: 'completed', output: result.output as never, finishedAt: new Date() },
        })
        await tx.agentRun.update({
          where: { id: runId },
          // feedback is consumed here: a regeneration must not re-apply the
          // same reviewer comment on every subsequent step.
          data: { currentStepType: stepType, feedback: null },
        })
      })

      const following = nextStep(stepType)
      if (!following) {
        await finish(runId, 'completed')
        log.info('run completed')
        return
      }

      await enqueue(QUEUE_RUN_STEP, { runId })
      log.info({ stepType, next: following }, 'step completed')
      return
    } catch (err) {
      const retryable = isRetryable(err) && attempt < MAX_ATTEMPTS
      log.warn({ err, stepType, attempt, retryable }, 'step failed')

      await prisma.agentStep
        .update({ where: { id: stepId }, data: { retryCount: attempt - 1 } })
        .catch(() => undefined)

      if (retryable) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt))
        continue
      }

      await fail(runId, stepId, err)
      return
    }
  }
}

async function finish(runId: string, status: 'completed'): Promise<void> {
  await prisma.agentRun.update({
    where: { id: runId },
    data: { status, finishedAt: new Date(), feedback: null },
  })
}

/**
 * Terminal failure. Because Phase 1 has no write tools, there is nothing
 * partially applied to compensate for — the run simply stops, with the error
 * persisted on both the step and the run.
 */
async function fail(runId: string, stepId: string | null, err: unknown): Promise<void> {
  const payload = serializeError(err)
  if (stepId) {
    await prisma.agentStep
      .update({ where: { id: stepId }, data: { status: 'failed', error: payload as never, finishedAt: new Date() } })
      .catch(() => undefined)
  }
  await prisma.agentRun
    .update({ where: { id: runId }, data: { status: 'failed', error: payload as never, finishedAt: new Date() } })
    .catch(() => undefined)

  runLogger(runId).error({ err }, 'run failed')
}
