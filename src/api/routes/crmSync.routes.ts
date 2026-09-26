import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import {
  approveSync,
  getPayload,
  getSyncById,
  getSyncRecord,
  listProviders,
  rejectSync,
  retrySync,
  selectProvider,
  syncHistory,
  syncQualification,
} from '../../crmsync/service.js'
import { FIELD_MAP, MAPPING_VERSION, OPEN_DECISIONS, PAYLOAD_VERSION } from '../../crmsync/mapping.js'
import { prisma } from '../../platform/db.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// TASK #986 — the CRM handoff API.
//
// SECURITY: a caller names a QUALIFICATION and nothing else.
//
// No endpoint accepts a score, a qualification status, an owner, a CRM
// external id or a tenant. Every one of those is loaded from trusted internal
// records, and the tenant comes from the token — so a qualification id from
// another tenant resolves to nothing rather than to somebody else's lead.
//
// No response carries a credential. The provider sections report availability
// and remediation, never configuration values.
//
// LANGUAGE: "prepared" is what happens today. "completed" is reserved for a
// provider confirming a write, and no provider can.

export const crmSyncRoutes = Router()

/** What a UI needs to render the handoff without re-deriving anything. */
function present(record: {
  id: string
  crmCompanyId: string
  companyName: string | null
  state: string
  externalKey: string
  providerName: string
  providerStatus: string
  mappingVersion: string
  payloadVersion: string
  resourceResults: unknown
  externalIds: unknown
  validationOk: boolean
  validationIssues: unknown
  ownerCrmUserId: string | null
  ownerStatus: string
  attemptCount: number
  lastAttemptAt: Date | null
  lastErrorCode: string | null
  lastError: string | null
  retryable: boolean
  syncedAt: Date | null
  qualificationId: string
}) {
  return {
    syncId: record.id,
    qualificationId: record.qualificationId,
    crmCompanyId: record.crmCompanyId,
    companyName: record.companyName,

    state: record.state,
    // Plain words for a UI, so nobody has to interpret a state name.
    stateLabel: STATE_LABELS[record.state] ?? record.state,

    provider: { name: record.providerName, status: record.providerStatus },
    mappingVersion: record.mappingVersion,
    payloadVersion: record.payloadVersion,
    externalKey: record.externalKey,

    // Per resource, never averaged into one word.
    resources: record.resourceResults ?? [],
    externalIds: record.externalIds ?? {},

    validation: { ok: record.validationOk, issues: record.validationIssues ?? [] },

    owner: { crmUserId: record.ownerCrmUserId, status: record.ownerStatus },

    attempts: record.attemptCount,
    lastAttemptAt: record.lastAttemptAt,
    lastError: record.lastErrorCode ? { code: record.lastErrorCode, message: record.lastError } : null,
    retryable: record.retryable,
    syncedAt: record.syncedAt,
  }
}

const STATE_LABELS: Record<string, string> = {
  pending: 'Not yet prepared',
  ready: 'Prepared and ready',
  synced: 'Synchronised with the CRM',
  partial: 'Partially synchronised',
  awaiting_user_approval: 'Prepared — waiting for a person to decide',
  rejected_by_user: 'Declined by a reviewer',
  blocked_provider_unavailable: 'Prepared — CRM synchronisation unavailable',
  blocked_validation: 'Blocked — the package did not validate',
  blocked_not_qualified: 'Not synchronised — the lead is not qualified',
  blocked_missing_owner: 'Blocked — no sales owner assigned',
  failed: 'Failed',
  retrying: 'Retrying',
}

const SyncBody = z
  .object({
    // A qualification REFERENCE. Nothing else is accepted.
    dryRun: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict()

/** 1. Prepare (and deliver, if a provider can) the handoff for a qualification. */
crmSyncRoutes.post(
  '/qualifications/:qualificationId',
  requirePermission('operate'),
  validateBody(SyncBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof SyncBody>

    const result = await syncQualification({
      tenantId: p.tenantId,
      qualificationId: String(req.params.qualificationId),
      actorCrmUserId: p.crmUserId,
      dryRun: body.dryRun,
      force: body.force,
    })

    res.json({
      syncId: result.syncRecordId,
      qualificationId: result.qualificationId,
      crmCompanyId: result.crmCompanyId,
      companyName: result.companyName,
      state: result.state,
      stateLabel: STATE_LABELS[result.state] ?? result.state,
      reason: result.reason,
      provider: { name: result.providerName, status: result.providerStatus },
      mappingVersion: result.mappingVersion,
      payloadVersion: result.payloadVersion,
      externalKey: result.externalKey,
      resources: result.resources,
      validation: result.validation,
      attempt: result.attempt,
      retryable: result.retryable,
      errorCode: result.errorCode,
      outboxId: result.outboxId,
      dryRun: result.dryRun,
      reused: result.reused,
    })
  }),
)

/** 2. The current handoff state for a qualification. */
crmSyncRoutes.get(
  '/qualifications/:qualificationId',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const qualificationId = String(req.params.qualificationId)
    const record = await getSyncRecord(p.tenantId, qualificationId)

    if (!record) {
      res.json({
        qualificationId,
        prepared: false,
        reason: 'No CRM handoff has been prepared for this qualification yet.',
      })
      return
    }

    const held = record.outbox[0]
    res.json({
      prepared: true,
      ...present(record),
      outbox: held
        ? {
            id: held.id,
            state: held.state,
            reason: held.reason,
            blockedBy: held.blockedBy,
            attemptCount: held.attemptCount,
            createdAt: held.createdAt,
          }
        : null,
    })
  }),
)

/** 3. Every attempt, newest first. Append-only. */
crmSyncRoutes.get(
  '/qualifications/:qualificationId/history',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const limit = Number(req.query.limit ?? 50) || 50
    const rows = await syncHistory(p.tenantId, String(req.params.qualificationId), limit)

    res.json({
      qualificationId: req.params.qualificationId,
      attempts: rows.map((a) => ({
        id: a.id,
        attempt: a.attempt,
        from: a.previousState,
        to: a.newState,
        provider: { name: a.providerName, status: a.providerStatus },
        mappingVersion: a.mappingVersion,
        payloadVersion: a.payloadVersion,
        resources: a.resourceResults ?? [],
        externalIds: a.externalIds ?? {},
        validationOk: a.validationOk,
        error: a.errorCode ? { code: a.errorCode, message: a.error } : null,
        retryable: a.retryable,
        durationMs: a.durationMs,
        actorType: a.actorType,
        occurredAt: a.occurredAt,
      })),
      note: 'Append-only. A later attempt adds a row; it never rewrites an earlier one.',
    })
  }),
)

/** 4. Retry. Transient failures only, within the attempt ceiling. */
crmSyncRoutes.post(
  '/:id/retry',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const result = await retrySync(p.tenantId, String(req.params.id), p.crmUserId)
    res.json({
      syncId: result.syncRecordId,
      state: result.state,
      stateLabel: STATE_LABELS[result.state] ?? result.state,
      reason: result.reason,
      attempt: result.attempt,
      retryable: result.retryable,
      errorCode: result.errorCode,
      ...(result.skipped ? { skipped: result.skipped } : {}),
    })
  }),
)

/** 5. The prepared package itself, for inspection. */
crmSyncRoutes.get(
  '/:id/payload',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const { record, outbox } = await getPayload(p.tenantId, String(req.params.id))
    if (!outbox) {
      throw new NotFoundError('No prepared package is held for this handoff.')
    }
    res.json({
      syncId: record.id,
      qualificationId: record.qualificationId,
      mappingVersion: outbox.mappingVersion,
      payloadVersion: outbox.payloadVersion,
      state: outbox.state,
      reason: outbox.reason,
      payload: outbox.payload,
      note: 'Minimised at build time: business-useful fields and references only. No credential, no raw provider payload, no report binary.',
    })
  }),
)

/** 6. Provider capability, reported honestly. */
crmSyncRoutes.get(
  '/providers',
  requirePermission('view'),
  asyncHandler(async (_req, res) => {
    const active = selectProvider()
    res.json({
      activeProvider: active.name,
      providers: listProviders().map((p) => ({
        name: p.name,
        destination: p.destination,
        capabilities: p.capabilities(),
        ...p.availability(),
      })),
      mappingVersion: MAPPING_VERSION,
      payloadVersion: PAYLOAD_VERSION,
      note: 'No provider can currently write to a CRM. Packages are prepared, validated and held.',
    })
  }),
)

/** 7. One provider in full, with the field map and the open decisions. */
crmSyncRoutes.get(
  '/providers/:provider',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const name = String(req.params.provider)
    const provider = listProviders().find((p) => p.name === name)
    if (!provider) throw new NotFoundError(`No CRM sync provider named "${name}".`)

    res.json({
      name: provider.name,
      destination: provider.destination,
      capabilities: provider.capabilities(),
      ...provider.availability(),
      mappingVersion: MAPPING_VERSION,
      payloadVersion: PAYLOAD_VERSION,
      fieldMap: FIELD_MAP,
      writableFields: FIELD_MAP.filter((m) => m.disposition === 'write').length,
      blockedFields: FIELD_MAP.filter((m) => m.disposition === 'blocked_no_target_field').length,
      // Surfaced rather than buried: this map encodes decisions nobody has taken.
      openBusinessDecisions: OPEN_DECISIONS,
      policy: {
        allowUnassigned: env.CRM_SYNC_ALLOW_UNASSIGNED,
        includeWorkbenchLink: env.CRM_SYNC_INCLUDE_WORKBENCH_LINK,
        maxAttempts: env.CRM_SYNC_MAX_ATTEMPTS,
      },
    })
  }),
)

/** Also useful for a UI: the handoff by its own id. */
crmSyncRoutes.get(
  '/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const record = await getSyncById(p.tenantId, String(req.params.id))
    if (!record) throw new NotFoundError('That CRM sync record does not exist.')
    res.json(present(record))
  }),
)

// ─────────────────────────────────────────────────────────────────────────────
// THE HUMAN DECISION SURFACE
//
// approveSync() and rejectSync() were implemented, tested, and reachable from
// nothing. A handoff could be prepared and held for a person, and no person had
// any way to answer it. These three endpoints are that missing surface and
// nothing more.
//
// WHAT THESE ROUTES DO NOT DO
//
//   · They do not decide anything. The state machine, the audit write and the
//     delivery all live in crmsync/service.ts; a route that re-implemented any
//     of it would be a second answer to the same question.
//   · They do not accept an approver. Identity comes from the verified JWT, so
//     a body naming someone else changes nothing about who is recorded.
//   · They do not accept a payload. The score and the qualification status are
//     rebuilt from trusted records at delivery time. Both bodies are `.strict()`
//     and carry only a concurrency token and the reviewer's own words, so a
//     field like `intentScore` is rejected rather than quietly ignored.
//
// Paths are two segments deep on purpose: `/:id` above matches a single
// segment, so `/approvals/...` cannot be swallowed by it.

/**
 * Who prepared this handoff.
 *
 * Not stored on the record — it lives on the attempt that created it, which is
 * the append-only history of who did what. Read here so a reviewer cannot sign
 * off their own work while the policy forbids it.
 */
async function requestersFor(syncRecordIds: string[]): Promise<Map<string, string | null>> {
  if (syncRecordIds.length === 0) return new Map()
  const attempts = await prisma.crmSyncAttempt.findMany({
    where: { syncRecordId: { in: syncRecordIds }, actorType: 'user', actorCrmUserId: { not: null } },
    orderBy: { occurredAt: 'asc' },
    select: { syncRecordId: true, actorCrmUserId: true },
  })
  const byRecord = new Map<string, string | null>()
  // First user attempt wins: whoever raised it, not whoever last touched it.
  for (const a of attempts) if (!byRecord.has(a.syncRecordId)) byRecord.set(a.syncRecordId, a.actorCrmUserId)
  return byRecord
}

/**
 * Refuses a decision on a record that has moved since the reviewer saw it.
 *
 * The reviewer echoes back the `updatedAt` they were shown. If the record has
 * been re-synced, retried or already decided in between, the value no longer
 * matches and the decision is refused rather than applied to a different
 * package than the one that was read.
 */
function assertFresh(seen: string, actual: Date): void {
  if (new Date(seen).getTime() !== actual.getTime()) {
    throw new ConflictError(
      'This handoff has changed since you loaded it. Reload it and review the current package before deciding.',
      { expectedUpdatedAt: seen, actualUpdatedAt: actual.toISOString() },
    )
  }
}

/** Applies the existing self-approval policy. Not a new rule — the same one. */
function assertNotSelfApproval(requestedBy: string | null, deciderCrmUserId: string): void {
  if (!env.ALLOW_SELF_APPROVAL && requestedBy && requestedBy === deciderCrmUserId) {
    throw new ForbiddenError(
      'You prepared this handoff, so you cannot also approve it. An approval is a second person agreeing.',
    )
  }
}

const DecisionBody = z
  .object({
    /** The `updatedAt` the reviewer was shown. A stale value is refused. */
    expectedUpdatedAt: z.string().datetime(),
    note: z.string().min(1).max(4000).optional(),
  })
  .strict()

const RejectBody = z
  .object({
    expectedUpdatedAt: z.string().datetime(),
    // A rejection must say why: "declined" with no reason tells the next person
    // nothing, and this is the record they will read.
    reason: z.string().min(3).max(4000),
  })
  .strict()

async function pendingRecord(tenantId: string, syncId: string) {
  const record = await prisma.crmSyncRecord.findFirst({ where: { id: syncId, tenantId } })
  if (!record) throw new NotFoundError('That CRM handoff does not exist.')
  return record
}

/** 9. Everything waiting for a person, shaped for a review screen. */
crmSyncRoutes.get(
  '/approvals/pending',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const records = await prisma.crmSyncRecord.findMany({
      where: { tenantId: p.tenantId, state: 'awaiting_user_approval' },
      orderBy: { updatedAt: 'asc' },
      take: 200,
      include: { qualification: { select: { status: true, scoreAtQualification: true, reason: true } } },
    })
    const requesters = await requestersFor(records.map((r) => r.id))

    res.json({
      // Deliberately narrow. A reviewer needs to know which company, how it
      // scored, who owns it and whether the package validated — not the
      // evidence chain behind it. The full package stays behind
      // GET /crm-sync/:id/payload for anyone who wants to look.
      pending: records.map((r) => {
        const requestedBy = requesters.get(r.id) ?? null
        return {
          syncId: r.id,
          qualificationId: r.qualificationId,
          crmCompanyId: r.crmCompanyId,
          companyName: r.companyName,
          state: r.state,
          stateLabel: STATE_LABELS[r.state] ?? r.state,
          qualification: {
            status: r.qualification.status,
            score: r.qualification.scoreAtQualification,
            reason: r.qualification.reason,
          },
          owner: { crmUserId: r.ownerCrmUserId, status: r.ownerStatus },
          validation: { ok: r.validationOk },
          preparedAt: r.lastAttemptAt,
          requestedByCrmUserId: requestedBy,
          /** True when THIS caller may not decide it. Shown, not enforced here. */
          youPreparedThis: Boolean(requestedBy && requestedBy === p.crmUserId),
          /** Echo this back with a decision so a stale review is refused. */
          expectedUpdatedAt: r.updatedAt,
        }
      }),
      count: records.length,
      note: 'A CRM handoff is written only after a person approves it. Nothing here has been sent.',
    })
  }),
)

/** 10. A person approves. This is the only route that can cause a CRM write. */
crmSyncRoutes.post(
  '/approvals/:syncId/approve',
  requirePermission('approve'),
  validateBody(DecisionBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as { expectedUpdatedAt: string; note?: string }

    const record = await pendingRecord(p.tenantId, String(req.params.syncId))
    assertFresh(body.expectedUpdatedAt, record.updatedAt)
    assertNotSelfApproval((await requestersFor([record.id])).get(record.id) ?? null, p.crmUserId)

    // The state check, the audit write and the delivery are approveSync's. A
    // record that is already approved, already rejected, or never awaited a
    // decision is refused there, with the state named.
    const result = await approveSync(p.tenantId, record.id, p.crmUserId, body.note ?? null)

    res.json({
      syncId: result.syncRecordId,
      qualificationId: result.qualificationId,
      state: result.state,
      stateLabel: STATE_LABELS[result.state] ?? result.state,
      decision: 'approved',
      decidedByCrmUserId: p.crmUserId,
      reason: result.reason,
      resources: result.resources,
      errorCode: result.errorCode,
    })
  }),
)

/** 11. A person declines. Recorded, not deleted. */
crmSyncRoutes.post(
  '/approvals/:syncId/reject',
  requirePermission('approve'),
  validateBody(RejectBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as { expectedUpdatedAt: string; reason: string }

    const record = await pendingRecord(p.tenantId, String(req.params.syncId))
    assertFresh(body.expectedUpdatedAt, record.updatedAt)
    // No self-approval check on a rejection: declining your own handoff takes a
    // lead out of the queue, which is the safe direction. The reason is
    // recorded either way.

    const result = await rejectSync(p.tenantId, record.id, p.crmUserId, body.reason)

    res.json({
      syncId: result.syncRecordId,
      state: result.state,
      stateLabel: STATE_LABELS[result.state] ?? result.state,
      decision: 'rejected',
      decidedByCrmUserId: p.crmUserId,
      reason: result.reason,
    })
  }),
)
