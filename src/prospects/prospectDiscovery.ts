import { Prisma } from '@prisma/client'
import { resolveAudience } from '../campaign/audienceResolver.js'
import { mapConceptToIndustries, type ConceptMapping } from '../campaign/conceptMapper.js'
import { getCrm } from '../crm/index.js'
import type { CrmDropdownOption } from '../crm/types.js'
import { claim, type Claim } from '../domain/provenance.js'
import { getLlm } from '../llm/index.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { AppError, serializeError } from '../platform/errors.js'
import { parseProspectObjective, resolveGeography } from './objectiveParser.js'

// STAGE 1 — FIND PROSPECTS.
//
// Discovery only. It answers "which companies already in the CRM match what the
// user asked for", and nothing else. It does not enrich, score, audit, contact,
// or write anything back.
//
// It is assembled almost entirely from parts that already existed:
//   conceptMapper      - user's word -> real CRM industry vocabulary
//   audienceResolver   - query -> suppression -> cap -> immutable snapshot
//   suppressionService - do-not-contact and open-opportunity exclusion
//   CrmPort            - read-only; it has no write methods to misuse
//
// Two guarantees hold structurally rather than by convention:
//
//   No invented companies. Every prospect is a row the CRM returned. Nothing
//   here can synthesise one, because the only source of companies is
//   crm.exportCompanies.
//
//   No unverified problem claims. A stated need ("may need product-data
//   improvement") is recorded as a hypothesis attached to the SEARCH, never to
//   a company, and is applied to no filter. Testing it is a later stage's job.

export async function startProspectSearch(input: {
  tenantId: string
  objective: string
  requestedByCrmUserId: string
  /** How many companies to return. Overrides the count read from the wording. */
  requestedCount?: number | null
}): Promise<{ id: string }> {
  const id = newId()
  await prisma.prospectSearch.create({
    data: {
      id,
      tenantId: input.tenantId,
      objective: input.objective,
      requestedCount: input.requestedCount ?? null,
      requestedByCrmUserId: input.requestedByCrmUserId,
      status: 'queued',
    },
  })
  await audit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorCrmUserId: input.requestedByCrmUserId,
    action: 'prospect_search.started',
    resourceType: 'ProspectSearch',
    resourceId: id,
    summary: input.objective,
  })
  return { id }
}

/**
 * How long an identical queued/running search is treated as "the same request".
 * Bounded so a search stuck behind a dead worker does not block a retry forever.
 */
export const IN_FLIGHT_REUSE_WINDOW_MS = 10 * 60_000

/**
 * Starts a search and hands it to the queue — or returns the identical search
 * already in flight.
 *
 * Two guarantees the route cannot give on its own:
 *  - A double-click (or a second tab) does not run the same objective twice;
 *    the in-flight search is returned instead.
 *  - A search whose enqueue fails does not sit 'queued' forever: the row is
 *    marked failed with the reason, and the error is rethrown to the caller.
 */
export async function queueProspectSearch(input: {
  tenantId: string
  objective: string
  requestedByCrmUserId: string
  requestedCount?: number | null
  enqueue: (searchId: string) => Promise<unknown>
  now?: Date
}): Promise<{ id: string; status: string; reused: boolean }> {
  const objective = input.objective.trim()
  const requestedCount = input.requestedCount ?? null
  const since = new Date((input.now ?? new Date()).getTime() - IN_FLIGHT_REUSE_WINDOW_MS)

  const existing = await prisma.prospectSearch.findFirst({
    where: {
      tenantId: input.tenantId,
      objective,
      requestedCount,
      status: { in: ['queued', 'running'] },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  })
  if (existing) return { id: existing.id, status: existing.status, reused: true }

  const { id } = await startProspectSearch({
    tenantId: input.tenantId,
    objective,
    requestedCount,
    requestedByCrmUserId: input.requestedByCrmUserId,
  })

  try {
    await input.enqueue(id)
  } catch (err) {
    logger.error({ err, searchId: id }, 'prospect search could not be queued')
    const reason = err instanceof Error ? err.message : String(err)
    await prisma.prospectSearch
      .update({
        where: { id },
        data: {
          status: 'failed',
          error: {
            name: 'EnqueueFailed',
            code: 'enqueue_failed',
            message: `The search could not be handed to the worker queue, so it never ran: ${reason}`,
          } as never,
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined)
    throw err
  }

  return { id, status: 'queued', reused: false }
}

/**
 * A search that cannot be run honestly. Raised BEFORE any CRM export, so the
 * alternative — running the export without the filter that could not be
 * resolved, and returning companies the user did not ask for — never happens.
 */
export class ProspectSearchUnresolvableError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, 'objective_unresolved', message, details)
  }
}

async function readVocabulary(
  read: () => Promise<CrmDropdownOption[]>,
): Promise<{ values: string[]; error: string | null }> {
  try {
    const options = await read()
    return { values: options.map((o) => o.value).filter(Boolean), error: null }
  } catch (err) {
    return { values: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** A few real CRM values, so a failure message shows what CAN be matched. */
function sampleValues(values: string[], n = 8): string {
  if (!values.length) return ''
  const shown = values.slice(0, n).map((v) => `"${v}"`).join(', ')
  return values.length > n ? `${shown}, and ${values.length - n} more` : shown
}

/** Queue handler. Never throws: failures are recorded on the search row. */
export async function runProspectDiscovery(searchId: string): Promise<void> {
  const search = await prisma.prospectSearch.findUnique({ where: { id: searchId } })
  if (!search) return
  if (search.status === 'completed') return

  const log = logger.child({ searchId })
  const crm = getCrm()
  const llm = getLlm()

  // Declared outside the try so a search that stops early still records what
  // was understood and why it stopped.
  const provenance: Claim[] = [claim('user_intent', `Objective as stated: "${search.objective}"`)]
  let parsedForRow: unknown = undefined
  let mappingForRow: ConceptMapping | null = null

  try {
    await prisma.prospectSearch.update({
      where: { id: searchId },
      data: { status: 'running', error: Prisma.DbNull },
    })

    // ── 1. Parse the objective ──────────────────────────────────────────────
    const parsed = await parseProspectObjective({
      objective: search.objective,
      llm,
      tenantId: search.tenantId,
      searchId,
    })

    if (parsed.targetConcept) {
      provenance.push(claim('user_intent', `Targeting concept: "${parsed.targetConcept}"`))
    }
    if (parsed.requestedCount) {
      provenance.push(claim('user_intent', `Requested up to ${parsed.requestedCount} prospects.`))
    }
    if (parsed.geography.length) {
      provenance.push(claim('user_intent', `Geography requested: ${parsed.geography.join(', ')}`))
    }
    if (parsed.statedNeedHypothesis) {
      // The load-bearing disclaimer for requirement 8.
      provenance.push(
        claim('user_intent', `Stated hypothesis about these companies: "${parsed.statedNeedHypothesis}"`),
      )
      provenance.push(
        claim(
          'ai_inference',
          'This hypothesis was NOT used to select anyone and has NOT been verified against any company. ' +
            'No prospect below is claimed to have this problem.',
        ),
      )
    }
    parsed.companyCharacteristics.forEach((c) =>
      provenance.push(claim('user_intent', `Stated characteristic: "${c}"`)),
    )
    parsed.ambiguities.forEach((a) => provenance.push(claim('ai_inference', `Unspecified by the user: ${a}`)))

    parsedForRow = parsed

    // ── 2. Read the CRM's own vocabulary ────────────────────────────────────
    // A failed read is NOT an empty vocabulary. Treating it as one used to let
    // the concept go unmapped and the export run with no industry filter —
    // returning the whole CRM for a specific request.
    const [industryRead, countryRead] = await Promise.all([
      readVocabulary(() => crm.getDropdownOptions('company.industry')),
      readVocabulary(() => crm.getDropdownOptions('company.country')),
    ])
    const industryVocab = industryRead.values
    const countryVocab = countryRead.values
    provenance.push(
      claim('crm_data', `CRM vocabulary: ${industryVocab.length} industries, ${countryVocab.length} countries.`),
    )

    if (parsed.targetConcept && industryRead.error) {
      throw new ProspectSearchUnresolvableError(
        `Could not read the list of industries from NXT Sales (${industryRead.error}), so "${parsed.targetConcept}" ` +
          'could not be matched to any industry. No search was run, because running it without an industry filter ' +
          'would return companies of every industry. Try again once the CRM is reachable.',
        { stage: 'industry_vocabulary', reason: industryRead.error },
      )
    }
    if (parsed.geography.length && countryRead.error) {
      throw new ProspectSearchUnresolvableError(
        `Could not read the list of countries from NXT Sales (${countryRead.error}), so ${parsed.geography
          .map((g) => `"${g}"`)
          .join(', ')} could not be matched. No search was run, because running it without a country filter ` +
          'would return companies from every country. Try again once the CRM is reachable.',
        { stage: 'country_vocabulary', reason: countryRead.error },
      )
    }

    // ── 3. Resolve the concept against that vocabulary ──────────────────────
    const mapping = parsed.targetConcept
      ? await mapConceptToIndustries({
          concept: parsed.targetConcept,
          vocabulary: industryVocab,
          llm,
          tenantId: search.tenantId,
        })
      : null
    mappingForRow = mapping

    if (mapping) {
      provenance.push(claim('ai_inference', `Interpretation: ${mapping.interpretation}`))
      provenance.push(claim('ai_inference', mapping.note))
      mapping.direct.forEach((d) => provenance.push(claim('ai_inference', `Direct match "${d.value}" — ${d.reason}`)))
      mapping.related.forEach((r) =>
        provenance.push(claim('ai_inference', `Adjacent candidate "${r.value}" — ${r.reason}`)),
      )
      if (mapping.rejected.length) {
        provenance.push(
          claim(
            'crm_data',
            `Discarded ${mapping.rejected.length} proposed value(s) absent from the CRM vocabulary: ${mapping.rejected.join(', ')}.`,
          ),
        )
      }
    } else {
      provenance.push(claim('user_intent', 'No targeting concept was named, so no industry filter was applied.'))
    }

    // A named concept that maps to nothing must stop the search. Continuing
    // would apply no industry filter at all and return every company in the
    // CRM as if it matched what was asked for.
    if (mapping && mapping.applied.length === 0) {
      const vocabHint = industryVocab.length
        ? ` Industries NXT Sales holds include ${sampleValues(industryVocab)}.`
        : ''
      throw new ProspectSearchUnresolvableError(
        (industryVocab.length
          ? `"${mapping.concept}" could not be matched to any of the ${industryVocab.length} industries in NXT Sales.`
          : `NXT Sales returned no industry list, so "${mapping.concept}" could not be matched to any industry.`) +
          ' No search was run, because running it without an industry filter would return companies of every industry.' +
          ` Rephrase the objective using the kind of business the CRM records.${vocabHint}`,
        { stage: 'concept_mapping', concept: mapping.concept, mappingStatus: mapping.status },
      )
    }

    // ── 4. Geography ────────────────────────────────────────────────────────
    const geo = resolveGeography(parsed.geography, countryVocab)
    if (geo.matched.length) {
      provenance.push(claim('crm_data', `Geography resolved to CRM values: ${geo.matched.join(', ')}.`))
    }
    geo.unmatched.forEach((u) =>
      provenance.push(
        claim('crm_data', `Geography term "${u}" matched no CRM country value; it was NOT applied as a filter.`),
      ),
    )
    // Same rule for geography: if a place was named and NONE of it resolved,
    // dropping the filter would widen the search to every country. A partial
    // match narrows rather than widens, so it proceeds with the gap recorded.
    if (parsed.geography.length && geo.unmatched.length && !geo.matched.length) {
      const countryHint = countryVocab.length ? ` Countries NXT Sales holds include ${sampleValues(countryVocab)}.` : ''
      throw new ProspectSearchUnresolvableError(
        `${geo.unmatched.map((u) => `"${u}"`).join(', ')} could not be matched to any country in NXT Sales. ` +
          'No search was run, because running it without a country filter would return companies from every country. ' +
          `Rephrase the objective naming a country.${countryHint}`,
        { stage: 'geography', unmatched: geo.unmatched },
      )
    }

    // ── 5. Build the query and resolve ──────────────────────────────────────
    // No hasDeal filter: NXT Sales' hasDeal='no' excludes companies with ANY
    // deal, won and lost included. Open opportunities are excluded precisely by
    // the resolver's suppression instead, and kept when the user asked for them.
    const includeOpenDeals = parsed.includeExistingOpportunities === true
    const query = {
      industries: mapping?.applied ?? [],
      countries: geo.matched,
      cmsValues: [] as string[],
      leadStatuses: [] as string[],
    }
    provenance.push(
      claim(
        'user_intent',
        includeOpenDeals
          ? 'Companies with an open opportunity were INCLUDED, as the objective asked for existing opportunities.'
          : 'Companies with an open opportunity were excluded — they belong to sales.',
      ),
    )

    const segmentId = newId()
    await prisma.segment.create({
      data: {
        id: segmentId,
        tenantId: search.tenantId,
        name: `Prospect search: ${search.objective.slice(0, 60)}`,
        definition: query as never,
        rationale: mapping?.note ?? 'No targeting concept supplied.',
      },
    })

    // How many to return, and on whose authority.
    //
    // The operator's number wins. Before this the only source was the count
    // the parser read out of the objective, so "find a cleaning supplier in
    // Malta" returned exactly one company — a defensible reading of the
    // sentence and the wrong answer to the question. Which rule applied is
    // recorded, because a list of one and a list of fifty are different
    // results and the reason has to be legible afterwards.
    const limit = search.requestedCount ?? parsed.requestedCount ?? undefined
    if (search.requestedCount != null) {
      provenance.push(
        claim('user_intent', `Asked for up to ${search.requestedCount} compan${search.requestedCount === 1 ? 'y' : 'ies'} on the search form.`),
      )
      if (parsed.requestedCount != null && parsed.requestedCount !== search.requestedCount) {
        provenance.push(
          claim(
            'user_intent',
            `The objective's own wording reads as a request for ${parsed.requestedCount}; the number stated on the form was used instead.`,
          ),
        )
      }
    } else if (parsed.requestedCount != null) {
      provenance.push(
        claim('ai_inference', `No count was stated on the form; the objective's wording was read as a request for ${parsed.requestedCount}.`),
      )
    }

    const resolved = await resolveAudience({
      tenantId: search.tenantId,
      segmentId,
      query: query as never,
      crm,
      limit,
      includeOpenDeals,
    })

    provenance.push(
      claim(
        'crm_data',
        `${resolved.totalMatched} companies matched in NXT Sales; ${resolved.totalSuppressed} suppressed; ` +
          `${resolved.totalIncluded} returned (cap ${resolved.capApplied}${resolved.truncated ? ', list truncated' : ''}).`,
      ),
    )
    if (resolved.totalMatched === 0) {
      provenance.push(
        claim('crm_data', 'Zero companies matched. The CRM holds no prospects for these criteria — this is a real result.'),
      )
    }
    provenance.push(
      claim(
        'crm_data',
        'Every prospect is an existing NXT Sales company record. No company was generated, inferred, or sourced externally.',
      ),
    )

    await prisma.prospectSearch.update({
      where: { id: searchId },
      data: {
        status: 'completed',
        parsed: parsed as never,
        conceptMapping: (mapping ?? undefined) as never,
        queryUsed: query as never,
        segmentId,
        snapshotId: resolved.snapshotId,
        totalMatched: resolved.totalMatched,
        totalSuppressed: resolved.totalSuppressed,
        totalReturned: resolved.totalIncluded,
        truncated: resolved.truncated,
        mappingStatus: mapping?.status ?? 'no_concept',
        // An ambiguous mapping means the audience rests on an interpretation
        // nobody has confirmed. The flag rides through to whoever reads it.
        requiresApproval: mapping?.requiresApproval ?? false,
        provenance: provenance as never,
        finishedAt: new Date(),
      },
    })

    await audit({
      tenantId: search.tenantId,
      actorType: 'agent',
      action: 'prospect_search.completed',
      resourceType: 'ProspectSearch',
      resourceId: searchId,
      dataClass: 'customer_pii',
      summary: `${resolved.totalIncluded} prospects from ${resolved.totalMatched} matches`,
    })

    log.info({ matched: resolved.totalMatched, returned: resolved.totalIncluded }, 'prospect search completed')
  } catch (err) {
    const unresolvable = err instanceof ProspectSearchUnresolvableError
    if (unresolvable) log.warn({ err }, 'prospect search stopped: objective could not be resolved')
    else log.error({ err }, 'prospect search failed')
    if (unresolvable) {
      provenance.push(claim('crm_data', `Search stopped before querying the CRM: ${err.message}`))
    }
    await prisma.prospectSearch
      .update({
        where: { id: searchId },
        data: {
          status: 'failed',
          error: serializeError(err) as never,
          finishedAt: new Date(),
          // What was understood before stopping, so the failure is legible.
          ...(unresolvable
            ? {
                parsed: (parsedForRow ?? undefined) as never,
                conceptMapping: (mappingForRow ?? undefined) as never,
                mappingStatus: mappingForRow?.status ?? null,
                provenance: provenance as never,
              }
            : {}),
        },
      })
      .catch(() => undefined)
  }
}
