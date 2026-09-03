import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { BadRequestError } from '../../platform/errors.js'
import type { StepHandler } from './types.js'

// Terminal step for Phase 1.
//
// The deliverable is an APPROVED CAMPAIGN PACKAGE — strategy, audience,
// research, assets, approvals and provenance. Nothing has been published,
// nothing has been written back to the CRM, and no email has been sent.

export const packageStep: StepHandler = async (ctx) => {
  if (!ctx.run.campaignId) throw new BadRequestError('Run has no campaign to finalise.')

  await prisma.campaign.update({
    where: { id: ctx.run.campaignId },
    data: { status: 'approved' },
  })

  const [assetCount, versionCount, approvals] = await Promise.all([
    prisma.asset.count({ where: { campaignId: ctx.run.campaignId, runId: ctx.run.id } }),
    prisma.assetVersion.count({ where: { asset: { campaignId: ctx.run.campaignId, runId: ctx.run.id } } }),
    prisma.approval.findMany({
      where: { runId: ctx.run.id },
      select: { kind: true, status: true, decidedByCrmUserId: true, decidedAt: true, payloadHash: true },
    }),
  ])

  await audit({
    tenantId: ctx.run.tenantId,
    actorType: 'agent',
    runId: ctx.run.id,
    action: 'campaign.packaged',
    resourceType: 'Campaign',
    resourceId: ctx.run.campaignId,
    summary: `approved package with ${assetCount} assets`,
  })

  return {
    output: {
      campaignId: ctx.run.campaignId,
      assetCount,
      versionCount,
      approvals,
      // Stated explicitly in the output so the terminal state cannot be
      // mistaken for "the campaign went out".
      externalEffects: 'none — Phase 1 publishes nothing',
      retrieveWith: `GET /api/v1/campaigns/${ctx.run.campaignId}/package`,
    },
  }
}
