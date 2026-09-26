import { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { classifyCompanyUrl, resolveCompanySource } from '../crm/companySource.js'
import type { CrmCompany } from '../crm/types.js'
import { discoveredCompanyIdFor, resolvePipelineCompany } from '../prospects/discoveredCompanyAdapter.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { serializeError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import {
  assembleCandidates,
  selectShortlist,
  UNVERIFIED_EMPLOYER_REASON,
  type ShortlistExclusion,
} from './candidates.js'
import { hostOf } from './companyMatch.js'
import { ApolloProvider } from './providers/apolloProvider.js'
import { CrmContactProvider } from './providers/crmContactProvider.js'
import { LinkedInReferenceProvider } from './providers/linkedInReferenceProvider.js'
import { runDmProvider, type DecisionMakerProvider, type DmProviderResult } from './providers/provider.js'
import { PublicResearchProvider } from './providers/publicResearchProvider.js'
import { RocketReachProvider } from './providers/rocketReachProvider.js'
import { SocialSignalProvider } from './providers/socialSignalProvider.js'
import { HunterProvider } from './providers/hunterProvider.js'
import { WebCorroborationProvider } from './providers/webCorroborationProvider.js'
import { ZoomInfoProvider } from './providers/zoomInfoProvider.js'
import type { ScoredCandidate } from './types.js'

// STAGE 4 — DECISION-MAKER DISCOVERY ENGINE.
//
// Runs every provider, merges what they saw into one candidate per human,
// verifies each candidate actually works at this company, scores by evidence
// quality, and returns a short ranked list.
//
// The governing rule: "No verified decision maker found" beats "probably this
// person". Two consequences run through the whole file — a candidate whose
// employment cannot be shown is never shortlisted however good the title is,
// and a run that finds nobody records WHY, per provider, so an empty result can
// be read correctly.

/**
 * The approved provider order (Team Answer, Sections A.3 and E.2):
 *
 *   Apollo -> ZoomInfo -> RocketReach -> official LinkedIn -> AI web search
 *
 * with two sources sitting ahead of all of them. Section E.4 is explicit that
 * for a company already in NXT Sales we use the stored data rather than
 * re-collecting it, and Section E.5 allows LinkedIn references that the CRM
 * already holds. Both are free, local, and cannot be improved on by paying a
 * provider, so they always run.
 *
 * WHY EVERY PROVIDER NOW RUNS, AND WHAT CHANGED.
 *
 * This chain used to STOP as soon as one source produced a company-matched,
 * role-relevant, reachable person — `isSufficient` decided, and everything
 * after it was recorded as "Not called: an earlier provider already returned
 * a decision maker". The intention was to control spend on the paid sources.
 *
 * The effect was a CRM-FIRST-STOP. A company whose NXT Sales record happens to
 * name one buyer got exactly that one person, and Apollo, ZoomInfo,
 * RocketReach and Hunter were reported as unused — not because they had
 * nothing to add, but because the cheapest source answered first. Two things
 * were lost every time: a better-verified email for the person we already had,
 * and the second person who makes an ALTERNATIVE contact possible at all.
 *
 * So the order below is a PRIORITY ORDER, not a stopping rule. CRM still goes
 * first because it is authoritative and free; every later source still runs,
 * and its findings are merged into the same people by identity rather than
 * replacing them.
 *
 * Cost is still bounded, by the thing that actually bounds it: a provider that
 * is not configured, or not eligible for this company, reports that from
 * `available()` and never makes a request. Nothing here pays for a source it
 * cannot use.
 */
interface ProviderStage {
  provider: DecisionMakerProvider
  /**
   * Kept for the registry's own readability: these sources are free and ours.
   * It no longer gates anything — every stage runs.
   */
  always?: true
}

const PROVIDER_STAGES: ProviderStage[] = [
  { provider: new CrmContactProvider(), always: true },
  { provider: new LinkedInReferenceProvider(), always: true },
  // Stage 3's own findings, before any paid provider is asked. A person the
  // company already published and Intent Signals already stored should be
  // EVALUATED here rather than rediscovered — and it costs nothing.
  { provider: new SocialSignalProvider(), always: true },
  { provider: new ApolloProvider() },
  { provider: new ZoomInfoProvider() },
  { provider: new RocketReachProvider() },
  // After the people-databases and before the open-web fallback. Hunter is
  // not a people database — it is a record of addresses seen on public pages,
  // so it answers "how do we reach them" better than "who are they", and the
  // three above should have their say about identity first.
  { provider: new HunterProvider() },
  { provider: new WebCorroborationProvider() },
  // LAST, and deliberately so. Every source above either holds a record of
  // this company or reads the company's own website, and both are better
  // evidence about who works somewhere than the open web is. This one runs
  // when they have had their say — it widens the net rather than replacing
  // anything, and a person it finds is merged into the same people by identity
  // like any other source's.
  { provider: new PublicResearchProvider() },
]

/**
 * Statuses that mean a request was actually made.
 *
 * `unauthorized`, `unavailable` and `skipped` are decided before the network:
 * a missing credential, a plan without the endpoint, a company with no domain
 * to search by. Everything else describes what a real request came back with.
 */
const WAS_QUERIED = new Set(['available', 'no_results', 'rate_limited', 'error'])

/**
 * Sources that read records this service or NXT Sales already holds, rather
 * than asking an external system. They never "query" anything.
 */
const LOCAL_PROVIDERS = new Set(['crm_contacts', 'intent_social'])

export function providerNames(): string[] {
  return PROVIDER_STAGES.map((s) => s.provider.name)
}

/**
 * Whether a run produced a decision maker worth acting on.
 *
 * THIS NO LONGER GATES ANYTHING. It used to stop the provider chain, which is
 * how a company with one CRM contact never reached Apollo, Hunter or the open
 * web. It is now a READING of the finished result — used to say whether the
 * run succeeded in finding someone usable, never to decide whether to look.
 *
 * Deliberately strict, and made of the exact criteria the business named. A
 * candidate satisfies it only when all four hold:
 *
 *   company match   — verified or probable, never a name we cannot place
 *   role relevance  — a P1 or P2 specialist, never the executive fallback,
 *                     because falling back is what you do when the sources
 *                     came back empty, not a reason to stop asking them
 *   reachability    — some way to make contact, or the run has found a
 *                     biography rather than a lead
 *   evidence        — medium confidence or better
 *
 * Seniority is deliberately NOT part of the test. It ranks candidates once
 * they are relevant; letting it gate escalation would stop the search early
 * for a senior irrelevant person, which is the failure this stage exists to
 * avoid.
 */
export function isSufficient(scored: ScoredCandidate[]): boolean {
  return scored.some(
    (c) =>
      (c.companyMatch === 'verified' || c.companyMatch === 'probable') &&
      c.rolePriority !== null &&
      c.rolePriority <= 2 &&
      c.contactability !== 'none' &&
      c.confidence !== 'low',
  )
}

/**
 * How long a queued or running search counts as still in flight. A run older
 * than this is presumed stranded (its job expired or its worker died) and no
 * longer blocks a new search — otherwise one lost job would lock a company out
 * of discovery for good.
 */
export const DM_IN_FLIGHT_WINDOW_MS = 30 * 60 * 1000

/**
 * Queues one search for a company — or returns the one already in flight.
 *
 * DUPLICATES. Three clicks on "Find decision makers" inside six seconds used to
 * start three identical runs, each spending provider and model budget on the
 * same answer; the automatic new-lead trigger would multiply that. So while a
 * search for this company is queued or running, the caller gets THAT run back
 * with `reused: true` and must not enqueue a job for it.
 *
 * The check and the insert happen under a transaction-scoped advisory lock on
 * (tenant, company), so two requests arriving together cannot both see "none in
 * flight" and both insert. A finished search never blocks a new one: asking
 * again later is a legitimate re-run.
 */
export async function queueDecisionMakerDiscovery(input: {
  tenantId: string
  crmCompanyId: string
  requestedByCrmUserId: string
  prospectSearchId?: string | null
  /** Set when crmCompanyId is a DiscoveredCompany.id placeholder — see that model. */
  discoveredCompanyId?: string | null
  /**
   * For the automatic new-lead trigger: a company that has EVER been searched
   * is not searched again. Checked under the same lock, so a manual search and
   * an automatic one arriving together still produce one run.
   */
  onlyIfNeverSearched?: boolean
}): Promise<{ id: string; reused: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dm-discover:${input.tenantId}:${input.crmCompanyId}`}))`

    // Stranded runs for this company are closed off first, so a lost job
    // reads as failed rather than as "queued" forever.
    await tx.decisionMakerRun.updateMany(staleRunSweep(input.tenantId, input.crmCompanyId))

    const inFlight = await tx.decisionMakerRun.findFirst({
      where: {
        tenantId: input.tenantId,
        crmCompanyId: input.crmCompanyId,
        ...(input.onlyIfNeverSearched
          ? {}
          : {
              status: { in: ['queued', 'running'] },
              createdAt: { gte: new Date(Date.now() - DM_IN_FLIGHT_WINDOW_MS) },
            }),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (inFlight) return { id: inFlight.id, reused: true }

    const id = newId()
    await tx.decisionMakerRun.create({
      data: {
        id,
        tenantId: input.tenantId,
        crmCompanyId: input.crmCompanyId,
        prospectSearchId: input.prospectSearchId ?? null,
        // Recorded whether or not the caller said so: the route passes only
        // an id, and the row must still say which kind of company it names.
        discoveredCompanyId:
          input.discoveredCompanyId ?? (await discoveredCompanyIdFor(input.tenantId, input.crmCompanyId)),
        requestedByCrmUserId: input.requestedByCrmUserId,
        status: 'queued',
      },
    })
    return { id, reused: false }
  })
}

export const STALE_RUN_REASON =
  'The search did not finish within the in-flight window. Its job was lost or its worker stopped, so it was ' +
  'closed as failed; start the search again.'

/** The update that fails queued/running runs older than the in-flight window. */
export function staleRunSweep(tenantId: string, crmCompanyId?: string, now: Date = new Date()) {
  return {
    where: {
      tenantId,
      ...(crmCompanyId ? { crmCompanyId } : {}),
      status: { in: ['queued', 'running'] },
      createdAt: { lt: new Date(now.getTime() - DM_IN_FLIGHT_WINDOW_MS) },
    },
    data: { status: 'failed', failureReason: STALE_RUN_REASON, completedAt: now },
  }
}

/**
 * Fails runs stranded in queued/running beyond the in-flight window. Scoped to
 * one company when given one. Returns how many were closed.
 */
export async function failStaleDecisionMakerRuns(tenantId: string, crmCompanyId?: string): Promise<number> {
  const r = await prisma.decisionMakerRun.updateMany(staleRunSweep(tenantId, crmCompanyId))
  return r.count
}

/**
 * Records that a run's job could not be put on the queue.
 *
 * Without this the run sat in `queued` with no job behind it, reading as
 * "running" on the screen and blocking every new search for the company for
 * the whole in-flight window.
 */
export async function markDecisionMakerRunEnqueueFailed(runId: string, err: unknown): Promise<void> {
  await prisma.decisionMakerRun
    .update({
      where: { id: runId },
      data: {
        status: 'failed',
        failureReason: `The search could not be queued: ${String((err as Error)?.message ?? err).slice(0, 400)}`,
        completedAt: new Date(),
      },
    })
    .catch(() => undefined)
}

/**
 * The company's verified website host, for the providers that search by domain.
 *
 * Prefers the domain Stage 2 enrichment actually reached over the CRM field,
 * because the enrichment result is a URL that responded whereas the CRM column
 * is whatever someone typed.
 *
 * WHAT WENT WRONG BEFORE. This read the raw `Company.domain` column through
 * hostOf() and never asked whether that string was a website at all. A record
 * whose website column holds a social platform — which is common, and which
 * resolveCompanySource exists precisely to recognise — therefore produced
 * "facebook.com" as THE COMPANY'S DOMAIN. Two providers then acted on it:
 * Hunter spent a metered domain search looking for staff addresses at
 * facebook.com, and the website provider fetched Facebook's own pages looking
 * for the company's team page. Neither is this company's domain, and one of
 * them costs money every time.
 *
 * The judgement is not repeated here. resolveCompanySource is the one place
 * that decides what counts as a company's website, and this asks it. A company
 * with no website of its own gets NO DOMAIN, which is the truth — and both
 * domain-based providers already decline cleanly on a null domain, so nothing
 * downstream needs to know why.
 *
 * WHAT IT WILL NOT DO: derive a domain from a social profile, or adopt
 * `candidateWebsiteUrl`. That field is an unverified hypothesis from a
 * corporate email address, offered for a caller that can check it — and
 * handing an unchecked guess to a paid provider is exactly the inference this
 * stage forbids.
 */
async function resolveDomain(
  tenantId: string,
  crmCompanyId: string,
  company: CrmCompany,
): Promise<string | null> {
  const source = resolveCompanySource(company)
  // Social-only, or nothing usable at all. There is no company domain to
  // search by, and a platform root is nobody's.
  if (!source.websiteUrl) return null

  const enrichment = await prisma.companyEnrichment.findFirst({
    where: { tenantId, crmCompanyId, status: 'enriched' },
    orderBy: { createdAt: 'desc' },
    select: { sourceUrl: true },
  })

  // The enrichment URL is preferred, but only once it has passed the same
  // test: an older row could itself hold a platform URL, written before that
  // judgement was centralised.
  const enriched = classifyCompanyUrl(enrichment?.sourceUrl)
  if (enriched.kind === 'primary_website' && enriched.url) return hostOf(enriched.url)

  return hostOf(source.websiteUrl)
}

/** Queue handler. Never throws: failures are recorded on the run row. */
export async function runDecisionMakerDiscovery(runId: string): Promise<void> {
  const run = await prisma.decisionMakerRun.findUnique({ where: { id: runId } })
  if (!run) return
  if (run.status === 'completed') return

  const log = logger.child({ dmRunId: runId, crmCompanyId: run.crmCompanyId })

  if (run.retryCount >= env.DM_MAX_RETRIES) {
    await prisma.decisionMakerRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        failureReason: `Exceeded DM_MAX_RETRIES (${env.DM_MAX_RETRIES}).`,
        completedAt: new Date(),
      },
    })
    return
  }

  try {
    await prisma.decisionMakerRun.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date(), retryCount: { increment: 1 }, error: Prisma.DbNull },
    })

    // A company found by "Find New Company" is read from the platform's own
    // record; anything else from NXT Sales.
    const resolved = await resolvePipelineCompany(run.tenantId, run.crmCompanyId)
    if (!resolved) {
      await prisma.decisionMakerRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          failureReason: 'Company not found in NXT Sales (it may have been recycle-binned).',
          completedAt: new Date(),
        },
      })
      return
    }
    const company: CrmCompany = resolved.company

    const companyDomain = await resolveDomain(run.tenantId, run.crmCompanyId, company)

    // Providers run in sequence and in isolation: one dead source must not lose
    // the candidates another already found.
    // EVERY provider runs, in priority order.
    //
    // Not "until one succeeds". A later source can supply a verified email for
    // the person the CRM already named, or the second person who makes an
    // alternative contact possible — and neither is reachable if the chain
    // stops at the first answer. Providers that are not configured or not
    // eligible decline in `available()` without making a request, so this
    // costs nothing where there is nothing to spend.
    const results: DmProviderResult[] = []
    for (const stage of PROVIDER_STAGES) {
      const result = await runDmProvider(stage.provider, {
        tenantId: run.tenantId,
        company,
        companyDomain,
        maxResults: env.DM_MAX_CANDIDATES * 4,
      })
      results.push(result)
      log.debug({ provider: result.provider, status: result.status, found: result.candidates.length }, 'provider finished')
    }

    const drafts = results.flatMap((r) => r.candidates)
    const scored = assembleCandidates(drafts, company, companyDomain)
    const { shortlist, excluded } = selectShortlist(scored, env.DM_MAX_CANDIDATES)

    await persistCandidates(run.tenantId, runId, run.crmCompanyId, scored, shortlist, excluded)

    const costUsd = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)

    await prisma.decisionMakerRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        companyName: company.name,
        companyDomain,
        candidateCount: shortlist.length,
        // Everyone seen and not shortlisted — contradicted, unverified,
        // irrelevant, held back by the fallback policy, or cut by the cap.
        excludedCount: Math.max(excluded.length, scored.length - shortlist.length),
        duplicatesCollapsed: Math.max(0, drafts.length - scored.length),
        providerResults: results.map((r) => ({
          provider: r.provider,
          status: r.status,
          // Whether a REQUEST was actually made. A provider that declined in
          // available() — no credential, no domain, nothing to search by —
          // never reached the network, and an operator reading "0 people"
          // needs to know which of the two happened.
          // A source that reads data this service already holds (the CRM
          // record, stored intent signals) makes no request at all, so "no
          // results" from it is a check of a record, not a query.
          queried: WAS_QUERIED.has(r.status) && !LOCAL_PROVIDERS.has(r.provider),
          local: LOCAL_PROVIDERS.has(r.provider),
          candidates: r.candidates.length,
          reason: r.reason ?? null,
          durationMs: r.durationMs,
          costUsd: r.costUsd ?? null,
          metadata: r.metadata ?? null,
        })) as never,
        noResultsReason: shortlist.length ? null : explainNoResults(results, scored.length, excluded.length),
        costUsd: new Prisma.Decimal(costUsd),
        completedAt: new Date(),
      },
    })

    await audit({
      tenantId: run.tenantId,
      actorType: 'agent',
      action: 'decision_makers.discovered',
      resourceType: 'DecisionMakerRun',
      resourceId: runId,
      dataClass: 'customer_pii',
      // Names are deliberately NOT written into the audit summary — the audit
      // log is a different retention class from the candidate table.
      summary: `${company.name}: ${shortlist.length} shortlisted, ${excluded.length} excluded`,
    })

    log.info({ shortlisted: shortlist.length, excluded: excluded.length, costUsd }, 'decision-maker discovery completed')
  } catch (err) {
    log.error({ err }, 'decision-maker discovery failed')
    await prisma.decisionMakerRun
      .update({
        where: { id: runId },
        data: {
          status: 'failed',
          error: serializeError(err) as never,
          failureReason: (err as Error).message?.slice(0, 500),
          completedAt: new Date(),
        },
      })
      .catch(() => undefined)
  }
}

/**
 * Says why a run found nobody, distinguishing the three reasons that look
 * identical in an empty list: nothing ran, people were found but none were
 * relevant, or people were found and relevant but could not be tied to this
 * company.
 */
export function explainNoResults(
  results: DmProviderResult[],
  peopleSeen: number,
  excluded: number,
): string {
  const blocked = results.filter((r) => r.status === 'unauthorized')
  const ran = results.filter((r) => r.status === 'available' || r.status === 'no_results')

  const parts: string[] = ['No verified decision maker found.']

  if (peopleSeen > 0) {
    parts.push(
      `${peopleSeen} person(s) were seen but ${excluded} were excluded — either the title matched no role ` +
        'group that owns product or catalog data, or their employment at this company could not be verified.',
    )
  } else if (ran.length) {
    parts.push(`${ran.length} source(s) ran and returned nobody at this company.`)
  }

  if (blocked.length) {
    parts.push(
      `${blocked.length} person-data source(s) could not be consulted at all: ` +
        blocked.map((b) => `${b.provider} (${b.reason})`).join(' '),
    )
  }

  return parts.join(' ')
}

/**
 * Writes candidates, shortlisted and excluded alike.
 *
 * Excluded people are stored on purpose: "we looked at 12 people and none of
 * them owned product data" is a real finding, and discarding it would make the
 * next run repeat the work and a reviewer unable to check the judgement.
 *
 * Contact details are written ONLY when DM_STORE_CONTACT_DATA is enabled. The
 * default is off — this stage does not need an inbox to answer "who".
 */
async function persistCandidates(
  tenantId: string,
  runId: string,
  crmCompanyId: string,
  all: ScoredCandidate[],
  shortlist: ScoredCandidate[],
  excluded: ShortlistExclusion[] = [],
): Promise<void> {
  const rankByIdentity = new Map(shortlist.map((c, i) => [c.identityKey, i + 1]))
  // The reason selectShortlist actually gave, per person. Recomputing it here
  // lost the fallback-policy and unverified-employer steps, so a suppressed
  // Owner was stored as "ranked below the top N".
  const reasonByIdentity = new Map(excluded.map((e) => [e.identityKey, e.reason]))

  // One transaction per run, and this run's earlier rows are cleared first: a
  // run that crashed mid-write and was retried used to keep the partial rows
  // from the first attempt beside the full set from the second.
  await prisma.$transaction(async (tx) => {
    await tx.decisionMakerCandidate.deleteMany({ where: { tenantId, dmRunId: runId } })
    for (const c of all) {
      await writeCandidate(tx, c)
    }
    // A company can yield a few hundred people; the default 5s interactive
    // transaction budget is too tight for that many sequential writes.
  }, { timeout: 60_000, maxWait: 10_000 })

  async function writeCandidate(tx: Prisma.TransactionClient, c: ScoredCandidate): Promise<void> {
    const rank = rankByIdentity.get(c.identityKey) ?? null
    const shortlisted = rank !== null

    await tx.decisionMakerCandidate.create({
      data: {
        id: newId(),
        tenantId,
        dmRunId: runId,
        crmCompanyId,
        identityKey: c.identityKey,
        fullName: c.fullName,
        rawTitle: c.rawTitle,
        normalizedTitle: c.normalizedTitle,
        roleGroup: c.roleGroup,
        rolePriority: c.rolePriority,
        seniority: c.seniority,
        statedCompany: c.statedCompany,
        companyMatch: c.companyMatch,
        companyMatchReasons: c.companyMatchReasons as never,
        profileUrl: c.profileUrl,
        location: c.location,
        email: env.DM_STORE_CONTACT_DATA ? c.email : null,
        phone: env.DM_STORE_CONTACT_DATA ? c.phone : null,
        confidence: c.confidence,
        confidenceReasons: c.confidenceReasons as never,
        contactability: c.contactability,
        corroboratingProviders: c.corroboratingProviders as never,
        corroborationCount: c.corroboratingProviders.length,
        rankScore: c.rankScore,
        rankReasons: c.rankReasons as never,
        rank,
        // Contact details are stripped from stored evidence too, not just from
        // the columns — otherwise the setting would be cosmetic.
        evidence: (env.DM_STORE_CONTACT_DATA ? c.evidence : c.evidence.map(redactContact)) as never,
        outcome: shortlisted ? 'shortlisted' : 'excluded',
        exclusionReason: shortlisted ? null : (reasonByIdentity.get(c.identityKey) ?? exclusionReasonFor(c)),
      },
    })
  }
}

/** Only for a person selectShortlist gave no reason for, which should not happen. */
function exclusionReasonFor(c: ScoredCandidate): string {
  if (c.companyMatch === 'rejected') return `A source places them at "${c.statedCompany}", not this company.`
  if (c.companyMatch === 'unverified') return UNVERIFIED_EMPLOYER_REASON
  if (c.rolePriority === null) {
    return c.rawTitle
      ? `Title "${c.rawTitle}" does not match any role group that owns product or catalog data.`
      : 'No job title was stated by any source, so relevance cannot be established.'
  }
  return `Ranked below the top ${env.DM_MAX_CANDIDATES} (score ${c.rankScore}).`
}

/** Removes emails and phone numbers from evidence text before storage. */
function redactContact<T extends { snippet: string }>(e: T): T {
  return {
    ...e,
    snippet: e.snippet
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email redacted]')
      .replace(/(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g, '[phone redacted]'),
  }
}
