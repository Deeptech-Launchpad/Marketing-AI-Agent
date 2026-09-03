import { Router } from 'express'
import { z } from 'zod'
import { decideApproval } from '../../approval/approvalService.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

export const approvalRoutes = Router()

approvalRoutes.get(
  '/',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending'

    const approvals = await prisma.approval.findMany({
      where: { tenantId: p.tenantId, status },
      orderBy: { requestedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        runId: true,
        campaignId: true,
        kind: true,
        status: true,
        requestedAt: true,
        expiresAt: true,
      },
    })
    res.json({ approvals })
  }),
)

/**
 * Returns the payload the reviewer must actually read, and the hash they must
 * echo back to decide on it.
 */
approvalRoutes.get(
  '/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const approval = await prisma.approval.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: { run: { select: { objective: true, requestedByCrmUserId: true, mode: true } } },
    })
    if (!approval) throw new NotFoundError('Approval not found.')

    res.json({
      id: approval.id,
      runId: approval.runId,
      campaignId: approval.campaignId,
      kind: approval.kind,
      status: approval.status,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
      objective: approval.run.objective,
      requestedBy: approval.run.requestedByCrmUserId,
      // Must be echoed back on the decision — see approval/payloadHash.ts.
      payloadHash: approval.payloadHash,
      payload: approval.payloadSnapshot,
    })
  }),
)

const Decision = z.object({
  payloadHash: z.string().length(64),
  comment: z.string().max(4000).optional(),
})

function decisionRoute(decision: 'approved' | 'rejected' | 'changes_requested') {
  return asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof Decision>

    const result = await decideApproval({
      tenantId: p.tenantId,
      approvalId: req.params.id!,
      decision,
      payloadHash: body.payloadHash,
      comment: body.comment ?? null,
      crmUserId: p.crmUserId,
      requestId: req.requestId ?? null,
    })
    res.json({ id: req.params.id, ...result })
  })
}

approvalRoutes.post(
  '/:id/approve',
  requirePermission('approve'),
  validateBody(Decision),
  decisionRoute('approved'),
)

approvalRoutes.post(
  '/:id/reject',
  requirePermission('approve'),
  validateBody(Decision),
  decisionRoute('rejected'),
)

approvalRoutes.post(
  '/:id/request-changes',
  requirePermission('approve'),
  validateBody(Decision),
  decisionRoute('changes_requested'),
)
