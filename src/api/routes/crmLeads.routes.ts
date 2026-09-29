import { Router } from 'express'
import { z } from 'zod'
import {
  addDecisionMakerToCrm,
  addDiscoveredCompaniesToCrm,
  checkDiscoveredCompany,
  leadWriteStatus,
  type Actor,
} from '../../crm/leads/leadWrite.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'
import type { Request } from 'express'

// NEW LEADS INTO NXT SALES (2026-09-29).
//
// Checking whether a company is already in NXT Sales is a read, open to
// operators. ADDING to NXT Sales writes to the CRM, so it needs the approve
// permission, happens only on a person's click, and goes through every write
// gate (see crm/leads/leadWrite.ts). Nothing here runs on its own.

export const crmLeadsRoutes = Router()

const actorOf = (req: Request): Actor => ({
  tenantId: req.principal!.tenantId,
  crmUserId: req.principal!.crmUserId,
  requestId: req.requestId ?? null,
})

/** Whether adding to NXT Sales is possible right now, and if not, why. */
crmLeadsRoutes.get(
  '/status',
  requirePermission('view'),
  asyncHandler(async (_req, res) => {
    res.json(leadWriteStatus())
  }),
)

/** Check one company found by Prospects against the live CRM again. */
crmLeadsRoutes.post(
  '/companies/:id/check',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    res.json(await checkDiscoveredCompany(req.principal!.tenantId, req.params.id!))
  }),
)

/** "Add to NXT Sales" for one or more companies found by Prospects. */
crmLeadsRoutes.post(
  '/companies/add',
  requirePermission('approve'),
  validateBody(z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(25) }).strict()),
  asyncHandler(async (req, res) => {
    res.json({ results: await addDiscoveredCompaniesToCrm(actorOf(req), (req.body as { ids: string[] }).ids) })
  }),
)

/** Add a verified decision maker to their company's record in NXT Sales. */
crmLeadsRoutes.post(
  '/decision-makers/:id/add',
  requirePermission('approve'),
  asyncHandler(async (req, res) => {
    res.json(await addDecisionMakerToCrm(actorOf(req), req.params.id!))
  }),
)
