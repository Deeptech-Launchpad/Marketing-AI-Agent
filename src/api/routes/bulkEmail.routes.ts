import { Router, type Request } from 'express'
import { z } from 'zod'
import {
  analyzeUpload,
  bulkSettings,
  bulkView,
  listBulk,
  reviewBulk,
  setBulkState,
  startBulk,
  unsubscribeRecipient,
  type Actor,
} from '../../outreach/bulk/service.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// Outreach → Bulk email (2026-10-07). A separate option; the One company and
// Several companies routes are not touched. Upload and Review write nothing;
// Start needs the approve permission.

export const bulkEmailRoutes = Router()

const actorOf = (req: Request): Actor => ({ tenantId: req.principal!.tenantId, crmUserId: req.principal!.crmUserId, requestId: req.requestId })

// ~5 MB of spreadsheet, base64-encoded.
const File = { fileBase64: z.string().min(8).max(7_200_000), fileName: z.string().max(200).optional() }

const Setup = z
  .object({
    ...File,
    templateKey: z.string().min(1).max(60),
    fromEmail: z.string().min(3).max(254),
    fromName: z.string().max(80).nullable().optional(),
    ccEmails: z.array(z.string().max(254)).max(10).optional(),
    signature: z.string().max(1000),
    postalAddress: z.string().max(300),
    startDate: z.string().max(10),
    startTime: z.string().max(5),
    timezone: z.string().max(64),
    sendStart: z.string().max(5),
    sendEnd: z.string().max(5),
    sendDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    intervalMinutes: z.number().int().min(1).max(240),
    dailyCap: z.number().int().min(1).max(2000),
    name: z.string().max(120).optional(),
  })
  .strict()

bulkEmailRoutes.get(
  '/settings',
  requirePermission('view'),
  asyncHandler(async (_req, res) => {
    res.json(bulkSettings())
  }),
)

bulkEmailRoutes.get(
  '/',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json(await listBulk(req.principal!.tenantId))
  }),
)

bulkEmailRoutes.post(
  '/analyze',
  requirePermission('operate'),
  validateBody(z.object(File).strict()),
  asyncHandler(async (req, res) => {
    res.json(await analyzeUpload(req.body as { fileBase64: string; fileName?: string }))
  }),
)

bulkEmailRoutes.post(
  '/review',
  requirePermission('operate'),
  validateBody(Setup),
  asyncHandler(async (req, res) => {
    res.json(await reviewBulk(actorOf(req), req.body as z.infer<typeof Setup>))
  }),
)

bulkEmailRoutes.post(
  '/start',
  requirePermission('approve'),
  validateBody(Setup.extend({ confirm: z.boolean() }).strict()),
  asyncHandler(async (req, res) => {
    res.status(201).json(await startBulk(actorOf(req), req.body as z.infer<typeof Setup> & { confirm: boolean }))
  }),
)

bulkEmailRoutes.get(
  '/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json(await bulkView(req.principal!.tenantId, req.params.id!))
  }),
)

for (const to of ['pause', 'resume', 'cancel'] as const) {
  bulkEmailRoutes.post(
    `/:id/${to}`,
    requirePermission('operate'),
    asyncHandler(async (req, res) => {
      res.json(await setBulkState(actorOf(req), req.params.id!, to))
    }),
  )
}

bulkEmailRoutes.post(
  '/recipients/:id/unsubscribe',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    res.json(await unsubscribeRecipient(actorOf(req), req.params.id!))
  }),
)
