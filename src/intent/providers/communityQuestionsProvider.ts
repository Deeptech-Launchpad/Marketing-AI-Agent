import { env } from '../../config/env.js'
import { resolveCompanySource } from '../../crm/companySource.js'
import { discoverPublicSources, readPublicSourcesUntil, NO_EVIDENCE } from '../../research/publicResearch.js'
import { CLUSTER_WHY, COMMUNITY_ANGLE, communityOf, readCommunityQuestions } from '../communityQuestions.js'
import { placeOf, statedDateOf } from '../externalSignals.js'
import { readRedditThread, redditThreadPath } from '../redditThread.js'
import type { IntentSignalDraft } from '../types.js'
import type { IntentProvider, ProviderContext, ProviderResult } from './provider.js'

// SOURCE — QUESTIONS ASKED IN THE COMMUNITIES WHERE OUR BUYERS ARE.
//
// The Community Engagement & Trust-Building method (September 2026), applied
// to one company: the forums, subreddits and communities it names are
// searched for questions by or about this company on the topics AltiusNxt
// solves, and each is kept only when the method's own rules flag it (see
// communityQuestions.ts). Added beside the other sources; it changes none of
// them. LinkedIn and Facebook groups stay manual, as the method says.

/** Pages read per company. Each is one request to a third-party host and one model read. */
const MAX_PAGES = 6
/** Links asked of the search index across the three searches. */
const MAX_SOURCES = 12
/** Signals kept per company from this source (see externalSourcesProvider). */
const MAX_SIGNALS = 25
/** How long this source may spend fetching pages (see externalSourcesProvider). */
const READ_BUDGET_MS = 120_000

export class CommunityQuestionsProvider implements IntentProvider {
  readonly name = 'community_questions'
  readonly category = 'catalog'

  available(): { ok: boolean; reason?: string } {
    if (!env.PUBLIC_RESEARCH_ENABLED) {
      return {
        ok: false,
        reason:
          'PUBLIC_RESEARCH_ENABLED is off, so forums and communities were not searched for questions. This source ' +
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
      topic: 'community_questions',
      maxSources: MAX_SOURCES,
      feature: 'intent_community_questions',
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
    const pagesRead: Array<{ url: string; community: string; ok: boolean; flagged: number; reason?: string }> = []
    let logged = 0
    let excluded = 0
    let rejected = 0
    const readFailures: string[] = []

    let redditRefused = false
    // Past refusals until MAX_PAGES pages were read (2026-10-07).
    for (const fetched of await readPublicSourcesUntil(discovery.sources, {
      readable: MAX_PAGES,
      maxAttempts: MAX_SOURCES,
      budgetMs: READ_BUDGET_MS,
      counts: (p) => Boolean(p.text) && !(companyHost && onHost(p.finalUrl, companyHost)),
    })) {
      let page = fetched
      // The company's own pages are not community questions.
      if (companyHost && onHost(page.finalUrl, companyHost)) continue
      // Reddit serves a page fetch a script shell; its public thread data
      // holds the post and comments. Asked once per thread, and not again in
      // this run once Reddit refuses.
      if (!page.text && !redditRefused && redditThreadPath(page.finalUrl)) {
        const thread = await readRedditThread(page.finalUrl)
        if (thread.refused) redditRefused = true
        page = thread.text ? { ...page, text: thread.text, reason: null } : { ...page, reason: thread.reason ?? page.reason }
      }
      const community = communityOf(page.finalUrl)
      if (!page.text) {
        pagesRead.push({ url: page.finalUrl, community: community.name, ok: false, flagged: 0, reason: page.reason ?? undefined })
        continue
      }
      const read = await readCommunityQuestions({ text: page.text, sourceUrl: page.finalUrl, tenantId: ctx.tenantId, company: { name: companyName, host: companyHost } })
      // A read that failed — the model step itself — is a page NOT read, and
      // is recorded so. It used to be recorded as read with no signals, so an
      // AI outage reported "pages were read and none stated a signal": a
      // failure presented as a finding about the company (2026-10-06).
      costUsd += read.costUsd
      if (read.failed) readFailures.push(read.reason ?? 'The reading step failed.')
      logged += read.logged
      excluded += read.excluded
      rejected += read.rejected

      const place = placeOf(page.finalUrl)
      let added = 0
      for (const q of read.flagged) {
        if (signals.length >= MAX_SIGNALS) break
        signals.push({
          crmCompanyId: ctx.company.id,
          signalType: 'community_question',
          signalCategory: 'catalog',
          summary: `Community question on ${community.name} (${q.clusterLabel}): “${clip(q.quote, 180)}”`,
          // WHY IT MATTERS — a fixed sentence per cluster, never a model's view.
          interpretation: CLUSTER_WHY[q.cluster],
          // The method's own guidance: help first, no pitch.
          outreachAngle: COMMUNITY_ANGLE,
          evidence: q.quote,
          sourceUrl: page.finalUrl,
          sourceType: place.sourceType,
          observedAt: statedDateOf(q.statedDate),
          polarity: 'positive',
          provider: this.name,
          metadata: {
            kind: 'community_question',
            kindLabel: 'Community question',
            platform: place.platform,
            platformLabel: community.name,
            cluster: q.cluster,
            clusterLabel: q.clusterLabel,
            clusterWeight: q.weight,
            clustersMatched: q.clustersMatched,
            persona: q.persona,
            posterTitle: q.posterTitle,
            decision: q.decision,
            statedDate: q.statedDate,
            discoveredVia: page.discoveredVia,
            searchTitle: page.title,
            method: 'Community Engagement & Trust-Building System (Sep 2026)',
          },
        })
        added++
      }
      pagesRead.push({ url: page.finalUrl, community: community.name, ok: !read.failed, flagged: added, ...(read.failed ? { reason: read.reason ?? undefined } : {}) })
    }

    const readOk = pagesRead.filter((p) => p.ok).length
    const couldNotRead = signals.length === 0 && readOk === 0 && readFailures.length > 0
    return {
      provider: this.name,
      ok: !couldNotRead,
      signals,
      reason: signals.length
        ? undefined
        : couldNotRead
          ? `The community pages found could not be read: ${readFailures[0]}`
          : discovery.sources.length === 0
          ? `${NO_EVIDENCE} The search found no forum or community questions by or about this company.`
          : readOk === 0
            ? `${NO_EVIDENCE} ${pagesRead.length} community page(s) were found but none could be read.`
            : `${NO_EVIDENCE} ${readOk} community page(s) were read; none held a question the method flags for this company.`,
      durationMs: Date.now() - started,
      costUsd: costUsd || undefined,
      metadata: {
        queriesRun: discovery.queriesRun,
        sourcesDiscovered: discovery.sources.length,
        pagesRead,
        // The method's own counts: matched but not flagged (cluster 6, or
        // 3/4/5 without a persona), excluded outright, and not on the page.
        loggedNotFlagged: logged,
        excludedByMethod: excluded,
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

function hostOfCompany(ctx: ProviderContext): string | null {
  const raw = resolveCompanySource(ctx.company).websiteUrl
  if (!raw) return null
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
