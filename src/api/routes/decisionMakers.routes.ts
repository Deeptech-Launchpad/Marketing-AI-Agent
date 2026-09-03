import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { providerNames, queueDecisionMakerDiscovery } from '../../decisionmakers/discovery.js'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_DM_DISCOVER } from '../../platform/queue.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

// Stage 4 — decision-maker discovery. Read-only against the CRM and the open
// web. No outreach, no CRM write-back, no publishing, no messaging.

export const decisionMakerRoutes = Router()

const MAX_BATCH = 20

const DiscoverBody = z
  .object({
    crmCompanyIds: z.array(z.string().min(1)).min(1).max(MAX_BATCH).optional(),
    prospectSearchId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(MAX_BATCH).optional(),
  })
  .refine((b) => b.crmCompanyIds || b.prospectSearchId, {
    message: 'Provide either crmCompanyIds or prospectSearchId.',
  })

/** Start discovery for one or more companies. */
decisionMakerRoutes.post(
  '/discover',
  requirePermission('operate'),
  validateBody(DiscoverBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof DiscoverBody>

    let ids = body.crmCompanyIds ?? []

    if (body.prospectSearchId) {
      const search = await prisma.prospectSearch.findFirst({
        where: { id: body.prospectSearchId, tenantId: p.tenantId },
        select: { id: true, snapshotId: true },
      })
      if (!search) throw new NotFoundError('Prospect search not found.')
      if (!search.snapshotId) throw new NotFoundError('That prospect search has no audience snapshot yet.')

      const members = await prisma.audienceMember.findMany({
        where: { snapshotId: search.snapshotId },
        orderBy: [{ score: 'desc' }, { companyName: 'asc' }],
        take: body.limit ?? 10,
        select: { crmCompanyId: true },
      })
      ids = members.map((m) => m.crmCompanyId)
    }

    if (!ids.length) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'No companies to process.' } })
    }

    const queued: Array<{ id: string; crmCompanyId: string }> = []
    for (const crmCompanyId of ids.slice(0, MAX_BATCH)) {
      const { id } = await queueDecisionMakerDiscovery({
        tenantId: p.tenantId,
        crmCompanyId,
        requestedByCrmUserId: p.crmUserId,
        prospectSearchId: body.prospectSearchId ?? null,
      })
      await enqueue(QUEUE_DM_DISCOVER, { dmRunId: id })
      queued.push({ id, crmCompanyId })
    }

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'decision_makers.queued',
      resourceType: 'DecisionMakerRun',
      summary: `${queued.length} company/companies queued for decision-maker discovery`,
      requestId: req.requestId,
    })

    res.status(202).json({
      queued: queued.length,
      runs: queued,
      providers: providerNames(),
      contactDataStored: env.DM_STORE_CONTACT_DATA,
    })
  }),
)

/** Status of one discovery run, with its shortlist. */
decisionMakerRoutes.get(
  '/runs/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const run = await prisma.decisionMakerRun.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: {
        candidates: {
          where: { outcome: 'shortlisted' },
          orderBy: { rank: 'asc' },
        },
      },
    })
    if (!run) throw new NotFoundError('Decision-maker run not found.')

    res.json({
      ...run,
      // A run with no candidates must read as a finding, not as a gap.
      summary: run.candidateCount
        ? `${run.candidateCount} candidate(s) shortlisted from ${run.candidateCount + run.excludedCount} person(s) seen.`
        : (run.noResultsReason ?? 'No verified decision maker found.'),
    })
  }),
)

/** All shortlisted candidates for one company, newest run first. */
decisionMakerRoutes.get(
  '/companies/:crmCompanyId/candidates',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const includeExcluded = req.query.includeExcluded === 'true'

    const latestRun = await prisma.decisionMakerRun.findFirst({
      where: { tenantId: p.tenantId, crmCompanyId: req.params.crmCompanyId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
    })

    if (!latestRun) {
      return res.status(404).json({
        error: {
          code: 'not_found',
          message: 'No completed decision-maker discovery run exists for that company yet.',
        },
      })
    }

    const candidates = await prisma.decisionMakerCandidate.findMany({
      where: {
        tenantId: p.tenantId,
        dmRunId: latestRun.id,
        ...(includeExcluded ? {} : { outcome: 'shortlisted' }),
      },
      orderBy: [{ outcome: 'asc' }, { rank: 'asc' }, { rankScore: 'desc' }],
    })

    res.json({
      crmCompanyId: req.params.crmCompanyId,
      companyName: latestRun.companyName,
      runId: latestRun.id,
      discoveredAt: latestRun.completedAt,
      total: candidates.filter((c) => c.outcome === 'shortlisted').length,
      candidates,
      providerResults: latestRun.providerResults,
      noResultsReason: latestRun.noResultsReason,
      disclaimers: [
        'Every field was STATED by a source. A null title, email or profile means no source stated it — nothing here is inferred, pattern-guessed, or completed from a name.',
        'companyMatch describes how the person was tied to this company. Only "verified" means a source proved the employment.',
        'Confidence describes EVIDENCE QUALITY, computed by deterministic rules — not by a model.',
        'An empty list means no candidate could be verified, NOT that the company has no decision maker.',
        'Relevance is decided by job FUNCTION, never by seniority alone: a title has to name a function that owns product or catalog data.',
        'This stage identifies WHO. It does not contact anyone, and it writes nothing back to NXT Sales.',
      ],
    })
  }),
)

/** Plain-language reading of the contactability enum. */
function contactabilityExplanation(value: string): string {
  switch (value) {
    case 'contactable':
      return 'A provider stated a work email or phone number, and it was stored.'
    case 'withheld_by_policy':
      return 'A provider stated contact details, but DM_STORE_CONTACT_DATA is off so they were not stored. This is a policy decision, not a data gap.'
    case 'profile_only':
      return 'No contact details were stated by any source. A public profile URL is available.'
    default:
      return 'No source stated contact details, and no public profile URL was published. Nothing was guessed from the name or the company domain.'
  }
}

/** The full evidence chain behind one candidate. */
decisionMakerRoutes.get(
  '/candidates/:id',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const candidate = await prisma.decisionMakerCandidate.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      include: {
        run: {
          select: {
            id: true,
            companyName: true,
            companyDomain: true,
            status: true,
            providerResults: true,
            completedAt: true,
          },
        },
      },
    })
    if (!candidate) throw new NotFoundError('Candidate not found.')

    const evidence = (candidate.evidence ?? []) as Array<{
      provider: string
      sourceType: string
      sourceUrl: string | null
      snippet: string
      observedAt: string | null
    }>

    res.json({
      ...candidate,
      evidenceChain: {
        whoTheyAre: candidate.fullName,
        whatTheirTitleSays: !candidate.rawTitle
          ? 'No source stated a job title, so relevance could not be established.'
          : candidate.rolePriority === null
            ? `"${candidate.rawTitle}" — normalised to "${candidate.normalizedTitle}", which names no function that owns product or catalog data.`
            : `"${candidate.rawTitle}" — normalised to "${candidate.normalizedTitle}", matched to ${candidate.roleGroup} (Priority ${candidate.rolePriority}).`,
        howWeKnowTheyWorkHere: `${candidate.companyMatch} — ${((candidate.companyMatchReasons ?? []) as string[]).join(' ')}`,
        howStrong: `${candidate.confidence} — ${((candidate.confidenceReasons ?? []) as string[]).join(' ')}`,
        whyRankedHere: ((candidate.rankReasons ?? []) as string[]).join(' '),
        howReachable: contactabilityExplanation(candidate.contactability),
        sources: evidence.map((e) => ({
          provider: e.provider,
          sourceType: e.sourceType,
          whereToCheck: e.sourceUrl ?? `${e.sourceType} (internal record — no public URL)`,
          whenObserved: e.observedAt ?? 'Source provided no date.',
          literalText: e.snippet,
        })),
      },
    })
  }),
)
