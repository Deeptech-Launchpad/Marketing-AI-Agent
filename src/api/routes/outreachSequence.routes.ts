import { Router } from 'express'
import { z } from 'zod'
import { SenderSchema, readSender, writeSender } from '../../outreach/salesSequence/sender.js'
import {
  addReply,
  approve,
  approvedTemplates,
  attest,
  companyView,
  confirmReply,
  createCallPoints,
  editDraft,
  listProspects,
  markSent,
  prepareStage,
  reject,
  removeExpoParagraph,
  scheduleTestSend,
  sendTestPreview,
  setCampaignState,
  setInputs,
  skipStage,
  startSequence,
  switchVersion,
  type Actor,
} from '../../outreach/salesSequence/service.js'
import { REPLY_CLASSES } from '../../outreach/salesSequence/stageMachine.js'
import { MAX_BATCH_COMPANIES, batchCandidates, batchView, createTestBatch, listBatches, setBatchState } from '../../outreach/salesSequence/batches.js'
import { transportStatus } from '../../outreach/salesSequence/sending/transport.js'
import { audit } from '../../platform/audit.js'
import { BadRequestError } from '../../platform/errors.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'
import type { Request } from 'express'

// THE SALES-APPROVED OUTREACH SEQUENCE (2026-09-26).
//
// Drafts for review, never sends. Preparing, editing, entering values,
// pasting replies and marking an email sent are operator work; approving a
// draft is an approver's decision (the same split the legacy /release uses).
// A real customer email is never sent by the platform: an approved email is
// sent by a person from their own mail client, then marked sent.
//
// TEST MODE (2026-09-28): the only routes that deliver anything are the test
// ones below, and every one of them goes through the test-mode guard — the
// email reaches an INTERNAL test inbox only, never the customer.

export const outreachSequenceRoutes = Router()

const actorOf = (req: Request): Actor => ({
  tenantId: req.principal!.tenantId,
  crmUserId: req.principal!.crmUserId,
  requestId: req.requestId ?? null,
})

const STAGES = ['initial', 'reply_followup', 'sku_report', 'noreply_followup', 'noreply_report', 'expo_invite', 'expo_cannot_attend', 'breakup'] as const
const VERSIONS = ['v1', 'v2', 'v3'] as const

/** A stage key from the path, or a 400 naming the valid ones. */
function stageParam(raw: string | undefined): (typeof STAGES)[number] {
  const hit = STAGES.find((s) => s === raw)
  if (!hit) throw new BadRequestError(`Unknown stage "${raw ?? ''}". Valid stages: ${STAGES.join(', ')}.`)
  return hit
}

outreachSequenceRoutes.get(
  '/prospects',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json({ prospects: await listProspects(req.principal!.tenantId) })
  }),
)

outreachSequenceRoutes.get(
  '/templates',
  requirePermission('view'),
  asyncHandler(async (_req, res) => {
    res.json({ templates: approvedTemplates() })
  }),
)

outreachSequenceRoutes.get(
  '/companies/:crmCompanyId',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const campaign = typeof req.query.campaign === 'string' && req.query.campaign.trim() ? req.query.campaign.trim() : null
    res.json(await companyView(req.principal!.tenantId, req.params.crmCompanyId!, new Date(), campaign, req.principal!.crmUserId))
  }),
)

outreachSequenceRoutes.post(
  '/companies/:crmCompanyId/start',
  requirePermission('operate'),
  validateBody(z.object({ version: z.enum(VERSIONS).optional() }).strict()),
  asyncHandler(async (req, res) => {
    const result = await startSequence(actorOf(req), req.params.crmCompanyId!, req.body as { version?: (typeof VERSIONS)[number] })
    res.status(result.created ? 201 : 200).json(result)
  }),
)

outreachSequenceRoutes.post(
  '/campaigns/:id/stages/:stageKey/prepare',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const stage = stageParam(req.params.stageKey)
    res.status(201).json(await prepareStage(actorOf(req), req.params.id!, stage))
  }),
)

outreachSequenceRoutes.post(
  '/actions/:id/edit',
  requirePermission('operate'),
  validateBody(z.object({ subject: z.string().max(300).nullable(), body: z.string().min(1).max(20_000) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await editDraft(actorOf(req), req.params.id!, req.body as { subject: string | null; body: string }))
  }),
)

const InputsBody = z
  .object({
    clientCompanyName: z.string().max(200).nullable().optional(),
    skus: z.array(z.string().max(300)).max(5).nullable().optional(),
    xOf5: z.number().int().min(0).max(5).nullable().optional(),
    product: z.string().max(200).nullable().optional(),
    productCategory: z.string().max(200).nullable().optional(),
    name: z.string().max(100).nullable().optional(),
    recipientEmail: z.string().max(254).nullable().optional(),
  })
  .strict()

outreachSequenceRoutes.post(
  '/actions/:id/inputs',
  requirePermission('operate'),
  validateBody(InputsBody),
  asyncHandler(async (req, res) => {
    res.json(await setInputs(actorOf(req), req.params.id!, req.body as z.infer<typeof InputsBody>))
  }),
)

outreachSequenceRoutes.post(
  '/actions/:id/attest',
  requirePermission('operate'),
  validateBody(z.object({ key: z.enum(['ai_test', 'report_attached']), confirmed: z.boolean() }).strict()),
  asyncHandler(async (req, res) => {
    const b = req.body as { key: 'ai_test' | 'report_attached'; confirmed: boolean }
    res.json(await attest(actorOf(req), req.params.id!, b.key, b.confirmed))
  }),
)

outreachSequenceRoutes.post(
  '/actions/:id/version',
  requirePermission('operate'),
  validateBody(z.object({ version: z.enum(VERSIONS) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await switchVersion(actorOf(req), req.params.id!, (req.body as { version: (typeof VERSIONS)[number] }).version))
  }),
)

outreachSequenceRoutes.post(
  '/actions/:id/remove-expo',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    res.json(await removeExpoParagraph(actorOf(req), req.params.id!))
  }),
)

outreachSequenceRoutes.post(
  '/actions/:id/approve',
  requirePermission('approve'),
  asyncHandler(async (req, res) => {
    res.json(await approve(actorOf(req), req.params.id!))
  }),
)

outreachSequenceRoutes.post(
  '/actions/:id/reject',
  requirePermission('approve'),
  validateBody(z.object({ reason: z.string().max(500).default(''), regenerate: z.boolean().default(false) }).strict()),
  asyncHandler(async (req, res) => {
    const b = req.body as { reason: string; regenerate: boolean }
    res.json(await reject(actorOf(req), req.params.id!, b.reason, b.regenerate))
  }),
)

outreachSequenceRoutes.post(
  '/actions/:id/mark-sent',
  requirePermission('operate'),
  validateBody(z.object({ sentAt: z.string().datetime().nullable().optional() }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await markSent(actorOf(req), req.params.id!, (req.body as { sentAt?: string | null }).sentAt ?? null))
  }),
)

outreachSequenceRoutes.post(
  '/campaigns/:id/stages/:stageKey/skip',
  requirePermission('operate'),
  validateBody(z.object({ reason: z.string().max(500).default('') }).strict()),
  asyncHandler(async (req, res) => {
    const stage = stageParam(req.params.stageKey)
    res.json(await skipStage(actorOf(req), req.params.id!, stage, (req.body as { reason: string }).reason))
  }),
)

outreachSequenceRoutes.post(
  '/campaigns/:id/replies',
  requirePermission('operate'),
  validateBody(z.object({ text: z.string().min(1).max(20_000), receivedAt: z.string().datetime() }).strict()),
  asyncHandler(async (req, res) => {
    res.status(201).json(await addReply(actorOf(req), req.params.id!, req.body as { text: string; receivedAt: string }))
  }),
)

outreachSequenceRoutes.post(
  '/replies/:id/confirm',
  requirePermission('operate'),
  validateBody(z.object({ classification: z.enum(REPLY_CLASSES), skus: z.array(z.string().max(300)).max(5).optional() }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await confirmReply(actorOf(req), req.params.id!, req.body as { classification: (typeof REPLY_CLASSES)[number]; skus?: string[] }))
  }),
)

for (const to of ['stop', 'pause', 'resume'] as const) {
  outreachSequenceRoutes.post(
    `/campaigns/:id/${to}`,
    requirePermission('operate'),
    validateBody(z.object({ reason: z.string().max(500).optional() }).strict()),
    asyncHandler(async (req, res) => {
      res.json(await setCampaignState(actorOf(req), req.params.id!, to, (req.body as { reason?: string }).reason))
    }),
  )
}

outreachSequenceRoutes.post(
  '/campaigns/:id/call-points',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    res.json(await createCallPoints(actorOf(req), req.params.id!))
  }),
)

// ── TEST MODE sending (internal test inboxes only) ─────────────────────────

outreachSequenceRoutes.get(
  '/sending',
  requirePermission('view'),
  asyncHandler(async (_req, res) => {
    res.json(transportStatus())
  }),
)

outreachSequenceRoutes.post(
  '/actions/:id/test-send',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    res.json(await sendTestPreview({ ...actorOf(req), email: req.principal!.email }, req.params.id!))
  }),
)

outreachSequenceRoutes.post(
  '/actions/:id/reschedule-test',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    res.json(await scheduleTestSend(actorOf(req), req.params.id!))
  }),
)

outreachSequenceRoutes.get(
  '/batches',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json(await listBatches(req.principal!.tenantId))
  }),
)

outreachSequenceRoutes.get(
  '/batches/candidates',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json({ candidates: await batchCandidates(req.principal!.tenantId), max: MAX_BATCH_COMPANIES })
  }),
)

const CreateBatchBody = z
  .object({
    name: z.string().max(120).optional(),
    crmCompanyIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_BATCH_COMPANIES),
    firstSendAt: z.string().datetime(),
    timezone: z.string().max(64).optional(),
    sendDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    sendStart: z.string().max(5).optional(),
    sendEnd: z.string().max(5).optional(),
    spacingMinutes: z.number().int().min(1).max(240).optional(),
    dailyCap: z.number().int().min(1).max(200).optional(),
  })
  .strict()

outreachSequenceRoutes.post(
  '/batches',
  requirePermission('operate'),
  validateBody(CreateBatchBody),
  asyncHandler(async (req, res) => {
    res.status(201).json(await createTestBatch(actorOf(req), req.body as z.infer<typeof CreateBatchBody>))
  }),
)

outreachSequenceRoutes.get(
  '/batches/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json(await batchView(req.principal!.tenantId, req.params.id!))
  }),
)

for (const to of ['pause', 'resume', 'cancel'] as const) {
  outreachSequenceRoutes.post(
    `/batches/:id/${to}`,
    requirePermission('operate'),
    asyncHandler(async (req, res) => {
      res.json(await setBatchState(actorOf(req), req.params.id!, to))
    }),
  )
}

// ── The sender every draft is signed as ────────────────────────────────────

outreachSequenceRoutes.get(
  '/sender',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    // Only the shared part: the company name and signature. The person is
    // always whoever starts the outreach (see readSenderFor).
    const { companyName, signature } = await readSender(req.principal!.tenantId)
    res.json({ sender: { companyName, signature }, configured: Boolean(companyName) })
  }),
)

outreachSequenceRoutes.post(
  '/sender',
  requirePermission('admin'),
  validateBody(SenderSchema.strict()),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const sender = await writeSender(p.tenantId, req.body as z.infer<typeof SenderSchema>)
    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'outreach.sender_updated',
      resourceType: 'Tenant',
      resourceId: p.tenantId,
      summary: `Outreach company name set to ${sender.companyName}`,
      requestId: req.requestId ?? null,
    })
    res.json({ sender: { companyName: sender.companyName, signature: sender.signature }, configured: Boolean(sender.companyName) })
  }),
)
