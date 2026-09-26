import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../../platform/audit.js'
import { prisma, newId } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_OUTREACH_ACTION } from '../../platform/queue.js'
import { channelStatus, createCampaign, executeAction } from '../../outreach/engine.js'
import { checkSuppression } from '../../outreach/suppression.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// TASK #982 — the outreach API.
//
// Authenticated, RBAC-gated, tenant-scoped. `operate` plans and cancels;
// `approve` is what releases an action for execution, reusing the same
// permission that signs off an audit report — because deciding to contact a
// prospect is the same class of decision.
//
// No endpoint here exposes a provider secret, and none of them sends anything
// synchronously: execution goes through the queue so it can be retried,
// re-validated and audited.

export const outreachRoutes = Router()

const CreateBody = z
  .object({
    // Primary since the 2026-09-24 restructure: the default path builds from
    // Decision Makers + Intent Signals for this company, not an audit.
    crmCompanyId: z.string().min(1).optional(),
    discoveredCompanyId: z.string().min(1).optional(),
    // LEGACY: when given, the campaign is built from this approved audit
    // exactly as it always has been.
    auditRunId: z.string().min(1).optional(),
    dryRun: z.boolean().optional(),
    startsAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((b) => Boolean(b.crmCompanyId || b.auditRunId), {
    message: 'Either crmCompanyId or auditRunId is required.',
  })

/** 1. Plan a campaign — from Decision Makers + Intent Signals, or (legacy) from an approved audit. */
outreachRoutes.post(
  '/campaigns',
  requirePermission('operate'),
  validateBody(CreateBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof CreateBody>

    const result = await createCampaign({
      tenantId: p.tenantId,
      crmCompanyId: body.crmCompanyId,
      discoveredCompanyId: body.discoveredCompanyId ?? null,
      auditRunId: body.auditRunId,
      requestedByCrmUserId: p.crmUserId,
      dryRun: body.dryRun,
      startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
    })

    res.status(201).json({
      ...result,
      channels: channelStatus(),
      note: 'Nothing has been sent. Actions are composed, validated and scheduled; releasing one for execution is a separate, permissioned step.',
    })
  }),
)

/** 2 & 3. The campaign, its steps and its actions. */
outreachRoutes.get(
  '/campaigns/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const campaign = await prisma.outreachCampaign.findFirst({
      where: { id: req.params.id!, tenantId: p.tenantId },
      include: {
        steps: { orderBy: { stepNumber: 'asc' } },
        actions: {
          orderBy: { stepNumber: 'asc' },
          include: { message: { select: { subject: true, characterCount: true, templateKey: true, templateVersion: true } } },
        },
      },
    })
    if (!campaign) throw new NotFoundError('Outreach campaign not found.')

    const byStatus: Record<string, number> = {}
    campaign.actions.forEach((a) => (byStatus[a.status] = (byStatus[a.status] ?? 0) + 1))

    res.json({
      ...campaign,
      byStatus,
      channels: channelStatus(),
      disclaimers: [
        'Every action records which gate stopped it: a blocked provider, a failed validation, a suppression rule, or a missing target.',
        'A blocked channel does not fail the campaign — the other channels continue.',
        'Auto-send is off unless enabled BOTH globally and on the campaign. A dry run stays a dry run regardless.',
      ],
    })
  }),
)

/** 4. Preview the generated messages, with the evidence behind each. */
outreachRoutes.get(
  '/campaigns/:id/messages',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const campaign = await prisma.outreachCampaign.findFirst({
      where: { id: req.params.id!, tenantId: p.tenantId },
      select: { id: true, companyName: true },
    })
    if (!campaign) throw new NotFoundError('Outreach campaign not found.')

    const actions = await prisma.outreachAction.findMany({
      where: { campaignId: campaign.id },
      orderBy: { stepNumber: 'asc' },
      include: { message: true },
    })

    res.json({
      campaignId: campaign.id,
      companyName: campaign.companyName,
      messages: actions.map((a) => ({
        actionId: a.id,
        stepNumber: a.stepNumber,
        channel: a.channel,
        status: a.status,
        statusReason: a.statusReason,
        target: { name: a.contactName, title: a.contactTitle, destination: a.destination, kind: a.destinationKind },
        subject: a.message?.subject ?? null,
        body: a.message?.body ?? null,
        templateKey: a.message?.templateKey,
        templateVersion: a.message?.templateVersion,
        workbenchUrl: a.message?.workbenchUrl ?? null,
        evidence: a.message?.evidence ?? [],
        validation: a.validation,
      })),
      disclaimers: [
        'Every claim in these messages is drawn from an approved audit finding and passes the same claim guard used on the audit report.',
        'A message that cites a finding names the finding it cites, so "why was this sent to this person" always has an answer.',
      ],
    })
  }),
)

const ReleaseBody = z.object({ actionId: z.string().min(1) }).strict()

/**
 * 5 & 6. Release one action for execution.
 *
 * Requires `approve`, not `operate`: composing a message is planning work,
 * deciding to contact somebody is a sign-off.
 */
outreachRoutes.post(
  '/campaigns/:id/release',
  requirePermission('approve'),
  validateBody(ReleaseBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof ReleaseBody>

    const action = await prisma.outreachAction.findFirst({
      where: { id: body.actionId, campaignId: req.params.id!, tenantId: p.tenantId },
      select: { id: true, status: true, channel: true, stepNumber: true, companyName: true },
    })
    if (!action) throw new NotFoundError('Action not found on that campaign.')

    await enqueue(QUEUE_OUTREACH_ACTION, { actionId: action.id })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'outreach.action_released',
      resourceType: 'OutreachAction',
      resourceId: action.id,
      dataClass: 'customer_pii',
      summary: `${action.channel} step ${action.stepNumber} for ${action.companyName} released for execution`,
      requestId: req.requestId,
    })

    res.status(202).json({
      actionId: action.id,
      queued: true,
      note: 'Queued. Suppression, provider availability and message validation are all re-checked at execution time.',
    })
  }),
)

/** Execute synchronously — for a controlled dry run, not for bulk sending. */
outreachRoutes.post(
  '/campaigns/:id/execute',
  requirePermission('approve'),
  validateBody(ReleaseBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof ReleaseBody>

    const action = await prisma.outreachAction.findFirst({
      where: { id: body.actionId, campaignId: req.params.id!, tenantId: p.tenantId },
      select: { id: true },
    })
    if (!action) throw new NotFoundError('Action not found on that campaign.')

    const result = await executeAction(action.id)
    res.json(result)
  }),
)

/** 7. One action's full history, including every provider attempt. */
outreachRoutes.get(
  '/actions/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const action = await prisma.outreachAction.findFirst({
      where: { id: req.params.id!, tenantId: p.tenantId },
      include: {
        message: true,
        runs: { orderBy: { attempt: 'asc' } },
        campaign: { select: { auditRunId: true, dryRun: true, autoSendEnabled: true } },
      },
    })
    if (!action) throw new NotFoundError('Outreach action not found.')

    res.json({
      ...action,
      why: {
        target: action.contactName
          ? `${action.contactName}${action.contactTitle ? ` (${action.contactTitle})` : ''} at ${action.companyName}`
          : `${action.companyName} — no verified individual was identified`,
        channel: action.channel,
        evidence: action.message?.evidence ?? [],
        auditRunId: action.campaign.auditRunId,
        validation: action.validation,
        suppression: action.suppressionReason
          ? { reason: action.suppressionReason, detail: action.suppressionDetail }
          : null,
      },
    })
  }),
)

const SuppressBody = z
  .object({
    matchType: z.enum(['company', 'domain', 'email']),
    matchValue: z.string().min(1).max(320),
    reason: z.string().min(3).max(500),
    source: z.enum(['manual', 'unsubscribe', 'policy']).default('manual'),
  })
  .strict()

/** 8a. Cancel every future action on a campaign. */
outreachRoutes.post(
  '/campaigns/:id/cancel',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const campaign = await prisma.outreachCampaign.findFirst({
      where: { id: req.params.id!, tenantId: p.tenantId },
      select: { id: true, companyName: true },
    })
    if (!campaign) throw new NotFoundError('Outreach campaign not found.')

    // Anything already sent stays sent: cancelling stops what has not happened,
    // it does not rewrite what has.
    const cancelled = await prisma.outreachAction.updateMany({
      where: { campaignId: campaign.id, status: { notIn: ['sent', 'cancelled'] } },
      data: { status: 'cancelled', statusReason: 'Campaign cancelled by an operator.' },
    })
    await prisma.outreachCampaign.update({ where: { id: campaign.id }, data: { status: 'cancelled' } })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'outreach.campaign_cancelled',
      resourceType: 'OutreachCampaign',
      resourceId: campaign.id,
      dataClass: 'internal',
      summary: `${campaign.companyName}: ${cancelled.count} pending action(s) cancelled`,
      requestId: req.requestId,
    })

    res.json({ cancelled: cancelled.count, note: 'Actions already sent are unchanged.' })
  }),
)

/** 8b. Add a suppression entry. Applies to every channel immediately. */
outreachRoutes.post(
  '/suppressions',
  requirePermission('operate'),
  validateBody(SuppressBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof SuppressBody>

    const entry = await prisma.suppressionEntry.upsert({
      where: {
        tenantId_scope_matchType_matchValue: {
          tenantId: p.tenantId,
          scope: 'global',
          matchType: body.matchType,
          matchValue: body.matchValue.toLowerCase().trim(),
        },
      },
      create: {
        id: newId(),
        tenantId: p.tenantId,
        scope: 'global',
        matchType: body.matchType,
        matchValue: body.matchValue.toLowerCase().trim(),
        reason: body.reason,
        source: body.source,
        createdByCrmUserId: p.crmUserId,
      },
      update: { reason: body.reason, source: body.source },
    })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'outreach.suppression_added',
      resourceType: 'SuppressionEntry',
      resourceId: entry.id,
      dataClass: 'customer_pii',
      summary: `${body.matchType} "${body.matchValue}" suppressed: ${body.reason}`,
      requestId: req.requestId,
    })

    res.status(201).json({
      ...entry,
      note: 'This suppression applies to every channel. A contact who opted out of one channel has not consented to another.',
    })
  }),
)

/** Channel availability, for an operator deciding what is worth planning. */
outreachRoutes.get(
  '/channels',
  requirePermission('view'),
  asyncHandler(async (_req, res) => {
    res.json({
      channels: channelStatus(),
      disclaimers: [
        'Status is read from configuration at request time. No credential is ever returned.',
        '"draft_only" means the message is composed for a human to send — the platform will not act on that channel.',
      ],
    })
  }),
)

/** A dry-run suppression check, so an operator can see a block before planning. */
outreachRoutes.get(
  '/suppressions/check',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const crmCompanyId = String(req.query.crmCompanyId ?? '')
    if (!crmCompanyId) throw new NotFoundError('Provide crmCompanyId.')

    const result = await checkSuppression({
      tenantId: p.tenantId,
      crmCompanyId,
      companyName: String(req.query.companyName ?? ''),
      companyDomain: typeof req.query.domain === 'string' ? req.query.domain : null,
      destination: typeof req.query.destination === 'string' ? req.query.destination : null,
      channel: 'email',
    })
    res.json(result)
  }),
)

// ── SALES-APPROVED TEMPLATES (2026-09-24 restructure) ───────────────────────
//
// Plain CRUD over what Sales supplies. The platform never authors or edits a
// template's own words — composeFromTemplate (personalize.ts) is the only
// thing that ever rewrites one, and only per recipient, grounded in facts.

const TemplateBody = z
  .object({
    channel: z.enum(['email', 'linkedin', 'call', 'email_followup', 'whatsapp']),
    key: z.string().min(1).max(200),
    version: z.string().min(1).max(50),
    purpose: z.string().min(1).max(500),
    subjectRaw: z.string().max(2000).nullable().optional(),
    bodyRaw: z.string().min(1).max(20_000),
  })
  .strict()

outreachRoutes.post(
  '/templates',
  requirePermission('operate'),
  validateBody(TemplateBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof TemplateBody>

    const template = await prisma.outreachTemplate.upsert({
      where: { tenantId_channel_key_version: { tenantId: p.tenantId, channel: body.channel, key: body.key, version: body.version } },
      create: {
        id: newId(),
        tenantId: p.tenantId,
        channel: body.channel,
        key: body.key,
        version: body.version,
        purpose: body.purpose,
        subjectRaw: body.subjectRaw ?? null,
        bodyRaw: body.bodyRaw,
        createdByCrmUserId: p.crmUserId,
      },
      update: {
        purpose: body.purpose,
        subjectRaw: body.subjectRaw ?? null,
        bodyRaw: body.bodyRaw,
      },
    })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'outreach.template_saved',
      resourceType: 'OutreachTemplate',
      resourceId: template.id,
      summary: `${body.channel} "${body.key}@${body.version}"`,
      requestId: req.requestId,
    })

    res.status(201).json(template)
  }),
)

outreachRoutes.get(
  '/templates',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const channel = typeof req.query.channel === 'string' ? req.query.channel : undefined
    const templates = await prisma.outreachTemplate.findMany({
      where: { tenantId: p.tenantId, ...(channel ? { channel } : {}) },
      orderBy: [{ channel: 'asc' }, { createdAt: 'desc' }],
    })
    res.json({ templates })
  }),
)

outreachRoutes.patch(
  '/templates/:id',
  requirePermission('operate'),
  validateBody(z.object({ isActive: z.boolean() }).strict()),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const existing = await prisma.outreachTemplate.findFirst({ where: { id: req.params.id!, tenantId: p.tenantId } })
    if (!existing) throw new NotFoundError('Template not found.')

    const { isActive } = req.body as { isActive: boolean }
    const template = await prisma.outreachTemplate.update({ where: { id: existing.id }, data: { isActive } })
    res.json(template)
  }),
)
