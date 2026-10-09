import { env } from '../../config/env.js'
import { audit } from '../../platform/audit.js'
import { newId, prisma } from '../../platform/db.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../platform/errors.js'
import { logger } from '../../platform/logger.js'
import { checkSuppression } from '../suppression.js'
import { readSpreadsheet } from './excel.js'
import { extractContacts, firstNameOf, recipientsOf, strictEmail } from './extract.js'
import { fmtIst, IST, istToUtc, planSequential } from './schedule.js'
import { checkSender, type SenderCheck } from './senders.js'
import { cleanSignatureHtml, MAX_SIGNATURE_HTML } from './signature.js'
import { BULK_ROTATION, bulkTemplate, cleanSignature, composeBulkEmail, rotationTemplate, STATIC_SITE, versionOf, type BulkTemplate } from './template.js'
import { addPixel, hashToken, newTrackingToken, pixelUrl, trackingReady, trackingStatusForScreen } from './tracking.js'
import { bulkSender, bulkSendingStatus, bulkTransportAccount } from './transport.js'

// BULK EMAIL (2026-10-08) — a simple, standalone workflow:
//
//   Upload Excel → analyze contacts → review emails → date, time and minutes
//   between emails (IST) → approve → start sending
//
// Upload and Review write nothing. Start (the approve permission, with a
// confirmation) stores the send and one row per company: the exact email it
// receives — the approved template with only [First Name] and [Company Name]
// filled, and the sender's signature under it — and its time. The worker then
// sends them ONE AT A TIME: email 1 at the start time, then one every N
// minutes. Each is re-checked against the opt-out list just before it goes;
// a failure is recorded and the rest carry on.
//
// The From the customer sees is the From email set on the Bulk email screen,
// carried by the SMTP account configured on the server. It is only used while
// the sender check (senders.ts) shows that account may genuinely send as it —
// at Start, on Resume, and again before sending once the last check is a day
// old or the account has changed. Otherwise nothing is sent and the send is
// paused with the reason.

export interface Actor {
  tenantId: string
  crmUserId: string
  requestId?: string
}

export const MAX_RECIPIENTS = 2000
const SENDING_STUCK_MS = 15 * 60_000

async function record(actor: { tenantId: string; crmUserId: string; requestId?: string }, campaignId: string, action: string, summary: string, metadata?: Record<string, unknown>) {
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
    requestId: actor.requestId ?? null,
  })
}

// ── Settings ───────────────────────────────────────────────────────────────

export async function bulkSettings(tenantId: string) {
  return {
    sending: bulkSendingStatus(),
    sender: await senderView(tenantId),
    // Versions 1, 2 and 3, assigned in turn down the list.
    templates: BULK_ROTATION.map((t, i) => ({ key: t.key, label: t.label, version: i + 1, subject: t.subject, body: t.body, placeholders: ['[First Name]', '[Company Name]'] })),
    defaults: { startTime: '10:00', intervalMinutes: 5, timezone: IST },
    maxRecipients: MAX_RECIPIENTS,
  }
}

// ── The sender: From, CC and signature ─────────────────────────────────────

const SENDER_KEY = 'bulkSender'
const CHECKS_KEY = 'bulkSenderChecks'
/** A check older than this is made again before the next email goes. */
const RECHECK_MS = 24 * 3_600_000
const MAX_CC = 10

export interface BulkSenderProfile {
  fromEmail: string
  ccEmails: string[]
  /** The signature as plain text (derived from signatureHtml when one is set). */
  signature: string
  /** The signature exactly as pasted, cleaned of active content. */
  signatureHtml: string
  /** What cleaning took out of the last pasted signature, in words. */
  signatureRemoved: string[]
  updatedAt: string | null
  updatedByCrmUserId: string | null
}

type Settings = Record<string, unknown>

async function tenantSettings(tenantId: string): Promise<Settings> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
  return (t?.settings as Settings | null) ?? {}
}

async function patchSettings(tenantId: string, patch: Settings) {
  const current = await tenantSettings(tenantId)
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...current, ...patch } as never } })
}

function profileOf(settings: Settings): BulkSenderProfile {
  const raw = (settings[SENDER_KEY] ?? {}) as Partial<BulkSenderProfile>
  return {
    fromEmail: typeof raw.fromEmail === 'string' ? raw.fromEmail : '',
    ccEmails: Array.isArray(raw.ccEmails) ? raw.ccEmails.filter((x): x is string => typeof x === 'string') : [],
    signature: typeof raw.signature === 'string' ? raw.signature : '',
    signatureHtml: typeof raw.signatureHtml === 'string' ? raw.signatureHtml : '',
    signatureRemoved: Array.isArray(raw.signatureRemoved) ? raw.signatureRemoved.filter((x): x is string => typeof x === 'string') : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    updatedByCrmUserId: typeof raw.updatedByCrmUserId === 'string' ? raw.updatedByCrmUserId : null,
  }
}

function checksOf(settings: Settings): Record<string, SenderCheck> {
  const raw = settings[CHECKS_KEY]
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, SenderCheck>) : {}
}

/** The stored check of this From — only if it was made with the SMTP account configured now. */
function currentCheck(settings: Settings, fromEmail: string): SenderCheck | null {
  const account = bulkTransportAccount()
  const c = checksOf(settings)[fromEmail.toLowerCase()]
  return c && account && c.accountEmail === account.user.toLowerCase() ? c : null
}

async function storeCheck(tenantId: string, check: SenderCheck) {
  const settings = await tenantSettings(tenantId)
  const all = { ...checksOf(settings), [check.fromEmail.toLowerCase()]: check }
  // Only the latest few addresses are kept.
  const kept = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].checkedAt.localeCompare(a[1].checkedAt)).slice(0, 20))
  await patchSettings(tenantId, { [CHECKS_KEY]: kept })
}

async function auditSender(actor: { tenantId: string; crmUserId: string; requestId?: string }, action: string, check: SenderCheck) {
  await audit({
    tenantId: actor.tenantId,
    actorType: actor.crmUserId === 'bulk-sender' ? 'system' : 'user',
    actorCrmUserId: actor.crmUserId,
    runId: null,
    action: `outreach.bulk_email.${action}`,
    resourceType: 'BulkEmailSender',
    resourceId: check.fromEmail,
    dataClass: 'internal',
    summary: `Bulk email sender ${check.fromEmail}: ${check.authorized ? 'authorized' : 'NOT authorized'} — ${check.reason}`,
    metadata: { fromEmail: check.fromEmail, accountEmail: check.accountEmail, authorized: check.authorized, method: check.method },
    requestId: actor.requestId ?? null,
  })
}

/**
 * Whether this From may be used now. The stored check is used while it is
 * fresh and was made with today's account; otherwise (or when `fresh`) the
 * check is made again and stored.
 */
async function authorizeFrom(actor: { tenantId: string; crmUserId: string; requestId?: string }, fromEmail: string, now: Date, fresh: boolean): Promise<SenderCheck> {
  const stored = fresh ? null : currentCheck(await tenantSettings(actor.tenantId), fromEmail)
  if (stored && now.getTime() - Date.parse(stored.checkedAt) < RECHECK_MS) return stored
  const check = await checkSender(fromEmail, bulkTransportAccount(), now)
  await storeCheck(actor.tenantId, check)
  await auditSender(actor, 'sender_checked', check)
  return check
}

/** The sender as the screen shows it, and whether bulk emails can go from it. */
export async function senderView(tenantId: string) {
  const settings = await tenantSettings(tenantId)
  const profile = profileOf(settings)
  const sending = bulkSendingStatus()
  const check = profile.fromEmail ? currentCheck(settings, profile.fromEmail) : null
  const stale = profile.fromEmail && !check ? checksOf(settings)[profile.fromEmail.toLowerCase()] ?? null : null
  const problem = !profile.fromEmail
    ? 'Set the From email for bulk emails.'
    : !sending.account
      ? 'No SMTP account is configured on the server, so the From email cannot be checked.'
      : !check
        ? stale
          ? `The server's sending account changed since ${profile.fromEmail} was checked — check it again.`
          : `${profile.fromEmail} has not been checked yet — click "Check sender".`
        : check.authorized
          ? null
          : check.reason
  return {
    fromEmail: profile.fromEmail || null,
    ccEmails: profile.ccEmails,
    signature: profile.signature,
    signatureHtml: profile.signatureHtml,
    signatureRemoved: profile.signatureRemoved,
    updatedAt: profile.updatedAt,
    check: check ? { authorized: check.authorized, reason: check.reason, warning: check.warning, checkedAt: check.checkedAt, checkedLocal: fmtIst(new Date(check.checkedAt)) } : null,
    authorized: problem === null,
    problem,
    account: sending.account,
  }
}

/** Saves the From, CC and signature, and checks the From straight away. */
export async function saveBulkSender(actor: Actor, input: { fromEmail: string; ccEmails: string[]; signatureHtml: string }, now = new Date()) {
  const fromEmail = strictEmail(input.fromEmail)
  if (!fromEmail) throw new BadRequestError(`"${input.fromEmail}" is not a valid From email address.`)
  const ccEmails: string[] = []
  for (const raw of input.ccEmails.map((c) => c.trim()).filter(Boolean)) {
    const cc = strictEmail(raw)
    if (!cc) throw new BadRequestError(`CC "${raw}" is not a valid email address.`)
    if (!ccEmails.includes(cc)) ccEmails.push(cc)
  }
  if (ccEmails.length > MAX_CC) throw new BadRequestError(`At most ${MAX_CC} CC addresses.`)
  if ((input.signatureHtml ?? '').length > MAX_SIGNATURE_HTML) throw new BadRequestError('The signature is too large — use smaller images.')
  // Kept exactly as pasted; only active content and images that cannot travel are taken out.
  const sig = cleanSignatureHtml(input.signatureHtml ?? '')
  const profile: BulkSenderProfile = {
    fromEmail,
    ccEmails,
    signature: cleanSignature(sig.text),
    signatureHtml: sig.html,
    signatureRemoved: sig.removed,
    updatedAt: now.toISOString(),
    updatedByCrmUserId: actor.crmUserId,
  }
  await patchSettings(actor.tenantId, { [SENDER_KEY]: profile })
  await authorizeFrom(actor, fromEmail, now, true)
  return senderView(actor.tenantId)
}

/** Checks the saved From again (for example after adding it as a "Send mail as" address). */
export async function recheckBulkSender(actor: Actor, now = new Date()) {
  const profile = profileOf(await tenantSettings(actor.tenantId))
  if (!profile.fromEmail) throw new BadRequestError('Set the From email first.')
  await authorizeFrom(actor, profile.fromEmail, now, true)
  return senderView(actor.tenantId)
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
  /** Start date and time, in IST. */
  startDate: string
  startTime: string
  intervalMinutes: number
  /** Test option: also use webmail addresses (gmail, yahoo …). Off by default. */
  allowWebmail?: boolean
  name?: string
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
  /** The approved version this person receives (1, 2 or 3). */
  templateKey: string | null
  version: number | null
  status: 'ready' | 'skipped'
  reason: string | null
  scheduledAt: string | null
  scheduledLocal: string | null
}

function checkedSetup(s: BulkSetup) {
  const template = bulkTemplate(s.templateKey)
  if (!template) throw new BadRequestError('Unknown template.')
  const start = istToUtc(s.startDate, s.startTime)
  if (!start) throw new BadRequestError('Choose the date and the time sending starts.')
  const intervalMinutes = Math.round(Number(s.intervalMinutes))
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 240) throw new BadRequestError('Minutes between emails must be 1 to 240.')
  return { template, start, intervalMinutes }
}

/** Every company's email, its time and its status — exactly what Start would store. Nothing is written. */
export async function reviewBulk(actor: Actor, s: BulkSetup, now = new Date()) {
  const setup = checkedSetup(s)
  const profile = profileOf(await tenantSettings(actor.tenantId))
  const signature = cleanSignature(profile.signature)
  const signatureHtml = profile.signatureHtml
  const upload = await analyzeUpload({ fileBase64: s.fileBase64, fileName: s.fileName, allowWebmail: s.allowWebmail })
  if (upload.companies.length > MAX_RECIPIENTS) throw new BadRequestError(`At most ${MAX_RECIPIENTS} companies per upload.`)

  // Never two sends to one address at once; and, for a real list, never an
  // address another bulk send already emailed inside the cooldown.
  const since = new Date(now.getTime() - env.OUTREACH_COOLDOWN_DAYS * 86_400_000)
  const earlier = await prisma.bulkEmailRecipient.findMany({
    where: {
      tenantId: actor.tenantId,
      OR: [{ status: { in: ['scheduled', 'sending'] } }, ...(s.allowWebmail ? [] : [{ status: 'sent', sentAt: { gte: since } }])],
    },
    select: { toEmail: true, companyName: true, status: true, sentAt: true },
  })
  const earlierFor = (company: string, email: string) =>
    earlier.find((e) => e.toEmail === email || e.companyName.toLowerCase().trim() === company.toLowerCase().trim())

  const rows: ReviewRow[] = []
  let readyCount = 0
  for (const c of upload.companies) {
    const { to, cc } = recipientsOf(c)
    const base = { position: rows.length, companyName: c.companyName, rows: c.rows, subject: null, text: null, html: null, templateKey: null, version: null, scheduledAt: null, scheduledLocal: null }
    const skip = (reason: string) => rows.push({ ...base, contactName: to?.name ?? null, toEmail: to?.email ?? c.people[0]?.email ?? null, ccEmails: [], status: 'skipped', reason })
    if (c.skip) {
      skip(c.skip)
      continue
    }
    if (!c.people.length) continue // no usable address at all: listed under noAddress
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
      skip(`On the opt-out list: ${sup.detail ?? sup.reason}`)
      continue
    }
    // A colleague who opted out is left out of the copy, not the email.
    const ccOk: string[] = []
    for (const p of cc) {
      const s2 = await checkSuppression({ tenantId: actor.tenantId, crmCompanyId: `bulk:${c.key}`, companyName: '', companyDomain: null, destination: p.email, channel: 'email', openDealCheck: 'skip' })
      if (!s2.suppressed && p.email !== to.email) ccOk.push(p.email)
    }
    // The sender's CC addresses are copied on every email too.
    for (const extra of profile.ccEmails) if (!ccOk.includes(extra) && extra !== to.email) ccOk.push(extra)
    // Versions in sequence: 1, 2, 3, 1, 2, 3 … over the emails that go.
    const template = rotationTemplate(readyCount)
    const email = composeBulkEmail({ template, firstName: firstNameOf(to.name), companyName: c.companyName, signature, signatureHtml })
    if (email.unfilled.length) {
      skip(`Could not fill ${email.unfilled.join(', ')}.`)
      continue
    }
    readyCount++
    rows.push({ ...base, contactName: to.name, toEmail: to.email, ccEmails: ccOk, subject: email.subject, text: email.text, html: email.html, templateKey: template.key, version: versionOf(template.key), status: 'ready', reason: null })
  }

  // A start time already passed begins now.
  const begin = setup.start.getTime() < now.getTime() ? now : setup.start
  const ready = rows.filter((r) => r.status === 'ready')
  planSequential(begin, ready.length, setup.intervalMinutes).forEach((at, i) => {
    ready[i]!.scheduledAt = at.toISOString()
    ready[i]!.scheduledLocal = fmtIst(at)
  })
  const last = ready.length ? new Date(ready[ready.length - 1]!.scheduledAt!) : null

  return {
    fileName: upload.fileName,
    columns: upload.columns,
    template: { key: setup.template.key, label: setup.template.label },
    counts: {
      rowsWithCompany: upload.totalRows,
      companies: upload.companies.length,
      validEmails: ready.length,
      skipped: rows.filter((r) => r.status === 'skipped').length,
      noWorkAddress: upload.noAddress.length,
    },
    rows,
    noAddress: upload.noAddress,
    schedule: {
      timezone: IST,
      startLocal: fmtIst(begin),
      firstLocal: ready[0]?.scheduledLocal ?? null,
      estimatedCompletionLocal: last ? fmtIst(last) : null,
      estimatedCompletionAt: last?.toISOString() ?? null,
      intervalMinutes: setup.intervalMinutes,
    },
    from: { email: profile.fromEmail || null },
    sender: await senderView(actor.tenantId),
    sending: bulkSendingStatus(),
  }
}

// ── One person, without an Excel file (2026-10-08) ─────────────────────────
//
// The same approved versions, sender, checks and sender as a bulk list —
// only the list is one person typed in. It goes as soon as it is approved
// (within a minute, by the same one-at-a-time sender).

export interface SingleSetup {
  firstName: string
  companyName: string
  toEmail: string
  ccEmails?: string[]
  /** static_site_v1 / v2 / v3. */
  templateKey: string
}

async function checkedSingle(actor: Actor, s: SingleSetup) {
  const template = bulkTemplate(s.templateKey)
  if (!template) throw new BadRequestError('Choose Version 1, 2 or 3.')
  const firstName = s.firstName.trim()
  const companyName = s.companyName.trim()
  if (!firstName) throw new BadRequestError('Enter the first name.')
  if (!companyName) throw new BadRequestError('Enter the company name.')
  const toEmail = strictEmail(s.toEmail)
  if (!toEmail) throw new BadRequestError(`"${s.toEmail}" is not a valid email address.`)
  const profile = profileOf(await tenantSettings(actor.tenantId))
  const ccEmails: string[] = []
  for (const raw of [...(s.ccEmails ?? []), ...profile.ccEmails].map((c) => c.trim()).filter(Boolean)) {
    const cc = strictEmail(raw)
    if (!cc) throw new BadRequestError(`CC "${raw}" is not a valid email address.`)
    if (cc !== toEmail && !ccEmails.includes(cc)) ccEmails.push(cc)
  }
  if (ccEmails.length > MAX_CC * 2) throw new BadRequestError('Too many CC addresses.')
  return { template, firstName, companyName, toEmail, ccEmails, profile }
}

/** The one email exactly as it will be sent. Nothing is written. */
export async function reviewSingle(actor: Actor, s: SingleSetup) {
  const x = await checkedSingle(actor, s)
  const sup = await checkSuppression({
    tenantId: actor.tenantId,
    crmCompanyId: `bulk:${x.companyName.toLowerCase()}`,
    companyName: x.companyName,
    companyDomain: x.toEmail.split('@')[1] ?? null,
    destination: x.toEmail,
    channel: 'email',
    openDealCheck: 'skip',
  })
  const queued = await prisma.bulkEmailRecipient.findFirst({ where: { tenantId: actor.tenantId, toEmail: x.toEmail, status: { in: ['scheduled', 'sending'] } }, select: { id: true } })
  const lastSent = await prisma.bulkEmailRecipient.findFirst({ where: { tenantId: actor.tenantId, toEmail: x.toEmail, status: 'sent' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } })
  const email = composeBulkEmail({ template: x.template, firstName: x.firstName, companyName: x.companyName, signature: cleanSignature(x.profile.signature), signatureHtml: x.profile.signatureHtml })
  const blocked = sup.suppressed
    ? `${x.toEmail} is on the opt-out list: ${sup.detail ?? sup.reason}`
    : queued
      ? `An email to ${x.toEmail} is already waiting to be sent.`
      : email.unfilled.length
        ? `Could not fill ${email.unfilled.join(', ')}.`
        : null
  return {
    toEmail: x.toEmail,
    ccEmails: x.ccEmails,
    companyName: x.companyName,
    contactName: x.firstName,
    templateKey: x.template.key,
    version: versionOf(x.template.key),
    subject: email.subject,
    text: email.text,
    html: email.html,
    blocked,
    previouslySentLocal: lastSent?.sentAt ? fmtIst(lastSent.sentAt) : null,
    sender: await senderView(actor.tenantId),
    sending: bulkSendingStatus(),
  }
}

/** Approves and sends the one email (within a minute). */
export async function startSingle(actor: Actor, s: SingleSetup & { confirm?: boolean }, now = new Date()) {
  if (s.confirm !== true) throw new BadRequestError('Tick the confirmation that you reviewed this email.')
  const sending = bulkSendingStatus()
  if (sending.reason) throw new ConflictError(sending.reason)
  const review = await reviewSingle(actor, s)
  if (review.blocked) throw new ConflictError(`Not sent — ${review.blocked}`)
  const x = await checkedSingle(actor, s)
  const fromEmail = x.profile.fromEmail
  if (!fromEmail) throw new BadRequestError('Set the From email for bulk emails first (Sender, on the Bulk email page).')
  const auth = await authorizeFrom(actor, fromEmail, now, true)
  if (!auth.authorized) throw new ConflictError(`Not sent — ${fromEmail} is not authorized for this sending account. ${auth.reason}`)

  const id = newId()
  const name = `${x.firstName} at ${x.companyName} — ${fmtIst(now).replace(/, \d{1,2}:\d{2} [AP]M IST$/, '')}`.slice(0, 120)
  await prisma.bulkEmailCampaign.create({
    data: {
      id,
      tenantId: actor.tenantId,
      name,
      status: 'running',
      templateKey: x.template.key,
      subject: x.template.subject,
      body: x.template.body,
      fromEmail,
      fromName: null,
      ccEmails: x.profile.ccEmails as never,
      signature: cleanSignature(x.profile.signature),
      signatureHtml: x.profile.signatureHtml,
      postalAddress: '',
      sourceFileName: null,
      timezone: IST,
      startAt: now,
      sendDays: [1, 2, 3, 4, 5, 6, 7] as never,
      sendStartMinute: 0,
      sendEndMinute: 1440,
      intervalMinutes: 1,
      dailyCap: 0,
      totalRows: 1,
      createdByCrmUserId: actor.crmUserId,
      approvedByCrmUserId: actor.crmUserId,
      approvedAt: now,
    },
  })
  await prisma.bulkEmailRecipient.create({
    data: {
      id: newId(),
      tenantId: actor.tenantId,
      campaignId: id,
      position: 0,
      companyName: x.companyName,
      contactName: x.firstName,
      toEmail: x.toEmail,
      ccEmails: x.ccEmails as never,
      sourceRows: [] as never,
      subject: review.subject,
      body: review.text,
      templateKey: x.template.key,
      status: 'scheduled',
      reason: null,
      scheduledAt: now,
    },
  })
  await record(actor, id, 'started', `Single email approved: Version ${review.version} to ${x.toEmail} from ${fromEmail}`, { toEmail: x.toEmail, version: review.version })
  return { campaignId: id, scheduled: 1 }
}

// ── Start ──────────────────────────────────────────────────────────────────

export async function startBulk(actor: Actor, s: BulkSetup & { confirm?: boolean }, now = new Date()) {
  if (s.confirm !== true) throw new BadRequestError('Tick the confirmation that you reviewed every email in this send.')
  const sending = bulkSendingStatus()
  if (sending.reason) throw new ConflictError(sending.reason)
  const checked = checkedSetup(s)
  const profile = profileOf(await tenantSettings(actor.tenantId))
  const fromEmail = profile.fromEmail
  if (!fromEmail) throw new BadRequestError('Set the From email for bulk emails first (Sender, on the Bulk email page).')
  // Checked again now, with the account configured now: never sent on an old answer.
  const auth = await authorizeFrom(actor, fromEmail, now, true)
  if (!auth.authorized) throw new ConflictError(`Not started — ${fromEmail} is not authorized for this sending account. ${auth.reason}`)

  const review = await reviewBulk(actor, s, now)
  const ready = review.rows.filter((r) => r.status === 'ready')
  if (!ready.length) throw new ConflictError('No email can be sent from this file — see the reason against each company.')

  const id = newId()
  const name = (s.name ?? '').trim().slice(0, 120) || `${s.fileName?.replace(/\.xlsx$/i, '') || 'Bulk email'} — ${fmtIst(now).replace(/, \d{1,2}:\d{2} [AP]M IST$/, '')}`
  // The columns kept from the first version (sending hours, days, daily limit,
  // footer) are stored as "none": every day, all day, no limit.
  await prisma.bulkEmailCampaign.create({
    data: {
      id,
      tenantId: actor.tenantId,
      name,
      status: 'running',
      templateKey: checked.template.key,
      subject: checked.template.subject,
      body: checked.template.body,
      fromEmail,
      fromName: null,
      ccEmails: profile.ccEmails as never,
      signature: cleanSignature(profile.signature),
      signatureHtml: profile.signatureHtml,
      postalAddress: '',
      sourceFileName: s.fileName ?? null,
      timezone: IST,
      startAt: checked.start,
      sendDays: [1, 2, 3, 4, 5, 6, 7] as never,
      sendStartMinute: 0,
      sendEndMinute: 1440,
      intervalMinutes: checked.intervalMinutes,
      dailyCap: 0,
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
      templateKey: r.templateKey,
      status: r.status === 'ready' ? 'scheduled' : 'skipped',
      reason: r.reason,
      scheduledAt: r.scheduledAt ? new Date(r.scheduledAt) : null,
    })),
  })
  await record(actor, id, 'started', `Bulk email "${name}" approved: ${ready.length} emails from ${fromEmail}, from ${review.schedule.firstLocal}, ${checked.intervalMinutes} min apart; ${review.counts.skipped} skipped`, {
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
  const n = (st: string) => groups.find((g) => g.status === st)?._count._all ?? 0
  // Open tracking, over the sent emails: the three always add up to "sent".
  const tracked = await prisma.bulkEmailRecipient.count({ where: { campaignId, status: 'sent', trackingEnabled: true } })
  const openDetected = await prisma.bulkEmailRecipient.count({ where: { campaignId, status: 'sent', trackingEnabled: true, openCount: { gt: 0 } } })
  return {
    scheduled: n('scheduled'),
    sending: n('sending'),
    sent: n('sent'),
    failed: n('failed'),
    skipped: n('skipped'),
    total: groups.reduce((a, g) => a + g._count._all, 0),
    opens: { sent: n('sent'), openDetected, noOpenDetected: tracked - openDetected, trackingUnavailable: n('sent') - tracked },
  }
}

/** One email's open-tracking result, as the screen shows it. Nothing is shown for an email not sent. */
function openTracking(r: { status: string; trackingEnabled: boolean | null; trackingNote: string | null; openCount: number; firstOpenedAt: Date | null; lastOpenedAt: Date | null }) {
  if (r.status !== 'sent') return null
  if (r.trackingEnabled !== true) {
    return {
      status: 'tracking_unavailable' as const,
      note: r.trackingEnabled === false ? r.trackingNote ?? 'This email was sent without open tracking.' : 'Sent before open tracking existed.',
      openCount: 0,
      firstOpenedLocal: null,
      lastOpenedLocal: null,
    }
  }
  return {
    status: r.openCount > 0 ? ('open_detected' as const) : ('no_open_detected' as const),
    note: null,
    openCount: r.openCount,
    firstOpenedLocal: r.firstOpenedAt ? fmtIst(r.firstOpenedAt) : null,
    lastOpenedLocal: r.lastOpenedAt ? fmtIst(r.lastOpenedAt) : null,
  }
}

type Campaign = NonNullable<Awaited<ReturnType<typeof prisma.bulkEmailCampaign.findFirst>>>
type Recipient = NonNullable<Awaited<ReturnType<typeof prisma.bulkEmailRecipient.findFirst>>>

function campaignRow(c: Campaign) {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    statusReason: c.statusReason,
    templateKey: c.templateKey,
    fromEmail: c.fromEmail,
    ccEmails: (c.ccEmails as string[]) ?? [],
    startLocal: fmtIst(c.startAt),
    intervalMinutes: c.intervalMinutes,
    sourceFileName: c.sourceFileName,
    createdAt: c.createdAt.toISOString(),
    completedAt: c.completedAt?.toISOString() ?? null,
    completedLocal: c.completedAt ? fmtIst(c.completedAt) : null,
  }
}

export async function listBulk(tenantId: string) {
  const campaigns = await prisma.bulkEmailCampaign.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 100 })
  const out = []
  for (const c of campaigns) out.push({ ...campaignRow(c), counts: await countsOf(c.id) })
  return { campaigns: out, sending: bulkSendingStatus(), openTracking: trackingStatusForScreen() }
}

export async function bulkView(tenantId: string, id: string) {
  const c = await prisma.bulkEmailCampaign.findFirst({ where: { id, tenantId } })
  if (!c) throw new NotFoundError('Bulk send not found.')
  const recipients = await prisma.bulkEmailRecipient.findMany({ where: { campaignId: id }, orderBy: { position: 'asc' } })
  const last = await prisma.bulkEmailRecipient.findFirst({ where: { campaignId: id, status: 'scheduled' }, orderBy: { scheduledAt: 'desc' }, select: { scheduledAt: true } })
  return {
    campaign: { ...campaignRow(c), estimatedCompletionLocal: last?.scheduledAt ? fmtIst(last.scheduledAt) : null },
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
      version: versionOf(r.templateKey ?? c.templateKey),
      status: r.status,
      reason: r.reason,
      scheduledLocal: r.scheduledAt ? fmtIst(r.scheduledAt) : null,
      sentLocal: r.sentAt ? fmtIst(r.sentAt) : null,
      tracking: openTracking(r),
    })),
    sending: bulkSendingStatus(),
    openTracking: trackingStatusForScreen(),
  }
}

// ── Controls ───────────────────────────────────────────────────────────────

export async function setBulkState(actor: Actor, id: string, to: 'pause' | 'resume' | 'cancel', now = new Date()) {
  const c = await prisma.bulkEmailCampaign.findFirst({ where: { id, tenantId: actor.tenantId } })
  if (!c) throw new NotFoundError('Bulk send not found.')
  if (c.status === 'completed' || c.status === 'cancelled') throw new ConflictError(`This bulk send is already ${c.status}.`)
  if (to === 'pause') {
    await prisma.bulkEmailCampaign.update({ where: { id }, data: { status: 'paused', statusReason: null } })
    await record(actor, id, 'paused', `Bulk email "${c.name}" paused — nothing more is sent until it is resumed`)
    return { id, status: 'paused' }
  }
  if (to === 'resume') {
    const auth = await authorizeFrom(actor, c.fromEmail, now, true)
    if (!auth.authorized) throw new ConflictError(`Not resumed — ${c.fromEmail} is not authorized for this sending account. ${auth.reason}`)
    // The rest are re-timed from now, so a long pause never ends in a burst.
    const remaining = await prisma.bulkEmailRecipient.findMany({ where: { campaignId: id, status: 'scheduled' }, orderBy: { position: 'asc' }, select: { id: true } })
    const slots = planSequential(now, remaining.length, c.intervalMinutes)
    for (const [i, r] of remaining.entries()) await prisma.bulkEmailRecipient.update({ where: { id: r.id }, data: { scheduledAt: slots[i] } })
    await prisma.bulkEmailCampaign.update({ where: { id }, data: { status: 'running', statusReason: null } })
    await record(actor, id, 'resumed', `Bulk email "${c.name}" resumed — ${remaining.length} emails re-timed from now`)
    return { id, status: 'running' }
  }
  await prisma.bulkEmailRecipient.updateMany({ where: { campaignId: id, status: 'scheduled' }, data: { status: 'skipped', reason: 'The bulk send was cancelled.' } })
  await prisma.bulkEmailCampaign.update({ where: { id }, data: { status: 'cancelled', completedAt: now } })
  await record(actor, id, 'cancelled', `Bulk email "${c.name}" cancelled — unsent emails skipped`)
  return { id, status: 'cancelled' }
}

/** A recipient replied "unsubscribe": their address goes on the opt-out list, which every send checks. */
export async function unsubscribeRecipient(actor: Actor, recipientId: string) {
  const r = await prisma.bulkEmailRecipient.findFirst({ where: { id: recipientId, tenantId: actor.tenantId } })
  if (!r || !r.toEmail) throw new NotFoundError('Recipient not found.')
  await prisma.suppressionEntry.upsert({
    where: { tenantId_scope_matchType_matchValue: { tenantId: actor.tenantId, scope: 'global', matchType: 'email', matchValue: r.toEmail } },
    create: { id: newId(), tenantId: actor.tenantId, scope: 'global', matchType: 'email', matchValue: r.toEmail, reason: 'Replied "unsubscribe" to a bulk email', source: 'unsubscribe', createdByCrmUserId: actor.crmUserId },
    update: {},
  })
  await prisma.bulkEmailRecipient.updateMany({ where: { tenantId: actor.tenantId, toEmail: r.toEmail, status: 'scheduled' }, data: { status: 'skipped', reason: 'Unsubscribed.' } })
  await record(actor, r.campaignId, 'unsubscribed', `${r.toEmail} unsubscribed — added to the opt-out list`)
  return { email: r.toEmail }
}

// ── The sender (worker, every minute) ──────────────────────────────────────

/**
 * Sends what is due, at most ONE email per send per call, and only when that
 * send's last email went at least `interval` minutes ago. A failure is
 * recorded on that email and the send carries on.
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
      const lastSent = await prisma.bulkEmailRecipient.findFirst({ where: { campaignId: c.id, sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } })
      const spaced = !lastSent?.sentAt || now.getTime() - lastSent.sentAt.getTime() >= c.intervalMinutes * 60_000 - 5_000
      if (spaced) {
        const next = await prisma.bulkEmailRecipient.findFirst({ where: { campaignId: c.id, status: 'scheduled', scheduledAt: { lte: now } }, orderBy: [{ scheduledAt: 'asc' }, { position: 'asc' }] })
        if (next) {
          const system = { tenantId: c.tenantId, crmUserId: 'bulk-sender' }
          const auth = await authorizeFrom(system, c.fromEmail, now, false)
          if (!auth.authorized) {
            // Nothing goes from an address this account may not send as.
            const statusReason = `Paused — ${c.fromEmail} is not authorized for the sending account: ${auth.reason}`
            await prisma.bulkEmailCampaign.update({ where: { id: c.id }, data: { status: 'paused', statusReason } })
            await record(system, c.id, 'paused', `Bulk email "${c.name}" paused: the From address is not authorized`, { reason: auth.reason })
            continue
          }
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
      logger.error({ err, campaignId: c.id }, 'bulk email: dispatch failed; it is tried again next minute')
    }
  }
  return { sent, failed }
}

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
    await prisma.bulkEmailRecipient.update({ where: { id: r.id }, data: { status: 'skipped', reason: sup.suppressed ? `On the opt-out list: ${sup.detail ?? sup.reason}` : 'Nothing to send.' } })
    return 'skipped'
  }
  // The version this person was given at review.
  const template: BulkTemplate = bulkTemplate(r.templateKey ?? c.templateKey) ?? STATIC_SITE
  const email = composeBulkEmail({ template, firstName: firstNameOf(r.contactName), companyName: r.companyName, signature: c.signature, signatureHtml: c.signatureHtml })
  // What goes is what was reviewed: the stored text. The HTML part is the same
  // words, laid out, and is only used when it matches.
  const reviewedHtml = email.text === r.body ? email.html : `<pre style="font-family:Verdana,Geneva,sans-serif;white-space:pre-wrap">${r.body.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`

  // Open tracking: this email's own invisible image, only when a verified
  // public HTTPS address is in place. Any problem here means the email goes
  // without it — never that the email does not go.
  let html = reviewedHtml
  let tracked = false
  let trackingNote: string | null = null
  try {
    const t = await trackingReady(now)
    if (t.ok && t.base) {
      const token = newTrackingToken()
      await prisma.bulkEmailRecipient.update({ where: { id: r.id }, data: { trackingTokenHash: hashToken(token) } })
      html = addPixel(reviewedHtml, pixelUrl(t.base, token))
      tracked = true
    } else {
      trackingNote = t.reason
    }
  } catch (err) {
    logger.warn({ campaignId: c.id, recipientId: r.id, err: String((err as Error).message ?? err).slice(0, 200) }, 'bulk email: open tracking could not be prepared; sending without it')
    html = reviewedHtml
    tracked = false
    trackingNote = 'Open tracking could not be prepared for this email, so it was sent without it.'
  }

  try {
    const res = await bulkSender().send({ fromEmail: c.fromEmail, fromName: c.fromName, to: r.toEmail, cc: (r.ccEmails as string[]) ?? [], subject: r.subject, text: r.body, html })
    await prisma.bulkEmailRecipient.update({
      where: { id: r.id },
      data: { status: 'sent', sentAt: now, messageId: res.messageId, reason: null, trackingEnabled: tracked, trackingNote: tracked ? null : trackingNote },
    })
    return 'sent'
  } catch (err) {
    const reason = String((err as Error).message ?? err).slice(0, 400)
    await prisma.bulkEmailRecipient.update({ where: { id: r.id }, data: { status: 'failed', reason } })
    logger.warn({ campaignId: c.id, recipientId: r.id, reason }, 'bulk email: one email failed; the send carries on')
    return 'failed'
  }
}
