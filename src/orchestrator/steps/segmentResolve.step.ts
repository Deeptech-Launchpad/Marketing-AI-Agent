import { resolveAudience } from '../../campaign/audienceResolver.js'
import { getCrm } from '../../crm/index.js'
import { claim, type Claim } from '../../domain/provenance.js'
import { audit } from '../../platform/audit.js'
import { prisma, newId } from '../../platform/db.js'
import { BadRequestError } from '../../platform/errors.js'
import type { StepHandler } from './types.js'

// Executes the proposed filters and materialises an immutable audience.
//
// NO LLM RUNS IN THIS STEP. The model proposed the filters; resolving them,
// applying suppression and capping the result is deterministic code. That
// separation is what makes the resulting audience defensible — and it means a
// model that was talked into something in an earlier step still cannot change
// who ends up on the list.

export const segmentResolveStep: StepHandler = async (ctx) => {
  const crm = getCrm()
  const proposal = await ctx.prior<{
    query: Record<string, unknown>
    rationale: string
    concept: string | null
    mappingStatus: string
    requiresApproval: boolean
    icpSufficient: boolean
    conceptMapping: { applied?: string[]; status?: string } | null
  }>('SEGMENT_PROPOSE')
  if (!proposal?.query) throw new BadRequestError('No segment proposal is available to resolve.')

  const query = proposal.query as unknown as Record<string, unknown>

  const segmentId = newId()
  await prisma.segment.create({
    data: {
      id: segmentId,
      tenantId: ctx.run.tenantId,
      campaignId: ctx.run.campaignId,
      name: `Segment for run ${ctx.run.id.slice(0, 8)}`,
      // Stored verbatim so the audience is reproducible months from now.
      definition: query as never,
      rationale: proposal.rationale ?? null,
    },
  })

  const resolved = await resolveAudience({
    tenantId: ctx.run.tenantId,
    segmentId,
    campaignId: ctx.run.campaignId,
    query: query as never,
    crm,
  })

  // Reading the customer base is exactly the kind of access that needs to be
  // answerable later.
  await audit({
    tenantId: ctx.run.tenantId,
    actorType: 'agent',
    runId: ctx.run.id,
    action: 'audience.resolved',
    resourceType: 'AudienceSnapshot',
    resourceId: resolved.snapshotId,
    dataClass: 'customer_pii',
    summary: `matched ${resolved.totalMatched}, suppressed ${resolved.totalSuppressed}, included ${resolved.totalIncluded}`,
  })

  const applied = (query.industries as string[] | undefined) ?? []
  const provenance: Claim[] = [
    proposal.concept
      ? claim('user_intent', `Audience requested for the concept "${proposal.concept}".`)
      : claim('user_intent', 'No targeting concept was supplied.'),
    claim(
      'crm_data',
      applied.length
        ? `Industry filter applied: ${applied.join(', ')}.`
        : 'No industry filter was applied — the concept mapped to nothing in the CRM vocabulary.',
    ),
    claim(
      'crm_data',
      `${resolved.totalMatched} companies matched in NXT Sales; ${resolved.totalSuppressed} suppressed; ` +
        `${resolved.totalIncluded} included${resolved.truncated ? ' (capped)' : ''}.`,
    ),
    claim(
      proposal.icpSufficient ? 'crm_data' : 'ai_inference',
      proposal.icpSufficient
        ? 'Selection was narrowed by ICP evidence the CRM could prove.'
        : 'Selection reflects the requested concept only. The CRM could not prove an ICP, so these companies match what was ASKED FOR, not what is known to convert.',
    ),
  ]

  if (resolved.totalMatched === 0) {
    provenance.push(
      claim(
        'crm_data',
        'Zero companies matched. The audience is empty — this is a real result, not a failure to be worked around.',
      ),
    )
  }

  return {
    output: {
      segmentId,
      snapshotId: resolved.snapshotId,
      totalMatched: resolved.totalMatched,
      totalSuppressed: resolved.totalSuppressed,
      totalIncluded: resolved.totalIncluded,
      // Never presented as a complete audience when it is not one.
      truncated: resolved.truncated,
      sample: resolved.sample,
      queryUsed: query,
      concept: proposal.concept,
      appliedIndustries: applied,
      mappingStatus: proposal.mappingStatus,
      requiresApproval: proposal.requiresApproval,
      icpSufficient: proposal.icpSufficient,
      selectionBasis: proposal.icpSufficient ? 'user_intent_narrowed_by_crm_evidence' : 'user_intent_only',
      provenance,
    },
  }
}
