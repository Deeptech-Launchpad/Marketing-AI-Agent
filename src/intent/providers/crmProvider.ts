import { getCrm } from '../../crm/index.js'
import { prisma } from '../../platform/db.js'
import type { IntentSignalDraft } from '../types.js'
import type { IntentProvider, ProviderContext, ProviderResult } from './provider.js'

// SOURCE A — NXT SALES / CRM.
//
// Read-only, through the existing CrmPort. Signals are derived only from rows
// the CRM actually holds: an absent field produces no signal, because "we never
// recorded this" is not evidence of anything.
//
// This provider emits NEGATIVE signals as well as positive ones. A company with
// an open opportunity or a suppression entry is a company where outreach is
// inappropriate, and that is a finding worth surfacing rather than an omission.

const RECENT_ACTIVITY_DAYS = 90

export class CrmSignalProvider implements IntentProvider {
  readonly name = 'crm'
  readonly category = 'crm'

  available(): { ok: boolean; reason?: string } {
    return { ok: true }
  }

  async collect(ctx: ProviderContext): Promise<ProviderResult> {
    const started = Date.now()
    const crm = getCrm()
    const company = ctx.company
    const signals: IntentSignalDraft[] = []

    // ── Open opportunities: NEGATIVE. Owned by sales, not marketing. ────────
    const deals = await crm.listDeals({ companyId: company.id }).catch(() => [])
    const open = deals.filter((d) => d.stage !== 'Won' && d.stage !== 'Lost')
    if (open.length) {
      const d = open[0]!
      signals.push({
        crmCompanyId: company.id,
        signalType: 'open_opportunity',
        signalCategory: 'crm',
        summary: `${open.length} open opportunity/opportunities in NXT Sales`,
        interpretation:
          'Already in an active sales conversation. Cold outreach would be inappropriate and may cut across the deal owner.',
        evidence: `Deal "${d.title}" at stage "${d.stage}"${d.value ? `, value ${d.value} ${d.currency}` : ''}`,
        sourceUrl: null,
        sourceType: 'crm_record',
        observedAt: d.openDate ? new Date(d.openDate) : new Date(d.createdAt),
        polarity: 'negative',
        provider: this.name,
        metadata: { dealId: d.id, stage: d.stage, openDealCount: open.length },
      })
    }

    // ── Won deals: NEGATIVE for prospecting. Already a customer. ────────────
    const won = deals.filter((d) => d.stage === 'Won')
    if (won.length) {
      const d = won[0]!
      signals.push({
        crmCompanyId: company.id,
        signalType: 'existing_customer',
        signalCategory: 'crm',
        summary: `${won.length} won deal(s) on record`,
        interpretation:
          'Existing customer. Any approach should be account management, not new-business prospecting.',
        evidence: `Won deal "${d.title}"${d.openDate ? ` opened ${d.openDate.slice(0, 10)}` : ''}`,
        sourceUrl: null,
        sourceType: 'crm_record',
        observedAt: d.openDate ? new Date(d.openDate) : new Date(d.createdAt),
        polarity: 'negative',
        provider: this.name,
        metadata: { dealId: d.id, wonDealCount: won.length },
      })
    }

    // ── Recent two-way engagement: POSITIVE. ────────────────────────────────
    const activities = await crm.listActivities({ companyId: company.id, type: 'email' }).catch(() => [])
    const cutoff = Date.now() - RECENT_ACTIVITY_DAYS * 86_400_000
    const recent = activities.filter((a) => new Date(a.createdAt).getTime() >= cutoff)
    const inbound = recent.filter((a) => a.direction === 'inbound')

    if (inbound.length) {
      const a = inbound[0]!
      signals.push({
        crmCompanyId: company.id,
        signalType: 'inbound_engagement',
        signalCategory: 'crm',
        summary: `${inbound.length} inbound email(s) in the last ${RECENT_ACTIVITY_DAYS} days`,
        interpretation:
          'The company initiated or replied to contact recently, which indicates an open channel and some current attention.',
        evidence: `Inbound email "${a.subject ?? '(no subject)'}" on ${a.createdAt.slice(0, 10)}`,
        sourceUrl: null,
        sourceType: 'crm_record',
        observedAt: new Date(a.createdAt),
        polarity: 'positive',
        provider: this.name,
        metadata: { activityId: a.id, inboundCount: inbound.length },
      })
    } else if (recent.length) {
      // Outbound-only contact is a fact about US, not about them. Neutral.
      const a = recent[0]!
      signals.push({
        crmCompanyId: company.id,
        signalType: 'recent_outbound_only',
        signalCategory: 'crm',
        summary: `${recent.length} outbound contact(s) in the last ${RECENT_ACTIVITY_DAYS} days, no reply on record`,
        interpretation:
          'We contacted them recently and nothing came back. This describes our own activity, not their intent, and matters mainly to avoid contacting them again too soon.',
        evidence: `Outbound email "${a.subject ?? '(no subject)'}" on ${a.createdAt.slice(0, 10)}`,
        sourceUrl: null,
        sourceType: 'crm_record',
        observedAt: new Date(a.createdAt),
        polarity: 'neutral',
        provider: this.name,
        metadata: { activityId: a.id, recentCount: recent.length },
      })
    }

    // ── Suppression: NEGATIVE, and the strongest one there is. ──────────────
    const suppression = await prisma.suppressionEntry
      .findMany({
        where: {
          tenantId: ctx.tenantId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          AND: [
            {
              OR: [
                { matchType: 'company', matchValue: company.id.toLowerCase() },
                ...(company.domain
                  ? [{ matchType: 'domain', matchValue: company.domain.trim().toLowerCase() }]
                  : []),
              ],
            },
          ],
        },
      })
      .catch(() => [])

    for (const entry of suppression) {
      signals.push({
        crmCompanyId: company.id,
        signalType: 'suppressed',
        signalCategory: 'crm',
        summary: 'Company is on the suppression list',
        interpretation: 'Explicitly excluded from contact. This overrides any positive signal below.',
        evidence: `Suppression entry (${entry.matchType} = ${entry.matchValue}): ${entry.reason}`,
        sourceUrl: null,
        sourceType: 'crm_record',
        observedAt: entry.createdAt,
        polarity: 'negative',
        provider: this.name,
        metadata: { suppressionId: entry.id, scope: entry.scope },
      })
    }

    return {
      provider: this.name,
      ok: true,
      signals,
      durationMs: Date.now() - started,
      metadata: { dealsChecked: deals.length, activitiesChecked: activities.length },
    }
  }
}
