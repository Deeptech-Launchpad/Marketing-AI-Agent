import { Router } from 'express'
import { z } from 'zod'
import { addEntry } from '../../campaign/suppressionService.js'
import { env } from '../../config/env.js'
import { MEMBER_ROLES } from '../../domain/enums.js'
import { prisma, newId } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

export const adminRoutes = Router()

// ── Suppression ─────────────────────────────────────────────────────────────
// NXT Sales has no suppression concept, so this is the only place a "do not
// contact" instruction can be recorded. It applies to every audience resolution
// even though Phase 1 sends nothing, so the counts a reviewer approves are the
// real ones.

const SuppressionBody = z.object({
  matchType: z.enum(['company', 'domain', 'email']),
  matchValue: z.string().min(1).max(320),
  reason: z.string().min(1).max(500),
  scope: z.enum(['global', 'campaign']).default('global'),
  campaignId: z.string().optional(),
})

adminRoutes.post(
  '/suppression',
  requirePermission('admin'),
  validateBody(SuppressionBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof SuppressionBody>
    const entry = await addEntry({
      tenantId: p.tenantId,
      scope: body.scope,
      matchType: body.matchType,
      matchValue: body.matchValue,
      reason: body.reason,
      campaignId: body.campaignId ?? null,
      createdByCrmUserId: p.crmUserId,
    })
    res.status(201).json(entry)
  }),
)

adminRoutes.get(
  '/suppression',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const entries = await prisma.suppressionEntry.findMany({
      where: { tenantId: p.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    res.json({ entries })
  }),
)

adminRoutes.delete(
  '/suppression/:id',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const entry = await prisma.suppressionEntry.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true },
    })
    if (!entry) throw new NotFoundError('Suppression entry not found.')
    await prisma.suppressionEntry.delete({ where: { id: entry.id } })
    res.json({ id: entry.id, deleted: true })
  }),
)

// ── Members ─────────────────────────────────────────────────────────────────
// Marketing roles are granted here, deliberately separate from NXT Sales'
// User.role — a CRM admin is not automatically a campaign approver.

const MemberBody = z.object({
  email: z.string().email(),
  name: z.string().max(200).optional(),
  role: z.enum(MEMBER_ROLES),
})

adminRoutes.post(
  '/members',
  requirePermission('admin'),
  validateBody(MemberBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof MemberBody>
    const email = body.email.toLowerCase().trim()

    const member = await prisma.tenantMember.upsert({
      where: { tenantId_email: { tenantId: p.tenantId, email } },
      create: {
        id: newId(),
        tenantId: p.tenantId,
        email,
        name: body.name ?? null,
        role: body.role,
      },
      update: { role: body.role, name: body.name ?? undefined },
      select: { id: true, email: true, role: true },
    })
    res.status(201).json(member)
  }),
)

adminRoutes.get(
  '/members',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const members = await prisma.tenantMember.findMany({
      where: { tenantId: p.tenantId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, crmUserId: true },
    })
    res.json({ members })
  }),
)

// ── Prompts ─────────────────────────────────────────────────────────────────

adminRoutes.get(
  '/prompts',
  requirePermission('admin'),
  asyncHandler(async (_req, res) => {
    const prompts = await prisma.agentPrompt.findMany({
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
      select: { id: true, key: true, version: true, label: true, enabled: true, isSystem: true, temperature: true },
    })
    res.json({ prompts })
  }),
)

// ── Usage & audit ───────────────────────────────────────────────────────────

adminRoutes.get(
  '/usage',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
    const since = new Date(Date.now() - days * 86_400_000)

    const groups = await prisma.llmCall.groupBy({
      by: ['model', 'feature'],
      where: { tenantId: p.tenantId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { promptTokens: true, outputTokens: true, totalTokens: true, costUsd: true },
    })

    const unpriced = await prisma.llmCall.count({
      where: { tenantId: p.tenantId, createdAt: { gte: since }, priced: false },
    })
    const noUsageData = await prisma.llmCall.count({
      where: { tenantId: p.tenantId, createdAt: { gte: since }, hasUsageData: false },
    })

    res.json({
      windowDays: days,
      byModelFeature: groups.map((g) => ({
        model: g.model,
        feature: g.feature,
        requests: g._count._all,
        totalTokens: g._sum.totalTokens ?? 0,
        costUsd: Number(g._sum.costUsd ?? 0),
      })),
      // Reported rather than hidden: an unpriced model means the cost figure is
      // an under-estimate, and a request with no usage metadata contributes
      // zero tokens by design rather than a guess.
      unpricedRequests: unpriced,
      requestsWithoutUsageData: noUsageData,
    })
  }),
)

adminRoutes.get(
  '/audit',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const events = await prisma.auditEvent.findMany({
      where: {
        tenantId: p.tenantId,
        ...(typeof req.query.action === 'string' ? { action: req.query.action } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    res.json({ events })
  }),
)

adminRoutes.get(
  '/kill-switch',
  requirePermission('admin'),
  asyncHandler(async (_req, res) => {
    // Read-only: flipping the switch is an env change plus a restart, which is
    // deliberate. A kill switch someone can toggle over the API is one an
    // attacker can toggle back.
    res.json({
      enabled: env.KILL_SWITCH_ENABLED,
      note: 'Set KILL_SWITCH_ENABLED=true and restart to halt all agent dispatch.',
      defaultRunMode: env.DEFAULT_RUN_MODE,
      writeToolsAvailable: false,
    })
  }),
)
