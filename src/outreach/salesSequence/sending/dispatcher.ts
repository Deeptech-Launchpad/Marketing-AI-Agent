import { env } from '../../../config/env.js'
import { prisma } from '../../../platform/db.js'
import { logger } from '../../../platform/logger.js'
import { startOfLocalDay } from '../businessDays.js'
import { prepareDueTestFollowUps, runScheduledTestSend } from '../service.js'
import { windowOfBatch } from './batchWindow.js'
import { withinWindow } from './schedule.js'

// THE TEST SENDER'S TICK (2026-09-28).
//
// Runs every few minutes from the worker, and only while OUTREACH_EMAIL_MODE is
// "test". For each running test batch it:
//   1. prepares any no-reply follow-up the PDF timing now allows (as a DRAFT —
//      Sales still reviews and approves each one), and
//   2. sends the approved, scheduled emails that are due — inside the batch's
//      sending hours and under its daily cap — to the internal test inbox.
// It never approves anything and never addresses a customer.

const TERMINAL_CAMPAIGN = ['completed', 'cancelled']
const OPEN_ACTION = ['draft', 'ready_to_send', 'scheduled', 'sending', 'failed']

export interface DispatchSummary {
  batches: number
  prepared: number
  sent: number
  failed: number
  notSent: number
}

export async function dispatchTestSends(now = new Date()): Promise<DispatchSummary> {
  const summary: DispatchSummary = { batches: 0, prepared: 0, sent: 0, failed: 0, notSent: 0 }
  if (env.OUTREACH_EMAIL_MODE !== 'test') return summary

  const batches = await prisma.outreachBatch.findMany({ where: { mode: 'test', status: 'running' }, orderBy: { createdAt: 'asc' } })
  for (const batch of batches) {
    summary.batches++
    const campaigns = await prisma.outreachCampaign.findMany({
      where: { batchId: batch.id, isTest: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true },
    })

    for (const c of campaigns) {
      if (c.status !== 'active') continue
      try {
        summary.prepared += await prepareDueTestFollowUps(batch.tenantId, c.id, now)
      } catch (err) {
        logger.error({ err, campaignId: c.id }, 'test batch: follow-ups could not be prepared')
      }
    }

    const w = windowOfBatch(batch)
    if (withinWindow(now, w)) {
      const sentToday = await prisma.outreachSendAttempt.count({
        where: { kind: 'scheduled', status: 'accepted', campaignId: { in: campaigns.map((c) => c.id) }, createdAt: { gte: startOfLocalDay(now, w.tz) } },
      })
      const room = Math.max(0, batch.dailyCap - sentToday)
      if (room > 0) {
        const due = await prisma.outreachAction.findMany({
          where: { campaignId: { in: campaigns.map((c) => c.id) }, status: 'scheduled', scheduledAt: { lte: now } },
          orderBy: { scheduledAt: 'asc' },
          take: room,
          select: { id: true },
        })
        for (const a of due) {
          const result = await runScheduledTestSend(a.id, now).catch((err) => {
            logger.error({ err, actionId: a.id }, 'test batch: scheduled send crashed')
            return 'failed' as const
          })
          if (result === 'sent') summary.sent++
          else if (result === 'failed') summary.failed++
          else if (result === 'not_sent') summary.notSent++
        }
      }
    }

    // Done when every campaign has ended, or has nothing left to send or approve.
    const fresh = await prisma.outreachCampaign.findMany({ where: { batchId: batch.id }, select: { id: true, status: true } })
    const open = await prisma.outreachAction.count({ where: { campaignId: { in: fresh.map((c) => c.id) }, status: { in: OPEN_ACTION } } })
    if (fresh.length > 0 && fresh.every((c) => TERMINAL_CAMPAIGN.includes(c.status)) && open === 0) {
      await prisma.outreachBatch.update({ where: { id: batch.id }, data: { status: 'completed' } })
    }
  }
  if (summary.sent || summary.failed || summary.notSent || summary.prepared) logger.info(summary, 'outreach test dispatch')
  return summary
}
