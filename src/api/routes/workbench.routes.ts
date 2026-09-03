import { Router } from 'express'
import QRCode from 'qrcode'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { buildWorkbench } from '../../workbench/builder.js'
import { mintLink, revokeLink, workbenchQrUrl, workbenchUrl } from '../../workbench/links.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// TASK #981 — the INTERNAL Workbench API.
//
// Authenticated, RBAC-gated, tenant-scoped, mounted under /api/v1. The
// customer-facing surface is a separate public router — nothing here is
// reachable without a token, and nothing there can reach these.

export const workbenchRoutes = Router()

const BuildBody = z.object({ productPageId: z.string().min(1).optional() }).strict()

const LinkBody = z
  .object({
    label: z.string().min(1).max(120).optional(),
    ttlDays: z.number().int().positive().max(365).optional(),
    maxViews: z.number().int().positive().max(10_000).optional(),
  })
  .strict()

/** Build (or rebuild) the Workbench for an approved audit. */
workbenchRoutes.post(
  '/runs/:id/workbench',
  requirePermission('operate'),
  validateBody(BuildBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof BuildBody>

    const result = await buildWorkbench({
      tenantId: p.tenantId,
      auditRunId: req.params.id!,
      requestedByCrmUserId: p.crmUserId,
      productPageId: body.productPageId ?? null,
    })

    res.status(result.status === 'ready' ? 200 : 200).json({
      ...result,
      note:
        result.status === 'no_product_page'
          ? 'No product page was available, so no demonstration was fabricated. The public page explains this and offers a deeper review instead.'
          : result.builtFromUnapproved
            ? 'Built from an UNAPPROVED report via the development-only bypass. This must never be used in production.'
            : undefined,
    })
  }),
)

/** The internal view: everything the demo will show, plus its provenance. */
workbenchRoutes.get(
  '/runs/:id/workbench',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const demo = await prisma.workbenchDemo.findFirst({
      where: { auditRunId: req.params.id!, tenantId: p.tenantId },
      include: {
        fields: { orderBy: { position: 'asc' } },
        links: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            label: true,
            tokenHint: true,
            expiresAt: true,
            revokedAt: true,
            maxViews: true,
            viewCount: true,
            firstViewedAt: true,
            lastViewedAt: true,
            createdAt: true,
          },
        },
      },
    })
    if (!demo) throw new NotFoundError('No Workbench has been built for that audit run yet.')

    const registrations = await prisma.workbenchVisitor.count({ where: { demoId: demo.id } })

    res.json({
      ...demo,
      registrations,
      disclaimers: [
        'Every AFTER value is produced by restructuring, deriving from, or rewording an observed field. Nothing is invented.',
        'A field with no observed source is shown empty and carries the observation proving it was looked for.',
        'The visual style is an approximation sampled from the prospect site. No prospect HTML, CSS or JavaScript is served.',
        'Registrations collected here are NOT written to NXT Sales and are not scored or routed.',
      ],
    })
  }),
)

/** Mint a share link. The plaintext token is returned exactly once. */
workbenchRoutes.post(
  '/runs/:id/workbench/link',
  requirePermission('operate'),
  validateBody(LinkBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof LinkBody>

    const demo = await prisma.workbenchDemo.findFirst({
      where: { auditRunId: req.params.id!, tenantId: p.tenantId },
      select: { id: true, status: true, companyName: true },
    })
    if (!demo) throw new NotFoundError('No Workbench has been built for that audit run yet.')

    const link = await mintLink({
      tenantId: p.tenantId,
      demoId: demo.id,
      createdByCrmUserId: p.crmUserId,
      label: body.label ?? null,
      ttlDays: body.ttlDays,
      maxViews: body.maxViews ?? null,
    })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'workbench.link_minted',
      resourceType: 'WorkbenchLink',
      resourceId: link.linkId,
      dataClass: 'internal',
      summary: `Share link created for ${demo.companyName}, expires ${link.expiresAt.toISOString().slice(0, 10)}`,
      requestId: req.requestId,
    })

    res.status(201).json({
      linkId: link.linkId,
      url: link.url,
      expiresAt: link.expiresAt,
      qrPath: `/api/v1/website-audit/runs/${req.params.id}/workbench/link/${link.linkId}/qr.svg`,
      warning:
        'This token is shown once and is not recoverable. Anyone holding this link can open the demonstration until it expires or is revoked.',
    })
  }),
)

/**
 * The QR code for a link.
 *
 * Rendered from the stored URL shape, which needs the plaintext token — so the
 * token is accepted as a query parameter here rather than being stored. A
 * caller that has just minted a link has it; nobody else can produce one.
 */
workbenchRoutes.get(
  '/runs/:id/workbench/link/:linkId/qr.svg',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const token = typeof req.query.token === 'string' ? req.query.token : ''

    const link = await prisma.workbenchLink.findFirst({
      where: { id: req.params.linkId!, tenantId: p.tenantId },
      select: { id: true, tokenHint: true, revokedAt: true },
    })
    if (!link) throw new NotFoundError('Link not found.')
    if (!token || !link.tokenHint || !token.endsWith(link.tokenHint)) {
      throw new NotFoundError(
        'Provide the plaintext token as ?token=… — it is not stored, so the QR code cannot be regenerated without it.',
      )
    }

    // The encoded URL carries the s=qr marker so a scan is distinguishable
    // from the same link pasted into a browser. See workbenchQrUrl.
    const svg = await QRCode.toString(workbenchQrUrl(token), { type: 'svg', margin: 1, width: 320 })
    res.setHeader('Content-Type', 'image/svg+xml')
    res.setHeader('Cache-Control', 'no-store')
    res.send(svg)
  }),
)

/** Revoke a link. Immediate: the next public request is refused. */
workbenchRoutes.delete(
  '/runs/:id/workbench/link/:linkId',
  requirePermission('operate'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const ok = await revokeLink(p.tenantId, req.params.linkId!, p.crmUserId)
    if (!ok) throw new NotFoundError('Link not found, or it was already revoked.')

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'workbench.link_revoked',
      resourceType: 'WorkbenchLink',
      resourceId: req.params.linkId!,
      dataClass: 'internal',
      summary: 'Share link revoked',
      requestId: req.requestId,
    })

    res.json({ revoked: true, linkId: req.params.linkId })
  }),
)

/** Who registered to view this demo. Stored, inert, never sent anywhere. */
workbenchRoutes.get(
  '/runs/:id/workbench/registrations',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const demo = await prisma.workbenchDemo.findFirst({
      where: { auditRunId: req.params.id!, tenantId: p.tenantId },
      select: { id: true, companyName: true },
    })
    if (!demo) throw new NotFoundError('No Workbench has been built for that audit run yet.')

    const visitors = await prisma.workbenchVisitor.findMany({
      where: { demoId: demo.id },
      orderBy: { registeredAt: 'desc' },
      take: 200,
      select: {
        id: true,
        fullName: true,
        companyName: true,
        workEmail: true,
        jobTitle: true,
        phone: true,
        registeredAt: true,
        lastSeenAt: true,
        viewCount: true,
      },
    })

    res.json({
      companyName: demo.companyName,
      total: visitors.length,
      visitors,
      ctaUrl: env.WORKBENCH_CTA_URL,
      disclaimers: [
        'These registrations are stored for access control only. Task #981 does not write them to NXT Sales, score them, or route them.',
        'Engagement scoring and lead routing are later tasks and are not implemented.',
      ],
    })
  }),
)
