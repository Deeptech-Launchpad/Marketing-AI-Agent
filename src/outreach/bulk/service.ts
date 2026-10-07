import { env } from '../../config/env.js'
import { audit } from '../../platform/audit.js'
import { newId, prisma } from '../../platform/db.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../platform/errors.js'
import { logger } from '../../platform/logger.js'
import { checkSuppression } from '../suppression.js'
import { parseClock, withinWindow, type SendWindow } from './clock.js'
import { readSpreadsheet } from './excel.js'
import { extractContacts, firstNameOf, recipientsOf, strictEmail } from './extract.js'
import { fmtLocal, localDay, localToUtc, planBulkSlots } from './schedule.js'
import { bulkTemplate, composeBulkEmail, STATIC_SITE, type BulkTemplate } from './template.js'
import { bulkSender, bulkSendingStatus } from './transport.js'

// BULK EMAIL UPLOAD (2026-10-07) — upload → settings → schedule → review → start.
//
// Upload and Review write nothing. Start (the approve permission, with a
// confirmation) stores the campaign and one row per company: the exact email
// each will receive, its time, or why it is skipped. The worker then sends
// them ONE AT A TIME from the configured company mailbox: never two from the
// same campaign closer than the interval, only inside the sending hours, never
// over the daily limit, and each one re-checked against the suppression list
// just before it goes. A failure is recorded and the rest carry on.

export interface Actor {
  tenantId: string
  crmUserId: string
  requestId?: string
}

export const MAX_RECIPIENTS = 2000
const SENDING_STUCK_MS = 15 * 60_000

async function record(actor: Actor | { tenantId: string; crmUserId: string }, campaignId: string, action: string, summary: string, metadata?: Record<string, unknown>) {
  await audit({
    tenantId: actor.tenantId,
    actorType: actor.crmUserId === 'bulk-sender' ? 'system' : 'user',
    actorCrmUserId: actor.crmUserId,
    runId: campaignId,
    action: `outreach.bulk_email.${action}`,
    resourceType: 'BulkEmailCampaign',
    resourceId: campaignId,
    dataClass: 'customer_pii',
    summary,
    metadata: metadata ?? null,
    requestId: 'requestId' in actor ? (actor.requestId ?? null) : null,
  })
}

// ── Settings ───────────────────────────────────────────────────────────────

export function bulkSettings() {
  const t = STATIC_SITE
  return {
    sending: bulkSendingStatus(),
    templates: [{ key: t.key, label: t.label, subject: t.subject, body: t.body, placeholders: ['[First Name]', '[Company Name]'] }],
    defaults: { timezone: 'America/Indiana/Indianapolis', startTime: '08:00', sendStart: '08:00', sendEnd: '17:00', sendDays: [1, 2, 3, 4, 5], intervalMinutes: 5, dailyCap: Math.min(100, env.BULK_MAX_PER_DAY) },
    maxRecipients: MAX_RECIPIENTS,
  }
}

// ── Upload ─────────────────────────────────────────────────────────────────

function decodeFile(fileBase64: string): Buffer {
  const b64 = fileBase64.replace(/^data:[^,]*,/, '')
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new BadRequestError('The file could not be read.')
  return Buffer.from(b64, 'base64')
}

/** What the uploaded file contains: one entry per company, and the rows with no usable address. Nothing is stored. */
export async function analyzeUpload(input: { fileBase64: string; fileName?: string; allowWebmail?: boolean }) {
  const rows = await readSpreadsheet(decodeFile(input.fileBase64))
  const x = extractContacts(rows, { allowWebmail: input.allowWebmail === true })
  if (!x.columns.company || x.columns.contacts.length === 0) {
    throw new BadRequestError('No "Company Name" and "Email" columns were found in the first sheet. Check the headings row.')
  }
  return { fileName: input.fileName ?? null, ...x }
}

// ── Review ─────────────────────────────────────────────────────────────────

export interface BulkSetup {
  fileBase64: string
  fileName?: string
  templateKey: string
  fromEmail: string
  fromName?: string | null
  ccEmails?: string[]
  signature: string
  postalAddress: string
  startDate: string
  startTime: string
  timezone: string
  sendStart: string
  sendEnd: string
  sendDays: number[]
  intervalMinutes: number
  dailyCap: number
  name?: string
  /** Test option: also use webmail addresses (gmail, yahoo …). Off by default. */
  allowWebmail?: boolean
}

export interface ReviewRow {
  position: number
  companyName: string
  contactName: string | null
  toEmail: string | null
  ccEmails: string[]
  rows: number[]
  subject: string | null
  text: string | null
  html: string | null
  status: 'ready' | 'skipped'
  reason: string | null
  scheduledAt: string | null
  scheduledLocal: string | null
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function checkedSetup(s: BulkSetup) {
  const template = bulkTemplate(s.templateKey)
  if (!template) throw new BadRequestError('Unknown template.')
  if (!validTimeZone(s.timezone)) throw new BadRequestError(`"${s.timezone}" is not a time zone.`)
  const start = localToUtc(s.startDate, s.startTime, s.timezone)
  if (!start) throw new BadRequestError('Choose a start date and a start time.')
  const sendStartMinute = parseClock(s.sendStart)
  const sendEndMinute = parseClock(s.sendEnd)
  if (sendStartMinute === null || sendEndMinute === null || sendEndMinute <= sendStartMinute) {
    throw new BadRequestError('Sending hours must be two times like 08:00 and 17:00, the first earlier than the second.')
  }
  const days = [...new Set(s.sendDays.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort()
  if (!days.length) throw new BadRequestError('Choose at least one sending day.')
  const intervalMinutes = Math.round(Number(s.intervalMinutes))
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 240) throw new BadRequestError('Minutes between emails must be 1 to 240.')
  const dailyCap = Math.round(Number(s.dailyCap))
  if (!Number.isFinite(dailyCap) || dailyCap < 1 || dailyCap > env.BULK_MAX_PER_DAY) {
    throw new BadRequestError(`The daily limit must be 1 to ${env.BULK_MAX_PER_DAY} emails.`)
  }
  const ccEmails: string[] = []
  for (const raw of s.ccEmails ?? []) {
    if (!raw.trim()) continue
    const e = strictEmail(raw)
    if (!e) throw new BadRequestError(`"${raw}" is not an email address.`)
    if (!ccEmails.includes(e)) ccEmails.push(e)
  }
  const fromEmail = strictEmail(s.fromEmail)
  if (!fromEmail) throw new BadRequestError('Choose the From / sender email.')
  const window: SendWindow = { tz: s.timezone, days, startMinute: sendStartMinute, endMinute: sendEndMinute }
  return { template, start, window, intervalMinutes, dailyCap, ccEmails, fromEmail, sendStartMinute, sendEndMinute, days }
}

/** Every company's email, its time and its status — exactly what Start would store. Nothing is written. */
export async function reviewBulk(actor: Actor, s: BulkSetup, now = new Date()) {
  const setup = checkedSetup(s)
  const upload = await analyzeUpload({ fileBase64: s.fileBase64, fileName: s.fileName, allowWebmail: s.allowWebmail })
  if (upload.companies.length > MAX_RECIPIENTS) throw new BadRequestError(`At most ${MAX_RECIPIENTS} companies per upload.`)

  // Already emailed by an earlier bulk send, inside the cooldown, or queued now.
  const since = new Date(now.getTime() - env.OUTREACH_COOLDOWN_DAYS * 86_400_000)
  const earlier = await prisma.bulkEmailRecipient.findMany({
    where: {
      tenantId: actor.tenantId,
      OR: [{ status: { in: ['scheduled', 'sending'] } }, { status: 'sent', sentAt: { gte: since } }],
    },
    select: { toEmail: true, companyName: true, status: true, sentAt: true },
  })
  const earlierFor = (company: string, email: string | null) =>
    earlier.find((e) => (email && e.toEmail === email) || e.companyName.toLowerCase().trim() === company.toLowerCase().trim())

  const rows: ReviewRow[] = []
  for (const c of upload.companies) {
    const { to, cc } = recipientsOf(c)
    const base = { position: rows.length, companyName: c.companyName, rows: c.rows, subject: null, text: null, html: null, scheduledAt: null, scheduledLocal: null }
    const skip = (reason: string, extra: Partial<ReviewRow> = {}) => rows.push({ ...base, contactName: to?.name ?? null, toEmail: to?.email ?? c.people[0]?.email ?? null, ccEmails: [], status: 'skipped', reason, ...extra })
    if (c.skip) {
      skip(c.skip)
      continue
    }
    if (!c.people.length) continue // no work address at all: listed under noAddress
    if (!to) {
      skip('No contact name, so the greeting [First Name] cannot be filled.')
      continue
    }
    const prior = earlierFor(c.companyName, to.email)
    if (prior) {
      skip(prior.status === 'sent' ? `Already emailed by a bulk send on ${prior.sentAt?.toISOString().slice(0, 10)}.` : 'Already queued in another bulk send.')
      continue
    }
    const sup = await checkSuppression({
      tenantId: actor.tenantId,
      crmCompanyId: `bulk:${c.key}`,
      companyName: c.companyName,
      companyDomain: to.email.split('@')[1] ?? null,
      destination: to.email,
      channel: 'email',
      openDealCheck: 'skip',
    })
    if (sup.suppressed) {
      skip(`On the suppression list: ${sup.detail ?? sup.reason}`)
      continue
    }
    // A copied person who opted out is left out of the copy, not the email.
    const ccOk: string[] = []
    for (const p of cc) {
      const s2 = await checkSuppression({ tenantId: actor.tenantId, crmCompanyId: `bulk:${c.key}`, companyName: '', companyDomain: null, destination: p.email, channel: 'email', openDealCheck: 'skip' })
      if (!s2.suppressed) ccOk.push(p.email)
    }
    const ccAll = [...new Set([...ccOk, ...setup.ccEmails])].filter((e) => e !== to.email)
    const email = composeBulkEmail({ template: setup.template, firstName: firstNameOf(to.name), companyName: c.companyName, signature: s.signature, postalAddress: s.postalAddress })
    if (email.unfilled.length) {
      skip(`Could not fill ${email.unfilled.join(', ')}.`)
      continue
    }
    rows.push({ ...base, contactName: to.name, toEmail: to.email, ccEmails: ccAll, subject: email.subject, text: email.text, html: email.html, status: 'ready', reason: null })
  }

  const ready = rows.filter((r) => r.status === 'ready')
  const slots = planBulkSlots(setup.start.getTime() < now.getTime() ? now : setup.start, ready.length, setup.intervalMinutes, setup.window, setup.dailyCap)
  ready.forEach((r, i) => {
    const at = slots[i]
    if (!at) {
      r.status = 'skipped'
      r.reason = 'No sending time is left within a year under these hours and days.'
      return
    }
    r.scheduledAt = at.toISOString()
    r.scheduledLocal = fmtLocal(at, setup.window.tz)
  })
  const scheduled = rows.filter((r) => r.status === 'ready')
  const last = scheduled.length ? new Date(scheduled[scheduled.length - 1]!.scheduledAt!) : null

  return {
    fileName: upload.fileName,
    columns: upload.columns,
    template: { key: setup.template.key, label: setup.template.label },
    counts: {
      rowsWithCompany: upload.totalRows,
      companies: upload.companies.length,
      validEmails: scheduled.length,
      skipped: rows.filter((r) => r.status === 'skipped').length,
      noWorkAddress: upload.noAddress.length,
    },
    rows,
    noAddress: upload.noAddress,
    schedule: {
      timezone: setup.window.tz,
      startLocal: fmtLocal(setup.start.getTime() < now.getTime() ? now : setup.start, setup.window.tz),
      firstLocal: scheduled[0]?.scheduledLocal ?? null,
      estimatedCompletionLocal: last ? fmtLocal(last, setup.window.tz) : null,
      estimatedCompletionAt: last?.toISOString() ?? null,
      intervalMinutes: setup.intervalMinutes,
      dailyCap: setup.dailyCap,
    },
    from: { email: setup.fromEmail, name: s.fromName?.trim() || null },
    sending: bulkSendingStatus(),
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

export async function startBulk(actor: Actor, s: BulkSetup & { confirm?: boolean }, now = new Date()) {
  if (s.confirm !== true) throw new BadRequestError('Tick the confirmation that you reviewed every email in this send.')
  const sending = bulkSendingStatus()
  if (sending.reason) throw new ConflictError(sending.reason)
  const setup = checkedSetup(s)
  if (!sending.senders.includes(setup.fromEmail)) throw new BadRequestError(`${setup.fromEmail} is not a configured sending address. Choose one of: ${sending.senders.join(', ')}.`)
  if (!s.postalAddress.trim()) throw new BadRequestError('Enter the postal address for the opt-out footer — US law requires it in commercial email.')

  const review = await reviewBulk(actor, s, now)
  const ready = review.rows.filter((r) => r.status === 'ready')
  if (!ready.length) throw new ConflictError('No email can be sent from this file — see the reason against each company.')

  const id = newId()
  const name = (s.name ?? '').trim().slice(0, 120) || `${s.fileName?.replace(/\.xlsx$/i, '') || 'Bulk email'} — ${localDay(now, setup.window.tz)}`
  await prisma.bulkEmailCampaign.create({
    data: {
      id,
      tenantId: actor.tenantId,
      name,
      status: 'running',
      templateKey: setup.template.key,
      subject: setup.template.subject,
      body: setup.template.body,
      fromEmail: setup.fromEmail,
      fromName: s.fromName?.trim() || null,
      ccEmails: setup.ccEmails as never,
      signature: s.signature,
      postalAddress: s.postalAddress.trim(),
      sourceFileName: s.fileName ?? null,
      timezone: setup.window.tz,
      startAt: setup.start,
      sendDays: setup.days as never,
      sendStartMinute: setup.sendStartMinute,
      sendEndMinute: setup.sendEndMinute,
      intervalMinutes: setup.intervalMinutes,
      dailyCap: setup.dailyCap,
      totalRows: review.counts.rowsWithCompany,
      createdByCrmUserId: actor.crmUserId,
      approvedByCrmUserId: actor.crmUserId,
      approvedAt: now,
    },
  })
  await prisma.bulkEmailRecipient.createMany({
    data: review.rows.map((r, i) => ({
      id: newId(),
      tenantId: actor.tenantId,
      campaignId: id,
      position: i,
      companyName: r.companyName,
      contactName: r.contactName,
      toEmail: r.toEmail,
      ccEmails: r.ccEmails as never,
      sourceRows: r.rows as never,
      subject: r.subject,
      body: r.status === 'ready' ? r.text : null,
      status: r.status === 'ready' ? 'scheduled' : 'skipped',
      reason: r.reason,
      scheduledAt: r.scheduledAt ? new Date(r.scheduledAt) : null,
    })),
  })
  await record(actor, id, 'started', `Bulk email "${name}" approved: ${ready.length} emails from ${setup.fromEmail}, ${setup.intervalMinutes} min apart, at most ${setup.dailyCap}/day (${setup.window.tz}); ${review.counts.skipped} skipped`, {
    validEmails: ready.length,
    skipped: review.counts.skipped,
    noWorkAddress: review.counts.noWorkAddress,
    firstAt: review.schedule.firstLocal,
    estimatedCompletion: review.schedule.estimatedCompletionLocal,
  })
  return { campaignId: id, scheduled: ready.length, skipped: review.counts.skipped }
}

// ── Reading ────────────────────────────────────────────────────────────────

async function countsOf(campaignId: string) {
  const groups = await prisma.bulkEmailRecipient.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } })
  const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0
  return { scheduled: n('scheduled'), sending: n('sending'), sent: n('sent'), failed: n('failed'), skipped: n('skipped'), total: groups.reduce((a, g) => a + g._count._all, 0) }
}

function campaignRow(c: Awaited<ReturnType<typeof prisma.bulkEmailCampaign.findFirst>> & object) {
  const clock = (m: number) => {
    const h = Math.floor(m / 60)
    return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
  }
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    templateKey: c.templateKey,
    fromEmail: c.fromEmail,
    fromName: c.fromName,
    ccEmails: c.ccEmails,
    timezone: c.timezone,
    startLocal: fmtLocal(c.startAt, c.timezone),
    sendHours: `${clock(c.sendStartMinute)} – ${clock(c.sendEndMinute)}`,
    sendDays: c.sendDays,
    intervalMinutes: c.intervalMinutes,
    dailyCap: c.dailyCap,
    sourceFileName: c.sourceFileName,
    createdAt: c.createdAt.toISOString(),
    completedAt: c.completedAt?.toISOString() ?? null,
    completedLocal: c.completedAt ? fmtLocal(c.completedAt, c.timezone) : null,
  }
}

export async function listBulk(tenantId: string) {
  const campaigns = await prisma.bulkEmailCampaign.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 100 })
  const out = []
  for (const c of campaigns) out.push({ ...campaignRow(c), counts: await countsOf(c.id) })
  return { campaigns: out, sending: bulkSendingStatus() }
}

export async function bulkView(tenantId: string, id: string) {
  const c = await prisma.bulkEmailCampaign.findFirst({ where: { id, tenantId } })
  if (!c) throw new NotFoundError('Bulk send not found.')
  const recipients = await prisma.bulkEmailRecipient.findMany({ where: { campaignId: id }, orderBy: { position: 'asc' } })
  const last = await prisma.bulkEmailRecipient.findFirst({ where: { campaignId: id, status: 'scheduled' }, orderBy: { scheduledAt: 'desc' }, select: { scheduledAt: true } })
  return {
    campaign: { ...campaignRow(c), estimatedCompletionLocal: last?.scheduledAt ? fmtLocal(last.scheduledAt, c.timezone) : null },
    counts: await countsOf(id),
    recipients: recipients.map((r) => ({
      id: r.id,
      position: r.position,
      companyName: r.companyName,
      contactName: r.contactName,
      toEmail: r.toEmail,
      ccEmails: r.ccEmails,
      subject: r.subject,
      body: r.body,
      status: r.status,
      reason: r.reason,
      scheduledLocal: r.scheduledAt ? fmtLocal(r.scheduledAt, c.timezone) : null,
      sentLocal: r.sentAt ? fmtLocal(r.sentAt, c.timezone) : null,
    })),
    sending: bulkSendingStatus(),
  }
}

// ── Controls ───────────────────────────────────────────────────────────────

export async function setBulkState(actor: Actor, id: string, to: 'pause' | 'resume' | 'cancel', now = new Date()) {
  const c = await prisma.bulkEmailCampaign.findFirst({ where: { id, tenantId: actor.tenantId } })
  if (!c) throw new NotFoundError('Bulk send not found.')
  if (c.status === 'completed' || c.status === 'cancelled') throw new ConflictError(`This bulk send is already ${c.status}.`)
  if (to === 'pause') {
    await prisma.bulkEmailCampaign.update({ where: { id }, data: { status: 'paused' } })
    await record(actor, id, 'paused', `Bulk email "${c.name}" paused — nothing more is sent until it is resumed`)
    return { id, status: 'paused' }
  }
  if (to === 'resume') {
    // The remaining emails are re-planned from now, so a long pause does not
    // leave a backlog that would go out in a burst.
    const remaining = await prisma.bulkEmailRecipient.findMany({ where: { campaignId: id, status: 'scheduled' }, orderBy: { position: 'asc' }, select: { id: true } })
    const window: SendWindow = { tz: c.timezone, days: c.sendDays as number[], startMinute: c.sendStartMinute, endMinute: c.sendEndMinute }
    const slots = planBulkSlots(now, remaining.length, c.intervalMinutes, window, c.dailyCap)
    for (const [i, r] of remaining.entries()) {
      await prisma.bulkEmailRecipient.update({ where: { id: r.id }, data: slots[i] ? { scheduledAt: slots[i] } : { status: 'skipped', reason: 'No sending time left within a year.' } })
    }
    await prisma.bulkEmailCampaign.update({ where: { id }, data: { status: 'running' } })
    await record(actor, id, 'resumed', `Bulk email "${c.name}" resumed — ${remaining.length} emails re-planned from now`)
    return { id, status: 'running' }
  }
  await prisma.bulkEmailRecipient.updateMany({ where: { campaignId: id, status: 'scheduled' }, data: { status: 'skipped', reason: 'The bulk send was cancelled.' } })
  await prisma.bulkEmailCampaign.update({ where: { id }, data: { status: 'cancelled', completedAt: now } })
  await record(actor, id, 'cancelled', `Bulk email "${c.name}" cancelled — unsent emails skipped`)
  return { id, status: 'cancelled' }
}

/** A recipient replied "unsubscribe": their address goes on the suppression list, which every send checks. */
export async function unsubscribeRecipient(actor: Actor, recipientId: string) {
  const r = await prisma.bulkEmailRecipient.findFirst({ where: { id: recipientId, tenantId: actor.tenantId } })
  if (!r || !r.toEmail) throw new NotFoundError('Recipient not found.')
  await prisma.suppressionEntry.upsert({
    where: { tenantId_scope_matchType_matchValue: { tenantId: actor.tenantId, scope: 'global', matchType: 'email', matchValue: r.toEmail } },
    create: { id: newId(), tenantId: actor.tenantId, scope: 'global', matchType: 'email', matchValue: r.toEmail, reason: 'Replied "unsubscribe" to a bulk email', source: 'unsubscribe', createdByCrmUserId: actor.crmUserId },
    update: {},
  })
  await prisma.bulkEmailRecipient.updateMany({ where: { tenantId: actor.tenantId, toEmail: r.toEmail, status: 'scheduled' }, data: { status: 'skipped', reason: 'Unsubscribed.' } })
  await record(actor, r.campaignId, 'unsubscribed', `${r.toEmail} unsubscribed — added to the suppression list`)
  return { email: r.toEmail }
}

// ── The sender (worker, every minute) ──────────────────────────────────────

/**
 * Sends what is due, at most ONE email per campaign per call, and only when
 * the campaign's last email went at least `interval` minutes ago, the time is
 * inside its sending hours, and today's limit is not reached. A failure is
 * recorded on that email and the campaign carries on.
 */
export async function dispatchBulkEmails(now = new Date()): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0
  if (bulkSendingStatus().reason) return { sent, failed }

  // An email left "sending" by a worker that died is not sent again blind.
  await prisma.bulkEmailRecipient.updateMany({
    where: { status: 'sending', updatedAt: { lt: new Date(now.getTime() - SENDING_STUCK_MS) } },
    data: { status: 'failed', reason: 'Sending did not complete. It was not retried, so the contact cannot receive it twice.' },
  })

  const campaigns = await prisma.bulkEmailCampaign.findMany({ where: { status: 'running' }, orderBy: { createdAt: 'asc' } })
  for (const c of campaigns) {
    try {
      const window: SendWindow = { tz: c.timezone, days: c.sendDays as number[], startMinute: c.sendStartMinute, endMinute: c.sendEndMinute }
      const lastSent = await prisma.bulkEmailRecipient.findFirst({ where: { campaignId: c.id, sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } })
      const spaced = !lastSent?.sentAt || now.getTime() - lastSent.sentAt.getTime() >= c.intervalMinutes * 60_000 - 5_000
      const today = localDay(now, c.timezone)
      const sentToday = (await prisma.bulkEmailRecipient.findMany({ where: { campaignId: c.id, status: 'sent', sentAt: { gte: new Date(now.getTime() - 36 * 3_600_000) } }, select: { sentAt: true } })).filter(
        (r) => r.sentAt && localDay(r.sentAt, c.timezone) === today,
      ).length
      if (spaced && withinWindow(now, window) && sentToday < c.dailyCap) {
        const next = await prisma.bulkEmailRecipient.findFirst({ where: { campaignId: c.id, status: 'scheduled', scheduledAt: { lte: now } }, orderBy: [{ scheduledAt: 'asc' }, { position: 'asc' }] })
        if (next) {
          const outcome = await sendOne(c, next, now)
          if (outcome === 'sent') sent++
          if (outcome === 'failed') failed++
        }
      }
      // Finished: nothing scheduled or sending is left.
      const open = await prisma.bulkEmailRecipient.count({ where: { campaignId: c.id, status: { in: ['scheduled', 'sending'] } } })
      if (open === 0) {
        await prisma.bulkEmailCampaign.update({ where: { id: c.id }, data: { status: 'completed', completedAt: now } })
        const counts = await countsOf(c.id)
        await record({ tenantId: c.tenantId, crmUserId: 'bulk-sender' }, c.id, 'completed', `Bulk email "${c.name}" completed: ${counts.sent} sent, ${counts.failed} failed, ${counts.skipped} skipped`, counts)
      }
    } catch (err) {
      logger.error({ err, campaignId: c.id }, 'bulk email: campaign dispatch failed; it is tried again next minute')
    }
  }
  return { sent, failed }
}

type Campaign = NonNullable<Awaited<ReturnType<typeof prisma.bulkEmailCampaign.findFirst>>>
type Recipient = NonNullable<Awaited<ReturnType<typeof prisma.bulkEmailRecipient.findFirst>>>

async function sendOne(c: Campaign, r: Recipient, now: Date): Promise<'sent' | 'failed' | 'skipped' | 'taken'> {
  // Claimed first, so two workers can never send the same email.
  const claim = await prisma.bulkEmailRecipient.updateMany({ where: { id: r.id, status: 'scheduled' }, data: { status: 'sending' } })
  if (claim.count !== 1) return 'taken'

  // Re-checked at the moment of sending: someone may have opted out since.
  const sup = await checkSuppression({
    tenantId: c.tenantId,
    crmCompanyId: `bulk:${r.companyName.toLowerCase()}`,
    companyName: r.companyName,
    companyDomain: r.toEmail?.split('@')[1] ?? null,
    destination: r.toEmail,
    channel: 'email',
    openDealCheck: 'skip',
  })
  if (sup.suppressed || !r.toEmail || !r.body || !r.subject) {
    await prisma.bulkEmailRecipient.update({ where: { id: r.id }, data: { status: 'skipped', reason: sup.suppressed ? `On the suppression list: ${sup.detail ?? sup.reason}` : 'Nothing to send.' } })
    return 'skipped'
  }
  const template: BulkTemplate = bulkTemplate(c.templateKey) ?? STATIC_SITE
  const contactFirst = firstNameOf(r.contactName)
  const email = composeBulkEmail({ template, firstName: contactFirst, companyName: r.companyName, signature: c.signature, postalAddress: c.postalAddress })
  // What goes is what was reviewed: the stored text. The HTML part is the same
  // words, laid out, and is only used when it matches.
  const html = email.text === r.body ? email.html : `<pre style="font-family:Arial,Helvetica,sans-serif;white-space:pre-wrap">${r.body.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`
  try {
    const res = await bulkSender().send({
      fromEmail: c.fromEmail,
      fromName: c.fromName,
      to: r.toEmail,
      cc: (r.ccEmails as string[]) ?? [],
      subject: r.subject,
      text: r.body,
      html,
    })
    await prisma.bulkEmailRecipient.update({ where: { id: r.id }, data: { status: 'sent', sentAt: now, messageId: res.messageId, reason: null } })
    return 'sent'
  } catch (err) {
    const reason = String((err as Error).message ?? err).slice(0, 400)
    await prisma.bulkEmailRecipient.update({ where: { id: r.id }, data: { status: 'failed', reason } })
    logger.warn({ campaignId: c.id, recipientId: r.id, reason }, 'bulk email: one email failed; the send carries on')
    return 'failed'
  }
}
