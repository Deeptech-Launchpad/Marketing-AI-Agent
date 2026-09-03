import { getCrm } from '../../crm/index.js'
import type { ProviderAvailability, ProviderResult, ResolvedOwner } from '../types.js'

// TASK #985 — creating the follow-up task.
//
// WHERE THE TASK LIVES, AND WHY
//
// Task #985 asks for a follow-up task for the sales owner. The obvious home is
// NXT Sales — and it is not available. `CrmPort` has NO write method of any
// kind, by deliberate design across every previous stage, and no approved write
// adapter exists. So the task is created INSIDE the marketing platform and the
// CRM handoff is reported as not configured.
//
// That is exactly what Task #985 prescribes for this case. Adding a write path
// to NXT Sales here would invent a capability nobody approved, in the one part
// of the system that has been read-only on purpose since the beginning.
//
// The task is a task. It is never a message to a prospect.

export interface TaskPayload {
  qualificationId: string
  crmCompanyId: string
  companyName: string
  score: number
  threshold: number
  owner: ResolvedOwner
  /** Observed acts, in plain words. */
  whyLines: string[]
  recommendedAction: string
  dueAt: Date
  slaMinutes: number
  policyVersion: string
}

export interface SalesTaskProvider {
  readonly name: string
  readonly destination: string
  availability(): ProviderAvailability
  create(payload: TaskPayload): Promise<ProviderResult>
}

/**
 * The internal follow-up task.
 *
 * Always available. The caller persists the SalesFollowUpTask row; this
 * provider reports what that means — a real task in this platform, which a
 * salesperson can only see once a UI shows it to them.
 */
export class InternalTaskProvider implements SalesTaskProvider {
  readonly name = 'internal'
  readonly destination = 'Follow-up task inside the Marketing AI platform'

  availability(): ProviderAvailability {
    return { status: 'available' }
  }

  async create(_payload: TaskPayload): Promise<ProviderResult> {
    return {
      status: 'available',
      delivered: true,
      reason: 'A follow-up task was created in the Marketing AI platform.',
    }
  }
}

/**
 * A task in NXT Sales.
 *
 * Reports `not_configured`, and the reason is structural rather than a missing
 * credential: the CRM port exposes no write operation at all. The check below
 * INSPECTS the live port rather than asserting from memory, so if an approved
 * write adapter is ever added this provider notices.
 */
export class CrmTaskProvider implements SalesTaskProvider {
  readonly name = 'nxt_sales'
  readonly destination = 'Task in NXT Sales'

  availability(): ProviderAvailability {
    const crm = getCrm() as unknown as Record<string, unknown>
    const hasWrite = ['createTask', 'createActivity', 'createFollowUp', 'createNote'].some(
      (m) => typeof crm[m] === 'function',
    )

    if (!hasWrite) {
      return {
        status: 'not_configured',
        reason:
          'The NXT Sales integration is read-only. The CRM port exposes no write operation, so no task can be created in the CRM.',
        remediation:
          'Add an approved write adapter to the CRM port, behind this provider boundary. Do not write to NXT Sales tables directly.',
      }
    }
    return { status: 'available' }
  }

  async create(_payload: TaskPayload): Promise<ProviderResult> {
    const a = this.availability()
    return {
      status: a.status,
      delivered: false,
      reason: a.reason ?? 'The CRM task transport is not implemented.',
    }
  }
}

/** Preference order: the CRM if it were writable, otherwise our own platform. */
export const TASK_PROVIDERS: SalesTaskProvider[] = [new CrmTaskProvider(), new InternalTaskProvider()]

export function selectTaskProvider(): { provider: SalesTaskProvider; skipped: Array<{ name: string; reason: string }> } {
  const skipped: Array<{ name: string; reason: string }> = []
  for (const provider of TASK_PROVIDERS) {
    const a = provider.availability()
    if (a.status === 'available') return { provider, skipped }
    skipped.push({ name: provider.name, reason: a.reason ?? a.status })
  }
  return { provider: new InternalTaskProvider(), skipped }
}

/** The task body a salesperson would read. */
export function renderTaskBody(payload: TaskPayload): string {
  return [
    'FOLLOW UP — HIGH INTENT',
    '',
    `Company:      ${payload.companyName}`,
    `Intent score: ${payload.score} / 100 (threshold ${payload.threshold})`,
    `Due by:       ${payload.dueAt.toISOString()} (${payload.slaMinutes} minutes)`,
    '',
    'What we observed:',
    ...payload.whyLines.map((l) => `  - ${l}`),
    '',
    `Suggested action: ${payload.recommendedAction}`,
    '',
    'Nothing has been sent to this prospect. This task exists so a person decides what to do next.',
  ].join('\n')
}
