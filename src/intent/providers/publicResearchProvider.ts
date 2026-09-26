import { env } from '../../config/env.js'
import { resolveCompanySource } from '../../crm/companySource.js'
import {
  discoverPublicSources,
  readPublicSources,
  NO_EVIDENCE,
  type ReadPublicSource,
  type ResearchTopic,
} from '../../research/publicResearch.js'
import { isEventAboutCompany, isHistoryStatement, readEventsFromPage, type ReadEvent } from '../eventReader.js'
import { outreachAngleFor } from '../outreachAngles.js'
import type { IntentSignalDraft, SignalCategory, SourceType } from '../types.js'
import type { IntentProvider, ProviderContext, ProviderResult } from './provider.js'

// SOURCE — THE PUBLIC WEB, FOUND BY SEARCH AND READ BY US.
//
// The same layer Decision Makers uses, asking a different question of it.
// Stage 3's existing providers can only read what they can address directly:
// the CRM, a <meta generator> tag, conventional careers paths, and the social
// profiles the company's own site links to. A company whose careers page
// 404s and whose platforms serve sign-in walls produces nothing — while its
// product launch sits in a search index.
//
// What is new is WHERE WE LOOK. The standard of proof is unchanged:
//
//   · The search returns LINKS. It is never asked what a company has been
//     doing, and no event is read out of a search result or a model's prose.
//   · Every page is fetched by this service through the SSRF-guarded,
//     redirect-capped, byte-capped transport.
//   · Those bytes go to readEventsFromPage, which verifies every quoted
//     sentence and every job title character-by-character against them.
//
// LOGIN WALLS. A platform that shows a logged-out reader a sign-in form has
// shown us nothing, and that is recorded as the observation it is. No post is
// summarised from a wall, and none is guessed at from the profile's existence.
// The research layer detects this; this provider only reports it.

/** Where the page lives decides how strongly it counts. Not who wrote it. */
function sourceTypeFor(page: ReadPublicSource, companyHost: string | null): SourceType {
  try {
    const host = new URL(page.finalUrl).hostname.replace(/^www\./, '')
    if (companyHost && (host === companyHost || host.endsWith(`.${companyHost}`))) return 'company_website'
  } catch {
    /* fall through to third_party */
  }
  return 'third_party'
}

/**
 * The category for one reading.
 *
 * Decided by what the page STATED — an explicit job title makes it hiring —
 * rather than by which query found it. A search for announcements that happens
 * to surface a vacancy should record a vacancy.
 */
function categoryFor(event: ReadEvent, topic: ResearchTopic): SignalCategory {
  if (event.jobTitle) return 'hiring'
  if (event.kind === 'job_posting') return 'hiring'
  if (topic === 'business_activity') return 'business'
  return 'business'
}

/** Only a date the SOURCE stated. An unparseable string becomes null, never today. */
function statedDate(raw: string | null): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  // A date in the future is a parse artefact, not an observation.
  if (d.getTime() > Date.now() + 86_400_000) return null
  return d
}

export class PublicResearchSignalProvider implements IntentProvider {
  readonly name = 'public_web_research'
  // The category this source MOSTLY produces. A reading that states an open
  // role is still recorded as hiring — see categoryFor, which reads what the
  // page said rather than which query found it.
  readonly category = 'business'

  available(): { ok: boolean; reason?: string } {
    if (!env.PUBLIC_RESEARCH_ENABLED) {
      return {
        ok: false,
        reason:
          'PUBLIC_RESEARCH_ENABLED is off, so the open web was not searched. This source reaches third-party ' +
          'hosts and spends model budget, so it is opt-in.',
      }
    }
    return { ok: true }
  }

  async collect(ctx: ProviderContext): Promise<ProviderResult> {
    const started = Date.now()
    const availability = this.available()
    if (!availability.ok) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: availability.reason,
        durationMs: Date.now() - started,
        metadata: { notConfigured: true },
      }
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
    const signals: IntentSignalDraft[] = []
    const pagesRead: Array<{ url: string; finalUrl: string; ok: boolean; loginWall: boolean; events: number; reason?: string }> = []
    const queriesRun: string[] = []
    let costUsd = 0
    let rejected = 0
    let loginWalls = 0
    let sourcesDiscovered = 0
    let droppedHistory = 0
    let droppedOtherOrganisation = 0
    const failures: string[] = []

    // Two questions, both generic: what has this company announced, and what
    // is it advertising. Every company is asked both.
    for (const topic of ['business_activity', 'hiring'] as const) {
      const discovery = await discoverPublicSources({
        tenantId: ctx.tenantId,
        companyName,
        domain: companyHost,
        topic,
        feature: 'intent_public_research',
      })
      costUsd += discovery.costUsd
      queriesRun.push(...discovery.queriesRun)
      if (discovery.status !== 'available') {
        failures.push(discovery.reason ?? 'The search source failed without a reason.')
        continue
      }
      sourcesDiscovered += discovery.sources.length

      for (const page of await readPublicSources(discovery.sources)) {
        if (page.loginWall) loginWalls += 1
        if (!page.text) {
          pagesRead.push({
            url: page.url,
            finalUrl: page.finalUrl,
            ok: false,
            loginWall: page.loginWall,
            events: 0,
            reason: page.reason ?? undefined,
          })
          continue
        }

        const read = await readEventsFromPage({ text: page.text, sourceUrl: page.finalUrl, tenantId: ctx.tenantId })
        costUsd += read.costUsd
        rejected += read.rejected

        let added = 0
        const pageType = sourceTypeFor(page, companyHost)
        for (const event of read.events) {
          if (signals.length >= ctx.maxResults) break
          // Grounded is not the same as ABOUT THIS COMPANY. A third-party page
          // must name the company near the sentence; history is not an event.
          if (isHistoryStatement(event)) {
            droppedHistory += 1
            continue
          }
          if (
            !isEventAboutCompany(event, page.text, {
              name: companyName,
              host: companyHost,
              pageOnCompanyDomain: pageType === 'company_website',
            })
          ) {
            droppedOtherOrganisation += 1
            continue
          }
          const category = categoryFor(event, topic)
          signals.push({
            crmCompanyId: ctx.company.id,
            signalType: event.jobTitle ? 'public_job_posting' : 'public_business_activity',
            signalCategory: category,
            summary: event.summary,
            // WHAT HAPPENED, in the page's own terms, is the summary above.
            // This is WHY IT MATTERS, and it is careful to describe what the
            // publication may indicate rather than to assert a need.
            interpretation: event.jobTitle
              ? `A publicly advertised role is one of the few outside-visible signs of where a company is putting ` +
                `effort. It may indicate work underway that touches product information; it does not establish that it does.`
              : `A company publishing this is telling the market what it is doing. It may indicate activity that ` +
                `changes what the catalogue has to carry; it does not establish that it does.`,
            // THE OUTREACH ANGLE. Composed from the category and, where the
            // source stated one, the advertised role. Never model-written.
            outreachAngle: outreachAngleFor({ category, statedJobTitle: event.jobTitle }),
            // THE SOURCE TEXT, verbatim and already verified to exist in the
            // bytes we fetched. A reader can open the URL and find it.
            evidence: event.sourceSentence.slice(0, 500),
            sourceUrl: page.finalUrl,
            sourceType: pageType,
            observedAt: statedDate(event.statedDate),
            polarity: 'positive',
            provider: this.name,
            metadata: {
              topic,
              kind: event.kind,
              // Only ever a title the page published. Null is common and correct.
              jobTitle: event.jobTitle,
              discoveredVia: page.discoveredVia,
              searchTitle: page.title,
            },
          })
          added += 1
        }
        pagesRead.push({ url: page.url, finalUrl: page.finalUrl, ok: true, loginWall: false, events: added })
      }
    }

    const readOk = pagesRead.filter((p) => p.ok).length

    return {
      provider: this.name,
      // A search that ran and found nothing is a SUCCESS with no signals, not
      // a failure. Only a search that could not run is ok:false.
      ok: signals.length > 0 || failures.length === 0,
      signals,
      reason: signals.length
        ? undefined
        : failures.length
          ? failures.join(' ')
          : sourcesDiscovered === 0
            ? `${NO_EVIDENCE} The search returned no indexed pages about this company.`
            : readOk === 0
              ? `${NO_EVIDENCE} ${sourcesDiscovered} page(s) were found but none could be read` +
                (loginWalls ? `; ${loginWalls} served a sign-in wall to a logged-out reader.` : '.')
              : `${NO_EVIDENCE} ${readOk} public page(s) were read and none stated a business event or an open role.`,
      durationMs: Date.now() - started,
      costUsd: costUsd || undefined,
      metadata: {
        queriesRun,
        sourcesDiscovered,
        pagesRead,
        loginWalls,
        // The verifier's own count. Non-zero is the guard working.
        claimsRejectedAsUngrounded: rejected,
        // Grounded, but not about this company or not a current event.
        eventsDroppedNotNamingCompany: droppedOtherOrganisation,
        eventsDroppedAsHistory: droppedHistory,
      },
    }
  }
}

/**
 * The company's own website host, via the one authority on it. The raw domain
 * column can hold a social platform, and treating facebook.com as the
 * company's own domain would let every Facebook page count as the company
 * speaking.
 */
function hostOfCompany(ctx: ProviderContext): string | null {
  const raw = resolveCompanySource(ctx.company).websiteUrl
  if (!raw) return null
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
