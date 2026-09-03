import { prisma } from '../../platform/db.js'
import type { DetectedTechnology } from '../../research/htmlToText.js'
import type { IntentSignalDraft } from '../types.js'
import type { IntentProvider, ProviderContext, ProviderResult } from './provider.js'

// SOURCE B — WEBSITE / TECHNOLOGY.
//
// Reads Stage 2's stored enrichment rather than re-fetching. Stage 2 already
// did the SSRF-guarded fetch and kept the markup that proved each detection, so
// re-crawling would spend another request to learn the same thing.
//
// Because Stage 2 keeps every attempt as its own row, comparing the two most
// recent runs gives a real CHANGE signal — a technology that appears between
// observations is a far stronger indicator of current activity than the same
// technology sitting there unchanged.
//
// A technology that is absent means NOT DETECTED. It never means "not used",
// and no signal is emitted for absence.

const PIM_ERP_CATEGORIES = new Set(['pim', 'erp'])

export class TechnologySignalProvider implements IntentProvider {
  readonly name = 'technology'
  readonly category = 'technology'

  available(): { ok: boolean; reason?: string } {
    return { ok: true }
  }

  async collect(ctx: ProviderContext): Promise<ProviderResult> {
    const started = Date.now()
    const company = ctx.company

    // Two most recent COMPLETED observations, newest first.
    const runs = await prisma.companyEnrichment.findMany({
      where: {
        tenantId: ctx.tenantId,
        crmCompanyId: company.id,
        status: { in: ['enriched', 'unreachable', 'no_website'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 2,
    })

    if (!runs.length) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: 'No Stage 2 enrichment exists for this company yet. Run enrichment first.',
        durationMs: Date.now() - started,
      }
    }

    const latest = runs[0]!
    const previous = runs[1]
    const signals: IntentSignalDraft[] = []
    const current = (latest.technologies ?? []) as unknown as DetectedTechnology[]

    // ── Website unreachable: NEGATIVE, and a real commercial observation. ───
    if (latest.status === 'unreachable') {
      signals.push({
        crmCompanyId: company.id,
        signalType: 'website_unreachable',
        signalCategory: 'website',
        summary: 'Company website could not be reached',
        interpretation:
          'The site failed to load when checked. Any web-derived signal for this company is unavailable, and the failure itself may indicate a neglected or in-transition web presence.',
        evidence: `${latest.sourceUrl ?? 'unknown URL'} — ${latest.failureReason ?? 'unreachable'}`,
        sourceUrl: latest.sourceUrl,
        sourceType: 'company_website',
        observedAt: latest.finishedAt ?? latest.createdAt,
        polarity: 'negative',
        provider: this.name,
        metadata: { enrichmentId: latest.id, failureReason: latest.failureReason },
      })
    }

    // ── Currently detected platform stack ───────────────────────────────────
    for (const tech of current) {
      const isPimErp = PIM_ERP_CATEGORIES.has(tech.category)
      signals.push({
        crmCompanyId: company.id,
        signalType: isPimErp ? 'pim_erp_detected' : 'platform_detected',
        signalCategory: 'technology',
        summary: `${tech.name} detected on the company website`,
        interpretation: isPimErp
          ? 'Running product-information or ERP tooling indicates an existing investment in structured product data, and an owner for it.'
          : 'Indicates the commerce/content platform in use, which determines how catalog work would have to be delivered.',
        evidence: tech.evidence,
        sourceUrl: latest.sourceUrl,
        sourceType: 'company_website',
        observedAt: latest.fetchedAt ?? latest.finishedAt ?? latest.createdAt,
        polarity: 'positive',
        provider: this.name,
        metadata: { enrichmentId: latest.id, category: tech.category, technology: tech.name },
      })
    }

    // ── Change between observations: the strongest technology signal ────────
    if (previous) {
      const before = new Set(((previous.technologies ?? []) as unknown as DetectedTechnology[]).map((t) => t.name))
      const added = current.filter((t) => !before.has(t.name))

      for (const tech of added) {
        signals.push({
          crmCompanyId: company.id,
          signalType: 'technology_added',
          signalCategory: 'technology',
          summary: `${tech.name} newly detected since the previous observation`,
          interpretation:
            'A platform appearing between two observations suggests active change to the technology stack, which often accompanies a project with budget attached.',
          evidence: `${tech.evidence} (absent on ${previous.createdAt.toISOString().slice(0, 10)}, present on ${latest.createdAt.toISOString().slice(0, 10)})`,
          sourceUrl: latest.sourceUrl,
          sourceType: 'company_website',
          observedAt: latest.fetchedAt ?? latest.createdAt,
          polarity: 'positive',
          provider: this.name,
          metadata: {
            enrichmentId: latest.id,
            previousEnrichmentId: previous.id,
            technology: tech.name,
          },
        })
      }
    }

    return {
      provider: this.name,
      ok: true,
      signals,
      durationMs: Date.now() - started,
      metadata: {
        observationsAvailable: runs.length,
        latestStatus: latest.status,
        technologiesDetected: current.length,
        // Stated so an empty result is never read as "no technology in use".
        note: 'Absent technologies mean NOT DETECTED, never not-in-use.',
      },
    }
  }
}
