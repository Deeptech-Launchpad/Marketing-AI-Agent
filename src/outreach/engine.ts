import { env } from '../config/env.js'
import { syncOutreachActions } from '../engagement/adapters/outreachAdapter.js'
import { getCrm } from '../crm/index.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { ConflictError, NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { mintLink } from '../workbench/links.js'
import { composeFromTemplate, composeMessage } from './personalize.js'
import { CallTaskProvider } from './providers/callTaskProvider.js'
import { EmailFollowUpProvider, EmailProvider } from './providers/emailProvider.js'
import { LinkedInProvider } from './providers/linkedInProvider.js'
import { runProvider, type OutreachProvider } from './providers/provider.js'
import { WhatsAppProvider } from './providers/whatsAppProvider.js'
import { defaultSequence, idempotencyKey, scheduledAtFor, stepIsEligible } from './sequence.js'
import { assertOutreachReady, verifyEmail } from '../emailverification/service.js'
import { discoveredWebsiteDomain } from '../prospects/discoveredCompanyAdapter.js'
import { checkSuppression } from './suppression.js'
import { validateAction, type ValidationOutcome } from './validation.js'
import {
  CHANNEL_LIMITS,
  RETRYABLE_FAILURES,
  TERMINAL_STATUSES,
  type ActionStatus,
  type OutreachChannel,
  type OutreachTarget,
} from './types.js'

// TASK #982 — the outreach engine.
//
// It plans a campaign from approved artifacts, composes each message from
// evidence, and executes what it is permitted to execute. Its default posture
// is to STOP SHORT of sending: composing, validating and scheduling are safe;
// contacting a person is not, and a human releases that.
//
// The engine never fails a campaign because a channel is unavailable. In this
// environment three of five channels have no provider, so a campaign that
// aborted on the first blocked channel would produce nothing at all — instead
// each action records precisely which gate stopped it and the rest carry on.

const PROVIDERS: Record<OutreachChannel, OutreachProvider> = {
  email: new EmailProvider(),
  linkedin: new LinkedInProvider(),
  call: new CallTaskProvider(),
  email_followup: new EmailFollowUpProvider(),
  whatsapp: new WhatsAppProvider(),
}

export function providerFor(channel: OutreachChannel): OutreachProvider {
  return PROVIDERS[channel]
}

/** A snapshot of what every channel can currently do, for the API and reports. */
export function channelStatus(): Array<{
  channel: OutreachChannel
  provider: string
  status: string
  reason?: string
  remediation?: string
}> {
  return (Object.keys(PROVIDERS) as OutreachChannel[]).map((channel) => {
    const p = PROVIDERS[channel]
    const a = p.availability()
    return { channel, provider: p.name, status: a.status, reason: a.reason, remediation: a.remediation }
  })
}

// ── Campaign creation ──────────────────────────────────────────────────────

export interface CreateCampaignInput {
  tenantId: string
  /**
   * Required for the intent-basis path (below). Not required when auditRunId
   * is given — that path derives it from the audit run itself, exactly as it
   * always has.
   */
  crmCompanyId?: string
  /** Set when crmCompanyId is a DiscoveredCompany.id placeholder — see that model. */
  discoveredCompanyId?: string | null
  /**
   * The LEGACY basis. When given, campaign creation is built from this
   * approved audit exactly as it always has been — see createCampaignFromAudit.
   * When absent (the 2026-09-24 restructure's default), the campaign is built
   * from Decision Makers + Intent Signals instead — see createCampaignFromIntent.
   */
  auditRunId?: string
  requestedByCrmUserId: string
  dryRun?: boolean
  startsAt?: Date
}

export interface CreateCampaignResult {
  campaignId: string
  companyName: string | null
  actions: Array<{ id: string; channel: OutreachChannel; stepNumber: number; status: ActionStatus; reason: string | null }>
  decisionMaker: { name: string; title: string | null } | null
  workbenchUrl: string | null
}

/**
 * Plans a campaign — the LEGACY basis, from an APPROVED audit, unchanged.
 * See createCampaignFromIntent for the 2026-09-24 restructure's default path.
 *
 * Every action is created up front with its schedule, its composed message and
 * its validation result, so a reviewer can read the whole sequence before any
 * of it is due. Nothing is executed here.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  if (!input.auditRunId) return createCampaignFromIntent(input)
  return createCampaignFromAudit(input as CreateCampaignInput & { auditRunId: string })
}

async function createCampaignFromAudit(input: CreateCampaignInput & { auditRunId: string }): Promise<CreateCampaignResult> {
  const log = logger.child({ auditRunId: input.auditRunId })

  const report = await prisma.auditReport.findFirst({
    where: { auditRunId: input.auditRunId, tenantId: input.tenantId },
  })
  if (!report) throw new NotFoundError('No audit report exists for that run.')

  // ── The approval gate. External contact needs a human-approved audit. ───
  if (report.status !== 'approved') {
    throw new ConflictError(
      `This report is "${report.status}". Outreach may only be built from a report approved in Task #980.`,
      { status: report.status },
    )
  }

  const run = await prisma.websiteAuditRun.findUniqueOrThrow({ where: { id: input.auditRunId } })
  const company = await getCrm().getCompany(run.crmCompanyId)
  if (!company) throw new NotFoundError('That company no longer exists in NXT Sales.')

  // ── Context: the strongest finding, the decision maker, the Workbench ───
  const findings = await prisma.catalogFinding.findMany({
    where: { auditRunId: input.auditRunId },
    orderBy: [{ affectedCount: 'desc' }],
  })
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 }
  findings.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9))
  const top = findings[0] ?? null

  const topFinding = top
    ? {
        id: top.id,
        title: top.title,
        metric: top.metric,
        finding: top.finding,
        recommendation: top.recommendation,
        sourceUrl: ((top.evidence ?? []) as Array<{ sourceUrl?: string }>)[0]?.sourceUrl ?? null,
      }
    : null

  // Prefer a shortlisted product-data owner; otherwise there is no verified
  // person for the channels that need one, and that is recorded rather than
  // worked around.
  // Only from the LATEST completed discovery run: every run has its own rank 1,
  // so ordering by rank across runs could pick a stale run's person.
  const latestDmRun = await prisma.decisionMakerRun.findFirst({
    where: { tenantId: input.tenantId, crmCompanyId: run.crmCompanyId, status: 'completed' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  const decisionMaker = latestDmRun
    ? await prisma.decisionMakerCandidate.findFirst({
        where: { tenantId: input.tenantId, dmRunId: latestDmRun.id, outcome: 'shortlisted' },
        orderBy: { rank: 'asc' },
      })
    : null

  const demo = await prisma.workbenchDemo.findFirst({
    where: { tenantId: input.tenantId, auditRunId: input.auditRunId, status: 'ready' },
  })
  // The campaign mints its OWN Workbench link rather than reusing an existing
  // one. Task #981 stores only a hash, so an existing link's URL cannot be
  // rebuilt — and a campaign-owned link is better anyway: it is scoped to this
  // outreach, expires with it, and can be revoked without breaking a link that
  // was shared some other way.
  //
  // The URL does end up stored in plaintext on the message, because a message
  // that carries a link has to contain it. That is why the link is narrow:
  // one demo, expiring, revocable, and carrying no internal identifier.
  const workbenchUrl = demo
    ? (
        await mintLink({
          tenantId: input.tenantId,
          demoId: demo.id,
          createdByCrmUserId: input.requestedByCrmUserId,
          label: `Outreach campaign for ${run.companyName ?? run.crmCompanyId}`,
        })
      ).url
    : null

  const intentSignals = await prisma.intentSignal.findMany({
    where: { tenantId: input.tenantId, crmCompanyId: run.crmCompanyId, status: 'active' },
    orderBy: { detectedAt: 'desc' },
    take: 3,
    select: { id: true, summary: true, sourceUrl: true },
  })

  const startsAt = input.startsAt ?? new Date()
  const dryRun = input.dryRun ?? env.OUTREACH_DEFAULT_DRY_RUN

  const campaignId = newId()
  await prisma.outreachCampaign.create({
    data: {
      id: campaignId,
      tenantId: input.tenantId,
      crmCompanyId: run.crmCompanyId,
      companyName: run.companyName,
      companyDomain: run.rootHost,
      auditRunId: input.auditRunId,
      auditReportId: report.id,
      decisionMakerId: decisionMaker?.id ?? null,
      workbenchDemoId: demo?.id ?? null,
      status: 'active',
      autoSendEnabled: env.OUTREACH_AUTO_SEND,
      dryRun,
      startsAt,
      requestedByCrmUserId: input.requestedByCrmUserId,
    },
  })

  const definitions = defaultSequence().slice(0, env.OUTREACH_MAX_ACTIONS_PER_CAMPAIGN)
  const created: CreateCampaignResult['actions'] = []

  for (const def of definitions) {
    const step = await prisma.outreachSequenceStep.create({
      data: {
        id: newId(),
        tenantId: input.tenantId,
        campaignId,
        stepNumber: def.stepNumber,
        channel: def.channel,
        dayOffset: def.dayOffset,
        purpose: def.purpose,
        requiresPreviousStatus: (def.requiresPreviousStatus ?? undefined) as never,
        requiresChannelEnabled: Boolean(def.requiresChannelEnabled),
      },
    })

    const target = buildTarget(def.channel, {
      companyName: run.companyName ?? company.name,
      crmCompanyId: run.crmCompanyId,
      decisionMaker,
    })

    const message = composeMessage({
      channel: def.channel,
      target,
      companyName: run.companyName ?? company.name,
      topFinding,
      sample: { pagesInspected: run.pagesFetched, productPagesInspected: run.productPages },
      auditRunId: input.auditRunId,
      workbenchUrl,
      workbenchProductName: demo?.productName ?? null,
      intentSignals,
      senderName: env.OUTREACH_FROM_NAME,
      senderCompany: env.OUTREACH_COMPANY_NAME,
    })

    const validation = await validateAction({
      tenantId: input.tenantId,
      auditRunId: input.auditRunId,
      message,
      target,
    })

    // A channel whose provider cannot act is recorded as blocked at planning
    // time, so the sequence is readable before anything falls due.
    const availability = PROVIDERS[def.channel].availability()
    const limits = CHANNEL_LIMITS[def.channel]

    let status: ActionStatus = 'scheduled'
    let reason: string | null = null

    if (limits.requiresDestination && !target.destination) {
      status = 'blocked_no_target'
      reason = validation.issues.find((i) => i.check === 'target')?.message ?? 'No verified destination for this channel.'
    } else if (!validation.ok) {
      status = 'blocked_validation_failed'
      reason = validation.issues.map((i) => i.message).join(' ')
    } else if (availability.status === 'draft_only') {
      status = 'manual_required'
      reason = availability.reason ?? null
    } else if (availability.status !== 'available') {
      status = 'blocked_provider_unavailable'
      reason = availability.reason ?? null
    }

    const actionId = newId()
    await prisma.outreachAction.create({
      data: {
        id: actionId,
        tenantId: input.tenantId,
        campaignId,
        stepId: step.id,
        crmCompanyId: run.crmCompanyId,
        companyName: run.companyName,
        channel: def.channel,
        stepNumber: def.stepNumber,
        contactName: target.contactName,
        contactTitle: target.contactTitle,
        decisionMakerId: target.decisionMakerId,
        destination: target.destination,
        destinationKind: target.destinationKind,
        status,
        statusReason: reason,
        idempotencyKey: idempotencyKey({
          campaignId,
          crmCompanyId: run.crmCompanyId,
          channel: def.channel,
          stepNumber: def.stepNumber,
          destination: target.destination,
          templateKey: message.templateKey,
          templateVersion: message.templateVersion,
        }),
        providerName: PROVIDERS[def.channel].name,
        providerStatus: availability.status,
        validation: validation as never,
        validationOk: validation.ok,
        scheduledAt: scheduledAtFor(startsAt, def.dayOffset),
      },
    })

    await prisma.outreachMessage.create({
      data: {
        id: newId(),
        tenantId: input.tenantId,
        actionId,
        templateKey: message.templateKey,
        templateVersion: message.templateVersion,
        subject: message.subject,
        body: message.body,
        blocks: message.blocks as never,
        ctaUrl: message.ctaUrl,
        workbenchUrl: message.workbenchUrl,
        evidence: message.evidence as never,
        characterCount: message.length,
      },
    })

    created.push({ id: actionId, channel: def.channel, stepNumber: def.stepNumber, status, reason })
  }

  await audit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorCrmUserId: input.requestedByCrmUserId,
    action: 'outreach.campaign_created',
    resourceType: 'OutreachCampaign',
    resourceId: campaignId,
    dataClass: 'customer_pii',
    summary: `${run.companyName}: ${created.length} action(s) planned across ${new Set(created.map((c) => c.channel)).size} channel(s)`,
  })

  // TASK #983: record the lifecycle of what we just planned. Idempotent, and
  // deliberately not allowed to fail the campaign — an engagement row is worth
  // less than the campaign it describes.
  try {
    await syncOutreachActions(input.tenantId, { actionIds: created.map((c) => c.id) })
  } catch (err) {
    log.error({ err, campaignId }, 'outreach: engagement lifecycle events could not be recorded')
  }

  log.info({ campaignId, actions: created.length, dryRun }, 'outreach campaign created')

  return {
    campaignId,
    companyName: run.companyName,
    actions: created,
    decisionMaker: decisionMaker ? { name: decisionMaker.fullName, title: decisionMaker.rawTitle } : null,
    workbenchUrl,
  }
}

/**
 * Plans a campaign — the DEFAULT basis, from Decision Makers + Intent
 * Signals, for the 2026-09-24 restructure. Website Audit / Audit Report /
 * Human Approval / AI Workbench are locked and will not produce new approved
 * audits, so this is what "Prepare outreach" now runs by default.
 *
 * The gate: a completed Decision Maker run AND at least one active Intent
 * Signal. Neither substitutes for the other — a shortlisted contact with no
 * signal is not yet a reason to reach out, and a signal with nobody to send it
 * to cannot be turned into an action.
 *
 * Message content comes from a Sales-approved OutreachTemplate, personalized
 * by composeFromTemplate — never the deterministic, audit-finding blocks
 * composeMessage builds for the legacy path above.
 */
async function createCampaignFromIntent(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  if (!input.crmCompanyId) {
    throw new ConflictError('crmCompanyId is required to prepare outreach without an approved audit.', {})
  }
  const crmCompanyId = input.crmCompanyId
  const log = logger.child({ crmCompanyId })

  const dmRun = await prisma.decisionMakerRun.findFirst({
    where: { tenantId: input.tenantId, crmCompanyId, status: 'completed' },
    orderBy: { createdAt: 'desc' },
  })
  if (!dmRun) {
    throw new ConflictError(
      'No completed Decision Maker Discovery run exists for this company. Outreach may only be prepared once ' +
        'Decision Maker Discovery has run and at least one intent signal has been detected.',
      { crmCompanyId },
    )
  }
  const decisionMaker = await prisma.decisionMakerCandidate.findFirst({
    where: { tenantId: input.tenantId, dmRunId: dmRun.id, outcome: 'shortlisted' },
    orderBy: { rank: 'asc' },
  })

  const intentSignals = await prisma.intentSignal.findMany({
    where: { tenantId: input.tenantId, crmCompanyId, status: 'active' },
    orderBy: { detectedAt: 'desc' },
    take: 3,
    select: { id: true, summary: true, sourceUrl: true },
  })
  if (intentSignals.length === 0) {
    throw new ConflictError(
      'No active intent signal exists for this company. Outreach may only be prepared once at least one ' +
        'intent signal has been detected.',
      { crmCompanyId },
    )
  }

  // ── Company facts: the CRM when this id resolves there, DiscoveredCompany
  //    otherwise (see that model's placeholder-id comment). Never invented —
  //    a CRM company carries no stored "summary" today, so companySummary
  //    stays null for one rather than being built from industry or name.
  //    Recognised from the id itself, not only when the caller says so: the
  //    screen passes the company in context, which for a company found by
  //    "Find New Company" IS its DiscoveredCompany id.
  let companyName: string | null
  let companyDomain: string | null
  let companySummary: string | null
  const discovered = await prisma.discoveredCompany.findFirst({
    where: { id: input.discoveredCompanyId ?? crmCompanyId, tenantId: input.tenantId },
  })
  if (input.discoveredCompanyId && !discovered) throw new NotFoundError('That discovered company no longer exists.')
  if (discovered) {
    companyName = discovered.companyName
    companyDomain = discoveredWebsiteDomain(discovered)
    companySummary = discovered.websiteSummary
  } else {
    const company = await getCrm().getCompany(crmCompanyId)
    if (!company) throw new NotFoundError('That company no longer exists in NXT Sales.')
    companyName = company.name
    companyDomain = company.domain
    companySummary = null
  }

  const startsAt = input.startsAt ?? new Date()
  const dryRun = input.dryRun ?? env.OUTREACH_DEFAULT_DRY_RUN

  const campaignId = newId()
  await prisma.outreachCampaign.create({
    data: {
      id: campaignId,
      tenantId: input.tenantId,
      crmCompanyId,
      discoveredCompanyId: discovered?.id ?? null,
      companyName,
      companyDomain,
      decisionMakerId: decisionMaker?.id ?? null,
      status: 'active',
      autoSendEnabled: env.OUTREACH_AUTO_SEND,
      dryRun,
      startsAt,
      requestedByCrmUserId: input.requestedByCrmUserId,
    },
  })

  const definitions = defaultSequence().slice(0, env.OUTREACH_MAX_ACTIONS_PER_CAMPAIGN)
  const created: CreateCampaignResult['actions'] = []

  for (const def of definitions) {
    const step = await prisma.outreachSequenceStep.create({
      data: {
        id: newId(),
        tenantId: input.tenantId,
        campaignId,
        stepNumber: def.stepNumber,
        channel: def.channel,
        dayOffset: def.dayOffset,
        purpose: def.purpose,
        requiresPreviousStatus: (def.requiresPreviousStatus ?? undefined) as never,
        requiresChannelEnabled: Boolean(def.requiresChannelEnabled),
      },
    })

    const target = buildTarget(def.channel, {
      companyName: companyName ?? crmCompanyId,
      crmCompanyId,
      decisionMaker,
    })

    // The one thing this path needs that the legacy path never did: a
    // Sales-approved template for this channel. Absent one, the step is
    // recorded as blocked — content nobody has supplied yet, a fact about
    // this platform's setup, not about the company or the channel.
    const template = await prisma.outreachTemplate.findFirst({
      where: { tenantId: input.tenantId, channel: def.channel, isActive: true },
      orderBy: { createdAt: 'desc' },
    })

    const availability = PROVIDERS[def.channel].availability()
    const limits = CHANNEL_LIMITS[def.channel]

    let status: ActionStatus = 'scheduled'
    let reason: string | null = null
    let message: Awaited<ReturnType<typeof composeFromTemplate>> | null = null
    let validation: ValidationOutcome = {
      ok: false,
      passed: [],
      issues: [{ check: 'template', field: 'template', message: 'No template.' }],
    }

    if (!template) {
      status = 'blocked_no_template'
      reason = `No Sales-approved outreach template is configured yet for the "${def.channel}" channel.`
    } else {
      message = await composeFromTemplate({
        channel: def.channel,
        target,
        companyName: companyName ?? crmCompanyId,
        companySummary,
        intentSignals,
        template,
        senderName: env.OUTREACH_FROM_NAME,
        senderCompany: env.OUTREACH_COMPANY_NAME,
        tenantId: input.tenantId,
      })

      validation = await validateAction({ tenantId: input.tenantId, auditRunId: null, message, target })

      if (limits.requiresDestination && !target.destination) {
        status = 'blocked_no_target'
        reason = validation.issues.find((i) => i.check === 'target')?.message ?? 'No verified destination for this channel.'
      } else if (!validation.ok) {
        status = 'blocked_validation_failed'
        reason = validation.issues.map((i) => i.message).join(' ')
      } else if (availability.status === 'draft_only') {
        status = 'manual_required'
        reason = availability.reason ?? null
      } else if (availability.status !== 'available') {
        status = 'blocked_provider_unavailable'
        reason = availability.reason ?? null
      }
    }

    const actionId = newId()
    await prisma.outreachAction.create({
      data: {
        id: actionId,
        tenantId: input.tenantId,
        campaignId,
        stepId: step.id,
        crmCompanyId,
        companyName,
        channel: def.channel,
        stepNumber: def.stepNumber,
        contactName: target.contactName,
        contactTitle: target.contactTitle,
        decisionMakerId: target.decisionMakerId,
        destination: target.destination,
        destinationKind: target.destinationKind,
        status,
        statusReason: reason,
        idempotencyKey: idempotencyKey({
          campaignId,
          crmCompanyId,
          channel: def.channel,
          stepNumber: def.stepNumber,
          destination: target.destination,
          templateKey: message?.templateKey ?? `${def.channel}.no_template`,
          templateVersion: message?.templateVersion ?? '0',
        }),
        providerName: PROVIDERS[def.channel].name,
        providerStatus: availability.status,
        validation: validation as never,
        validationOk: validation.ok,
        scheduledAt: scheduledAtFor(startsAt, def.dayOffset),
      },
    })

    if (message) {
      await prisma.outreachMessage.create({
        data: {
          id: newId(),
          tenantId: input.tenantId,
          actionId,
          templateKey: message.templateKey,
          templateVersion: message.templateVersion,
          subject: message.subject,
          body: message.body,
          blocks: message.blocks as never,
          ctaUrl: message.ctaUrl,
          workbenchUrl: message.workbenchUrl,
          evidence: message.evidence as never,
          characterCount: message.length,
        },
      })
    }

    created.push({ id: actionId, channel: def.channel, stepNumber: def.stepNumber, status, reason })
  }

  await audit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorCrmUserId: input.requestedByCrmUserId,
    action: 'outreach.campaign_created',
    resourceType: 'OutreachCampaign',
    resourceId: campaignId,
    dataClass: 'customer_pii',
    summary: `${companyName}: ${created.length} action(s) planned across ${new Set(created.map((c) => c.channel)).size} channel(s)`,
  })

  try {
    await syncOutreachActions(input.tenantId, { actionIds: created.map((c) => c.id) })
  } catch (err) {
    log.error({ err, campaignId }, 'outreach: engagement lifecycle events could not be recorded')
  }

  log.info({ campaignId, actions: created.length, dryRun }, 'outreach campaign created (intent basis)')

  return {
    campaignId,
    companyName,
    actions: created,
    decisionMaker: decisionMaker ? { name: decisionMaker.fullName, title: decisionMaker.rawTitle } : null,
    workbenchUrl: null,
  }
}

/**
 * Builds the target for a channel.
 *
 * A destination is only ever a value some source actually stated. Task #978
 * stored no email addresses and no phone numbers because it refused to guess
 * any, so those channels legitimately have nothing to aim at here.
 */
function buildTarget(
  channel: OutreachChannel,
  ctx: {
    companyName: string
    crmCompanyId: string
    decisionMaker: { id: string; fullName: string; rawTitle: string | null; email: string | null; profileUrl: string | null } | null
  },
): OutreachTarget {
  const dm = ctx.decisionMaker
  const base = {
    contactName: dm?.fullName ?? null,
    contactTitle: dm?.rawTitle ?? null,
    decisionMakerId: dm?.id ?? null,
    companyName: ctx.companyName,
    crmCompanyId: ctx.crmCompanyId,
  }

  switch (channel) {
    case 'email':
    case 'email_followup':
      return { ...base, destination: dm?.email ?? null, destinationKind: dm?.email ? 'email' : null }
    case 'linkedin':
      return { ...base, destination: dm?.profileUrl ?? null, destinationKind: dm?.profileUrl ? 'linkedin_profile' : null }
    case 'whatsapp':
      // A phone number is never taken from a company switchboard field: that is
      // not this person's number, and messaging it is not the same act.
      return { ...base, destination: null, destinationKind: null }
    case 'call':
      return { ...base, destination: null, destinationKind: 'internal_task' }
  }
}

// ── Execution ──────────────────────────────────────────────────────────────

export interface ExecuteResult {
  actionId: string
  status: ActionStatus
  reason: string | null
  delivered: boolean
  attempt: number
}

/**
 * Executes one due action.
 *
 * Re-checks everything at execution time rather than trusting the plan:
 * suppression, provider availability and validation can all have changed since
 * the campaign was created, and a person who opted out yesterday must not
 * receive a message scheduled last week.
 */
export async function executeAction(actionId: string): Promise<ExecuteResult> {
  const action = await prisma.outreachAction.findUnique({
    where: { id: actionId },
    include: { message: true, campaign: true },
  })
  if (!action) return { actionId, status: 'failed', reason: 'Action not found.', delivered: false, attempt: 0 }

  // ── The Sales sequence is never executed by the platform ───────────────
  // Its emails are reviewed, approved and sent by a person from their own
  // mail client (src/outreach/salesSequence/). /release, /execute and the
  // worker must not touch them — not even to record a provider as missing.
  if (action.campaign.flow !== 'legacy') {
    return {
      actionId,
      status: action.status as ActionStatus,
      reason: 'This email belongs to the Sales-approved sequence, which a person sends manually. The platform does not execute it.',
      delivered: false,
      attempt: action.retryCount,
    }
  }

  const log = logger.child({ actionId, channel: action.channel })

  // ── Idempotency: a terminal action is never re-run ─────────────────────
  if (TERMINAL_STATUSES.includes(action.status as ActionStatus)) {
    return {
      actionId,
      status: action.status as ActionStatus,
      reason: `Already ${action.status}; not re-executed.`,
      delivered: action.status === 'sent',
      attempt: action.retryCount,
    }
  }

  if (action.retryCount >= env.OUTREACH_MAX_RETRIES) {
    await fail(actionId, 'failed', `Exceeded OUTREACH_MAX_RETRIES (${env.OUTREACH_MAX_RETRIES}).`)
    return { actionId, status: 'failed', reason: 'Retry limit reached.', delivered: false, attempt: action.retryCount }
  }

  // ── Suppression, re-checked now ────────────────────────────────────────
  const suppression = await checkSuppression({
    tenantId: action.tenantId,
    crmCompanyId: action.crmCompanyId,
    companyName: action.companyName ?? '',
    companyDomain: action.campaign.companyDomain,
    destination: action.destination,
    channel: action.channel as OutreachChannel,
    campaignId: action.campaignId,
  })

  if (suppression.suppressed) {
    await prisma.outreachAction.update({
      where: { id: actionId },
      data: {
        status: 'blocked_suppressed',
        statusReason: suppression.detail,
        suppressionReason: suppression.reason,
        suppressionDetail: suppression.detail,
      },
    })
    log.info({ reason: suppression.reason }, 'outreach action suppressed')
    return { actionId, status: 'blocked_suppressed', reason: suppression.detail ?? null, delivered: false, attempt: action.retryCount }
  }

  // ── Email verification, re-checked now ─────────────────────────────────
  //
  // Team Answer, Section 4: "An address must be verified before the system
  // treats it as outreach-ready." Checked here rather than only at planning
  // time for the same reason suppression is: a verification can go stale, and
  // a provider can be configured, between a step being scheduled and it
  // falling due.
  if (action.channel === 'email' && action.destination) {
    const verification = await verifyEmail(action.destination)
    const gate = assertOutreachReady(verification)
    if (!gate.ready) {
      await prisma.outreachAction.update({
        where: { id: actionId },
        data: { status: 'blocked_email_unverified', statusReason: gate.reason },
      })
      log.info({ destination: action.destination, reason: gate.reason }, 'outreach action blocked — address not verified')
      return {
        actionId,
        status: 'blocked_email_unverified',
        reason: gate.reason,
        delivered: false,
        attempt: action.retryCount,
      }
    }
  }

  // ── Sequence dependency ────────────────────────────────────────────────
  const step = action.stepId ? await prisma.outreachSequenceStep.findUnique({ where: { id: action.stepId } }) : null
  if (step) {
    const previous = await prisma.outreachAction.findFirst({
      where: { campaignId: action.campaignId, stepNumber: { lt: action.stepNumber } },
      orderBy: { stepNumber: 'desc' },
      select: { status: true },
    })
    const eligibility = stepIsEligible(
      {
        stepNumber: step.stepNumber,
        channel: step.channel as OutreachChannel,
        dayOffset: step.dayOffset,
        purpose: step.purpose,
        requiresPreviousStatus: (step.requiresPreviousStatus ?? undefined) as string[] | undefined,
        requiresChannelEnabled: step.requiresChannelEnabled,
      },
      previous?.status ?? null,
      env.OUTREACH_WHATSAPP_ENABLED,
    )
    if (!eligibility.eligible) {
      await prisma.outreachAction.update({
        where: { id: actionId },
        data: { status: 'skipped', statusReason: eligibility.reason },
      })
      return { actionId, status: 'skipped', reason: eligibility.reason ?? null, delivered: false, attempt: action.retryCount }
    }
  }

  // ── Validation, re-checked now ─────────────────────────────────────────
  if (!action.message) {
    await fail(actionId, 'blocked_validation_failed', 'The action has no composed message.')
    return { actionId, status: 'blocked_validation_failed', reason: 'No message.', delivered: false, attempt: action.retryCount }
  }

  const target: OutreachTarget = {
    contactName: action.contactName,
    contactTitle: action.contactTitle,
    decisionMakerId: action.decisionMakerId,
    destination: action.destination,
    destinationKind: action.destinationKind as OutreachTarget['destinationKind'],
    companyName: action.companyName ?? '',
    crmCompanyId: action.crmCompanyId,
  }

  const validation = await validateAction({
    tenantId: action.tenantId,
    auditRunId: action.campaign.auditRunId,
    message: {
      channel: action.channel as OutreachChannel,
      templateKey: action.message.templateKey,
      templateVersion: action.message.templateVersion,
      subject: action.message.subject,
      body: action.message.body,
      blocks: (action.message.blocks ?? {}) as Record<string, string>,
      ctaUrl: action.message.ctaUrl,
      workbenchUrl: action.message.workbenchUrl,
      evidence: (action.message.evidence ?? []) as never,
      length: action.message.characterCount,
    },
    target,
  })

  if (!validation.ok) {
    await prisma.outreachAction.update({
      where: { id: actionId },
      data: {
        status: 'blocked_validation_failed',
        statusReason: validation.issues.map((i) => i.message).join(' '),
        validation: validation as never,
        validationOk: false,
      },
    })
    return {
      actionId,
      status: 'blocked_validation_failed',
      reason: validation.issues[0]?.message ?? null,
      delivered: false,
      attempt: action.retryCount,
    }
  }

  // ── Delivery ───────────────────────────────────────────────────────────
  const provider = PROVIDERS[action.channel as OutreachChannel]
  const attempt = action.retryCount + 1
  // Auto-send must be enabled BOTH globally and on the campaign. A dry run
  // stays a dry run whatever the global flag says.
  const dryRun = action.campaign.dryRun || !action.campaign.autoSendEnabled || !env.OUTREACH_AUTO_SEND

  await prisma.outreachAction.update({ where: { id: actionId }, data: { status: 'sending', retryCount: attempt } })

  const result = await runProvider(provider, {
    tenantId: action.tenantId,
    actionId,
    channel: action.channel as OutreachChannel,
    target,
    message: {
      channel: action.channel as OutreachChannel,
      templateKey: action.message.templateKey,
      templateVersion: action.message.templateVersion,
      subject: action.message.subject,
      body: action.message.body,
      blocks: (action.message.blocks ?? {}) as Record<string, string>,
      ctaUrl: action.message.ctaUrl,
      workbenchUrl: action.message.workbenchUrl,
      evidence: (action.message.evidence ?? []) as never,
      length: action.message.characterCount,
    },
    dryRun,
  })

  await prisma.outreachProviderRun.create({
    data: {
      id: newId(),
      tenantId: action.tenantId,
      actionId,
      attempt,
      providerName: provider.name,
      providerStatus: result.status,
      delivered: result.delivered,
      manualRequired: Boolean(result.manualRequired),
      reason: result.reason ?? null,
      failureKind: result.failureKind ?? null,
      response: (result.providerResponse ?? undefined) as never,
      durationMs: result.durationMs,
      dryRun,
    },
  })

  const status: ActionStatus = result.delivered
    ? 'sent'
    : result.manualRequired
      ? 'manual_required'
      : dryRun && (result.status === 'available' || result.status === 'draft_only')
        ? 'ready_to_send'
        : result.failureKind && RETRYABLE_FAILURES.includes(result.failureKind)
          ? 'scheduled'
          : result.status === 'not_configured' || result.status === 'disabled_by_policy'
            ? 'blocked_provider_unavailable'
            : 'failed'

  await prisma.outreachAction.update({
    where: { id: actionId },
    data: {
      status,
      statusReason: result.reason ?? null,
      providerStatus: result.status,
      providerMessageId: result.providerMessageId ?? null,
      providerResponse: (result.providerResponse ?? undefined) as never,
      failureKind: result.failureKind ?? null,
      validation: validation as never,
      validationOk: true,
      sentAt: result.delivered ? new Date() : null,
    },
  })

  await audit({
    tenantId: action.tenantId,
    actorType: 'agent',
    action: `outreach.${status}`,
    resourceType: 'OutreachAction',
    resourceId: actionId,
    dataClass: 'customer_pii',
    summary: `${action.channel} step ${action.stepNumber} for ${action.companyName}: ${status}${dryRun ? ' (dry run)' : ''}`,
  })

  // TASK #983: the outcome, once the row reflects it. `email_sent` is emitted
  // only when `sentAt` was actually written — a dry run does not become a send.
  try {
    await syncOutreachActions(action.tenantId, { actionIds: [actionId] })
  } catch (err) {
    log.error({ err, actionId }, 'outreach: engagement lifecycle event could not be recorded')
  }

  log.info({ status, provider: provider.name, dryRun, delivered: result.delivered }, 'outreach action executed')

  return { actionId, status, reason: result.reason ?? null, delivered: result.delivered, attempt }
}

async function fail(actionId: string, status: ActionStatus, reason: string): Promise<void> {
  await prisma.outreachAction.update({ where: { id: actionId }, data: { status, statusReason: reason } })
}
