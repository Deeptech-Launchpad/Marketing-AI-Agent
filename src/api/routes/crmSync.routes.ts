import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import {
  getPayload,
  getSyncById,
  getSyncRecord,
  listProviders,
  retrySync,
  selectProvider,
  syncHistory,
  syncQualification,
} from '../../crmsync/service.js'
import { FIELD_MAP, MAPPING_VERSION, OPEN_DECISIONS, PAYLOAD_VERSION } from '../../crmsync/mapping.js'
import { NotFoundError } from '../../platform/errors.js'
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
