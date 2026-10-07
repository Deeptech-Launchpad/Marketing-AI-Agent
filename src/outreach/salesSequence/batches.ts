import { env } from '../../config/env.js'
import { isEmailShaped } from '../../auth/accessList.js'
import { storedCompanyContactEmail } from '../../decisionmakers/companyContactEmail.js'
import { audit } from '../../platform/audit.js'
import { newId, prisma } from '../../platform/db.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../platform/errors.js'
import { windowOfBatch } from './sending/batchWindow.js'
import { parseClock, plannedInitialSlots } from './sending/schedule.js'
import { transportStatus } from './sending/transport.js'
import { readSenderFor } from './sender.js'
import {
  FLOW,
  approve,
  attest,
  planRotation,
  previewInitialEmail,
  setInputs,
  startSequence,
  testCampaignSummaries,
  type Actor,
  type InitialEmailPreview,
} from './service.js'
import { templateFor } from './templates.js'

// TEST BATCHES (2026-09-28).
//
// A batch is a rehearsal of the approved sequence for up to 10 companies. It
// creates each company's initial draft at once; Sales reviews and approves
// every email individually; only approved emails are scheduled, and the test
// sender delivers them to the INTERNAL test inbox — never to the customer.
// The sequence's own PDF timing is untouched: the batch only sets when the
// first emails go, the spacing, the sending hours and a daily cap.
//
// Test campaigns are kept apart from real ones: they do not appear in the real
// prospect list, Engagement or CRM Sync, and never block a real sequence.

export const MAX_BATCH_COMPANIES = 10
const OPEN_ACTION = ['draft', 'ready_to_send', 'scheduled', 'failed']

async function record(actor: Actor, batchId: string, action: string, summary: string, metadata?: Record<string, unknown>, kind: 'test_batch' | 'send_batch' = 'test_batch') {
  await audit({
    tenantId: actor.tenantId,
    actorType: actor.crmUserId === 'scheduler' ? 'system' : 'user',
    actorCrmUserId: actor.crmUserId,
    runId: batchId,
    action: `outreach.${kind}.${action}`,
    resourceType: 'OutreachBatch',
    resourceId: batchId,
    dataClass: 'customer_pii',
    summary,
    metadata: metadata ?? null,
    requestId: actor.requestId ?? null,
  })
}

/**
 * Companies a test batch can include: a shortlisted decision maker with an
 * email, or the verified company mailbox Decision Makers stored. Read from the
 * database only — no search, no provider call.
 */
export async function batchCandidates(tenantId: string) {
  const runs = await prisma.decisionMakerRun.findMany({
    where: { tenantId, status: 'completed' },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { id: true, crmCompanyId: true, companyName: true, companyDomain: true, providerResults: true },
  })
  const latest = new Map<string, (typeof runs)[number]>()
  for (const r of runs) if (!latest.has(r.crmCompanyId)) latest.set(r.crmCompanyId, r)

  // A company already in a real sequence is continued under One company; a
  // several-company send never starts a second sequence for it.
  const inOutreach = new Set(
    (
      await prisma.outreachCampaign.findMany({
        where: { tenantId, flow: FLOW, isTest: false, crmCompanyId: { in: [...latest.keys()] } },
        select: { crmCompanyId: true },
      })
    ).map((c) => c.crmCompanyId),
  )

  const out = []
  for (const run of latest.values()) {
    const dm = await prisma.decisionMakerCandidate.findFirst({
      where: { tenantId, dmRunId: run.id, outcome: 'shortlisted' },
      orderBy: { rank: 'asc' },
      select: { fullName: true, rawTitle: true, email: true },
    })
    const mailbox = dm && !dm.email ? storedCompanyContactEmail(run.providerResults) : null
    const recipient = dm?.email ?? mailbox?.email ?? null
    out.push({
      crmCompanyId: run.crmCompanyId,
      companyName: run.companyName ?? run.crmCompanyId,
      companyDomain: run.companyDomain,
      decisionMaker: dm ? { fullName: dm.fullName, title: dm.rawTitle } : null,
      intendedRecipient: recipient,
      recipientSource: dm?.email ? 'decision_maker' : mailbox ? 'company_mailbox' : null,
      ready: Boolean(dm && recipient),
      reason: !dm ? 'No shortlisted decision maker.' : !recipient ? 'No email for the decision maker and no verified company mailbox.' : null,
      inOutreach: inOutreach.has(run.crmCompanyId),
    })
  }
  return out.sort((a, b) => Number(b.ready) - Number(a.ready) || a.companyName.localeCompare(b.companyName))
}

export interface CreateBatchInput {
  name?: string
  crmCompanyIds: string[]
  /**
   * An address Sales typed for a company, keyed by crmCompanyId.
   *
   * It overrides whatever the platform worked out — the decision maker's own
   * address, or a verified company mailbox — and is recorded as sales_entered
   * so a reviewer can see it was a person's choice rather than a lookup. It is
   * also the only way to include a company no address was found for.
   */
  recipients?: Record<string, string>
  firstSendAt: string
  timezone?: string
  sendDays?: number[]
  sendStart?: string
  sendEnd?: string
  spacingMinutes?: number
  dailyCap?: number
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The schedule a batch was given, checked. Shared by test batches and several-company sends. */
function checkedSchedule(input: CreateBatchInput) {
  const firstSendAt = new Date(input.firstSendAt)
  if (Number.isNaN(firstSendAt.getTime())) throw new BadRequestError('Choose when the first test emails may go.')
  const timezone = (input.timezone ?? env.OUTREACH_SEQUENCE_TIMEZONE).trim()
  if (!validTimeZone(timezone)) throw new BadRequestError(`"${timezone}" is not a time zone.`)
  const sendDays = [...new Set((input.sendDays ?? [1, 2, 3, 4, 5]).map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort()
  if (sendDays.length === 0) throw new BadRequestError('Choose at least one sending day.')
  const sendStartMinute = parseClock(input.sendStart ?? '09:00')
  const sendEndMinute = parseClock(input.sendEnd ?? '17:00')
  if (sendStartMinute === null || sendEndMinute === null || sendEndMinute <= sendStartMinute) {
    throw new BadRequestError('Sending hours must be two times like 09:00 and 17:00, the first earlier than the second.')
  }
  const spacingMinutes = Math.round(Number(input.spacingMinutes ?? 10))
  if (!Number.isFinite(spacingMinutes) || spacingMinutes < 1 || spacingMinutes > 240) throw new BadRequestError('Spacing must be 1 to 240 minutes.')
  const dailyCap = Math.round(Number(input.dailyCap ?? 20))
  if (!Number.isFinite(dailyCap) || dailyCap < 1 || dailyCap > 200) throw new BadRequestError('The daily cap must be 1 to 200 emails.')
  return { firstSendAt, timezone, sendDays, sendStartMinute, sendEndMinute, spacingMinutes, dailyCap }
}

export async function createTestBatch(actor: Actor, input: CreateBatchInput) {
  const ids = [...new Set((input.crmCompanyIds ?? []).map((s) => String(s).trim()).filter(Boolean))]
  if (ids.length === 0) throw new BadRequestError('Choose at least one company.')
  if (ids.length > MAX_BATCH_COMPANIES) throw new BadRequestError(`A test batch holds at most ${MAX_BATCH_COMPANIES} companies.`)
  const { firstSendAt, timezone, sendDays, sendStartMinute, sendEndMinute, spacingMinutes, dailyCap } = checkedSchedule(input)
  const sender = await readSenderFor(actor.tenantId, actor.crmUserId)
  if (!sender.firstName.trim() || !sender.companyName.trim()) throw new ConflictError('Every email is signed with your name and the company name: make sure your NXT Sales user has a name, and an admin has set the company name in Settings → Outreach sender.')

  const batchId = newId()
  const name = (input.name ?? '').trim().slice(0, 120) || `Test batch ${new Date().toISOString().slice(0, 10)}`
  const batch = await prisma.outreachBatch.create({
    data: {
      id: batchId,
      tenantId: actor.tenantId,
      name,
      mode: 'test',
      status: 'running',
      firstSendAt,
      timezone,
      sendDays: sendDays as never,
      sendStartMinute,
      sendEndMinute,
      spacingMinutes,
      dailyCap,
      createdByCrmUserId: actor.crmUserId,
    },
  })
  const slots = plannedInitialSlots(firstSendAt, ids.length, spacingMinutes, windowOfBatch(batch))

  // Addresses Sales typed on the way in. Checked for shape here, so a typo is
  // refused before any draft is written rather than at approval time.
  const overrides = new Map<string, string>()
  for (const [id, raw] of Object.entries(input.recipients ?? {})) {
    const email = String(raw ?? '').trim()
    if (!email) continue
    if (!isEmailShaped(email)) throw new BadRequestError(`"${email}" is not an email address.`)
    overrides.set(String(id).trim(), email)
  }

  const results: Array<{ crmCompanyId: string; ok: boolean; campaignId: string | null; plannedAt: string | null; error: string | null }> = []
  for (const [i, crmCompanyId] of ids.entries()) {
    try {
      // An address Sales typed wins over the one worked out for them, and is
      // what lets a company with no shortlisted decision maker in at all. It
      // is given at creation, so the campaign and its first draft carry it
      // from the start rather than being corrected afterwards.
      const { campaignId } = await startSequence(actor, crmCompanyId, {
        isTest: true,
        batchId,
        recipientEmail: overrides.get(crmCompanyId) ?? null,
      })
      // The initial draft carries its planned slot; it is sent only once approved.
      const slot = slots[i] ?? null
      if (slot) {
        await prisma.outreachAction.updateMany({ where: { campaignId, stageKey: 'initial', status: 'draft' }, data: { scheduledAt: slot } })
      }
      results.push({ crmCompanyId, ok: true, campaignId, plannedAt: slot?.toISOString() ?? null, error: null })
    } catch (err) {
      results.push({ crmCompanyId, ok: false, campaignId: null, plannedAt: null, error: (err as Error).message })
    }
  }
  const created = results.filter((r) => r.ok).length
  if (created === 0) await prisma.outreachBatch.update({ where: { id: batchId }, data: { status: 'cancelled' } })
  await record(actor, batchId, 'created', `TEST batch "${name}" created: ${created} of ${ids.length} companies drafted — internal test inboxes only`, {
    results: results.map((r) => ({ crmCompanyId: r.crmCompanyId, ok: r.ok, error: r.error })),
  })
  return { batchId, created, results }
}

// ── SEVERAL COMPANIES: SELECT → CHECK ADDRESSES → SCHEDULE → REVIEW → SEND ──
//
// (2026-10-07) A real send to several companies, with no draft step. Review
// shows every company's first email exactly as it will be sent — the approved
// V1/V2/V3 copy with only the company, product, greeting and sender filled —
// and every problem. Send is the approval: one confirmation covers the batch,
// each email is approved with the same checks as One company, and each is
// given its time on the schedule. When its time comes it is listed as due,
// and the person sends it from their own mailbox and marks it sent — the
// platform never emails a customer itself.

export interface SendBatchInput extends CreateBatchInput {
  /** A greeting name Sales typed, by crmCompanyId — for a company with no named contact. */
  names?: Record<string, string>
  /** A product name Sales typed, by crmCompanyId — for a company with no analysed product. */
  products?: Record<string, string>
  /** The one confirmation: the queries the email states were run for each company. */
  confirmQueries?: boolean
}

function cleanIds(raw: string[] | undefined): string[] {
  const ids = [...new Set((raw ?? []).map((s) => String(s).trim()).filter(Boolean))]
  if (ids.length === 0) throw new BadRequestError('Choose at least one company.')
  if (ids.length > MAX_BATCH_COMPANIES) throw new BadRequestError(`At most ${MAX_BATCH_COMPANIES} companies can be sent to at once.`)
  return ids
}

function typedAddresses(recipients: Record<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, raw] of Object.entries(recipients ?? {})) {
    const email = String(raw ?? '').trim()
    if (!email) continue
    if (!isEmailShaped(email)) throw new BadRequestError(`"${email}" is not an email address.`)
    out.set(String(id).trim(), email)
  }
  return out
}

/** Every chosen company's first email, as it will be sent, with its problems. Nothing is written. */
export async function previewSendBatch(
  actor: Actor,
  input: { crmCompanyIds: string[]; recipients?: Record<string, string>; names?: Record<string, string>; products?: Record<string, string> },
) {
  const ids = cleanIds(input.crmCompanyIds)
  const typed = typedAddresses(input.recipients)
  const versions = await planRotation(actor.tenantId, ids.length)
  const emails: InitialEmailPreview[] = []
  for (const [i, crmCompanyId] of ids.entries()) {
    emails.push(
      await previewInitialEmail(actor, crmCompanyId, {
        version: versions[i]!,
        recipientEmail: typed.get(crmCompanyId) ?? null,
        name: input.names?.[crmCompanyId] ?? null,
        product: input.products?.[crmCompanyId] ?? null,
      }),
    )
  }
  return { emails, sending: transportStatus() }
}

export async function createSendBatch(actor: Actor, input: SendBatchInput) {
  const ids = cleanIds(input.crmCompanyIds)
  if (input.confirmQueries !== true) {
    throw new BadRequestError('Tick the confirmation that the queries these emails describe were run for each company.')
  }
  const { firstSendAt, timezone, sendDays, sendStartMinute, sendEndMinute, spacingMinutes, dailyCap } = checkedSchedule(input)
  const typed = typedAddresses(input.recipients)

  // The same composition and checks Review showed. Only emails with no
  // problem are sent; the rest are reported and nothing is created for them.
  const preview = await previewSendBatch(actor, { crmCompanyIds: ids, recipients: input.recipients, names: input.names, products: input.products })
  const ready = preview.emails.filter((e) => e.problems.length === 0)
  if (ready.length === 0) throw new ConflictError('None of the chosen companies can be sent to yet — see the problem listed for each one.')

  const batchId = newId()
  const name = (input.name ?? '').trim().slice(0, 120) || `Outreach ${new Date().toISOString().slice(0, 10)}`
  const batch = await prisma.outreachBatch.create({
    data: {
      id: batchId,
      tenantId: actor.tenantId,
      name,
      mode: 'manual',
      status: 'running',
      firstSendAt,
      timezone,
      sendDays: sendDays as never,
      sendStartMinute,
      sendEndMinute,
      spacingMinutes,
      dailyCap,
      createdByCrmUserId: actor.crmUserId,
    },
  })
  const slots = plannedInitialSlots(firstSendAt, ready.length, spacingMinutes, windowOfBatch(batch))

  const results: Array<{ crmCompanyId: string; companyName: string; ok: boolean; scheduledAt: string | null; error: string | null }> = []
  for (const e of preview.emails.filter((x) => x.problems.length > 0)) {
    results.push({ crmCompanyId: e.crmCompanyId, companyName: e.companyName, ok: false, scheduledAt: null, error: e.problems.join(' ') })
  }
  for (const [i, e] of ready.entries()) {
    try {
      const { campaignId, created } = await startSequence(actor, e.crmCompanyId, {
        batchId,
        recipientEmail: typed.get(e.crmCompanyId) ?? null,
        version: e.version,
        versionSource: 'auto_rotation',
      })
      if (!created) throw new ConflictError('This company is already in outreach — continue it under One company.')
      const action = await prisma.outreachAction.findFirst({ where: { campaignId, stageKey: 'initial', status: 'draft' }, select: { id: true } })
      if (!action) throw new ConflictError('The first email could not be prepared.')
      const typedName = input.names?.[e.crmCompanyId]?.trim()
      const typedProduct = input.products?.[e.crmCompanyId]?.trim()
      if (typedName || typedProduct) {
        await setInputs(actor, action.id, { ...(typedName ? { name: typedName } : {}), ...(typedProduct ? { product: typedProduct } : {}) })
      }
      // The batch's one confirmation, recorded on each email it covers.
      for (const def of templateFor('initial', e.version).attestations) {
        if (def.key === 'ai_test' || def.key === 'report_attached') await attest(actor, action.id, def.key, true)
      }
      try {
        await approve(actor, action.id)
      } catch (err) {
        // Something changed since Review. The email stays a draft under One
        // company, where it can be finished; nothing was scheduled.
        results.push({ crmCompanyId: e.crmCompanyId, companyName: e.companyName, ok: false, scheduledAt: null, error: `${(err as Error).message} Its draft is waiting under One company.` })
        continue
      }
      const slot = slots[i] ?? firstSendAt
      await prisma.outreachAction.update({ where: { id: action.id }, data: { scheduledAt: slot } })
      results.push({ crmCompanyId: e.crmCompanyId, companyName: e.companyName, ok: true, scheduledAt: slot.toISOString(), error: null })
    } catch (err) {
      results.push({ crmCompanyId: e.crmCompanyId, companyName: e.companyName, ok: false, scheduledAt: null, error: (err as Error).message })
    }
  }
  const scheduled = results.filter((r) => r.ok).length
  if (scheduled === 0) await prisma.outreachBatch.update({ where: { id: batchId }, data: { status: 'cancelled' } })
  await record(actor, batchId, 'sent', `"${name}": ${scheduled} of ${ids.length} first emails approved and scheduled — each is sent by a person from their own mailbox when due`, {
    results: results.map((r) => ({ crmCompanyId: r.crmCompanyId, ok: r.ok, scheduledAt: r.scheduledAt, error: r.error })),
  }, 'send_batch')
  return { batchId, scheduled, results }
}

/** A several-company send: each company's first email, when it is due, and whether it was sent. */
async function sendBatchCompanies(tenantId: string, batchId: string, now: Date) {
  const campaigns = await prisma.outreachCampaign.findMany({
    where: { batchId, tenantId, flow: FLOW, isTest: false },
    orderBy: { createdAt: 'asc' },
    select: { id: true, crmCompanyId: true, companyName: true, recipientEmail: true, status: true, statusReason: true, initialVersion: true },
  })
  const actions = await prisma.outreachAction.findMany({
    where: { campaignId: { in: campaigns.map((c) => c.id) }, stageKey: 'initial' },
    select: { id: true, campaignId: true, status: true, statusReason: true, scheduledAt: true, sentAt: true, message: { select: { subject: true, body: true } } },
  })
  return campaigns.map((c) => {
    const a = actions.find((x) => x.campaignId === c.id) ?? null
    const due = Boolean(a && a.status === 'ready_to_send' && a.scheduledAt && a.scheduledAt.getTime() <= now.getTime())
    const state =
      !a ? 'missing' : a.status === 'sent' ? 'sent' : a.status === 'ready_to_send' ? (due ? 'due' : 'scheduled') : a.status === 'draft' ? 'needs_attention' : a.status
    return {
      campaignId: c.id,
      crmCompanyId: c.crmCompanyId,
      companyName: c.companyName,
      recipientEmail: c.recipientEmail,
      version: c.initialVersion,
      campaignStatus: c.status,
      actionId: a?.id ?? null,
      state,
      statusReason: a?.statusReason ?? c.statusReason ?? null,
      scheduledAt: a?.scheduledAt?.toISOString() ?? null,
      sentAt: a?.sentAt?.toISOString() ?? null,
      subject: a?.message?.subject ?? null,
      body: a?.message?.body ?? null,
    }
  })
}

function batchRow(b: { id: string; name: string; mode: string; status: string; firstSendAt: Date; timezone: string; sendDays: unknown; sendStartMinute: number; sendEndMinute: number; spacingMinutes: number; dailyCap: number; createdByCrmUserId: string; createdAt: Date }) {
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return {
    id: b.id,
    name: b.name,
    mode: b.mode,
    status: b.status,
    firstSendAt: b.firstSendAt.toISOString(),
    timezone: b.timezone,
    sendDays: windowOfBatch(b).days,
    sendStart: clock(b.sendStartMinute),
    sendEnd: clock(b.sendEndMinute),
    spacingMinutes: b.spacingMinutes,
    dailyCap: b.dailyCap,
    createdByCrmUserId: b.createdByCrmUserId,
    createdAt: b.createdAt.toISOString(),
  }
}

export async function listBatches(tenantId: string) {
  const batches = await prisma.outreachBatch.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 100 })
  const out = []
  for (const b of batches) {
    const campaigns = await prisma.outreachCampaign.findMany({ where: { batchId: b.id }, select: { id: true } })
    const ids = campaigns.map((c) => c.id)
    if (b.mode === 'manual') {
      const now = new Date()
      const [due, waiting, sent] = await Promise.all([
        prisma.outreachAction.count({ where: { campaignId: { in: ids }, stageKey: 'initial', status: 'ready_to_send', scheduledAt: { lte: now } } }),
        prisma.outreachAction.count({ where: { campaignId: { in: ids }, stageKey: 'initial', status: 'ready_to_send', scheduledAt: { gt: now } } }),
        prisma.outreachAction.count({ where: { campaignId: { in: ids }, stageKey: 'initial', status: 'sent' } }),
      ])
      out.push({ ...batchRow(b), companies: ids.length, counts: { awaitingApproval: 0, scheduled: waiting, sent, failed: 0, due } })
      continue
    }
    const [awaitingApproval, scheduled, sent, failed] = await Promise.all([
      prisma.outreachAction.count({ where: { campaignId: { in: ids }, status: 'draft', stageKey: { not: null } } }),
      prisma.outreachAction.count({ where: { campaignId: { in: ids }, status: 'scheduled' } }),
      prisma.outreachAction.count({ where: { campaignId: { in: ids }, status: 'sent' } }),
      prisma.outreachAction.count({ where: { campaignId: { in: ids }, status: 'failed' } }),
    ])
    out.push({ ...batchRow(b), companies: ids.length, counts: { awaitingApproval, scheduled, sent, failed, due: 0 } })
  }
  return { batches: out, sending: transportStatus() }
}

export async function batchView(tenantId: string, batchId: string, now = new Date()) {
  const batch = await prisma.outreachBatch.findFirst({ where: { id: batchId, tenantId } })
  if (!batch) throw new NotFoundError('Test batch not found.')
  if (batch.mode === 'manual') {
    return { batch: batchRow(batch), companies: [], emails: await sendBatchCompanies(tenantId, batchId, now), sending: transportStatus() }
  }
  const campaigns = await prisma.outreachCampaign.findMany({ where: { batchId, tenantId, flow: FLOW, isTest: true }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  return {
    batch: batchRow(batch),
    companies: await testCampaignSummaries(tenantId, campaigns.map((c) => c.id), now),
    sending: transportStatus(),
  }
}

export async function setBatchState(actor: Actor, batchId: string, action: 'pause' | 'resume' | 'cancel') {
  const batch = await prisma.outreachBatch.findFirst({ where: { id: batchId, tenantId: actor.tenantId } })
  if (!batch) throw new NotFoundError('Test batch not found.')
  if (batch.status === 'cancelled' || batch.status === 'completed') throw new ConflictError(`This test batch is already ${batch.status}.`)

  if (action === 'pause') {
    if (batch.status === 'paused') return { batchId, status: 'paused' }
    await prisma.outreachBatch.update({ where: { id: batchId }, data: { status: 'paused' } })
    await record(actor, batchId, 'paused', `TEST batch "${batch.name}" paused — nothing is sent until it is resumed`)
    return { batchId, status: 'paused' }
  }
  if (action === 'resume') {
    if (batch.status === 'running') return { batchId, status: 'running' }
    await prisma.outreachBatch.update({ where: { id: batchId }, data: { status: 'running' } })
    await record(actor, batchId, 'resumed', `TEST batch "${batch.name}" resumed`)
    return { batchId, status: 'running' }
  }

  // Cancel: stop every campaign and cancel every email not yet sent.
  const campaigns = await prisma.outreachCampaign.findMany({ where: { batchId, tenantId: actor.tenantId }, select: { id: true, status: true } })
  const ids = campaigns.map((c) => c.id)
  await prisma.$transaction([
    prisma.outreachAction.updateMany({ where: { campaignId: { in: ids }, status: { in: OPEN_ACTION } }, data: { status: 'cancelled', statusReason: 'Test batch cancelled.' } }),
    prisma.outreachCampaign.updateMany({ where: { id: { in: ids }, status: { in: ['active', 'paused'] } }, data: { status: 'cancelled', statusReason: 'Test batch cancelled.' } }),
    prisma.outreachBatch.update({ where: { id: batchId }, data: { status: 'cancelled' } }),
  ])
  await record(actor, batchId, 'cancelled', `TEST batch "${batch.name}" cancelled — unsent test emails cancelled`)
  return { batchId, status: 'cancelled' }
}
