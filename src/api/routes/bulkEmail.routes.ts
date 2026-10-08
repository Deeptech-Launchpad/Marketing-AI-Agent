import { Router, type Request } from 'express'
import { z } from 'zod'
import {
  analyzeUpload,
  bulkSettings,
  bulkView,
  listBulk,
  recheckBulkSender,
  reviewBulk,
  reviewSingle,
  saveBulkSender,
  senderView,
  setBulkState,
  startBulk,
  startSingle,
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
const File = {
  fileBase64: z.string().min(8).max(7_200_000),
  fileName: z.string().max(200).optional(),
  // Test option: also use webmail addresses (gmail, yahoo …). Off by default.
  allowWebmail: z.boolean().optional(),
}

const Setup = z
  .object({
    ...File,
    templateKey: z.string().min(1).max(60),
    // When sending starts, in Indian Standard Time, and the gap between emails.
    startDate: z.string().max(10),
    startTime: z.string().max(5),
    intervalMinutes: z.number().int().min(1).max(240),
    name: z.string().max(120).optional(),
  })
  .strict()

bulkEmailRoutes.get(
  '/settings',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json(await bulkSettings(req.principal!.tenantId))
  }),
)

// The sender: the From the customer sees, CC on every email, and the
// signature. Saving checks the From against the server's SMTP account.
const Sender = z
  .object({
    fromEmail: z.string().min(3).max(254),
    ccEmails: z.array(z.string().max(254)).max(10),
    // The signature as pasted (HTML, embedded images included).
    signatureHtml: z.string().max(1_500_000),
  })
  .strict()

bulkEmailRoutes.get(
  '/sender',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json(await senderView(req.principal!.tenantId))
  }),
)

bulkEmailRoutes.post(
  '/sender',
  requirePermission('approve'),
  validateBody(Sender),
  asyncHandler(async (req, res) => {
    res.json(await saveBulkSender(actorOf(req), req.body as z.infer<typeof Sender>))
  }),
)

bulkEmailRoutes.post(
  '/sender/check',
  requirePermission('approve'),
  asyncHandler(async (req, res) => {
    res.json(await recheckBulkSender(actorOf(req)))
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
    res.json(await analyzeUpload(req.body as { fileBase64: string; fileName?: string; allowWebmail?: boolean }))
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

// One person, without an Excel file.
const Single = z
  .object({
    firstName: z.string().max(80),
    companyName: z.string().max(200),
    toEmail: z.string().max(254),
    ccEmails: z.array(z.string().max(254)).max(10).optional(),
    templateKey: z.string().min(1).max(60),
  })
  .strict()

bulkEmailRoutes.post(
  '/single/review',
  requirePermission('operate'),
  validateBody(Single),
  asyncHandler(async (req, res) => {
    res.json(await reviewSingle(actorOf(req), req.body as z.infer<typeof Single>))
  }),
)

bulkEmailRoutes.post(
  '/single/start',
  requirePermission('approve'),
  validateBody(Single.extend({ confirm: z.boolean() }).strict()),
  asyncHandler(async (req, res) => {
    res.status(201).json(await startSingle(actorOf(req), req.body as z.infer<typeof Single> & { confirm: boolean }))
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
