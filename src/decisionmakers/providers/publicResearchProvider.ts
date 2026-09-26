import { env } from '../../config/env.js'
import {
  discoverPublicSources,
  readPublicSources,
  NO_EVIDENCE,
  type ReadPublicSource,
} from '../../research/publicResearch.js'
import { hostOf, sameSite } from '../companyMatch.js'
import { assignStoredEmails } from './crmContactProvider.js'
import { readPeopleFromPage } from '../modelReader.js'
import type { CandidateDraft, DmSourceType, ProviderStatus } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'

// SOURCE — THE PUBLIC WEB, FOUND BY SEARCH AND READ BY US.
//
// The gap this closes. Every other source in this stage needs either a paid
// subscription or a URL we can guess. When the subscriptions are unbought and
// the company's site has no reachable /about or /team page, the stage has
// nowhere left to look — and returns nobody for a company the open web
// plainly has material on. That is a recall failure, and "no verified decision
// maker found" is only an honest answer when we actually looked.
//
// What is new here is WHERE WE LOOK, and nothing else. In particular:
//
//   · The search returns LINKS. It is never asked who works somewhere, and no
//     name is ever read out of a search result or a model's prose.
//   · Every page is fetched by this service, through the same SSRF-guarded,
//     redirect-capped, byte-capped transport the audit crawler uses.
//   · Those bytes are read by readPeopleFromPage — the SAME verifier the
//     company's own team pages already go through, unchanged. Every character
//     of every name, title and quoted sentence is checked against the page we
//     fetched, and dropped if absent.
//
// So a person found here is evidenced exactly as strongly as one found on the
// company's own about page: a verbatim sentence, at a URL a human can open and
// check. The net is wider; the standard of proof is identical.
//
// WHAT IS DELIBERATELY WEAKER THAN THE FIRST-PARTY PROVIDER, and must be:
//
// A company's own site is authoritative about its own staff. A trade article
// is not. So this provider states the employer as the SOURCE wrote it rather
// than asserting it from the fact of publication, and lets the engine's
// existing company-match step decide how strongly the person is tied to this
// company. A third-party page that names someone without tying them to the
// company will fail that check, which is the correct outcome.
//
// LINKEDIN. Public pages that a search index has returned are read like any
// other public page. Nothing here authenticates, presents a cookie, or drives
// a scraper: a profile that serves a sign-in wall to a logged-out reader is
// RECORDED as a sign-in wall by the research layer and yields no candidate.
// That is the same line Stage 3 already draws.

/**
 * Email addresses a fetched page PUBLISHES for its verified people.
 *
 * An address is attached to a person only when all of these hold, and never
 * otherwise:
 *
 *   · it is printed in the page we fetched, character for character — it is
 *     lifted from those bytes, never composed, and no model supplies it;
 *   · its domain is the company's own verified domain (or a subdomain), so a
 *     journalist's or a directory's address on a third-party page cannot be
 *     mistaken for the person's;
 *   · it is not a shared mailbox (info@, sales@ …);
 *   · its local part names this person, decided by the same matcher that
 *     assigns stored NXT Sales addresses — including its rule that an address
 *     two people could claim belongs to neither.
 *
 * Only people the verifier already confirmed are considered, so an address can
 * never introduce a person.
 */
export function publishedEmailsFor(
  names: string[],
  pageText: string,
  companyHost: string | null,
): Map<string, string> {
  const out = new Map<string, string>()
  if (!companyHost || names.length === 0) return out
  const onPage = (pageText.match(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi) ?? [])
    .map((e) => e.replace(/\.+$/, ''))
    .filter((e) => sameSite(e.split('@')[1]!.toLowerCase(), companyHost))
  if (onPage.length === 0) return out
  for (const [name, match] of assignStoredEmails(names, onPage)) {
    if (match.email) out.set(name, match.email)
  }
  return out
}

/** Hosts whose pages are the company speaking about itself. */
function sourceTypeFor(url: string, companyHost: string | null): DmSourceType {
  const host = hostOf(url)
  if (host && companyHost && (host === companyHost || host.endsWith(`.${companyHost}`))) return 'company_website'
  return 'third_party'
}

export class PublicResearchProvider implements DecisionMakerProvider {
  readonly name = 'public_web_research'
  readonly sourceType = 'third_party'

  available(ctx?: DmProviderContext): { status: ProviderStatus; reason?: string } {
    if (!env.PUBLIC_RESEARCH_ENABLED) {
      return {
        status: 'unavailable',
        reason:
          'PUBLIC_RESEARCH_ENABLED is off, so the open web was not searched. This source reaches third-party ' +
          'hosts and spends model budget, so it is opt-in.',
      }
    }
    if (!env.DM_MODEL_READER_ENABLED) {
      // Without the verifier there is no safe way to read an arbitrary page
      // for people. Refusing is the only correct behaviour: the alternative
      // is an unverified extraction, which this engine does not do.
      return {
        status: 'unavailable',
        reason:
          'DM_MODEL_READER_ENABLED is off. Public research reads arbitrary pages, and every person it reports must ' +
          'be verified character-by-character against the fetched page before it is believed.',
      }
    }
    if (ctx && !ctx.company.name?.trim()) {
      return {
        status: 'unavailable',
        reason: 'The company has no name on record, so no search query could be composed from facts we hold.',
      }
    }
    return { status: 'available' }
  }

  async search(ctx: DmProviderContext): Promise<DmProviderResult> {
    const started = Date.now()
    const companyHost = hostOf(ctx.companyDomain)

    const discovery = await discoverPublicSources({
      tenantId: ctx.tenantId,
      companyName: ctx.company.name,
      domain: companyHost,
      topic: 'people',
      feature: 'decision_maker_public_research',
    })

    if (discovery.status !== 'available') {
      return {
        provider: this.name,
        status: discovery.status === 'unauthorized' ? 'unauthorized' : discovery.status === 'error' ? 'error' : 'unavailable',
        candidates: [],
        reason: discovery.reason ?? 'Public research could not run.',
        durationMs: Date.now() - started,
        costUsd: discovery.costUsd || undefined,
        metadata: { searchProvider: discovery.provider, queriesRun: discovery.queriesRun },
      }
    }

    const pages = await readPublicSources(discovery.sources)
    const drafts: CandidateDraft[] = []
    const seenNames = new Set<string>()
    const pagesRead: Array<{ url: string; finalUrl: string; ok: boolean; loginWall: boolean; people: number; reason?: string }> = []
    let rejected = 0
    let untitled = 0
    let costUsd = discovery.costUsd
    let modelName: string | null = null
    let loginWalls = 0
    let emailsFound = 0
    let readFailures = 0
    let readFailureReason: string | null = null

    for (const page of pages) {
      if (page.loginWall) loginWalls += 1
      if (!page.text) {
        pagesRead.push({
          url: page.url,
          finalUrl: page.finalUrl,
          ok: false,
          loginWall: page.loginWall,
          people: 0,
          reason: page.reason ?? undefined,
        })
        continue
      }

      const read = await readPeopleFromPage({ text: page.text, sourceUrl: page.finalUrl, tenantId: ctx.tenantId })
      if (read.failed === true) {
        // The page was fetched but the model could not read it. That says
        // nothing about who the page names, so it is recorded as a failure
        // rather than as a page that named nobody.
        readFailures += 1
        if (read.reason) readFailureReason = read.reason
        pagesRead.push({
          url: page.url,
          finalUrl: page.finalUrl,
          ok: false,
          loginWall: false,
          people: 0,
          reason: read.reason ?? 'The model read failed.',
        })
        costUsd += read.costUsd
        continue
      }
      rejected += read.rejected
      costUsd += read.costUsd
      modelName = read.model ?? modelName

      const emails = publishedEmailsFor(
        read.people.map((p) => p.fullName),
        page.text,
        companyHost,
      )

      let added = 0
      for (const person of read.people) {
        // A page that names somebody without stating their role establishes a
        // name and nothing more. The engine cannot judge relevance from a name
        // and will not shortlist them — and the one thing that must never
        // happen is this provider supplying the title the page withheld. So
        // the person is carried with rawTitle null and the evidence says only
        // what the source actually establishes.
        if (!person.rawTitle) untitled += 1

        const key = person.fullName.toLowerCase()
        if (seenNames.has(key)) continue
        seenNames.add(key)

        const email = emails.get(person.fullName) ?? null
        if (email) emailsFound += 1
        drafts.push(draftFrom(person, page, companyHost, ctx.company.name, email))
        added += 1
        if (drafts.length >= ctx.maxResults) break
      }

      pagesRead.push({ url: page.url, finalUrl: page.finalUrl, ok: true, loginWall: false, people: added })
      if (drafts.length >= ctx.maxResults) break
    }

    const readOk = pagesRead.filter((p) => p.ok).length
    // Pages were fetched with text, and the model failed on every one of them.
    const allReadsFailed = readFailures > 0 && readOk === 0

    return {
      provider: this.name,
      status: drafts.length ? 'available' : allReadsFailed ? 'error' : 'no_results',
      candidates: drafts,
      reason: drafts.length
        ? undefined
        : allReadsFailed
          ? `${readFailures} public page(s) were fetched but the model could not read any of them ` +
            `(${readFailureReason ?? 'no reason given'}), so whether they name anyone is unknown.`
          : discovery.sources.length === 0
          ? `${NO_EVIDENCE} The search returned no indexed pages about this company.`
          : readOk === 0
            ? `${NO_EVIDENCE} ${discovery.sources.length} page(s) were found but none could be read` +
              (loginWalls ? `; ${loginWalls} served a sign-in wall to a logged-out reader.` : '.')
            : `${NO_EVIDENCE} ${readOk} public page(s) were read and none named a person this company employs.`,
      durationMs: Date.now() - started,
      costUsd: costUsd || undefined,
      metadata: {
        searchProvider: discovery.provider,
        queriesRun: discovery.queriesRun,
        sourcesDiscovered: discovery.sources.length,
        pagesRead,
        loginWalls,
        // The verifier's own numbers, kept visible. A non-zero rejection count
        // is the guard working, not an error.
        claimsRejectedAsUngrounded: rejected,
        namedWithoutARole: untitled,
        publishedEmailsMatched: emailsFound,
        modelReadFailures: readFailures,
        model: modelName,
      },
    }
  }
}

/**
 * One verified reading, as a candidate draft.
 *
 * Every field is either copied from the page or left null. There is no branch
 * here on which company this is, and nothing is defaulted.
 */
function draftFrom(
  person: { fullName: string; rawTitle: string | null; sourceSentence: string },
  page: ReadPublicSource,
  companyHost: string | null,
  companyName: string,
  /** Only ever a value from publishedEmailsFor: printed on this page, on the company's domain. */
  email: string | null = null,
): CandidateDraft {
  const sourceType = sourceTypeFor(page.finalUrl, companyHost)
  const supports: Array<'name' | 'title' | 'company' | 'profile_url' | 'contact'> = ['name']
  if (person.rawTitle) supports.push('title')
  if (email) supports.push('contact')
  // Only the company's OWN page establishes the employer by the fact of
  // publishing. A third-party page has to say so in words, and the engine's
  // company-match step is what reads those words.
  if (sourceType === 'company_website') supports.push('company')

  return {
    fullName: person.fullName,
    rawTitle: person.rawTitle,
    // The company's OWN page establishes the employer by the fact of
    // publishing it. A third-party page does not, so the employer is left
    // unstated and the engine's company-match step decides on the words the
    // page actually used — which is what that step is for.
    statedCompany: sourceType === 'company_website' ? companyName : null,
    profileUrl: null,
    providerPersonId: null,
    // Only an address this page publishes, on the company's own domain, whose
    // local part names this verified person — see publishedEmailsFor. Nothing
    // is composed or pattern-guessed. Storage still obeys DM_STORE_CONTACT_DATA.
    email,
    phone: null,
    location: null,
    evidence: [
      {
        provider: 'public_web_research',
        sourceType,
        sourceUrl: page.finalUrl,
        // The literal sentence, already verified to exist in the bytes we
        // fetched. A reader can open the URL and find it.
        snippet:
          person.sourceSentence.slice(0, 500) +
          (email ? ` | address published on this page naming this person: ${email}` : ''),
        // Pages rarely date a staff mention, and stamping "now" would assert
        // the mention is current when only the fetch is.
        observedAt: null,
        supports,
      },
    ],
  }
}
