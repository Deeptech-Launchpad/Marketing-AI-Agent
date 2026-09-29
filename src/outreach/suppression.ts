import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { prisma } from '../platform/db.js'
import type { OutreachChannel, SuppressionReason } from './types.js'

// TASK #982 — the suppression gate.
//
// One decision, applied identically to every channel. That is the point: a
// contact who opted out of email has not consented to being messaged on
// LinkedIn instead, and a per-channel suppression list is how that mistake gets
// made. So this runs before every action on every channel, and it runs again
// at execution time rather than only at scheduling time — a person can opt out
// between a campaign being planned and a step falling due.
//
// It reuses the existing SuppressionEntry model from Phase 1 rather than
// inventing a second list, and it invents no suppression records: every reason
// below comes from a stored row or from CRM state that already existed.

export interface SuppressionCheck {
  suppressed: boolean
  reason?: SuppressionReason
  detail?: string
  /** The row or record that caused it, so a block can be explained. */
  evidenceId?: string | null
}

export interface SuppressionInput {
  tenantId: string
  crmCompanyId: string
  companyName: string
  companyDomain: string | null
  /** The channel destination, when there is one. */
  destination: string | null
  channel: OutreachChannel
  campaignId?: string | null
  /**
   * Whether an open CRM deal suppresses. Default 'enforce' (unchanged for the
   * legacy engine). The Sales sequence passes 'skip' in two cases: a stage
   * that answers the prospect's own reply (Sales often opens a deal once SKUs
   * arrive, and the reply must still be answered), and a company found on the
   * open web that has no NXT Sales record to hold a deal at all.
   */
  openDealCheck?: 'enforce' | 'skip'
}

/**
 * Checks every suppression source, cheapest first.
 *
 * Returns on the FIRST match rather than collecting them all: the caller needs
 * to know it must not contact this person, and a list of five reasons is no
 * more actionable than one.
 */
export async function checkSuppression(input: SuppressionInput): Promise<SuppressionCheck> {
  // ── 1. Explicit suppression entries ────────────────────────────────────
  const candidates: Array<{ matchType: string; matchValue: string }> = [
    { matchType: 'company', matchValue: input.crmCompanyId },
    { matchType: 'company', matchValue: input.companyName.toLowerCase().trim() },
  ]
  if (input.companyDomain) candidates.push({ matchType: 'domain', matchValue: input.companyDomain.toLowerCase() })
  if (input.destination?.includes('@')) {
    const email = input.destination.toLowerCase().trim()
    candidates.push({ matchType: 'email', matchValue: email })
    const domain = email.split('@').pop()
    if (domain) candidates.push({ matchType: 'domain', matchValue: domain })
  }

  const entries = await prisma.suppressionEntry.findMany({
    where: {
      tenantId: input.tenantId,
      OR: candidates,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        { OR: [{ scope: 'global' }, ...(input.campaignId ? [{ scope: 'campaign', campaignId: input.campaignId }] : [])] },
      ],
    },
    take: 1,
  })

  if (entries.length) {
    const e = entries[0]!
    return {
      suppressed: true,
      reason: e.source === 'unsubscribe' ? 'opt_out' : e.matchType === 'domain' ? 'domain_suppressed' : 'do_not_contact',
      detail: `Suppression entry (${e.matchType} = ${e.matchValue}): ${e.reason}`,
      evidenceId: e.id,
    }
  }

  // ── 2. An open opportunity in the CRM ──────────────────────────────────
  //
  // A company already in an active sales conversation should not receive cold
  // outreach from a different motion. This reads the CRM; it never writes.
  if (input.openDealCheck !== 'skip') {
    try {
      const deals = await getCrm().listDeals({ companyId: input.crmCompanyId })
      const open = deals.find((d) => {
        const stage = (d.stage ?? '').toLowerCase()
        return stage && !/won|lost|closed/.test(stage)
      })
      if (open) {
        return {
          suppressed: true,
          reason: 'open_opportunity',
          detail: `An open deal exists on this company in NXT Sales (stage "${open.stage}"). Cold outreach is suppressed while a sales conversation is live.`,
          evidenceId: open.id,
        }
      }
    } catch {
      // A CRM read failure must not silently unsuppress. It is reported by the
      // caller as a validation problem rather than treated as "not suppressed".
      return {
        suppressed: true,
        reason: 'missing_consent',
        detail: 'The CRM could not be reached to check for an open opportunity, so outreach is held rather than sent blind.',
        evidenceId: null,
      }
    }
  }

  // ── 3. Cooldown: already contacted recently ────────────────────────────
  const since = new Date(Date.now() - env.OUTREACH_COOLDOWN_DAYS * 86_400_000)
  const recent = await prisma.outreachAction.findFirst({
    where: {
      tenantId: input.tenantId,
      crmCompanyId: input.crmCompanyId,
      status: 'sent',
      sentAt: { gte: since },
      // A test send reached an internal inbox, not the company: it is not contact.
      campaign: { isTest: false },
      ...(input.campaignId ? { NOT: { campaignId: input.campaignId } } : {}),
    },
    orderBy: { sentAt: 'desc' },
    select: { id: true, channel: true, sentAt: true },
  })

  if (recent) {
    return {
      suppressed: true,
      reason: 'cooldown',
      detail: `This company was contacted by ${recent.channel} on ${recent.sentAt?.toISOString().slice(0, 10)}, within the ${env.OUTREACH_COOLDOWN_DAYS}-day cooldown.`,
      evidenceId: recent.id,
    }
  }

  return { suppressed: false }
}
