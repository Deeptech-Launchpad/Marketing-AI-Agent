import { env } from '../../config/env.js'
import { resolveCompanySource } from '../../crm/companySource.js'
import { discoverPublicSources, readPublicSources, NO_EVIDENCE } from '../../research/publicResearch.js'
import { KIND_INFO, placeOf, readExternalSignals, statedDateOf } from '../externalSignals.js'
import { outreachAngleFor } from '../outreachAngles.js'
import type { IntentSignalDraft } from '../types.js'
import type { IntentProvider, ProviderContext, ProviderResult } from './provider.js'

// SOURCE — WHAT OTHERS PUBLISH ABOUT THE COMPANY.
//
// Reddit and industry forums, review platforms, news and trade press, blogs,
// and public social posts. Found by search, fetched by us as any logged-out
// visitor, read for what they STATE about this company. Pages on the
// company's own domain are left to the providers that already read it.
//
// A platform that serves a logged-out reader a sign-in wall (LinkedIn often
// does) has shown us nothing: that is recorded and counted, never guessed at.

/** Pages read per company. Each is one request to a third-party host and one model read. */
const MAX_PAGES = 8
/** Links asked of the search index across the four searches. */
const MAX_SOURCES = 10

export class ExternalSourcesProvider implements IntentProvider {
  readonly name = 'external_public_sources'
  readonly category = 'business'

  available(): { ok: boolean; reason?: string } {
    if (!env.PUBLIC_RESEARCH_ENABLED) {
      return {
        ok: false,
        reason:
          'PUBLIC_RESEARCH_ENABLED is off, so forums, reviews, news and social sources were not searched. This source ' +
          'reaches third-party hosts and spends model budget, so it is opt-in.',
      }
    }
    return { ok: true }
  }

  async collect(ctx: ProviderContext): Promise<ProviderResult> {
    const started = Date.now()
    const availability = this.available()
    if (!availability.ok) {
      return { provider: this.name, ok: false, signals: [], reason: availability.reason, durationMs: 0, metadata: { notConfigured: true } }
    }

    const companyName = ctx.company.name?.trim() ?? ''
    if (companyName.length < 2) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: 'The company has no usable name on record, so no search query could be composed from facts we hold.',
        durationMs: Date.now() - started,
        metadata: { notApplicable: true },
      }
    }
    const companyHost = hostOfCompany(ctx)

    const discovery = await discoverPublicSources({
      tenantId: ctx.tenantId,
      companyName,
      domain: companyHost,
      topic: 'external_signals',
      maxSources: MAX_SOURCES,
      feature: 'intent_external_sources',
    })
    let costUsd = discovery.costUsd
    if (discovery.status !== 'available') {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: discovery.reason ?? 'The search source failed without a reason.',
        durationMs: Date.now() - started,
        costUsd: costUsd || undefined,
        metadata: { queriesRun: discovery.queriesRun },
      }
    }

    const signals: IntentSignalDraft[] = []
    const pagesRead: Array<{ url: string; platform: string; ok: boolean; loginWall: boolean; signals: number; reason?: string }> = []
    let loginWalls = 0
    let rejected = 0
    const readFailures: string[] = []
    let ownSite = 0

    for (const page of await readPublicSources(discovery.sources, MAX_PAGES)) {
      const place = placeOf(page.finalUrl)
      // The company's own pages are read by the providers built for them.
      if (companyHost && onHost(page.finalUrl, companyHost)) {
        ownSite++
        continue
      }
      if (page.loginWall) loginWalls++
      if (!page.text) {
        pagesRead.push({ url: page.finalUrl, platform: place.platformLabel, ok: false, loginWall: page.loginWall, signals: 0, reason: page.reason ?? undefined })
        continue
      }

      const read = await readExternalSignals({
        text: page.text,
        sourceUrl: page.finalUrl,
        tenantId: ctx.tenantId,
        company: { name: companyName, host: companyHost },
      })
      // A read that failed — the model step itself — is a page NOT read, and
      // is recorded so. It used to be recorded as read with no signals, so an
      // AI outage reported "pages were read and none stated a signal": a
      // failure presented as a finding about the company (2026-10-06).
      costUsd += read.costUsd
      rejected += read.rejected
      if (read.failed) readFailures.push(read.reason ?? 'The reading step failed.')

      let added = 0
      for (const r of read.readings) {
        if (signals.length >= ctx.maxResults) break
        const info = KIND_INFO[r.kind]
        signals.push({
          crmCompanyId: ctx.company.id,
          signalType: `external_${r.kind}`,
          signalCategory: info.category,
          summary: `${info.label} on ${place.platformLabel}: “${clip(r.quote, 180)}”`,
          // WHY IT MATTERS — a fixed sentence per kind, never a model's view.
          interpretation: info.why,
          outreachAngle: outreachAngleFor({ category: info.category, statedJobTitle: null }),
          // The quote itself, verbatim and verified against the fetched bytes.
          evidence: r.quote,
          sourceUrl: page.finalUrl,
          sourceType: place.sourceType,
          observedAt: statedDateOf(r.statedDate),
          polarity: 'positive',
          provider: this.name,
          metadata: {
            kind: r.kind,
            kindLabel: info.label,
            platform: place.platform,
            platformLabel: place.platformLabel,
            statedDate: r.statedDate,
            discoveredVia: page.discoveredVia,
            searchTitle: page.title,
          },
        })
        added++
      }
      pagesRead.push({ url: page.finalUrl, platform: place.platformLabel, ok: !read.failed, loginWall: false, signals: added, ...(read.failed ? { reason: read.reason ?? undefined } : {}) })
    }

    const readOk = pagesRead.filter((p) => p.ok).length
    // Every page the search found failed at the reading step: this source
    // could not look, which is not the same as looking and finding nothing.
    const couldNotRead = signals.length === 0 && readOk === 0 && readFailures.length > 0
    return {
      provider: this.name,
      // Searched and found nothing is a success with no signals.
      ok: !couldNotRead,
      signals,
      reason: signals.length
        ? undefined
        : couldNotRead
          ? `The pages found could not be read: ${readFailures[0]}`
          : discovery.sources.length === 0
          ? `${NO_EVIDENCE} The search found no forum, review, news or social pages about this company.`
          : readOk === 0
            ? `${NO_EVIDENCE} ${pagesRead.length} outside page(s) were found but none could be read` +
              (loginWalls ? `; ${loginWalls} served a sign-in wall to a logged-out reader.` : '.')
            : `${NO_EVIDENCE} ${readOk} outside page(s) were read and none stated a relevant signal about this company.`,
      durationMs: Date.now() - started,
      costUsd: costUsd || undefined,
      metadata: {
        queriesRun: discovery.queriesRun,
        sourcesDiscovered: discovery.sources.length,
        pagesRead,
        loginWalls,
        pagesOnOwnSiteSkipped: ownSite,
        // The verifier's own count: quotes not on the page, or not about this company.
        claimsRejectedAsUngrounded: rejected,
      },
    }
  }
}

function onHost(url: string, host: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '')
    return h === host || h.endsWith(`.${host}`)
  } catch {
    return false
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The company's own website host, via the one authority on it. */
function hostOfCompany(ctx: ProviderContext): string | null {
  const raw = resolveCompanySource(ctx.company).websiteUrl
  if (!raw) return null
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
