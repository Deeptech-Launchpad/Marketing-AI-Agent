import type { StepType } from '../../domain/enums.js'
import { prisma } from '../../platform/db.js'
import { dispatch } from '../tools/dispatcher.js'

// Shared context handed to every step handler.

export interface RunRef {
  id: string
  tenantId: string
  campaignId: string | null
  objective: string
  requestedByCrmUserId: string
  feedback: string | null
}

export interface StepContext {
  run: RunRef
  stepId: string
  stepType: StepType
  /** Dispatches a tool through the registry firewall. Never bypass this. */
  tool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** Output of an earlier completed step in the same run. */
  prior: <T>(type: StepType) => Promise<T | null>
}

/**
 * Reads the most recent COMPLETED output for a step type. Most recent matters:
 * a "changes requested" decision creates a second STRATEGY step, and later
 * steps must see the regenerated one, not the rejected original.
 */
export async function priorOutput<T>(runId: string, type: StepType): Promise<T | null> {
  const row = await prisma.agentStep.findFirst({
    where: { runId, type, status: 'completed' },
    orderBy: { seq: 'desc' },
    select: { output: true },
  })
  return (row?.output as T | undefined) ?? null
}

export function buildContext(run: RunRef, stepId: string, stepType: StepType): StepContext {
  return {
    run,
    stepId,
    stepType,
    tool: (name, args) =>
      dispatch(name, args, { tenantId: run.tenantId, runId: run.id, stepId, stepType }),
    prior: <T>(type: StepType) => priorOutput<T>(run.id, type),
  }
}

/** A step returns its output plus, for approval steps, a request to pause. */
export interface StepResult {
  output: Record<string, unknown>
  awaitingApproval?: { approvalId: string; payloadHash: string }
}

export type StepHandler = (ctx: StepContext) => Promise<StepResult>

/**
 * Wraps untrusted third-party text so a prompt can never confuse it with an
 * instruction. Used for anything fetched from the web or written by an external
 * correspondent — the model is told, in the system prompt, that content inside
 * these markers is data to summarise, never direction to follow.
 */
export function delimitUntrusted(label: string, body: string): string {
  return [
    `<<<UNTRUSTED_CONTENT source="${label}">>>`,
    body.slice(0, 12_000),
    '<<<END_UNTRUSTED_CONTENT>>>',
  ].join('\n')
}
