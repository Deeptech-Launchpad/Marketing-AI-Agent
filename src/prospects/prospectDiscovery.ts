import { Prisma } from '@prisma/client'
import { resolveAudience } from '../campaign/audienceResolver.js'
import { mapConceptToIndustries } from '../campaign/conceptMapper.js'
import { getCrm } from '../crm/index.js'
import type { CrmDropdownOption } from '../crm/types.js'
import { claim, type Claim } from '../domain/provenance.js'
import { getLlm } from '../llm/index.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { serializeError } from '../platform/errors.js'
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
}): Promise<{ id: string }> {
  const id = newId()
  await prisma.prospectSearch.create({
    data: {
      id,
      tenantId: input.tenantId,
      objective: input.objective,
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

/** Queue handler. Never throws: failures are recorded on the search row. */
export async function runProspectDiscovery(searchId: string): Promise<void> {
  const search = await prisma.prospectSearch.findUnique({ where: { id: searchId } })
  if (!search) return
  if (search.status === 'completed') return

  const log = logger.child({ searchId })
  const crm = getCrm()
  const llm = getLlm()

  try {
    await prisma.prospectSearch.update({
      where: { id: searchId },
      data: { status: 'running', error: Prisma.DbNull },
    })

    const provenance: Claim[] = [claim('user_intent', `Objective as stated: "${search.objective}"`)]

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

    // ── 2. Read the CRM's own vocabulary ────────────────────────────────────
    const [industryOptions, countryOptions] = await Promise.all([
      crm.getDropdownOptions('company.industry').catch(() => [] as CrmDropdownOption[]),
      crm.getDropdownOptions('company.country').catch(() => [] as CrmDropdownOption[]),
    ])
    const industryVocab = industryOptions.map((o) => o.value).filter(Boolean)
    const countryVocab = countryOptions.map((o) => o.value).filter(Boolean)
    provenance.push(
      claim('crm_data', `CRM vocabulary: ${industryVocab.length} industries, ${countryVocab.length} countries.`),
    )

    // ── 3. Resolve the concept against that vocabulary ──────────────────────
    const mapping = parsed.targetConcept
      ? await mapConceptToIndustries({
          concept: parsed.targetConcept,
          vocabulary: industryVocab,
          llm,
          tenantId: search.tenantId,
        })
      : null

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

    // ── 5. Build the query and resolve ──────────────────────────────────────
    const query = {
      industries: mapping?.applied ?? [],
      countries: geo.matched,
      cmsValues: [] as string[],
      leadStatuses: [] as string[],
      // Companies with an open opportunity belong to sales, unless asked for.
      hasDeal: parsed.includeExistingOpportunities ? undefined : false,
    }

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

    const resolved = await resolveAudience({
      tenantId: search.tenantId,
      segmentId,
      query: query as never,
      crm,
      limit: parsed.requestedCount ?? undefined,
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
    log.error({ err }, 'prospect search failed')
    await prisma.prospectSearch
      .update({
        where: { id: searchId },
        data: { status: 'failed', error: serializeError(err) as never, finishedAt: new Date() },
      })
      .catch(() => undefined)
  }
}
