import { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { audit } from '../platform/audit.js'
import { newId, prisma } from '../platform/db.js'
import { ConflictError, NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { MAPPING_VERSION, PAYLOAD_VERSION } from './mapping.js'
import { buildPayload, type BuiltPayload } from './payload.js'
import { NxtSalesSyncProvider } from './providers/nxtSalesProvider.js'
import { OutboxSyncProvider } from './providers/outboxProvider.js'
import type { CrmSyncProvider } from './providers/provider.js'
import { validateForSync } from './validation.js'
import {
  isRetryable,
  type ResourceOutcome,
  type SyncResource,
  type SyncState,
  type ValidationResult,
} from './types.js'

// TASK #986 — running the handoff.
//
//   qualified lead  →  validate  →  map  →  idempotency  →  provider  →  result
//
// Everything the decision rests on is loaded from trusted internal records. A
// caller supplies a qualification reference and nothing else — no score, no
// owner, no CRM id, no tenant.
//
// This stage READS the whole pipeline and writes only its own three tables. It
// never touches an EngagementEvent, an IntentScore, a SalesQualification or an
// OutreachAction, which is also what stops the loop the queue design warns
// about: no CRM sync can produce an engagement event that produces a score
// that produces a qualification that produces a CRM sync.

const PROVIDERS: Record<string, () => CrmSyncProvider> = {
  nxt_sales: () => new NxtSalesSyncProvider(),
  outbox: () => new OutboxSyncProvider(),
}

export function selectProvider(): CrmSyncProvider {
  const factory = PROVIDERS[env.CRM_SYNC_PROVIDER]
  return factory ? factory() : new OutboxSyncProvider()
}

export function listProviders(): CrmSyncProvider[] {
  return [new NxtSalesSyncProvider(), new OutboxSyncProvider()]
}

/** The CRM objects a qualified lead would touch, in a stable order. */
const INTENDED_RESOURCES: SyncResource[] = ['company', 'activity', 'task']

export interface SyncOptions {
  tenantId: string
  qualificationId: string
  actorCrmUserId?: string | null
  /** Build and validate without persisting or contacting any provider. */
  dryRun?: boolean
  /** Ignore an existing successful result and attempt again. */
  force?: boolean
  /**
   * The person who reviewed this lead and decided it should be written.
   *
   * REQUIRED for anything to reach NXT Sales. Without it the package stops at
   * `awaiting_user_approval`. It is an object rather than a boolean because an
   * approval that cannot name its approver is not an approval — the id is
   * recorded on the sync record and on the audit event.
   */
  userApproval?: {
    approvedByCrmUserId: string
    approvedAt: Date
    /** Optional free text the reviewer left with their decision. */
    note?: string | null
  }
}

export interface SyncResult {
  syncRecordId: string | null
  qualificationId: string
  crmCompanyId: string | null
  companyName: string | null
  state: SyncState
  reason: string
  providerName: string
  providerStatus: string
  mappingVersion: string
  payloadVersion: string
  externalKey: string | null
  resources: ResourceOutcome[]
  validation: ValidationResult
  attempt: number
  retryable: boolean
  errorCode: string | null
  outboxId: string | null
  dryRun: boolean
  /** True when an existing successful result was reused. */
  reused: boolean
}

/**
 * Hands one qualified lead to the CRM.
 *
 * Idempotent: a completed handoff is returned rather than repeated, and the
 * outbox entry for an undelivered one is reused rather than duplicated.
 */
export async function syncQualification(options: SyncOptions): Promise<SyncResult> {
  const startedAt = Date.now()
  const dryRun = options.dryRun ?? false
  const provider = selectProvider()
  const availability = provider.availability()
  const capabilities = provider.capabilities()

  const existing = await prisma.crmSyncRecord.findFirst({
    where: { qualificationId: options.qualificationId, tenantId: options.tenantId },
  })

  // ── Idempotency: a finished handoff is not repeated ────────────────────
  if (existing && existing.state === 'synced' && !options.force) {
    return {
      syncRecordId: existing.id,
      qualificationId: options.qualificationId,
      crmCompanyId: existing.crmCompanyId,
      companyName: existing.companyName,
      state: 'synced',
      reason: 'This lead has already been synchronised. The existing result was returned rather than writing again.',
      providerName: existing.providerName,
      providerStatus: existing.providerStatus,
      mappingVersion: existing.mappingVersion,
      payloadVersion: existing.payloadVersion,
      externalKey: existing.externalKey,
      resources: (existing.resourceResults ?? []) as unknown as ResourceOutcome[],
      validation: { ok: true, issues: [] },
      attempt: existing.attemptCount,
      retryable: false,
      errorCode: null,
      outboxId: null,
      dryRun,
      reused: true,
    }
  }

  // ── Build the package ──────────────────────────────────────────────────
  const built = await buildPayload({ tenantId: options.tenantId, qualificationId: options.qualificationId })
  if (!built) {
    // Tenant isolation is a WHERE clause: another tenant's qualification is
    // simply not found, and nothing distinguishes it from one that never was.
    throw new NotFoundError('That qualification does not exist.')
  }

  const validation = await validateForSync(options.tenantId, built)

  // ── Decide the state ───────────────────────────────────────────────────
  let state: SyncState
  let reason: string
  let errorCode: string | null = null
  let resources: ResourceOutcome[] = []

  if (!validation.ok) {
    const gateFailed = validation.issues.some((i) => i.check === 'qualification_gate')
    const ownerFailed = validation.issues.some((i) => i.check === 'owner_required')
    state = gateFailed ? 'blocked_not_qualified' : ownerFailed ? 'blocked_missing_owner' : 'blocked_validation'
    errorCode = 'validation_failed'
    reason = validation.issues
      .filter((i) => i.severity === 'error')
      .map((i) => i.message)
      .join(' ')
  } else if (availability.status !== 'available' || !capabilities.canUpdate) {
    // The approved CRM write is UPDATE-scoped: updateCompany, carrying two
    // custom fields onto a Company that already exists.
    //
    // This gate previously asked for `canCreate`. Creating records is
    // deliberately outside the approved scope and has no implementation, so
    // canCreate is permanently false — which meant this branch always won and
    // the human-approval branch below could never be reached. Every approved
    // handoff was held as `blocked_provider_unavailable`, and enabling
    // CRM_WRITE_ENABLED would have changed nothing observable.
    //
    // The gate now asks for the capability this delivery actually uses. A
    // provider that can deliver nothing (the outbox) has canUpdate false and
    // is still held here, exactly as before.
    state = 'blocked_provider_unavailable'
    errorCode = availability.status === 'available' ? 'write_not_supported' : availability.status
    reason =
      availability.reason ??
      'No approved CRM write provider is configured, so the package was prepared and held rather than delivered.'
    resources = INTENDED_RESOURCES.map((r) => ({
      resource: r,
      result: 'not_supported' as const,
      externalId: null,
      reason,
      errorCode,
      retryable: false,
    }))
  } else if (!options.userApproval) {
    // ── THE HUMAN GATE ───────────────────────────────────────────────────
    //
    // Confirmed flow: the AI qualifies a lead, a USER reviews it, the user
    // decides, and only then is NXT Sales updated. A package that is
    // technically deliverable therefore stops here and waits for a person.
    //
    // The gate lives before delivery rather than inside the provider so that
    // it cannot be bypassed by adding another provider: any future adapter
    // inherits the same stop.
    state = 'awaiting_user_approval'
    errorCode = null
    reason =
      'The package is validated and ready. CRM updates require a person to review and approve the lead, so ' +
      'nothing has been written to NXT Sales.'
    resources = INTENDED_RESOURCES.map((r) => ({
      resource: r,
      result: 'not_supported' as const,
      externalId: null,
      reason,
      errorCode: null,
      retryable: false,
    }))
  } else {
    // Reached only with an explicit user approval AND an approved adapter.
    const outcome = await attemptDelivery(provider, built, capabilities)
    resources = outcome.resources
    state = outcome.state
    reason = outcome.reason
    errorCode = outcome.errorCode ?? null
  }

  const result: SyncResult = {
    syncRecordId: existing?.id ?? null,
    qualificationId: options.qualificationId,
    crmCompanyId: built.refs.crmCompanyId,
    companyName: built.payload.company.name,
    state,
    reason,
    providerName: provider.name,
    providerStatus: availability.status,
    mappingVersion: MAPPING_VERSION,
    payloadVersion: PAYLOAD_VERSION,
    externalKey: built.payload.externalKey,
    resources,
    validation,
    attempt: (existing?.attemptCount ?? 0) + 1,
    retryable: isRetryable(errorCode),
    errorCode,
    outboxId: null,
    dryRun,
    reused: false,
  }

  if (dryRun) return result

  return persist(result, built, {
    tenantId: options.tenantId,
    existing,
    provider,
    capabilities,
    actorCrmUserId: options.actorCrmUserId ?? null,
    durationMs: Date.now() - startedAt,
  })
}

/**
 * Delivers each intended resource, one at a time.
 *
 * Per-resource results are kept, and nothing is rolled back when one fails:
 * the providers here have no transaction to roll back into, and undoing a
 * successful write because a later one failed would lose real work.
 */
async function attemptDelivery(
  provider: CrmSyncProvider,
  built: BuiltPayload,
  capabilities: ReturnType<CrmSyncProvider['capabilities']>,
): Promise<{ state: SyncState; resources: ResourceOutcome[]; reason: string; errorCode?: string | null }> {
  const resources: ResourceOutcome[] = []

  const existingRecord = capabilities.canLookup
    ? await provider.findExisting(built.payload.externalKey).catch(() => null)
    : null

  for (const resource of INTENDED_RESOURCES) {
    if (!capabilities.resources.includes(resource)) {
      resources.push({
        resource,
        result: 'not_supported',
        externalId: null,
        reason: `${provider.destination} has no ${resource} object.`,
        errorCode: 'unsupported_operation',
        retryable: false,
      })
      continue
    }

    // The CRM record to update, when one is already known.
    //
    // For `company` it always is. The qualification carries the CRM company id
    // it was raised against, and validation has already cross-checked that id
    // against the payload — so the record is known AND verified before we reach
    // here. Asking the CRM to find it again could only agree or fail.
    //
    // findExisting() remains for other resources. It returns null for NXT Sales
    // because no CRM field holds our correlation key — which is exactly why the
    // company path must not be made to depend on it. Nothing about correlation
    // is stored CRM-side; idempotency stays on our side, on the unique
    // qualificationId of the sync record.
    const targetId = resource === 'company' ? built.refs.crmCompanyId : (existingRecord?.externalId ?? null)

    try {
      // Update an existing record where possible rather than creating a second
      // one — the duplicate-prevention rule, applied per resource.
      const outcome =
        targetId && capabilities.canUpdate
          ? await provider.update(resource, targetId, built.payload)
          : capabilities.canUpsert
            ? await provider.upsert(resource, built.payload)
            : await provider.create(resource, built.payload)
      resources.push(outcome)
    } catch (err) {
      logger.error({ err, resource }, 'crm sync: provider threw')
      resources.push({
        resource,
        result: 'failed',
        externalId: null,
        reason: (err as Error).message,
        errorCode: 'provider_temporarily_unavailable',
        retryable: true,
      })
    }
  }

  const wrote = resources.filter((r) => r.result === 'created' || r.result === 'updated' || r.result === 'unchanged')
  const failed = resources.filter((r) => r.result === 'failed')

  // A resource the provider deliberately does not support is not unfinished
  // work. NXT Sales has no Task object at all, and writing an Activity from a
  // qualification was never agreed — so `activity` and `task` report
  // not_supported on every run and always will.
  //
  // Counting them as an incomplete delivery meant a fully successful
  // company-only handoff could never be anything but `partial`, and the
  // idempotency short-circuit keys on `synced` — so a completed sync was never
  // recognised as complete. The terminal state is judged on the resources this
  // provider actually undertakes.
  const undertaken = resources.filter((r) => r.result !== 'not_supported')
  const skipped = resources.length - undertaken.length

  if (wrote.length > 0 && wrote.length === undertaken.length) {
    return {
      state: 'synced',
      resources,
      reason: skipped
        ? `Every resource this CRM supports was written and confirmed. ${skipped} unsupported resource(s) were not attempted.`
        : 'Every resource was written and confirmed by the CRM.',
    }
  }
  if (wrote.length > 0) {
    return {
      state: 'partial',
      resources,
      reason: `${wrote.length} of ${undertaken.length} attempted resources were written. The rest failed.`,
      errorCode: failed.length ? failed[0]!.errorCode : 'unsupported_operation',
    }
  }
  return {
    state: failed.length ? 'failed' : 'blocked_provider_unavailable',
    resources,
    reason: 'No resource could be written.',
    errorCode: failed.length ? failed[0]!.errorCode : 'write_not_supported',
  }
}

async function persist(
  result: SyncResult,
  built: BuiltPayload,
  ctx: {
    tenantId: string
    existing: Awaited<ReturnType<typeof prisma.crmSyncRecord.findFirst>>
    provider: CrmSyncProvider
    capabilities: ReturnType<CrmSyncProvider['capabilities']>
    actorCrmUserId: string | null
    durationMs: number
  },
): Promise<SyncResult> {
  const { tenantId, existing } = ctx
  const recordId = existing?.id ?? newId()
  const attempt = (existing?.attemptCount ?? 0) + 1

  const q = await prisma.salesQualification.findFirst({
    where: { id: result.qualificationId, tenantId },
    select: { ownerCrmUserId: true },
  })

  const fields = {
    tenantId,
    qualificationId: result.qualificationId,
    crmCompanyId: result.crmCompanyId!,
    companyName: result.companyName,
    state: result.state,
    externalKey: result.externalKey!,
    providerName: result.providerName,
    providerStatus: result.providerStatus,
    capabilities: ctx.capabilities as unknown as Prisma.InputJsonValue,
    mappingVersion: result.mappingVersion,
    payloadVersion: result.payloadVersion,
    resourceResults: result.resources as unknown as Prisma.InputJsonValue,
    externalIds: Object.fromEntries(
      result.resources.filter((r) => r.externalId).map((r) => [r.resource, r.externalId]),
    ) as unknown as Prisma.InputJsonValue,
    validationOk: result.validation.ok,
    validationIssues: result.validation.issues as unknown as Prisma.InputJsonValue,
    ownerCrmUserId: q?.ownerCrmUserId ?? null,
    ownerStatus: q?.ownerCrmUserId ? 'assigned' : 'unassigned',
    attemptCount: attempt,
    lastAttemptAt: new Date(),
    lastErrorCode: result.errorCode,
    lastError: result.errorCode ? result.reason.slice(0, 500) : null,
    retryable: result.retryable,
    nextRetryAt: result.retryable && attempt < env.CRM_SYNC_MAX_ATTEMPTS ? new Date(Date.now() + 60_000 * attempt) : null,
    intentScoreId: built.refs.intentScoreId,
    intentScoreSnapshotId: built.refs.intentScoreSnapshotId,
    auditRunId: built.refs.auditRunId,
    auditReportId: built.refs.auditReportId,
    workbenchDemoId: built.refs.workbenchDemoId,
    outreachCampaignId: built.refs.outreachCampaignId,
    followUpTaskId: built.refs.followUpTaskId,
    decisionMakerId: built.refs.decisionMakerId,
    syncedAt: result.state === 'synced' ? new Date() : existing?.syncedAt ?? null,
  }

  await prisma.crmSyncRecord.upsert({
    where: { qualificationId: result.qualificationId },
    create: { id: recordId, ...fields },
    update: fields,
  })

  // ── The outbox: hold a validated package that could not be delivered ───
  let outboxId: string | null = null
  if (result.validation.ok && result.state === 'blocked_provider_unavailable') {
    const held = await prisma.crmSyncOutbox.findFirst({
      where: { syncRecordId: recordId, state: 'pending' },
      orderBy: { createdAt: 'desc' },
    })

    if (held) {
      // Refresh the held package rather than stacking a second copy.
      await prisma.crmSyncOutbox.update({
        where: { id: held.id },
        data: {
          payload: built.payload as unknown as Prisma.InputJsonValue,
          mappingVersion: result.mappingVersion,
          payloadVersion: result.payloadVersion,
          reason: result.reason,
          blockedBy: result.errorCode,
          attemptCount: { increment: 1 },
        },
      })
      outboxId = held.id
    } else {
      outboxId = newId()
      await prisma.crmSyncOutbox.create({
        data: {
          id: outboxId,
          tenantId,
          syncRecordId: recordId,
          qualificationId: result.qualificationId,
          crmCompanyId: result.crmCompanyId!,
          externalKey: result.externalKey!,
          mappingVersion: result.mappingVersion,
          payloadVersion: result.payloadVersion,
          payload: built.payload as unknown as Prisma.InputJsonValue,
          state: 'pending',
          reason: result.reason,
          blockedBy: result.errorCode,
          attemptCount: 1,
        },
      })
    }
  }

  // ── Append-only attempt history ────────────────────────────────────────
  await prisma.crmSyncAttempt.create({
    data: {
      id: newId(),
      tenantId,
      syncRecordId: recordId,
      qualificationId: result.qualificationId,
      crmCompanyId: result.crmCompanyId!,
      attempt,
      previousState: existing?.state ?? null,
      newState: result.state,
      providerName: result.providerName,
      providerStatus: result.providerStatus,
      mappingVersion: result.mappingVersion,
      payloadVersion: result.payloadVersion,
      resourceResults: result.resources as unknown as Prisma.InputJsonValue,
      externalIds: fields.externalIds,
      errorCode: result.errorCode,
      error: result.errorCode ? result.reason.slice(0, 500) : null,
      retryable: result.retryable,
      validationOk: result.validation.ok,
      validationIssues: result.validation.issues as unknown as Prisma.InputJsonValue,
      durationMs: ctx.durationMs,
      actorType: ctx.actorCrmUserId ? 'user' : 'system',
      actorCrmUserId: ctx.actorCrmUserId,
    },
  })

  await audit({
    tenantId,
    actorType: ctx.actorCrmUserId ? 'user' : 'agent',
    actorCrmUserId: ctx.actorCrmUserId,
    action: `crm_sync.${result.state}`,
    resourceType: 'CrmSyncRecord',
    resourceId: recordId,
    dataClass: 'customer_pii',
    summary: `${result.companyName}: CRM handoff ${result.state} via ${result.providerName} (attempt ${attempt})`,
    metadata: {
      providerStatus: result.providerStatus,
      mappingVersion: result.mappingVersion,
      errorCode: result.errorCode,
      outboxId,
    },
  })

  return { ...result, syncRecordId: recordId, outboxId, attempt }
}

/**
 * A person approves the handoff, and only then is NXT Sales written.
 *
 * This is the ONLY path that supplies `userApproval`, so it is the only way a
 * CRM write can happen at all. Approving a package that is not waiting for a
 * decision is refused rather than treated as a re-send: the reviewer is
 * agreeing to something specific, and if the state has moved on, what they
 * read is not what would be written.
 */
export async function approveSync(
  tenantId: string,
  syncRecordId: string,
  approvedByCrmUserId: string,
  note?: string | null,
): Promise<SyncResult> {
  const record = await prisma.crmSyncRecord.findFirst({ where: { id: syncRecordId, tenantId } })
  if (!record) throw new NotFoundError('That CRM sync record does not exist.')

  if (record.state !== 'awaiting_user_approval') {
    throw new ConflictError(
      `This handoff is "${record.state}", not awaiting a decision. Only a package waiting for user approval can be approved.`,
      { state: record.state },
    )
  }

  await audit({
    tenantId,
    actorType: 'user',
    actorCrmUserId: approvedByCrmUserId,
    action: 'crm_sync.approved_by_user',
    resourceType: 'CrmSyncRecord',
    resourceId: syncRecordId,
    dataClass: 'customer_pii',
    summary: `A user approved the CRM handoff for ${record.companyName ?? record.crmCompanyId}.`,
    metadata: { qualificationId: record.qualificationId, note: note ?? null },
  })

  return syncQualification({
    tenantId,
    qualificationId: record.qualificationId,
    actorCrmUserId: approvedByCrmUserId,
    userApproval: { approvedByCrmUserId, approvedAt: new Date(), note: note ?? null },
  })
}

/**
 * A person declines the handoff.
 *
 * Recorded rather than deleted: "a reviewer looked at this and said no" is a
 * different fact from "nothing happened yet", and the difference matters when
 * somebody asks later why a qualified lead never reached the CRM.
 */
export async function rejectSync(
  tenantId: string,
  syncRecordId: string,
  rejectedByCrmUserId: string,
  reason: string,
): Promise<{ syncRecordId: string; state: SyncState; reason: string }> {
  const record = await prisma.crmSyncRecord.findFirst({ where: { id: syncRecordId, tenantId } })
  if (!record) throw new NotFoundError('That CRM sync record does not exist.')

  if (record.state !== 'awaiting_user_approval') {
    throw new ConflictError(
      `This handoff is "${record.state}", not awaiting a decision.`,
      { state: record.state },
    )
  }

  await prisma.crmSyncRecord.update({
    where: { id: syncRecordId },
    data: { state: 'rejected_by_user', lastError: reason, lastErrorCode: null },
  })

  await audit({
    tenantId,
    actorType: 'user',
    actorCrmUserId: rejectedByCrmUserId,
    action: 'crm_sync.rejected_by_user',
    resourceType: 'CrmSyncRecord',
    resourceId: syncRecordId,
    dataClass: 'customer_pii',
    summary: `A user declined the CRM handoff for ${record.companyName ?? record.crmCompanyId}.`,
    metadata: { qualificationId: record.qualificationId, reason },
  })

  return { syncRecordId, state: 'rejected_by_user', reason }
}

/**
 * Retries a handoff.
 *
 * Only a transient failure is retried, and only within the attempt ceiling. A
 * schema error or an unsupported operation is returned unchanged, because
 * retrying it would burn the CRM's capacity and fill the history with
 * identical failures.
 */
export async function retrySync(
  tenantId: string,
  syncRecordId: string,
  actorCrmUserId: string,
): Promise<SyncResult & { skipped?: string }> {
  const record = await prisma.crmSyncRecord.findFirst({ where: { id: syncRecordId, tenantId } })
  if (!record) throw new NotFoundError('That CRM sync record does not exist.')

  if (record.state === 'synced') {
    const result = await syncQualification({ tenantId, qualificationId: record.qualificationId, actorCrmUserId })
    return { ...result, skipped: 'Already synchronised; the existing result was returned.' }
  }

  if (record.lastErrorCode && !isRetryable(record.lastErrorCode) && record.lastErrorCode !== 'write_not_supported') {
    // Permanent failures are not retried. Re-running validation IS useful
    // though, because the underlying data may since have been corrected — so
    // this is a fresh evaluation rather than a blind repeat of the call.
    logger.info({ syncRecordId, errorCode: record.lastErrorCode }, 'crm sync: permanent failure, re-validating')
  }

  if (record.attemptCount >= env.CRM_SYNC_MAX_ATTEMPTS && isRetryable(record.lastErrorCode)) {
    const result = await syncQualification({
      tenantId,
      qualificationId: record.qualificationId,
      actorCrmUserId,
      dryRun: true,
    })
    return {
      ...result,
      skipped: `The retry ceiling of ${env.CRM_SYNC_MAX_ATTEMPTS} attempts has been reached. Nothing was attempted.`,
    }
  }

  return syncQualification({ tenantId, qualificationId: record.qualificationId, actorCrmUserId })
}

export async function getSyncRecord(tenantId: string, qualificationId: string) {
  return prisma.crmSyncRecord.findFirst({
    where: { qualificationId, tenantId },
    include: {
      outbox: { where: { state: 'pending' }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })
}

export async function getSyncById(tenantId: string, id: string) {
  return prisma.crmSyncRecord.findFirst({ where: { id, tenantId } })
}

export async function syncHistory(tenantId: string, qualificationId: string, limit = 50) {
  return prisma.crmSyncAttempt.findMany({
    where: { tenantId, qualificationId },
    orderBy: { occurredAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  })
}

/** The prepared package, for inspection. Read from the outbox, never rebuilt. */
export async function getPayload(tenantId: string, syncRecordId: string) {
  const record = await prisma.crmSyncRecord.findFirst({ where: { id: syncRecordId, tenantId } })
  if (!record) throw new NotFoundError('That CRM sync record does not exist.')
  const held = await prisma.crmSyncOutbox.findFirst({
    where: { syncRecordId: record.id },
    orderBy: { createdAt: 'desc' },
  })
  return { record, outbox: held }
}
