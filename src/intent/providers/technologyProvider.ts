import { prisma } from '../../platform/db.js'
import type { DetectedTechnology } from '../../research/htmlToText.js'
import type { IntentSignalDraft } from '../types.js'
import type { IntentProvider, ProviderContext, ProviderResult, SignalSupersession } from './provider.js'

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

/**
 * A technology's identity without its version: "Site Kit by Google 1.187.0"
 * and "Site Kit by Google 1.186.0" are the same technology, and "WordPress
 * 7.1" is WordPress.
 */
export function technologyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bv?\d+(?:\.\d+)+[a-z0-9.-]*\b/g, ' ')
    .replace(/\s+v?\d+\s*$/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Technologies present now and absent before, compared by version-stripped
 * name. `declared` detections (a page's generator tag) are ignored: a plugin
 * replacing the CMS in the generator tag is a change of declaration, not of
 * stack.
 */
export function addedTechnologies(before: DetectedTechnology[], after: DetectedTechnology[]): DetectedTechnology[] {
  const prior = new Set(before.filter((t) => t.category !== 'declared').map((t) => technologyKey(t.name)))
  const seen = new Set<string>()
  return after.filter((t) => {
    if (t.category === 'declared') return false
    const key = technologyKey(t.name)
    if (!key || prior.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type EnrichmentLike = { id: string; status: string; technologies: unknown }

/**
 * Whether a stored `technology_added` signal was false by the rules above.
 * Unknown rows are left alone: only a signal that can be shown false is withdrawn.
 */
export function isFalseTechnologyChange(metadata: unknown, rows: Map<string, EnrichmentLike>): boolean {
  const meta = (metadata ?? {}) as Record<string, unknown>
  const prev = typeof meta.previousEnrichmentId === 'string' ? rows.get(meta.previousEnrichmentId) : undefined
  const later = typeof meta.enrichmentId === 'string' ? rows.get(meta.enrichmentId) : undefined
  const tech = typeof meta.technology === 'string' ? meta.technology : null
  if (!prev || !tech) return false
  if (prev.status !== 'enriched') return true
  const key = technologyKey(tech)
  const techsOf = (r: EnrichmentLike) => (Array.isArray(r.technologies) ? (r.technologies as DetectedTechnology[]) : [])
  if (later) {
    const detected = techsOf(later).find((t) => technologyKey(t.name) === key)
    if (detected?.category === 'declared') return true
  }
  return techsOf(prev).some((t) => t.category !== 'declared' && technologyKey(t.name) === key)
}

export class TechnologySignalProvider implements IntentProvider {
  readonly name = 'technology'
  readonly category = 'technology'

  available(): { ok: boolean; reason?: string } {
    return { ok: true }
  }

  async collect(ctx: ProviderContext): Promise<ProviderResult> {
    const started = Date.now()
    const company = ctx.company

    // Recent COMPLETED observations, newest first. More than two, because the
    // change comparison needs the previous SUCCESSFUL read, which may sit
    // behind a run of failed ones, and because earlier false change signals
    // are re-checked against the rows they cited.
    const runs = await prisma.companyEnrichment.findMany({
      where: {
        tenantId: ctx.tenantId,
        crmCompanyId: company.id,
        status: { in: ['enriched', 'unreachable', 'no_website'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    if (!runs.length) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: 'No Stage 2 enrichment exists for this company yet. Run enrichment first.',
        durationMs: Date.now() - started,
        metadata: { notApplicable: true },
      }
    }

    const latest = runs[0]!
    // A change is only a change between two SUCCESSFUL reads. An unreachable
    // or no-website row has an empty technology list because nothing was read,
    // not because nothing was there — comparing against it made every
    // technology on the site "newly detected" (6 of 6 stored were false).
    const previous = latest.status === 'enriched' ? runs.slice(1).find((r) => r.status === 'enriched') : undefined
    const signals: IntentSignalDraft[] = []
    const current = (latest.technologies ?? []) as unknown as DetectedTechnology[]

    // ── The website was read: withdraw any standing "unreachable" ──────────
    //
    // A successful read is not itself an intent signal — a site that loads
    // says nothing about whether this company needs anything. But it DIRECTLY
    // CONTRADICTS a stored "could not be reached", and that contradiction has
    // to be acted on.
    //
    // Ultra Taps is why. Three runs recorded the site as unreachable while its
    // host was resetting connections; the site recovered, this provider read it
    // successfully and emitted nothing at all — and the three stale negatives
    // stayed active, still counting against outreach, for a company whose site
    // loads in 200ms. Emitting nothing was the bug: the run knew better and
    // said nothing.
    const supersedes: SignalSupersession[] = []
    if (latest.status === 'enriched') {
      const readAt = latest.fetchedAt ?? latest.finishedAt ?? latest.createdAt
      supersedes.push({
        signalType: 'website_unreachable',
        observedBefore: readAt,
        reason:
          `The website was read successfully on ${readAt.toISOString().slice(0, 10)}` +
          `${latest.sourceUrl ? ` (${latest.sourceUrl})` : ''}, so it is no longer unreachable.`,
      })

      // Earlier "technology added" signals that compared against a read that
      // never happened, or against a version bump or a generator declaration,
      // were never true. They are withdrawn by the same mechanism, row by row,
      // re-checked against the enrichment rows they cite.
      const byId = new Map(runs.map((r) => [r.id, r]))
      supersedes.push({
        signalType: 'technology_added',
        observedBefore: readAt,
        reason:
          'Withdrawn: the "newly detected" comparison was not between two successful reads of distinct technologies ' +
          '(the earlier observation could not read the site, or only a version number or generator declaration differed).',
        appliesTo: (metadata) => isFalseTechnologyChange(metadata, byId),
      })
    }

    // ── No website on record: an "unreachable" claim no longer applies. ─────
    if (latest.status === 'no_website') {
      const at = latest.finishedAt ?? latest.createdAt
      supersedes.push({
        signalType: 'website_unreachable',
        observedBefore: at,
        reason:
          `On ${at.toISOString().slice(0, 10)} the company record held no website to read, so "the website could not be reached" ` +
          'no longer describes it.',
      })
    }

    // ── Website unreachable: NEGATIVE, and a real commercial observation. ───
    //
    // Emitted once per failed enrichment row. Every intent run while the site is
    // down used to re-emit it from the SAME enrichment row, which is one
    // observation reported again, not a new one.
    const alreadyRecorded =
      latest.status === 'unreachable'
        ? (
            await prisma.intentSignal.findMany({
              where: { tenantId: ctx.tenantId, crmCompanyId: company.id, signalType: 'website_unreachable' },
              select: { metadata: true },
            })
          ).some((s) => ((s.metadata as Record<string, unknown> | null) ?? {}).enrichmentId === latest.id)
        : false

    if (latest.status === 'unreachable' && !alreadyRecorded) {
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
      const added = addedTechnologies(
        (previous.technologies ?? []) as unknown as DetectedTechnology[],
        current,
      )

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
      supersedes,
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
