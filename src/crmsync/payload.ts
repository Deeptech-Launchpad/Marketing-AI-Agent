import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { prisma } from '../platform/db.js'
import { engagementSummary } from '../engagement/timeline.js'
import { ENGAGEMENT_EVENT_TYPES, EVENT_ACTOR } from '../engagement/types.js'
import { externalKey, MAPPING_VERSION, PAYLOAD_VERSION } from './mapping.js'
import type { CrmSyncPayload } from './types.js'

// TASK #986 — assembling the handoff package.
//
// DATA MINIMISATION IS THE POINT OF THIS FILE.
//
// The Marketing AI platform knows a great deal that a CRM has no business
// holding: raw provider payloads, session hashes, hashed IPs, per-page
// observations, PDF bytes, internal debug state. None of it comes through
// here. What does come through is what a salesperson could act on, plus stable
// REFERENCES back to the records that justify it.
//
// Bounded on purpose: three findings, five contributions, ten recent events.
// An unbounded payload is how a sync turns into a database copy.
//
// Everything is READ. Nothing in this file writes anywhere.

const MAX_FINDINGS = 3
const MAX_CONTRIBUTIONS = 5
const MAX_RECENT_EVENTS = 10

/** Engagement acts worth counting for a salesperson, in a stable order. */
const SUMMARY_KEYS: Array<[string, string]> = [
  ['workbench_link_opened', 'workbenchLinkOpens'],
  ['workbench_registration_completed', 'registrations'],
  ['workbench_viewed', 'workbenchViews'],
  ['workbench_before_viewed', 'beforeViews'],
  ['workbench_after_viewed', 'afterViews'],
  ['workbench_comparison_used', 'comparisonUses'],
  ['workbench_evidence_viewed', 'evidenceViews'],
  ['workbench_cta_clicked', 'ctaClicks'],
  ['audit_report_qr_scanned', 'qrScans'],
  ['email_opened', 'emailOpens'],
  ['email_clicked', 'emailClicks'],
]

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

export interface PayloadContext {
  tenantId: string
  qualificationId: string
}

export interface BuiltPayload {
  payload: CrmSyncPayload
  /** Records the payload was assembled from, for validation to check. */
  refs: {
    crmCompanyId: string
    intentScoreId: string | null
    intentScoreSnapshotId: string | null
    auditRunId: string | null
    auditReportId: string | null
    workbenchDemoId: string | null
    outreachCampaignId: string | null
    followUpTaskId: string | null
    decisionMakerId: string | null
  }
}

/**
 * Builds the CRM package for one qualification.
 *
 * Returns null when the qualification does not exist for this tenant — the
 * tenant check is a WHERE clause, not an assertion after the fact, so a
 * qualification id from another tenant simply resolves to nothing.
 */
export async function buildPayload(ctx: PayloadContext): Promise<BuiltPayload | null> {
  const q = await prisma.salesQualification.findFirst({
    where: { id: ctx.qualificationId, tenantId: ctx.tenantId },
  })
  if (!q) return null

  // The APPROVED REPORT anchors the package.
  //
  // It is the evidence a human reviewed, and the thing that licensed every
  // downstream stage. Taking the newest audit run instead produced a package
  // that mixed findings from one audit with a report from another — which
  // validation correctly refused, because it is not one coherent story.
  const report = await prisma.auditReport.findFirst({
    where: { tenantId: ctx.tenantId, crmCompanyId: q.crmCompanyId, status: 'approved' },
    orderBy: { reviewedAt: 'desc' },
  })

  const [score, run, demo, campaign, task, decisionMaker, summary] = await Promise.all([
    prisma.intentScore.findUnique({
      where: { tenantId_crmCompanyId: { tenantId: ctx.tenantId, crmCompanyId: q.crmCompanyId } },
    }),
    // The run the approved report came from. Only when there is no approved
    // report at all does this fall back — and validation blocks that case.
    report
      ? prisma.websiteAuditRun.findFirst({ where: { id: report.auditRunId, tenantId: ctx.tenantId } })
      : prisma.websiteAuditRun.findFirst({
          where: { tenantId: ctx.tenantId, crmCompanyId: q.crmCompanyId },
          orderBy: { createdAt: 'desc' },
        }),
    // Prefer the demonstration built from that same audit; otherwise the most
    // recent one, whose details are then withheld as a mismatch.
    report
      ? prisma.workbenchDemo
          .findFirst({ where: { tenantId: ctx.tenantId, auditRunId: report.auditRunId } })
          .then(
            (d) =>
              d ??
              prisma.workbenchDemo.findFirst({
                where: { tenantId: ctx.tenantId, crmCompanyId: q.crmCompanyId },
                orderBy: { generatedAt: 'desc' },
              }),
          )
      : prisma.workbenchDemo.findFirst({
          where: { tenantId: ctx.tenantId, crmCompanyId: q.crmCompanyId },
          orderBy: { generatedAt: 'desc' },
        }),
    prisma.outreachCampaign.findFirst({
      // Test rehearsals are never handed to the CRM.
      where: { tenantId: ctx.tenantId, crmCompanyId: q.crmCompanyId, isTest: false },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.salesFollowUpTask.findFirst({
      where: { tenantId: ctx.tenantId, qualificationId: q.id },
      orderBy: { createdAt: 'desc' },
    }),
    // Only from the LATEST completed discovery run: every run has its own rank
    // 1, so ordering by rank across runs could pick a stale run's person.
    prisma.decisionMakerRun
      .findFirst({
        where: { tenantId: ctx.tenantId, crmCompanyId: q.crmCompanyId, status: 'completed' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      .then((latestDmRun) =>
        latestDmRun
          ? prisma.decisionMakerCandidate.findFirst({
              where: { tenantId: ctx.tenantId, dmRunId: latestDmRun.id, outcome: 'shortlisted' },
              orderBy: { rank: 'asc' },
            })
          : null,
      ),
    engagementSummary(ctx.tenantId, q.crmCompanyId),
  ])

  // The company comes from the CRM itself, so the package describes the record
  // the CRM already holds rather than our copy of it.
  let company: Awaited<ReturnType<ReturnType<typeof getCrm>['getCompany']>> = null
  try {
    company = await getCrm().getCompany(q.crmCompanyId)
  } catch {
    // Left null; validation refuses the sync rather than inventing a company.
  }

  const contributions = score?.latestSnapshotId
    ? await prisma.intentScoreContribution.findMany({
        where: { snapshotId: score.latestSnapshotId, adjustedPoints: { gt: 0 } },
        orderBy: [{ adjustedPoints: 'desc' }, { occurredAt: 'desc' }],
        take: MAX_CONTRIBUTIONS,
      })
    : []

  const findings = run
    ? await prisma.catalogFinding.findMany({
        where: { auditRunId: run.id },
        orderBy: [{ affectedCount: 'desc' }],
        take: MAX_FINDINGS,
      })
    : []

  // PROSPECT acts only.
  //
  // A salesperson reading "latest engagement" will take it as something the
  // prospect did. Including our own outreach lifecycle events made the newest
  // entry `outreach_action_blocked`, which is an act of ours — exactly the
  // conflation Tasks #983 to #985 were careful to avoid. Our activity is in
  // the outreach section, where it belongs.
  const prospectEventTypes = ENGAGEMENT_EVENT_TYPES.filter((t) => EVENT_ACTOR[t] === 'prospect')
  const recentEvents = await prisma.engagementEvent.findMany({
    where: {
      tenantId: ctx.tenantId,
      crmCompanyId: q.crmCompanyId,
      eventType: { in: prospectEventTypes as unknown as string[] },
    },
    orderBy: { occurredAt: 'desc' },
    take: MAX_RECENT_EVENTS,
    select: { id: true, eventType: true, channel: true, occurredAt: true },
  })

  // Channels where the PROSPECT was observed, for the same reason.
  const prospectChannels = [
    ...new Set(
      (
        await prisma.engagementEvent.findMany({
          where: {
            tenantId: ctx.tenantId,
            crmCompanyId: q.crmCompanyId,
            eventType: { in: prospectEventTypes as unknown as string[] },
          },
          select: { channel: true },
          distinct: ['channel'],
        })
      ).map((e) => e.channel),
    ),
  ].sort()

  const actions = campaign
    ? await prisma.outreachAction.findMany({
        where: { campaignId: campaign.id },
        orderBy: [{ stepNumber: 'asc' }],
        take: 10,
        select: {
          channel: true,
          stepNumber: true,
          status: true,
          providerStatus: true,
          scheduledAt: true,
          sentAt: true,
          statusReason: true,
        },
      })
    : []

  // Approval lives on the REPORT (`approvedRevision`), not on the revision
  // itself — so the approved revision is fetched by the number the report
  // points at rather than by a status the revision does not carry.
  const approvedRevision =
    report?.approvedRevision != null
      ? await prisma.auditReportRevision.findFirst({
          where: { auditReportId: report.id, revisionNumber: report.approvedRevision },
          select: { revisionNumber: true, createdAt: true },
        })
      : null

  const summaryCounts: Record<string, number> = {}
  for (const [eventType, label] of SUMMARY_KEYS) {
    const n = summary.byEventType[eventType] ?? 0
    if (n > 0) summaryCounts[label] = n
  }

  const payload: CrmSyncPayload = {
    payloadVersion: PAYLOAD_VERSION,
    mappingVersion: MAPPING_VERSION,
    generatedAt: new Date().toISOString(),
    externalKey: externalKey(ctx.tenantId, q.crmCompanyId, q.id),

    company: {
      crmCompanyId: q.crmCompanyId,
      name: company?.name ?? q.companyName ?? q.crmCompanyId,
      website: company?.endPdpUrl ?? run?.startUrl ?? null,
      domain: company?.domain ?? run?.rootHost ?? null,
      industry: company?.industry ?? null,
      country: company?.country ?? null,
    },

    contact: {
      // Task #978 shortlisted nobody for most companies, and a null here is
      // the honest answer rather than a guessed name.
      name: decisionMaker?.fullName ?? null,
      title: decisionMaker?.rawTitle ?? null,
      roleGroup: decisionMaker?.roleGroup ?? null,
      email: decisionMaker?.email ?? null,
      phone: decisionMaker?.phone ?? null,
      linkedInUrl: decisionMaker?.profileUrl ?? null,
      contactability: decisionMaker?.contactability ?? 'none',
      evidenceNote: decisionMaker
        ? `Verified through Task #978 with ${decisionMaker.confidence} confidence.`
        : 'No decision maker was verified for this company.',
      decisionMakerRef: decisionMaker?.id ?? null,
    },

    qualification: {
      status: q.status,
      scoreAtQualification: q.scoreAtQualification,
      threshold: q.thresholdAtQualification,
      aboveThreshold: q.differenceAtQualification,
      reason: q.reason,
      policyVersion: q.qualificationPolicyVersion,
      policyStatus: 'provisional',
      engineVersion: q.qualificationEngineVersion,
      qualifiedAt: iso(q.qualifiedAt),
      qualificationRef: q.id,
    },

    intent: {
      score: score?.normalizedScore ?? q.scoreAtQualification,
      level: score?.level ?? 'unknown',
      scorePolicyVersion: q.scorePolicyVersion,
      scorePolicyStatus: score?.policyStatus ?? 'provisional',
      calculationVersion: q.scoreCalculationVersion,
      evaluatedAt: (iso(q.scoreEvaluatedAt) ?? new Date(0).toISOString()),
      topContributions: contributions.map((c) => ({
        eventType: c.eventType,
        channel: c.channel,
        points: c.adjustedPoints,
        occurredAt: c.occurredAt.toISOString(),
        engagementEventRef: c.engagementEventId,
      })),
    },

    engagement: {
      latestEvent: recentEvents[0]?.eventType ?? null,
      latestEventAt: iso(recentEvents[0]?.occurredAt ?? null),
      firstEventAt: iso(summary.firstEventAt),
      // Prospect acts only. Our own outreach activity is not their engagement.
      totalProspectActions: summary.prospectEvents,
      distinctVisits: summary.distinctSessions,
      channelsObserved: prospectChannels,
      summary: summaryCounts,
      recentEvents: recentEvents.map((e) => ({
        eventType: e.eventType,
        channel: e.channel,
        occurredAt: e.occurredAt.toISOString(),
        engagementEventRef: e.id,
      })),
    },

    audit: {
      auditRunRef: run?.id ?? '',
      auditDate: iso(report?.auditDate ?? run?.createdAt ?? null),
      status: report?.status ?? run?.status ?? 'unknown',
      approvedRevision: approvedRevision?.revisionNumber ?? report?.approvedRevision ?? null,
      approvedAt: iso(approvedRevision?.createdAt ?? null),
      pagesInspected: report?.pagesInspected ?? run?.pagesFetched ?? 0,
      productPagesInspected: report?.productPagesInspected ?? run?.productPages ?? 0,
      // The sample-scoped sentences exactly as Task #979 wrote them. No PDF
      // bytes: the report binary stays where it was generated.
      topFindings: findings.map((f) => ({
        title: f.title,
        priority: f.priority,
        metric: f.metric,
        findingRef: f.id,
        sourceUrl: ((f.evidence ?? []) as Array<{ sourceUrl?: string }>)[0]?.sourceUrl ?? null,
      })),
    },

    workbench: {
      demoRef: demo?.id ?? null,
      status: demo?.status ?? null,
      productName: demo?.productName ?? null,
      // Withheld unless policy explicitly allows it — the link is a bearer
      // credential, and a shared CRM field is a wide audience for one.
      publicUrl: null,
      registered: false,
      observedFieldCount: demo?.observedFieldCount ?? null,
      totalFieldCount: demo?.totalFieldCount ?? null,
    },

    outreach: {
      campaignRef: campaign?.id ?? null,
      startedAt: iso(campaign?.startsAt ?? null),
      dryRun: campaign?.dryRun ?? null,
      // Status verbatim. A blocked or drafted action is never presented as sent.
      actions: actions.map((a) => ({
        channel: a.channel,
        stepNumber: a.stepNumber,
        status: a.status,
        providerStatus: a.providerStatus,
        scheduledAt: iso(a.scheduledAt),
        sentAt: iso(a.sentAt),
        statusReason: a.statusReason,
      })),
      lastSentAt: iso(actions.filter((a) => a.sentAt).sort((x, y) => (y.sentAt!.getTime() - x.sentAt!.getTime()))[0]?.sentAt ?? null),
    },

    followUp: {
      taskRef: task?.id ?? null,
      ownerName: q.ownerName,
      ownerCrmUserId: q.ownerCrmUserId,
      dueAt: iso(task?.dueAt ?? q.dueAt),
      slaMinutes: task?.slaMinutes ?? null,
      status: task?.status ?? q.taskStatus,
      completionStatus: task?.completionStatus ?? null,
      recommendedAction: task?.recommendedAction ?? null,
    },

    notes: [
      'The intent score and the qualification threshold are PROVISIONAL and have not been approved by the business.',
      'A high-intent lead means observed engagement crossed a chosen threshold. It is not a prediction that the company will buy.',
      'Audit figures describe the pages that were inspected, not the whole catalogue.',
      'Outreach action statuses are verbatim. A blocked or drafted action was not sent.',
    ],
  }

  // Workbench details are only included when the demo belongs to the SAME
  // audit run as the rest of this package — see validation.
  if (demo && run && demo.auditRunId === run.id) {
    payload.workbench.registered = await prisma.workbenchVisitor
      .count({ where: { demoId: demo.id } })
      .then((n) => n > 0)
    if (env.CRM_SYNC_INCLUDE_WORKBENCH_LINK) {
      payload.workbench.publicUrl = `${env.WORKBENCH_PUBLIC_BASE_URL.replace(/\/+$/, '')}/workbench/(link withheld — mint a scoped link before sharing)`
    }
  }

  return {
    payload,
    refs: {
      crmCompanyId: q.crmCompanyId,
      intentScoreId: score?.id ?? null,
      intentScoreSnapshotId: score?.latestSnapshotId ?? null,
      auditRunId: run?.id ?? null,
      auditReportId: report?.id ?? null,
      workbenchDemoId: demo?.id ?? null,
      outreachCampaignId: campaign?.id ?? null,
      followUpTaskId: task?.id ?? null,
      decisionMakerId: decisionMaker?.id ?? null,
    },
  }
}
