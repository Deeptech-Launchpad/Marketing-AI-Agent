import { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { serializeError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { assembleCandidates, selectShortlist } from './candidates.js'
import { hostOf } from './companyMatch.js'
import { ApolloProvider } from './providers/apolloProvider.js'
import { CrmContactProvider } from './providers/crmContactProvider.js'
import { LinkedInReferenceProvider } from './providers/linkedInReferenceProvider.js'
import { runDmProvider, type DecisionMakerProvider, type DmProviderResult } from './providers/provider.js'
import { RocketReachProvider } from './providers/rocketReachProvider.js'
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
 * Everything after them is an ESCALATION. The team asked for provider choice
 * to be automatic, based on availability, match success, company match, role
 * relevance and seniority — so each paid source is only called when the ones
 * before it have not already produced a usable decision maker. That is what
 * `isSufficient` decides, and it is why the AI web search sits last: the
 * document calls it a last resort, and this is what "last resort" means
 * mechanically.
 */
interface ProviderStage {
  provider: DecisionMakerProvider
  /**
   * Always call, regardless of what earlier sources found. Reserved for
   * sources that cost nothing and are already ours.
   */
  always?: true
}

const PROVIDER_STAGES: ProviderStage[] = [
  { provider: new CrmContactProvider(), always: true },
  { provider: new LinkedInReferenceProvider(), always: true },
  { provider: new ApolloProvider() },
  { provider: new ZoomInfoProvider() },
  { provider: new RocketReachProvider() },
  { provider: new WebCorroborationProvider() },
]

export function providerNames(): string[] {
  return PROVIDER_STAGES.map((s) => s.provider.name)
}

/**
 * Whether the run already has a decision maker good enough to stop paying for
 * more sources.
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

export async function queueDecisionMakerDiscovery(input: {
  tenantId: string
  crmCompanyId: string
  requestedByCrmUserId: string
  prospectSearchId?: string | null
}): Promise<{ id: string }> {
  const id = newId()
  await prisma.decisionMakerRun.create({
    data: {
      id,
      tenantId: input.tenantId,
      crmCompanyId: input.crmCompanyId,
      prospectSearchId: input.prospectSearchId ?? null,
      requestedByCrmUserId: input.requestedByCrmUserId,
      status: 'queued',
    },
  })
  return { id }
}

/**
 * Resolves the company's verified website host.
 *
 * Prefers the domain Stage 2 enrichment actually reached over the raw CRM
 * field, because the enrichment result is a URL that responded, whereas the CRM
 * field is whatever someone typed.
 */
async function resolveDomain(tenantId: string, crmCompanyId: string, crmDomain: string | null): Promise<string | null> {
  const enrichment = await prisma.companyEnrichment.findFirst({
    where: { tenantId, crmCompanyId, status: 'enriched' },
    orderBy: { createdAt: 'desc' },
    select: { sourceUrl: true },
  })
  return hostOf(enrichment?.sourceUrl ?? crmDomain)
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

    const company = await getCrm().getCompany(run.crmCompanyId)
    if (!company) {
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

    const companyDomain = await resolveDomain(run.tenantId, run.crmCompanyId, company.domain)

    // Providers run in sequence and in isolation: one dead source must not lose
    // the candidates another already found.
    const results: DmProviderResult[] = []
    for (const stage of PROVIDER_STAGES) {
      // Escalate only as far as necessary. What has been found so far is
      // scored with the same code that scores the final set, so the stop
      // decision is made against real candidates rather than a raw count.
      if (!stage.always) {
        const soFar = assembleCandidates(results.flatMap((r) => r.candidates), company, companyDomain)
        if (isSufficient(soFar)) {
          results.push({
            provider: stage.provider.name,
            status: 'skipped',
            candidates: [],
            reason:
              'Not called: an earlier provider in the approved order already returned a company-matched, ' +
              'role-relevant, reachable decision maker.',
            durationMs: 0,
          })
          log.debug({ provider: stage.provider.name }, 'provider skipped — earlier source sufficed')
          continue
        }
      }

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

    await persistCandidates(run.tenantId, runId, run.crmCompanyId, scored, shortlist)

    const costUsd = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)

    await prisma.decisionMakerRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        companyName: company.name,
        companyDomain,
        candidateCount: shortlist.length,
        excludedCount: excluded.length,
        duplicatesCollapsed: Math.max(0, drafts.length - scored.length),
        providerResults: results.map((r) => ({
          provider: r.provider,
          status: r.status,
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
): Promise<void> {
  const rankByIdentity = new Map(shortlist.map((c, i) => [c.identityKey, i + 1]))

  for (const c of all) {
    const rank = rankByIdentity.get(c.identityKey) ?? null
    const shortlisted = rank !== null

    await prisma.decisionMakerCandidate.create({
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
        exclusionReason: shortlisted ? null : exclusionReasonFor(c),
      },
    })
  }
}

function exclusionReasonFor(c: ScoredCandidate): string {
  if (c.companyMatch === 'rejected') return `A source places them at "${c.statedCompany}", not this company.`
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
