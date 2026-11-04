import { Router } from 'express'
import { z } from 'zod'
import { NotFoundError } from '../../platform/errors.js'
import { companyDetail, listCompanies, retryFailed } from '../../warmleads/companies.js'
import { approvePilot, pilotResults, requestPilot } from '../../warmleads/pilot.js'
import { runDetail } from '../../warmleads/service.js'
import { approveScale, approveSync, disableSync, ensureSettings, requestListRefresh, setPaused, updateLimits, updateWindow } from '../../warmleads/settings.js'
import { buildOverview } from '../../warmleads/view.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// WARM LEADS (permanent module). Reading is open to every member; every control is an admin action.
//
// This API only READS the Marketing database and WRITES settings / requests. It never calls NXT Sales,
// never starts an evaluation, and never touches Gemini: the dedicated worker (src/warmleadsWorker.ts) does
// the work when the settings allow it. So nothing here can send an email or spend an API call.

export const warmLeadsRoutes = Router()

const FILTERS = ['all', 'pending', 'in_progress', 'warm', 'early_signal', 'cold', 'insufficient_data', 'existing_customer', 'active_opportunity', 'do_not_contact', 'failed', 'needs_reevaluation', 'research_incomplete'] as const
const Confirm = z.object({ confirm: z.literal(true) })

warmLeadsRoutes.get(
  '/overview',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.get(
  '/companies',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        filter: z.enum(FILTERS).default('all'),
        search: z.string().max(100).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query)
    res.json(await listCompanies(req.principal!.tenantId, q))
  }),
)

warmLeadsRoutes.get(
  '/companies/:crmCompanyId',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const d = await companyDetail(req.principal!.tenantId, String(req.params.crmCompanyId))
    if (!d) throw new NotFoundError('Company not found in the Warm Leads list.')
    res.json(d)
  }),
)

warmLeadsRoutes.get(
  '/pilot/results',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json({ evaluations: await pilotResults(req.principal!.tenantId) })
  }),
)

warmLeadsRoutes.get(
  '/runs/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    res.json(await runDetail(req.principal!.tenantId, String(req.params.id)))
  }),
)

// ── Controls (admin) ────────────────────────────────────────────────────────

warmLeadsRoutes.post(
  '/start',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    await setPaused(req.principal!.tenantId, false, req.principal!.crmUserId)
    res.json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.post(
  '/pause',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    await setPaused(req.principal!.tenantId, true, req.principal!.crmUserId)
    res.json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.put(
  '/limits',
  requirePermission('admin'),
  validateBody(
    z
      .object({
        dailyCompanyLimit: z.number().int().optional(),
        dailyGeminiCeiling: z.number().int().optional(),
        retryShare: z.number().int().optional(),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) => {
    await updateLimits(req.principal!.tenantId, req.principal!.crmUserId, req.body)
    res.json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.put(
  '/window',
  requirePermission('admin'),
  validateBody(z.object({ start: z.string().max(5), end: z.string().max(5), timezone: z.string().max(64) }).strict()),
  asyncHandler(async (req, res) => {
    await updateWindow(req.principal!.tenantId, req.principal!.crmUserId, req.body)
    res.json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.post(
  '/refresh-list',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    await requestListRefresh(req.principal!.tenantId, req.principal!.crmUserId)
    res.status(202).json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.post(
  '/pilot',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    await requestPilot(req.principal!.tenantId, req.principal!.crmUserId)
    res.status(202).json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.post(
  '/pilot/approve',
  requirePermission('admin'),
  validateBody(Confirm),
  asyncHandler(async (req, res) => {
    await approvePilot(req.principal!.tenantId, req.principal!.crmUserId)
    res.json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.post(
  '/retry-failed',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    const s = await ensureSettings(req.principal!.tenantId)
    const retried = await retryFailed(req.principal!.tenantId, { pilotOnly: !s.pilotApprovedAt })
    res.json({ retried, overview: await buildOverview(req.principal!.tenantId) })
  }),
)

warmLeadsRoutes.post(
  '/scale/approve',
  requirePermission('admin'),
  validateBody(z.object({ level: z.literal(50), confirm: z.literal(true) })),
  asyncHandler(async (req, res) => {
    await approveScale(req.principal!.tenantId, req.principal!.crmUserId, req.body.level)
    res.json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.post(
  '/sync/approve',
  requirePermission('admin'),
  validateBody(Confirm),
  asyncHandler(async (req, res) => {
    await approveSync(req.principal!.tenantId, req.principal!.crmUserId)
    res.json(await buildOverview(req.principal!.tenantId))
  }),
)

warmLeadsRoutes.post(
  '/sync/disable',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    await disableSync(req.principal!.tenantId, req.principal!.crmUserId)
    res.json(await buildOverview(req.principal!.tenantId))
  }),
)
