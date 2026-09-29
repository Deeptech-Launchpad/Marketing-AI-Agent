import { createHash } from 'node:crypto'
import { env } from '../../config/env.js'
import { syncOutreachActions } from '../../engagement/adapters/outreachAdapter.js'
import { audit } from '../../platform/audit.js'
import { newId, prisma } from '../../platform/db.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../platform/errors.js'
import { logger } from '../../platform/logger.js'
import { checkSuppression, type SuppressionCheck } from '../suppression.js'
import { generateCallPoints } from './callPoints.js'
import { companyDisplayName, fill } from './placeholders.js'
import { composeStage, valuesFromInputs, withoutExpoParagraph } from './compose.js'
import { loadProspectFacts, type ProspectFacts } from './facts.js'
import { ensureCompanyContactEmail } from '../../decisionmakers/companyContactEmail.js'
import { deliverTestEmail } from './sending/deliver.js'
import { windowOfBatch } from './sending/batchWindow.js'
import { followUpSlot, nextSendSlot } from './sending/schedule.js'
import { evaluateGates, type Attestation, type GateResult, type MessageInputs } from './gates.js'
import { classifyReply, REPLY_LABELS } from './replies.js'
import { readSenderFor } from './sender.js'
import { computeSequence, type ConfirmedReply, type ReplyClass, type SequenceView, type StageAction } from './stageMachine.js'
import {
  CALL_POINTS_STEP_NUMBER,
  INITIAL_VERSIONS,
  STAGE_STEP_NUMBER,
  STAGE_TEMPLATES,
  TEMPLATE_SET_VERSION,
  templateFor,
  templateKeyFor,
  type InitialVersion,
  type StageKey,
  type StageTemplate,
} from './templates.js'

// THE SALES SEQUENCE, END TO END.
//
// Orchestration only: every decision is made by a pure module (the stage
// machine, the gates, the composer, the reply checks) and this file loads the
// rows those modules need, writes what they decided, records an audit event
// for every change, and keeps Engagement in step.
//
// Two rules hold throughout:
//   · Nothing is sent. "Mark as sent" records that a PERSON sent an approved
//     email from their own mail client; it is refused unless the copy is
//     exactly what was approved.
//   · Nothing is decided on a model's word alone. A reply's classification
//     changes the sequence only once Sales confirms it, and a draft moves
//     only by a person's approval.

export const FLOW = 'sales_sequence_v1'
const CALL_POINTS_STAGE = 'call_points'
const NO_REPLY_STAGES: StageKey[] = ['noreply_followup', 'noreply_report', 'expo_invite', 'breakup']
const REVISIONS_KEPT = 10

export interface Actor {
  tenantId: string
  crmUserId: string
  requestId?: string | null
}

const tz = () => env.OUTREACH_SEQUENCE_TIMEZONE
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export const bodyHash = (subject: string | null, body: string) => sha(`${subject ?? ''}\n\n${body}`)

function idempotencyKey(tenantId: string, crmCompanyId: string, campaignId: string, stage: string, isTest = false): string {
  // The initial email is keyed to the COMPANY, not the campaign: the database
  // itself refuses a second initial email to the same prospect. A TEST
  // campaign's emails are keyed to that test campaign, so a rehearsal never
  // blocks — or is mistaken for — the real sequence for the same company.
  if (isTest) return sha(`${FLOW}|test|${campaignId}|${stage}`)
  return stage === 'initial' ? sha(`${FLOW}|${tenantId}|${crmCompanyId}|initial`) : sha(`${FLOW}|${campaignId}|${stage}`)
}

/** Statuses of an approved email that has not gone yet: approved, scheduled (test), or a test send that failed. */
const APPROVED_UNSENT = ['ready_to_send', 'scheduled', 'failed']

// ── Loading ────────────────────────────────────────────────────────────────

async function loadCampaign(tenantId: string, campaignId: string) {
  const campaign = await prisma.outreachCampaign.findFirst({
    where: { id: campaignId, tenantId, flow: FLOW },
    include: {
      actions: { include: { message: true }, orderBy: [{ stepNumber: 'asc' }, { createdAt: 'asc' }] },
      replies: { orderBy: { receivedAt: 'asc' } },
    },
  })
  if (!campaign) throw new NotFoundError('Outreach sequence not found.')
  return campaign
}
type LoadedCampaign = Awaited<ReturnType<typeof loadCampaign>>
type LoadedAction = LoadedCampaign['actions'][number]

async function loadAction(tenantId: string, actionId: string) {
  const action = await prisma.outreachAction.findFirst({ where: { id: actionId, tenantId }, select: { campaignId: true } })
  if (!action) throw new NotFoundError('Draft not found.')
  const campaign = await loadCampaign(tenantId, action.campaignId)
  const loaded = campaign.actions.find((a) => a.id === actionId)!
  return { campaign, action: loaded }
}

function stageActions(c: LoadedCampaign): StageAction[] {
  return c.actions
    .filter((a) => a.stageKey && a.stageKey !== CALL_POINTS_STAGE)
    .map((a) => ({ stageKey: a.stageKey as StageKey, status: a.status, sentAt: a.sentAt }))
}

function confirmedReplies(c: LoadedCampaign): ConfirmedReply[] {
  return c.replies
    .filter((r) => r.classification && r.confirmedAt)
    .map((r) => ({ receivedAt: r.receivedAt, classification: r.classification as ReplyClass }))
}

function sequenceOf(c: LoadedCampaign, now = new Date()): SequenceView {
  return computeSequence({ campaignStatus: c.status, actions: stageActions(c), replies: confirmedReplies(c), now, tz: tz() })
}

/** The SKUs from the prospect's most recent confirmed "sent SKUs" reply. */
function confirmedSkus(c: LoadedCampaign): string[] {
  const r = c.replies.filter((x) => x.classification === 'sent_skus' && x.confirmedAt).pop()
  return Array.isArray(r?.skus) ? (r!.skus as string[]) : []
}

function templateOfAction(c: LoadedCampaign, stageKey: StageKey): StageTemplate {
  return templateFor(stageKey, stageKey === 'initial' ? ((c.initialVersion as InitialVersion) ?? 'v1') : null)
}

function isDiscoveredOnly(c: { discoveredCompanyId: string | null; crmCompanyId: string }): boolean {
  return Boolean(c.discoveredCompanyId) && c.discoveredCompanyId === c.crmCompanyId
}

async function suppressionFor(c: LoadedCampaign, template: StageTemplate): Promise<SuppressionCheck> {
  return checkSuppression({
    tenantId: c.tenantId,
    crmCompanyId: c.crmCompanyId,
    companyName: c.companyName ?? '',
    companyDomain: c.companyDomain,
    destination: c.recipientEmail,
    channel: 'email',
    campaignId: c.id,
    // A reply must still be answered while a deal is open, and a company found
    // on the open web has no NXT Sales record to hold one.
    openDealCheck: template.trigger === 'reply' || isDiscoveredOnly(c) ? 'skip' : 'enforce',
  })
}

async function gatesFor(c: LoadedCampaign, a: LoadedAction, seq: SequenceView, now: Date): Promise<GateResult> {
  const template = templateOfAction(c, a.stageKey as StageKey)
  return evaluateGates({
    template,
    stage: seq.stages.find((s) => s.stageKey === a.stageKey) ?? null,
    actionStatus: a.status,
    subject: a.message?.subject ?? null,
    body: a.message?.body ?? '',
    inputs: (a.message?.inputs ?? {}) as MessageInputs,
    attestations: (a.message?.attestations ?? []) as unknown as Attestation[],
    confirmedSkus: confirmedSkus(c),
    recipientEmail: c.recipientEmail,
    sender: await readSenderFor(c.tenantId, c.requestedByCrmUserId),
    suppression: await suppressionFor(c, template),
    now,
  })
}

async function record(actor: Actor, campaignId: string, action: string, resourceType: string, resourceId: string, summary: string, metadata?: Record<string, unknown>) {
  await audit({
    tenantId: actor.tenantId,
    actorType: 'user',
    actorCrmUserId: actor.crmUserId,
    runId: campaignId,
    action: `outreach.sequence.${action}`,
    resourceType,
    resourceId,
    dataClass: 'customer_pii',
    summary,
    metadata: metadata ?? null,
    requestId: actor.requestId ?? null,
  })
}

async function syncEngagement(tenantId: string, actionIds: string[]) {
  try {
    await syncOutreachActions(tenantId, { actionIds })
  } catch (err) {
    logger.error({ err, actionIds }, 'sales sequence: engagement events could not be recorded')
  }
}

// ── Starting ───────────────────────────────────────────────────────────────

/** The version with the fewest prospects so far — an even split across the three. */
async function nextRotationVersion(tenantId: string): Promise<InitialVersion> {
  const counts = await prisma.outreachCampaign.groupBy({
    by: ['initialVersion'],
    // Test rehearsals do not count toward the real split test.
    where: { tenantId, flow: FLOW, isTest: false },
    _count: { _all: true },
  })
  const n = (v: InitialVersion) => counts.find((c) => c.initialVersion === v)?._count._all ?? 0
  return [...INITIAL_VERSIONS].sort((a, b) => n(a) - n(b))[0]!
}

export async function startSequence(
  actor: Actor,
  crmCompanyId: string,
  opts: { version?: InitialVersion; isTest?: boolean; batchId?: string } = {},
) {
  const isTest = Boolean(opts.isTest)
  // A real sequence is one per company. A test campaign belongs to its batch,
  // and never stands in for the real one.
  const existing = isTest
    ? await prisma.outreachCampaign.findFirst({ where: { tenantId: actor.tenantId, crmCompanyId, flow: FLOW, isTest: true, batchId: opts.batchId ?? null }, select: { id: true } })
    : await prisma.outreachCampaign.findFirst({
        where: { tenantId: actor.tenantId, crmCompanyId, flow: FLOW, isTest: false },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
  if (existing) return { campaignId: existing.id, created: false }

  let facts = await loadProspectFacts(actor.tenantId, crmCompanyId)
  if (!facts) throw new NotFoundError('Company not found.')
  if (!facts.decisionMaker) {
    throw new ConflictError(
      'No decision maker has been shortlisted for this company yet. Run Decision Makers first — every approved email is addressed to a named person.',
    )
  }
  // No direct email and no company mailbox stored yet (a run made before the
  // fallback existed): look for one now, once, and read the facts again.
  if (!facts.decisionMaker.email && !facts.decisionMaker.companyContactEmail) {
    if (await ensureCompanyContactEmail(actor.tenantId, crmCompanyId)) {
      facts = (await loadProspectFacts(actor.tenantId, crmCompanyId)) ?? facts
    }
  }
  const dm = facts.decisionMaker!
  // The decision maker's own address first; a verified company mailbox only when they have none.
  const recipientEmail = dm.email ?? dm.companyContactEmail?.email ?? null
  const recipientEmailSource = dm.email ? 'decision_maker' : dm.companyContactEmail ? 'company_mailbox' : null

  const version = opts.version ?? (await nextRotationVersion(actor.tenantId))
  const campaignId = newId()
  await prisma.outreachCampaign.create({
    data: {
      id: campaignId,
      tenantId: actor.tenantId,
      crmCompanyId,
      discoveredCompanyId: facts.discoveredCompanyId,
      companyName: facts.companyName,
      companyDomain: facts.companyDomain,
      decisionMakerId: dm.id,
      status: 'active',
      flow: FLOW,
      initialVersion: version,
      versionSource: opts.version ? 'sales_override' : 'auto_rotation',
      recipientEmail,
      recipientEmailSource,
      autoSendEnabled: false,
      dryRun: true,
      isTest,
      batchId: opts.batchId ?? null,
      requestedByCrmUserId: actor.crmUserId,
    },
  })
  await record(
    actor,
    campaignId,
    'started',
    'OutreachCampaign',
    campaignId,
    `${isTest ? 'TEST ' : ''}Outreach started for ${facts.companyName} — Version ${version.slice(1)} (${opts.version ? 'chosen by Sales' : 'split-test rotation'})`,
  )

  try {
    await prepareStage(actor, campaignId, 'initial')
  } catch (err) {
    // Two starts at once: the database refused the second initial email. Keep
    // the first sequence and remove this one.
    if ((err as { code?: string }).code === 'P2002') {
      await prisma.outreachCampaign.delete({ where: { id: campaignId } }).catch(() => undefined)
      const first = await prisma.outreachCampaign.findFirst({ where: { tenantId: actor.tenantId, crmCompanyId, flow: FLOW, isTest }, select: { id: true } })
      if (first) return { campaignId: first.id, created: false }
    }
    throw err
  }
  return { campaignId, created: true }
}

// ── Drafts ─────────────────────────────────────────────────────────────────

export async function prepareStage(actor: Actor, campaignId: string, stageKey: StageKey) {
  const campaign = await loadCampaign(actor.tenantId, campaignId)
  if (campaign.status === 'cancelled') throw new ConflictError('This sequence was stopped. Resume it before preparing another email.')
  const seq = sequenceOf(campaign)
  const view = seq.stages.find((s) => s.stageKey === stageKey)
  if (!view) throw new BadRequestError(`Unknown stage "${stageKey}".`)
  const existing = campaign.actions.find((a) => a.stageKey === stageKey) ?? null
  if (existing && (existing.status === 'sent' || existing.status === 'sending' || APPROVED_UNSENT.includes(existing.status))) {
    throw new ConflictError(`${view.label} is already ${existing.status === 'sent' ? 'sent' : 'approved'}. Edit it instead of preparing it again.`)
  }
  if (!view.canPrepare && !(existing && (existing.status === 'draft' || existing.status === 'cancelled'))) {
    throw new ConflictError(view.reason ?? `${view.label} is not due yet.`)
  }

  // Only the initial versions carry the product page line, and only they need
  // the page re-opened and re-checked before it is linked.
  const facts = await loadProspectFacts(actor.tenantId, campaign.crmCompanyId, { recheckProductPage: stageKey === 'initial' })
  if (!facts) throw new NotFoundError('Company not found.')
  const template = templateOfAction(campaign, stageKey)
  const prevInputs = (existing?.message?.inputs ?? {}) as MessageInputs
  const inputs: MessageInputs = { ...(stageKey === 'sku_report' ? { skus: confirmedSkus(campaign) } : {}), ...prevInputs }
  const initialAction = campaign.actions.find((a) => a.stageKey === 'initial' && a.status !== 'cancelled')
  const composed = await composeStage({
    template,
    facts,
    sender: await readSenderFor(actor.tenantId, campaign.requestedByCrmUserId),
    inputs,
    initialSubject: stageKey === 'initial' ? null : initialAction?.message?.subject ?? null,
    tenantId: actor.tenantId,
  })

  const personalization = {
    templateSet: TEMPLATE_SET_VERSION,
    facts: facts.facts,
    resolution: composed.resolution,
    aiLine: composed.aiLine,
    signalsConsidered: composed.signalsConsidered,
    signalsUsed: composed.signalsUsed,
    unresolved: composed.unresolved,
    model: composed.model,
    preparedAt: new Date().toISOString(),
  }
  const evidence = [
    { kind: 'approved_template', referenceId: templateKeyFor(template), summary: `${template.pdfRef} ${template.label} (${TEMPLATE_SET_VERSION})`, sourceUrl: null },
    ...composed.resolution
      .filter((r) => r.value && r.factId)
      .map((r) => ({ kind: 'personalization_fact', referenceId: r.factId, summary: `${r.placeholder}: ${r.value} — ${r.source}`, sourceUrl: null })),
  ]
  const due = view.window
  const common = {
    companyName: campaign.companyName,
    contactName: facts.decisionMaker?.fullName ?? null,
    contactTitle: facts.decisionMaker?.title ?? null,
    decisionMakerId: facts.decisionMaker?.id ?? null,
    destination: campaign.recipientEmail,
    destinationKind: campaign.recipientEmail ? 'email' : null,
    dueStartAt: due?.start ?? null,
    dueEndAt: due?.end ?? null,
  }

  let actionId: string
  if (existing) {
    actionId = existing.id
    const m = existing.message
    const revisions = [
      ...(((m?.revisions ?? []) as unknown[]) ?? []),
      ...(m
        ? [{ revision: m.revision, subject: m.subject, body: m.body, at: new Date().toISOString(), by: actor.crmUserId, reason: existing.status === 'cancelled' ? `Rejected: ${existing.statusReason ?? 'no reason given'}` : 'Regenerated' }]
        : []),
    ].slice(-REVISIONS_KEPT)
    await prisma.outreachAction.update({
      where: { id: existing.id },
      data: { ...common, status: 'draft', statusReason: null, approvedAt: null, approvedByCrmUserId: null, approvedBodyHash: null, validationOk: false },
    })
    const messageData = {
      templateKey: templateKeyFor(template),
      templateVersion: TEMPLATE_SET_VERSION,
      subject: composed.subject,
      body: composed.body,
      draftSubject: composed.subject,
      draftBody: composed.body,
      evidence: evidence as never,
      personalization: personalization as never,
      inputs: inputs as never,
      characterCount: composed.body.length,
    }
    if (m) {
      await prisma.outreachMessage.update({ where: { id: m.id }, data: { ...messageData, revision: m.revision + 1, revisions: revisions as never } })
    } else {
      await prisma.outreachMessage.create({ data: { id: newId(), tenantId: actor.tenantId, actionId: existing.id, ...messageData } })
    }
  } else {
    actionId = newId()
    await prisma.outreachAction.create({
      data: {
        id: actionId,
        tenantId: actor.tenantId,
        campaignId,
        crmCompanyId: campaign.crmCompanyId,
        channel: stageKey === 'initial' ? 'email' : 'email_followup',
        stepNumber: STAGE_STEP_NUMBER[stageKey],
        stageKey,
        status: 'draft',
        idempotencyKey: idempotencyKey(actor.tenantId, campaign.crmCompanyId, campaignId, stageKey, campaign.isTest),
        providerName: campaign.isTest ? 'test_sender' : 'manual_send',
        providerStatus: 'draft_only',
        scheduledAt: due?.start ?? new Date(),
        ...common,
      },
    })
    await prisma.outreachMessage.create({
      data: {
        id: newId(),
        tenantId: actor.tenantId,
        actionId,
        templateKey: templateKeyFor(template),
        templateVersion: TEMPLATE_SET_VERSION,
        subject: composed.subject,
        body: composed.body,
        draftSubject: composed.subject,
        draftBody: composed.body,
        evidence: evidence as never,
        personalization: personalization as never,
        inputs: inputs as never,
        attestations: [] as never,
        characterCount: composed.body.length,
      },
    })
  }

  await record(actor, campaignId, 'draft_prepared', 'OutreachAction', actionId, `Draft prepared: ${template.pdfRef} ${template.label}`, {
    stageKey,
    aiLine: composed.aiLine.status,
    unresolved: composed.unresolved,
  })
  await syncEngagement(actor.tenantId, [actionId])
  return { actionId }
}

async function requireEditable(actor: Actor, actionId: string) {
  const { campaign, action } = await loadAction(actor.tenantId, actionId)
  if (!action.stageKey || action.stageKey === CALL_POINTS_STAGE) throw new BadRequestError('Only sequence drafts can be changed here.')
  if (action.status !== 'draft' && !APPROVED_UNSENT.includes(action.status)) {
    throw new ConflictError(`This email is "${action.status}" and can no longer be changed.`)
  }
  if (!action.message) throw new ConflictError('This draft has no message.')
  return { campaign, action, message: action.message }
}

/**
 * An approved draft that changes goes back to review: approval covers exact
 * copy. A scheduled test send is taken off the schedule with it.
 */
async function backToDraftIfApproved(actionId: string, status: string) {
  if (!APPROVED_UNSENT.includes(status)) return false
  await prisma.outreachAction.update({
    where: { id: actionId },
    data: { status: 'draft', statusReason: null, approvedAt: null, approvedByCrmUserId: null, approvedBodyHash: null, validationOk: false },
  })
  return true
}

function withRevision(message: { revision: number; subject: string | null; body: string; revisions: unknown }, actor: Actor, reason: string) {
  const revisions = [
    ...(((message.revisions ?? []) as unknown[]) ?? []),
    { revision: message.revision, subject: message.subject, body: message.body, at: new Date().toISOString(), by: actor.crmUserId, reason },
  ].slice(-REVISIONS_KEPT)
  return { revision: message.revision + 1, revisions: revisions as never }
}

export async function editDraft(actor: Actor, actionId: string, edit: { subject: string | null; body: string }) {
  const { campaign, action, message } = await requireEditable(actor, actionId)
  if (!edit.body.trim()) throw new BadRequestError('The email body cannot be empty.')
  if (edit.subject === message.subject && edit.body === message.body) return { actionId }
  const reopened = await backToDraftIfApproved(actionId, action.status)
  await prisma.outreachMessage.update({
    where: { id: message.id },
    data: {
      subject: edit.subject,
      body: edit.body,
      characterCount: edit.body.length,
      editedByCrmUserId: actor.crmUserId,
      editedAt: new Date(),
      ...withRevision(message, actor, 'Edited by Sales'),
    },
  })
  await record(actor, campaign.id, 'draft_edited', 'OutreachAction', actionId, `Draft edited${reopened ? ' after approval — back to review' : ''}`)
  if (reopened) await syncEngagement(actor.tenantId, [actionId])
  return { actionId }
}

export interface InputsPatch extends MessageInputs {
  recipientEmail?: string | null
}

export async function setInputs(actor: Actor, actionId: string, patch: InputsPatch) {
  const { campaign, action, message } = await requireEditable(actor, actionId)
  const { recipientEmail, ...inputPatch } = patch
  const merged: MessageInputs = { ...((message.inputs ?? {}) as MessageInputs), ...inputPatch }
  if (Array.isArray(merged.skus)) merged.skus = merged.skus.map((s) => s.trim()).slice(0, 5)

  // A value entered now fills the placeholder still visible in the draft.
  const values = valuesFromInputs(merged)
  const subject = message.subject ? fill(message.subject, values) : message.subject
  const body = fill(message.body, values)
  const reopened = await backToDraftIfApproved(actionId, action.status)
  await prisma.outreachMessage.update({
    where: { id: message.id },
    data: {
      inputs: merged as never,
      ...(subject !== message.subject || body !== message.body
        ? { subject, body, characterCount: body.length, ...withRevision(message, actor, 'Values entered by Sales') }
        : {}),
    },
  })
  if (recipientEmail !== undefined) {
    const email = recipientEmail?.trim() || null
    await prisma.outreachCampaign.update({
      where: { id: campaign.id },
      data: { recipientEmail: email, recipientEmailSource: email ? 'sales_entered' : null },
    })
    await prisma.outreachAction.updateMany({
      where: { campaignId: campaign.id, status: { in: ['draft', 'ready_to_send'] } },
      data: { destination: email, destinationKind: email ? 'email' : null },
    })
  }
  await record(actor, campaign.id, 'inputs_entered', 'OutreachAction', actionId, 'Values entered by Sales', {
    keys: Object.keys(patch),
  })
  if (reopened) await syncEngagement(actor.tenantId, [actionId])
  return { actionId }
}

/** The attestation statement with the product and company this draft uses. */
function attestationText(statement: string, action: LoadedAction, companyName: string | null): string {
  const resolution = ((action.message?.personalization as { resolution?: Array<{ placeholder: string; value: string | null }> } | null)?.resolution ?? [])
  const inputs = (action.message?.inputs ?? {}) as MessageInputs
  const product = inputs.product?.trim() || resolution.find((r) => r.placeholder === 'product')?.value || 'the product'
  return statement.split('{Product}').join(product).split('{Company}').join(companyDisplayName(companyName) ?? 'the company')
}

export async function attest(actor: Actor, actionId: string, key: 'ai_test' | 'report_attached', confirmed: boolean) {
  const { campaign, action, message } = await requireEditable(actor, actionId)
  const template = templateOfAction(campaign, action.stageKey as StageKey)
  const def = template.attestations.find((a) => a.key === key)
  if (!def) throw new BadRequestError('This email has no such confirmation.')
  const current = ((message.attestations ?? []) as unknown as Attestation[]).filter((a) => a.key !== key)
  const next: Attestation[] = confirmed
    ? [...current, { key, statement: attestationText(def.statement, action, campaign.companyName), byCrmUserId: actor.crmUserId, at: new Date().toISOString() }]
    : current
  await prisma.outreachMessage.update({ where: { id: message.id }, data: { attestations: next as never } })
  await record(actor, campaign.id, confirmed ? 'attested' : 'attestation_withdrawn', 'OutreachAction', actionId, confirmed ? `Confirmed: ${attestationText(def.statement, action, campaign.companyName)}` : 'Confirmation withdrawn')
  return { actionId }
}

export async function switchVersion(actor: Actor, actionId: string, version: InitialVersion) {
  const { campaign, action } = await requireEditable(actor, actionId)
  if (action.stageKey !== 'initial') throw new BadRequestError('Only the initial email has versions.')
  if (action.status !== 'draft') throw new ConflictError('Reopen the draft before switching version.')
  if (!INITIAL_VERSIONS.includes(version)) throw new BadRequestError('Unknown version.')
  if (campaign.initialVersion === version) return { actionId }
  await prisma.outreachCampaign.update({ where: { id: campaign.id }, data: { initialVersion: version, versionSource: 'sales_override' } })
  // The test statement differs by version, so its confirmation does not carry over.
  await prisma.outreachMessage.update({ where: { id: action.message!.id }, data: { attestations: [] as never } })
  await record(actor, campaign.id, 'version_switched', 'OutreachCampaign', campaign.id, `Initial email switched to Version ${version.slice(1)}`)
  return prepareStage(actor, campaign.id, 'initial')
}

export async function removeExpoParagraph(actor: Actor, actionId: string) {
  const { campaign, action, message } = await requireEditable(actor, actionId)
  if (action.stageKey !== 'reply_followup') throw new BadRequestError('Only the 2.1 follow-up carries the expo paragraph.')
  const body = withoutExpoParagraph(message.body)
  if (body === message.body) return { actionId }
  await backToDraftIfApproved(actionId, action.status)
  await prisma.outreachMessage.update({
    where: { id: message.id },
    data: { body, characterCount: body.length, editedByCrmUserId: actor.crmUserId, editedAt: new Date(), ...withRevision(message, actor, 'Expo paragraph removed (the expo has passed)') },
  })
  await record(actor, campaign.id, 'expo_paragraph_removed', 'OutreachAction', actionId, 'Expo paragraph removed from the 2.1 follow-up')
  return { actionId }
}

// ── Review ─────────────────────────────────────────────────────────────────

export async function approve(actor: Actor, actionId: string) {
  const { campaign, action } = await loadAction(actor.tenantId, actionId)
  if (!action.stageKey || action.stageKey === CALL_POINTS_STAGE || !action.message) throw new BadRequestError('Only sequence drafts can be approved.')
  const now = new Date()
  const gates = await gatesFor(campaign, action, sequenceOf(campaign, now), now)
  if (!gates.ok) {
    throw new ConflictError('This draft cannot be approved yet.', { items: gates.items.filter((i) => !i.ok) })
  }
  await prisma.outreachAction.update({
    where: { id: actionId },
    data: {
      status: 'ready_to_send',
      statusReason: null,
      approvedByCrmUserId: actor.crmUserId,
      approvedAt: now,
      approvedBodyHash: bodyHash(action.message.subject, action.message.body),
      validation: gates as never,
      validationOk: true,
    },
  })
  await record(actor, campaign.id, 'approved', 'OutreachAction', actionId, `Approved: ${templateOfAction(campaign, action.stageKey as StageKey).label}`)
  await syncEngagement(actor.tenantId, [actionId])
  // In a test batch, approval is what makes an email eligible to be sent — to
  // the internal test inbox, at its planned time.
  if (campaign.isTest && campaign.batchId) await scheduleTestSend(actor, actionId, now)
  return { actionId }
}

// ── TEST MODE sending (2026-09-28) ─────────────────────────────────────────

const windowOf = windowOfBatch

/**
 * Places an APPROVED email of a test batch on the schedule. The initial email
 * keeps the slot planned when the batch was created (or the next free one);
 * a follow-up goes inside its PDF window, or — if none is left — is not
 * scheduled at all. Nothing is ever scheduled that Sales did not approve.
 */
export async function scheduleTestSend(actor: Actor, actionId: string, now = new Date()) {
  const { campaign, action } = await loadAction(actor.tenantId, actionId)
  if (!campaign.isTest || !campaign.batchId) throw new ConflictError('Only emails in a test batch are sent by the platform.')
  if (!APPROVED_UNSENT.includes(action.status)) throw new ConflictError('Only an approved email can be scheduled.')
  const batch = await prisma.outreachBatch.findFirst({ where: { id: campaign.batchId, tenantId: actor.tenantId } })
  if (!batch || batch.status === 'cancelled' || batch.status === 'completed') throw new ConflictError('This test batch is no longer running.')
  const w = windowOf(batch)
  const members = await prisma.outreachCampaign.findMany({ where: { batchId: batch.id }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  const index = Math.max(0, members.findIndex((m) => m.id === campaign.id))

  let slot: Date | null
  if (action.stageKey === 'initial') {
    const planned = action.scheduledAt && action.scheduledAt.getTime() > now.getTime() ? action.scheduledAt : now
    slot = nextSendSlot(planned, w)
  } else {
    const view = sequenceOf(campaign, now).stages.find((s) => s.stageKey === action.stageKey)
    const window = view?.window ?? (action.dueStartAt && action.dueEndAt ? { start: action.dueStartAt, end: action.dueEndAt } : null)
    slot = window ? followUpSlot({ window, index, spacingMinutes: batch.spacingMinutes, w, now }) : null
  }

  if (!slot) {
    await prisma.outreachAction.update({
      where: { id: actionId },
      data: {
        status: 'ready_to_send',
        statusReason: 'Approved, but no sending slot is left inside this step’s PDF window and the batch’s sending hours — it will not be sent automatically.',
      },
    })
    return { actionId, scheduledAt: null }
  }
  await prisma.outreachAction.update({ where: { id: actionId }, data: { status: 'scheduled', statusReason: null, scheduledAt: slot } })
  await record(actor, campaign.id, 'test_scheduled', 'OutreachAction', actionId, `TEST send scheduled for ${slot.toISOString()} — to the internal test inbox only`)
  return { actionId, scheduledAt: slot.toISOString() }
}

/** "Send test to me": a one-off preview to the requester's own internal inbox. Changes no status. */
export async function sendTestPreview(actor: Actor & { email?: string | null }, actionId: string) {
  const { campaign, action } = await loadAction(actor.tenantId, actionId)
  if (!action.stageKey || action.stageKey === CALL_POINTS_STAGE || !action.message) throw new BadRequestError('Only sequence emails can be previewed.')
  const outcome = await deliverTestEmail({
    tenantId: actor.tenantId,
    actionId,
    campaignId: campaign.id,
    kind: 'preview',
    intendedRecipient: campaign.recipientEmail,
    subject: action.message.subject,
    body: action.message.body,
    sender: await readSenderFor(actor.tenantId, campaign.requestedByCrmUserId),
    requester: actor.email ?? null,
    triggeredBy: actor.crmUserId,
  })
  await record(
    actor,
    campaign.id,
    'test_preview',
    'OutreachAction',
    actionId,
    outcome.status === 'accepted' ? `Test preview sent to ${outcome.to.join(', ')} (${outcome.transport})` : `Test preview not sent: ${outcome.error}`,
  )
  return outcome
}

/**
 * The scheduler's send of one due test email. Every check runs again at the
 * moment of sending; any that fails records WHY the email was not sent. The
 * email goes only to the internal test inbox (deliver.ts → guard.ts).
 */
export async function runScheduledTestSend(actionId: string, now = new Date()): Promise<'sent' | 'failed' | 'not_sent' | 'skipped'> {
  // Claim it, so two schedulers can never send the same email.
  const claimed = await prisma.outreachAction.updateMany({
    where: { id: actionId, status: 'scheduled', scheduledAt: { lte: now } },
    data: { status: 'sending' },
  })
  if (claimed.count === 0) return 'skipped'
  const row = await prisma.outreachAction.findUnique({ where: { id: actionId }, select: { tenantId: true } })
  const system: Actor = { tenantId: row!.tenantId, crmUserId: 'scheduler' }
  const { campaign, action } = await loadAction(system.tenantId, actionId)
  const notSent = async (status: string, reason: string) => {
    await prisma.outreachAction.update({ where: { id: actionId }, data: { status, statusReason: reason } })
    await record(system, campaign.id, 'test_not_sent', 'OutreachAction', actionId, `TEST send not made: ${reason}`)
    return 'not_sent' as const
  }

  if (!campaign.isTest) return notSent('ready_to_send', 'Only test campaigns are sent by the platform; this email was not sent.')
  if (campaign.status === 'cancelled' || campaign.status === 'completed') {
    return notSent('cancelled', campaign.statusReason ?? 'The sequence was stopped.')
  }
  if (campaign.status !== 'active') {
    // Paused: it waits, and goes once the sequence is resumed.
    await prisma.outreachAction.update({ where: { id: actionId }, data: { status: 'scheduled' } })
    return 'skipped'
  }
  const message = action.message
  if (!message || action.approvedBodyHash !== bodyHash(message.subject, message.body)) {
    return notSent('draft', 'The email changed after it was approved — review and approve it again.')
  }
  const stage = sequenceOf(campaign, now).stages.find((s) => s.stageKey === action.stageKey)
  if (stage?.status === 'not_applicable') return notSent('cancelled', stage.reason ?? 'This step no longer applies.')
  if (action.dueEndAt && now.getTime() > action.dueEndAt.getTime()) {
    return notSent('ready_to_send', 'This step’s PDF window closed before it could be sent.')
  }
  const suppression = await suppressionFor(campaign, templateOfAction(campaign, action.stageKey as StageKey))
  if (suppression.suppressed) return notSent('cancelled', `The company is suppressed: ${suppression.detail ?? suppression.reason}`)

  const outcome = await deliverTestEmail({
    tenantId: system.tenantId,
    actionId,
    campaignId: campaign.id,
    kind: 'scheduled',
    intendedRecipient: campaign.recipientEmail,
    subject: message.subject,
    body: message.body,
    sender: await readSenderFor(system.tenantId, campaign.requestedByCrmUserId),
    triggeredBy: 'scheduler',
  })
  if (outcome.status !== 'accepted') {
    await prisma.outreachAction.update({
      where: { id: actionId },
      data: { status: 'failed', statusReason: outcome.error, retryCount: { increment: 1 }, failureKind: outcome.status === 'blocked' ? 'guard' : 'transient' },
    })
    await record(system, campaign.id, 'test_failed', 'OutreachAction', actionId, `TEST send failed: ${outcome.error}`)
    return 'failed'
  }
  await prisma.outreachAction.update({
    where: { id: actionId },
    data: { status: 'sent', sentAt: now, sentVia: 'platform_test', providerName: `test_${outcome.transport}`, providerMessageId: outcome.messageId, statusReason: null },
  })
  if (action.stageKey === 'breakup' || action.stageKey === 'sku_report') {
    await prisma.outreachCampaign.update({
      where: { id: campaign.id },
      data: { status: 'completed', statusReason: action.stageKey === 'breakup' ? 'Break-up email sent (test) — sequence complete.' : 'Report delivered (test) — sequence complete.' },
    })
  }
  await record(system, campaign.id, 'test_sent', 'OutreachAction', actionId, `TEST sent to ${outcome.to.join(', ')} (${outcome.transport}) — the customer was not contacted`)
  return 'sent'
}

/** For a running test batch: prepares each no-reply follow-up once the PDF timing allows. */
export async function prepareDueTestFollowUps(tenantId: string, campaignId: string, now = new Date()): Promise<number> {
  const campaign = await loadCampaign(tenantId, campaignId)
  if (!campaign.isTest || campaign.status !== 'active') return 0
  const seq = sequenceOf(campaign, now)
  let prepared = 0
  for (const s of seq.stages) {
    if (s.track !== 'no_reply' || !s.canPrepare) continue
    const live = campaign.actions.find((a) => a.stageKey === s.stageKey && a.status !== 'cancelled')
    if (live) continue
    try {
      await prepareStage({ tenantId, crmUserId: 'scheduler' }, campaignId, s.stageKey)
      prepared++
    } catch (err) {
      logger.info({ err: (err as Error).message, campaignId, stage: s.stageKey }, 'test batch: follow-up not prepared')
    }
  }
  return prepared
}

/** One row per email of a set of test campaigns — for the batch screen. */
export async function testCampaignSummaries(tenantId: string, campaignIds: string[], now = new Date()) {
  const out = []
  for (const id of campaignIds) {
    const c = await loadCampaign(tenantId, id)
    const seq = sequenceOf(c, now)
    const attempts = await prisma.outreachSendAttempt.findMany({ where: { campaignId: id }, orderBy: { createdAt: 'desc' }, take: 50 })
    out.push({
      campaignId: c.id,
      crmCompanyId: c.crmCompanyId,
      companyName: c.companyName,
      status: c.status,
      statusReason: c.statusReason,
      intendedRecipient: c.recipientEmail,
      phase: seq.phase,
      stages: seq.stages.map((s) => {
        const a = c.actions.find((x) => x.stageKey === s.stageKey && x.status !== 'cancelled') ?? c.actions.filter((x) => x.stageKey === s.stageKey).pop() ?? null
        const last = a ? attempts.find((t) => t.actionId === a.id && t.kind === 'scheduled') ?? null : null
        return {
          stageKey: s.stageKey,
          pdfRef: s.pdfRef,
          label: s.label,
          track: s.track,
          stageStatus: s.status,
          reason: s.reason,
          window: s.window ? { start: s.window.start.toISOString(), end: s.window.end.toISOString() } : null,
          actionId: a?.id ?? null,
          actionStatus: a?.status ?? null,
          statusReason: a?.statusReason ?? null,
          scheduledAt: a && (a.status === 'scheduled' || a.status === 'draft') ? a.scheduledAt.toISOString() : null,
          sentAt: a?.sentAt?.toISOString() ?? null,
          sentVia: a?.sentVia ?? null,
          lastAttempt: last ? { status: last.status, at: last.createdAt.toISOString(), error: last.error, to: last.actualRecipients } : null,
        }
      }),
    })
  }
  return out
}

export async function reject(actor: Actor, actionId: string, reason: string, regenerate: boolean) {
  const { campaign, action } = await requireEditable(actor, actionId)
  await prisma.outreachAction.update({
    where: { id: actionId },
    data: { status: 'cancelled', statusReason: reason.trim() || 'Rejected by Sales', approvedAt: null, approvedByCrmUserId: null, approvedBodyHash: null },
  })
  await record(actor, campaign.id, 'rejected', 'OutreachAction', actionId, `Draft rejected: ${reason.trim() || 'no reason given'}`)
  await syncEngagement(actor.tenantId, [actionId])
  if (regenerate) return prepareStage(actor, campaign.id, action.stageKey as StageKey)
  return { actionId }
}

export async function markSent(actor: Actor, actionId: string, sentAtRaw?: string | null) {
  const { campaign, action } = await loadAction(actor.tenantId, actionId)
  if (!action.stageKey || action.stageKey === CALL_POINTS_STAGE || !action.message) throw new BadRequestError('Only sequence emails can be marked sent.')
  if (campaign.isTest) throw new ConflictError('This is a TEST campaign: its emails are sent to the internal test inbox by the test sender, not marked sent by hand.')
  if (action.status !== 'ready_to_send') throw new ConflictError('Only an approved email can be marked sent.')
  if (action.approvedBodyHash !== bodyHash(action.message.subject, action.message.body)) {
    throw new ConflictError('The email changed after it was approved. Review and approve it again.')
  }
  const now = new Date()
  const sentAt = sentAtRaw ? new Date(sentAtRaw) : now
  if (Number.isNaN(sentAt.getTime()) || sentAt.getTime() > now.getTime() + 5 * 60_000) throw new BadRequestError('The sent time cannot be in the future.')
  if (action.approvedAt && sentAt.getTime() < action.approvedAt.getTime() - 60_000) throw new BadRequestError('The sent time cannot be before the approval.')

  const suppression = await suppressionFor(campaign, templateOfAction(campaign, action.stageKey as StageKey))
  if (suppression.suppressed) throw new ConflictError(`This company is suppressed: ${suppression.detail ?? suppression.reason}`)

  await prisma.outreachAction.update({ where: { id: actionId }, data: { status: 'sent', sentAt, sentByCrmUserId: actor.crmUserId } })
  // The break-up email ends the no-reply track; the report ends the reply track.
  if (action.stageKey === 'breakup' || action.stageKey === 'sku_report') {
    await prisma.outreachCampaign.update({
      where: { id: campaign.id },
      data: { status: 'completed', statusReason: action.stageKey === 'breakup' ? 'Break-up email sent — sequence complete.' : 'Report delivered — sequence complete.' },
    })
  }
  await record(actor, campaign.id, 'marked_sent', 'OutreachAction', actionId, `Marked sent by Sales: ${templateOfAction(campaign, action.stageKey as StageKey).label}`, {
    sentAt: sentAt.toISOString(),
  })
  await syncEngagement(actor.tenantId, [actionId])
  return { actionId }
}

export async function skipStage(actor: Actor, campaignId: string, stageKey: StageKey, reason: string) {
  const campaign = await loadCampaign(actor.tenantId, campaignId)
  const existing = campaign.actions.find((a) => a.stageKey === stageKey)
  if (existing?.status === 'sent') throw new ConflictError('That email was already sent.')
  const note = reason.trim() || 'Skipped by Sales'
  let actionId: string
  if (existing) {
    actionId = existing.id
    await prisma.outreachAction.update({ where: { id: existing.id }, data: { status: 'skipped', statusReason: note } })
  } else {
    actionId = newId()
    await prisma.outreachAction.create({
      data: {
        id: actionId,
        tenantId: actor.tenantId,
        campaignId,
        crmCompanyId: campaign.crmCompanyId,
        companyName: campaign.companyName,
        channel: stageKey === 'initial' ? 'email' : 'email_followup',
        stepNumber: STAGE_STEP_NUMBER[stageKey],
        stageKey,
        status: 'skipped',
        statusReason: note,
        idempotencyKey: idempotencyKey(actor.tenantId, campaign.crmCompanyId, campaignId, stageKey, campaign.isTest),
        providerName: 'manual_send',
        scheduledAt: new Date(),
      },
    })
  }
  await record(actor, campaignId, 'stage_skipped', 'OutreachAction', actionId, `Skipped: ${templateFor(stageKey, stageKey === 'initial' ? 'v1' : null).label} — ${note}`)
  return { actionId }
}

// ── Replies ────────────────────────────────────────────────────────────────

export async function addReply(actor: Actor, campaignId: string, input: { text: string; receivedAt: string }) {
  const campaign = await loadCampaign(actor.tenantId, campaignId)
  const text = input.text.trim()
  if (text.length < 2) throw new BadRequestError('Paste the reply text.')
  const receivedAt = new Date(input.receivedAt)
  if (Number.isNaN(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 5 * 60_000) {
    throw new BadRequestError('The received date must be a real date, not in the future.')
  }
  const seq = sequenceOf(campaign)
  const sent = seq.stages.filter((s) => s.status === 'done').map((s) => `${s.pdfRef} ${s.label}`)
  const reading = await classifyReply({
    text,
    stageContext: sent.length ? `Emails already sent to this prospect: ${sent.join('; ')}.` : 'No email has been marked sent yet.',
    tenantId: actor.tenantId,
  })
  const id = newId()
  await prisma.outreachReply.create({
    data: {
      id,
      tenantId: actor.tenantId,
      campaignId,
      receivedAt,
      text,
      modelClassification: reading.classification,
      modelEvidenceQuote: reading.evidenceQuote,
      modelSkus: reading.skus as never,
      modelChecks: reading.checks as never,
      enteredByCrmUserId: actor.crmUserId,
    },
  })
  await record(actor, campaignId, 'reply_added', 'OutreachReply', id, `Reply pasted — read as "${REPLY_LABELS[reading.classification]}" (not yet confirmed)`)
  return { replyId: id, reading }
}

export async function confirmReply(actor: Actor, replyId: string, input: { classification: ReplyClass; skus?: string[] }) {
  const reply = await prisma.outreachReply.findFirst({ where: { id: replyId, tenantId: actor.tenantId } })
  if (!reply) throw new NotFoundError('Reply not found.')
  if (reply.confirmedAt) throw new ConflictError('This reply was already confirmed.')
  if (input.classification === 'unclear') throw new BadRequestError('Choose what kind of reply this is before confirming.')

  const skus = (input.skus ?? (Array.isArray(reply.modelSkus) ? (reply.modelSkus as string[]) : []))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5)
  await prisma.outreachReply.update({
    where: { id: replyId },
    data: {
      classification: input.classification,
      classificationSource: input.classification === reply.modelClassification ? 'model' : 'sales_override',
      skus: (input.classification === 'sent_skus' ? skus : []) as never,
      confirmedByCrmUserId: actor.crmUserId,
      confirmedAt: new Date(),
    },
  })

  // Any reply ends the no-reply track: unsent follow-ups no longer apply.
  const cancelled = await prisma.outreachAction.findMany({
    // Scheduled and failed test sends are unsent too: a reply stops them as well.
    where: { campaignId: reply.campaignId, stageKey: { in: NO_REPLY_STAGES }, status: { in: ['draft', ...APPROVED_UNSENT] } },
    select: { id: true },
  })
  if (cancelled.length) {
    await prisma.outreachAction.updateMany({
      where: { id: { in: cancelled.map((c) => c.id) } },
      data: { status: 'cancelled', statusReason: 'The prospect replied.' },
    })
  }
  const status =
    input.classification === 'not_interested' ? 'cancelled' : input.classification === 'follow_up_later' ? 'paused' : 'active'
  await prisma.outreachCampaign.update({
    where: { id: reply.campaignId },
    data: {
      status,
      statusReason:
        status === 'cancelled' ? 'The prospect is not interested.' : status === 'paused' ? 'The prospect asked to be contacted later.' : null,
    },
  })
  await record(actor, reply.campaignId, 'reply_confirmed', 'OutreachReply', replyId, `Reply confirmed as "${REPLY_LABELS[input.classification]}"${skus.length && input.classification === 'sent_skus' ? ` — ${skus.length} SKU(s)` : ''}`)
  if (cancelled.length) await syncEngagement(actor.tenantId, cancelled.map((c) => c.id))

  // The approved template for this kind of reply, drafted for review.
  let prepared: string | null = null
  const next: StageKey | null =
    input.classification === 'sent_skus' ? 'reply_followup' : input.classification === 'interested_cannot_attend_expo' ? 'expo_cannot_attend' : null
  if (next) {
    try {
      prepared = (await prepareStage(actor, reply.campaignId, next)).actionId
    } catch (err) {
      logger.info({ err: (err as Error).message, next }, 'sales sequence: follow-up draft not prepared automatically')
    }
  }
  return { replyId, preparedActionId: prepared }
}

// ── The campaign as a whole ────────────────────────────────────────────────

export async function setCampaignState(actor: Actor, campaignId: string, to: 'stop' | 'pause' | 'resume', reason?: string) {
  const campaign = await loadCampaign(actor.tenantId, campaignId)
  const status = to === 'stop' ? 'cancelled' : to === 'pause' ? 'paused' : 'active'
  await prisma.outreachCampaign.update({
    where: { id: campaignId },
    data: { status, statusReason: to === 'resume' ? null : reason?.trim() || (to === 'stop' ? 'Stopped by Sales.' : 'Paused by Sales.') },
  })
  await record(actor, campaignId, to === 'stop' ? 'stopped' : to === 'pause' ? 'paused' : 'resumed', 'OutreachCampaign', campaignId, `Sequence ${to === 'stop' ? 'stopped' : to === 'pause' ? 'paused' : 'resumed'}${reason?.trim() ? `: ${reason.trim()}` : ''}`)
  return { campaignId: campaign.id, status }
}

export async function createCallPoints(actor: Actor, campaignId: string) {
  const campaign = await loadCampaign(actor.tenantId, campaignId)
  const facts = await loadProspectFacts(actor.tenantId, campaign.crmCompanyId)
  if (!facts) throw new NotFoundError('Company not found.')
  const seq = sequenceOf(campaign)
  const historyLines = [
    ...seq.stages.filter((s) => s.status === 'done').map((s) => `Sent: ${s.pdfRef} ${s.label}`),
    ...campaign.replies
      .filter((r) => r.confirmedAt)
      .map((r) => `Their reply (${r.receivedAt.toISOString().slice(0, 10)}, ${REPLY_LABELS[r.classification as ReplyClass] ?? r.classification}): ${r.text.slice(0, 300)}`),
  ]
  const result = await generateCallPoints({ facts, historyLines, currentStage: seq.next.text, tenantId: actor.tenantId })
  const body = result.points.map((p) => `• ${p.text}`).join('\n')
  const existing = campaign.actions.find((a) => a.stageKey === CALL_POINTS_STAGE)
  const personalization = { points: result.points, dropped: result.dropped, model: result.model, facts: facts.facts, historyLines, preparedAt: new Date().toISOString() }
  let actionId: string
  if (existing) {
    actionId = existing.id
    await prisma.outreachAction.update({ where: { id: existing.id }, data: { status: 'manual_required', statusReason: 'Call talking points for Sales.' } })
    if (existing.message) {
      await prisma.outreachMessage.update({ where: { id: existing.message.id }, data: { body, characterCount: body.length, personalization: personalization as never } })
    }
  } else {
    actionId = newId()
    await prisma.outreachAction.create({
      data: {
        id: actionId,
        tenantId: actor.tenantId,
        campaignId,
        crmCompanyId: campaign.crmCompanyId,
        companyName: campaign.companyName,
        channel: 'call',
        stepNumber: CALL_POINTS_STEP_NUMBER,
        stageKey: CALL_POINTS_STAGE,
        status: 'manual_required',
        statusReason: 'Call talking points for Sales.',
        contactName: facts.decisionMaker?.fullName ?? null,
        contactTitle: facts.decisionMaker?.title ?? null,
        decisionMakerId: facts.decisionMaker?.id ?? null,
        destinationKind: 'internal_task',
        idempotencyKey: idempotencyKey(actor.tenantId, campaign.crmCompanyId, campaignId, CALL_POINTS_STAGE),
        providerName: 'call_task',
        scheduledAt: new Date(),
      },
    })
    await prisma.outreachMessage.create({
      data: { id: newId(), tenantId: actor.tenantId, actionId, templateKey: 'call.talking_points', templateVersion: TEMPLATE_SET_VERSION, body, characterCount: body.length, personalization: personalization as never },
    })
  }
  await record(actor, campaignId, 'call_points', 'OutreachAction', actionId, 'Call talking points prepared')
  await syncEngagement(actor.tenantId, [actionId])
  return { actionId, points: result.points, dropped: result.dropped }
}

// ── Reading ────────────────────────────────────────────────────────────────

function windowJson(w: { start: Date; end: Date } | null) {
  return w ? { start: w.start.toISOString(), end: w.end.toISOString() } : null
}

export async function listProspects(tenantId: string, now = new Date()) {
  const campaigns = await prisma.outreachCampaign.findMany({
    // Real sequences only: test rehearsals live on the Test batches screen.
    where: { tenantId, flow: FLOW, isTest: false },
    orderBy: { updatedAt: 'desc' },
    take: 500,
    include: {
      actions: { select: { stageKey: true, status: true, sentAt: true, contactName: true, updatedAt: true } },
      replies: { select: { classification: true, confirmedAt: true, receivedAt: true } },
    },
  })
  const rows = campaigns.map((c) => {
    const seq = computeSequence({
      campaignStatus: c.status,
      actions: c.actions.filter((a) => a.stageKey && a.stageKey !== CALL_POINTS_STAGE).map((a) => ({ stageKey: a.stageKey as StageKey, status: a.status, sentAt: a.sentAt })),
      replies: c.replies.filter((r) => r.classification && r.confirmedAt).map((r) => ({ receivedAt: r.receivedAt, classification: r.classification as ReplyClass })),
      now,
      tz: tz(),
    })
    const lastActivity = [c.updatedAt, ...c.actions.map((a) => a.updatedAt)].sort((a, b) => b.getTime() - a.getTime())[0]!
    const pendingReplies = c.replies.filter((r) => !r.confirmedAt).length
    return {
      campaignId: c.id,
      crmCompanyId: c.crmCompanyId,
      companyName: c.companyName,
      contactName: c.actions.find((a) => a.contactName)?.contactName ?? null,
      initialVersion: c.initialVersion,
      status: c.status,
      phase: seq.phase,
      next: { ...seq.next, window: windowJson(seq.next.window) },
      pendingReplies,
      lastActivityAt: lastActivity.toISOString(),
    }
  })
  // What needs a person first: overdue, then due soonest, then most recent.
  rows.sort((a, b) => {
    if (a.next.overdue !== b.next.overdue) return a.next.overdue ? -1 : 1
    const as = a.next.window?.start ?? null
    const bs = b.next.window?.start ?? null
    if (as && bs && as !== bs) return as < bs ? -1 : 1
    if (as && !bs) return -1
    if (!as && bs) return 1
    return a.lastActivityAt < b.lastActivityAt ? 1 : -1
  })
  return rows
}

export async function companyView(tenantId: string, crmCompanyId: string, now = new Date(), campaignId?: string | null, viewerCrmUserId?: string | null) {
  const facts = await loadProspectFacts(tenantId, crmCompanyId)
  if (!facts) throw new NotFoundError('Company not found.')
  const summary = factsSummary(facts)
  const gate = facts.decisionMaker
    ? { ready: true, reason: null }
    : { ready: false, reason: 'No decision maker has been shortlisted for this company yet. Run Decision Makers first — every approved email is addressed to a named person.' }

  // The company's real sequence — or, when asked for by id, one of its test campaigns.
  const found = campaignId
    ? await prisma.outreachCampaign.findFirst({ where: { id: campaignId, tenantId, crmCompanyId, flow: FLOW }, select: { id: true } })
    : await prisma.outreachCampaign.findFirst({ where: { tenantId, crmCompanyId, flow: FLOW, isTest: false }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (!found) {
    // Not started yet: it would be signed as whoever is looking (and starts it).
    const sender = await readSenderFor(tenantId, viewerCrmUserId)
    return { crmCompanyId, facts: summary, gate, sender: { configured: Boolean(sender.firstName && sender.companyName), ...sender }, campaign: null, sequence: null, drafts: [], callPoints: null, replies: [], history: [] }
  }
  const campaign = await loadCampaign(tenantId, found.id)
  const seq = sequenceOf(campaign, now)
  // Signed as the person who started this outreach.
  const sender = await readSenderFor(tenantId, campaign.requestedByCrmUserId)

  const attemptRows = await prisma.outreachSendAttempt.findMany({ where: { campaignId: campaign.id }, orderBy: { createdAt: 'desc' }, take: 200 })
  const drafts = []
  for (const a of campaign.actions.filter((x) => x.stageKey && x.stageKey !== CALL_POINTS_STAGE)) {
    const stageKey = a.stageKey as StageKey
    const template = templateOfAction(campaign, stageKey)
    const reviewable = a.status === 'draft' || APPROVED_UNSENT.includes(a.status)
    drafts.push({
      actionId: a.id,
      stageKey,
      label: template.label,
      pdfRef: template.pdfRef,
      version: stageKey === 'initial' ? campaign.initialVersion : null,
      status: a.status,
      statusReason: a.statusReason,
      recipient: campaign.recipientEmail,
      recipientSource: campaign.recipientEmailSource,
      contactName: a.contactName,
      contactTitle: a.contactTitle,
      subject: a.message?.subject ?? null,
      body: a.message?.body ?? '',
      draftSubject: a.message?.draftSubject ?? null,
      draftBody: a.message?.draftBody ?? null,
      edited: Boolean(a.message?.editedAt),
      revision: a.message?.revision ?? 1,
      templateKey: a.message?.templateKey ?? null,
      inputs: a.message?.inputs ?? {},
      attestations: a.message?.attestations ?? [],
      attestationDefs: template.attestations.map((d) => ({ key: d.key, statement: attestationText(d.statement, a, campaign.companyName), maxAgeDays: d.maxAgeDays })),
      requiredInputs: template.requiredInputs,
      needsConfirmedSkus: template.needsConfirmedSkus,
      mentionsExpo: template.mentionsExpo,
      personalization: a.message?.personalization ?? null,
      dueStartAt: a.dueStartAt?.toISOString() ?? null,
      dueEndAt: a.dueEndAt?.toISOString() ?? null,
      approvedAt: a.approvedAt?.toISOString() ?? null,
      approvedByCrmUserId: a.approvedByCrmUserId,
      sentAt: a.sentAt?.toISOString() ?? null,
      sentByCrmUserId: a.sentByCrmUserId,
      sentVia: a.sentVia,
      scheduledAt: a.status === 'scheduled' ? a.scheduledAt.toISOString() : null,
      // Every attempt to deliver this email: previews and test sends.
      attempts: attemptRows
        .filter((t) => t.actionId === a.id)
        .slice(0, 20)
        .map((t) => ({
          id: t.id,
          at: t.createdAt.toISOString(),
          kind: t.kind,
          mode: t.mode,
          status: t.status,
          intendedRecipient: t.intendedRecipient,
          actualRecipients: Array.isArray(t.actualRecipients) ? (t.actualRecipients as string[]) : [],
          transport: t.transport,
          providerMessageId: t.providerMessageId,
          error: t.error,
        })),
      gates: reviewable ? await gatesFor(campaign, a, seq, now) : null,
    })
  }

  const callAction = campaign.actions.find((a) => a.stageKey === CALL_POINTS_STAGE)
  const events = await prisma.auditEvent.findMany({
    where: { tenantId, runId: campaign.id, action: { startsWith: 'outreach.sequence.' } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, action: true, summary: true, actorCrmUserId: true, createdAt: true },
  })
  const people = await prisma.tenantMember.findMany({
    where: { tenantId, crmUserId: { in: [...new Set(events.map((e) => e.actorCrmUserId).filter((x): x is string => Boolean(x)))] } },
    select: { crmUserId: true, name: true, email: true },
  })
  const nameOf = (id: string | null) => {
    const p = people.find((x) => x.crmUserId === id)
    return p ? p.name ?? p.email : null
  }

  return {
    crmCompanyId,
    facts: summary,
    gate,
    sender: { configured: Boolean(sender.firstName && sender.companyName), ...sender },
    campaign: {
      id: campaign.id,
      status: campaign.status,
      statusReason: campaign.statusReason,
      initialVersion: campaign.initialVersion,
      versionSource: campaign.versionSource,
      recipientEmail: campaign.recipientEmail,
      recipientEmailSource: campaign.recipientEmailSource,
      startedAt: campaign.createdAt.toISOString(),
      isTest: campaign.isTest,
      batchId: campaign.batchId,
    },
    sequence: {
      phase: seq.phase,
      initialSentAt: seq.initialSentAt?.toISOString() ?? null,
      next: { ...seq.next, window: windowJson(seq.next.window) },
      reminders: seq.reminders.map((r) => ({ label: r.label, window: windowJson(r.window) })),
      stages: seq.stages.map((s) => ({ ...s, window: windowJson(s.window) })),
    },
    drafts,
    callPoints: callAction?.message
      ? { actionId: callAction.id, body: callAction.message.body, personalization: callAction.message.personalization, updatedAt: callAction.updatedAt.toISOString() }
      : null,
    replies: campaign.replies.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt.toISOString(),
      text: r.text,
      modelClassification: r.modelClassification,
      modelEvidenceQuote: r.modelEvidenceQuote,
      modelSkus: r.modelSkus ?? [],
      modelChecks: r.modelChecks ?? [],
      classification: r.classification,
      classificationSource: r.classificationSource,
      skus: r.skus ?? [],
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      confirmedBy: nameOf(r.confirmedByCrmUserId),
    })),
    history: events.map((e) => ({ id: e.id, at: e.createdAt.toISOString(), action: e.action.replace('outreach.sequence.', ''), summary: e.summary, by: nameOf(e.actorCrmUserId) })),
  }
}

function factsSummary(f: ProspectFacts) {
  return {
    companyName: f.companyName,
    companyDomain: f.companyDomain,
    companySummary: f.companySummary,
    decisionMaker: f.decisionMaker,
    product: f.product,
    // The verified product page V1/V2/V3 link to, or why there is none.
    productPageUrl: f.productPageUrl ?? null,
    productPageNote: f.productPageNote ?? null,
    signals: f.signals,
    discovered: Boolean(f.discoveredCompanyId),
  }
}

export function approvedTemplates() {
  return STAGE_TEMPLATES.map((t) => ({
    key: t.key,
    version: t.version,
    label: t.label,
    pdfRef: t.pdfRef,
    subject: t.subject,
    body: t.body,
    trigger: t.trigger,
    requiredInputs: t.requiredInputs,
    attestations: t.attestations.map((a) => ({ key: a.key, statement: a.statement, maxAgeDays: a.maxAgeDays })),
    templateSet: TEMPLATE_SET_VERSION,
  }))
}
