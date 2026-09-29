import { env } from '../../config/env.js'
import { FORBIDDEN_FIELDS, ForbiddenCrmWriteError, assertServiceIdentity, isLocalTarget } from '../../crmsync/writeGate.js'
import { hostOf, normalizeCompanyName } from '../../decisionmakers/companyMatch.js'
import { registrableDomain } from '../../enrichment/siteIdentity.js'
import { verifiedProductPageUrl } from '../../outreach/salesSequence/productPage.js'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { ConflictError, NotFoundError, UpstreamError } from '../../platform/errors.js'
import { logger } from '../../platform/logger.js'
import { getCrm } from '../index.js'
import { crmPost, crmPut } from '../nxtSales/httpClient.js'
import { discoveredWebsiteDomain } from '../../prospects/discoveredCompanyAdapter.js'
import { findCompanyInCrm, type CrmCheck } from './crmDuplicates.js'

// NEW LEADS INTO NXT SALES (2026-09-29).
//
// What the Marketing AI Agent finds is checked against the LIVE CRM, and a
// company that is genuinely new is created there — only when a PERSON clicks
// "Add to NXT Sales". The rules, all enforced here:
//
//   · The live CRM decides what is a duplicate, checked again at the moment of
//     adding (findCompanyInCrm), and its own 409 on create is honoured: a
//     duplicate is LINKED, never created a second time.
//   · Every created company carries the Lead Source field = "Marketing AI
//     Agent"; without that field configured nothing is created.
//   · It is owned by the person who added it — their own NXT Sales user id,
//     never anyone else's. Owner CHANGES stay forbidden (writeGate.ts).
//   · One create at a time per company (a short claim), no retries: a create
//     that timed out is found by the duplicate check on the next attempt.
//   · Decision makers are MERGED into the company's contact lists — name and
//     role, public LinkedIn URL, verified work email — never replacing or
//     removing what is there, and never an email another company already has.
//   · Every write goes through crmPost / crmPut, so CRM_WRITE_ENABLED, the
//     separate CRM_WRITE_ALLOW_LIVE switch and the confirmed service identity
//     all apply exactly as they do to the existing CRM sync.

export interface Actor {
  tenantId: string
  crmUserId: string
  requestId?: string | null
}

export interface LeadWriteStatus {
  canWrite: boolean
  target: 'local' | 'live'
  sourceField: string | null
  sourceValue: string
  /** Why writing is not possible, in words an operator can act on. */
  reason: string | null
}

const CLAIM_MS = 10 * 60_000
const ROLE_MAILBOX = /^(info|sales|contact|contacts|enquiries|enquiry|inquiries|inquiry|admin|office|hello|support|service|orders?|accounts?|marketing|team|mail|webmaster|noreply|no-reply)@/i

export function leadWriteStatus(): LeadWriteStatus {
  const target = isLocalTarget(env.NXT_SALES_BASE_URL) ? 'local' : 'live'
  const sourceField = env.CRM_LEAD_SOURCE_FIELD.trim() || null
  const base = { target, sourceField, sourceValue: env.CRM_LEAD_SOURCE_VALUE.trim() } as const
  const no = (reason: string): LeadWriteStatus => ({ ...base, canWrite: false, reason })
  if (env.CRM_DRIVER !== 'real') return no('The CRM driver is not the real NXT Sales (CRM_DRIVER), so nothing can be added to it.')
  if (!env.CRM_WRITE_ENABLED) return no('Adding to NXT Sales is switched off (CRM_WRITE_ENABLED=false). The CRM is read-only.')
  if (target === 'live' && !env.CRM_WRITE_ALLOW_LIVE) {
    return no('This platform reads the live NXT Sales but may not write to it (CRM_WRITE_ALLOW_LIVE=false).')
  }
  try {
    assertServiceIdentity()
  } catch (err) {
    return no((err as Error).message)
  }
  if (!sourceField) {
    return no('The Lead Source field is not set up (CRM_LEAD_SOURCE_FIELD). Run `npm run crm:setup-lead-source` once, then set it.')
  }
  if (!base.sourceValue) return no('CRM_LEAD_SOURCE_VALUE is empty.')
  return { ...base, canWrite: true, reason: null }
}

/**
 * The last check on a create body. Owner may be set ONLY to the person adding
 * it; every other forbidden field is refused; the Lead Source must be there.
 */
export function assertCreatable(body: Record<string, unknown>, actorCrmUserId: string, sourceField: string, sourceValue: string): void {
  for (const field of FORBIDDEN_FIELDS) {
    if (field === 'ownerId') continue
    if (field in body) throw new ForbiddenCrmWriteError(field)
  }
  if (!actorCrmUserId || body.ownerId !== actorCrmUserId) {
    throw new Error('Refusing to create: the owner must be the person adding the company.')
  }
  const custom = (body.customFields ?? {}) as Record<string, unknown>
  for (const field of FORBIDDEN_FIELDS) {
    if (field in custom) throw new ForbiddenCrmWriteError(`customFields.${field}`)
  }
  if (custom[sourceField] !== sourceValue) {
    throw new Error(`Refusing to create: the Lead Source field "${sourceField}" must be "${sourceValue}".`)
  }
}

// ── The duplicate check, recorded on the discovered company ───────────────

type DiscoveredRow = Awaited<ReturnType<typeof loadDiscovered>>

async function loadDiscovered(tenantId: string, id: string) {
  const row = await prisma.discoveredCompany.findFirst({ where: { id, tenantId } })
  if (!row) throw new NotFoundError('Company not found.')
  return row
}

/** Checks one discovered company against the live CRM and records the answer. */
export async function checkDiscoveredCompany(tenantId: string, id: string): Promise<{ id: string; check: CrmCheck | { status: 'linked'; crmCompanyId: string } }> {
  const row = await loadDiscovered(tenantId, id)
  const now = new Date()

  // Created from here: confirm the record still exists in NXT Sales. A link
  // made by an earlier CHECK is decided again below, by a fresh check.
  if (row.crmCompanyId && row.crmMatchedOn === 'created') {
    try {
      const still = await getCrm().getCompany(row.crmCompanyId)
      if (still) {
        await prisma.discoveredCompany.update({ where: { id }, data: { crmCheckedAt: now, crmCheckNote: null } })
        return { id, check: { status: 'linked', crmCompanyId: row.crmCompanyId } }
      }
      await prisma.discoveredCompany.update({
        where: { id },
        data: {
          crmCompanyId: null,
          status: 'candidate',
          crmMatchedOn: null,
          crmCheckedAt: now,
          crmCheckNote: 'The linked NXT Sales company no longer exists (deleted or in the recycle bin).',
        },
      })
    } catch (err) {
      const reason = `NXT Sales could not be checked: ${(err as Error).message}`.slice(0, 400)
      await prisma.discoveredCompany.update({ where: { id }, data: { crmCheckedAt: now, crmCheckNote: reason } })
      return { id, check: { status: 'unreachable', reason } }
    }
  }

  // The company's VERIFIED website only — never a page it was merely read from.
  const check = await findCompanyInCrm({ name: row.companyName, website: discoveredWebsiteDomain(row) })
  await recordCheck(row, check, now)
  return { id, check }
}

async function recordCheck(row: DiscoveredRow, check: CrmCheck, now: Date) {
  if (check.status === 'found') {
    await prisma.discoveredCompany.update({
      where: { id: row.id },
      data: { crmCompanyId: check.match.id, status: 'matched_to_crm', crmMatchedOn: check.match.matchedOn, crmCheckedAt: now, crmCheckNote: null },
    })
  } else if (check.status === 'name_conflict') {
    await prisma.discoveredCompany.update({
      where: { id: row.id },
      data: {
        crmCompanyId: null,
        status: row.status === 'matched_to_crm' ? 'candidate' : row.status,
        crmMatchedOn: 'name_conflict',
        crmCheckedAt: now,
        crmCheckNote: check.reason,
      },
    })
  } else if (check.status === 'not_found') {
    await prisma.discoveredCompany.update({
      where: { id: row.id },
      data: { crmCompanyId: null, status: row.status === 'matched_to_crm' ? 'candidate' : row.status, crmMatchedOn: null, crmCheckedAt: now, crmCheckNote: null },
    })
  } else {
    await prisma.discoveredCompany.update({ where: { id: row.id }, data: { crmCheckedAt: now, crmCheckNote: check.reason } })
  }
}

/** Every company a search found, checked against the live CRM (reads only). */
export async function checkSearchAgainstCrm(tenantId: string, searchId: string): Promise<{ checked: number; inCrm: number; unreachable: number }> {
  const rows = await prisma.discoveredCompany.findMany({ where: { tenantId, searchId }, select: { id: true } })
  let inCrm = 0
  let unreachable = 0
  for (const r of rows) {
    const { check } = await checkDiscoveredCompany(tenantId, r.id).catch((err: Error) => ({ check: { status: 'unreachable' as const, reason: err.message } }))
    if (check.status === 'found' || check.status === 'linked') inCrm++
    if (check.status === 'unreachable') unreachable++
  }
  return { checked: rows.length, inCrm, unreachable }
}

// ── Adding a company ───────────────────────────────────────────────────────

export type AddResult =
  | { id: string; outcome: 'created'; crmCompanyId: string }
  | { id: string; outcome: 'already_in_crm'; crmCompanyId: string; crmName: string | null; matchedOn: string }
  | { id: string; outcome: 'name_conflict' | 'in_progress' | 'uncertain' | 'error'; message: string }

/** The verified decision maker to carry into NXT Sales with the company, if any. */
async function topDecisionMaker(tenantId: string, placeholderId: string) {
  const run = await prisma.decisionMakerRun.findFirst({
    where: { tenantId, crmCompanyId: placeholderId, status: 'completed' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (!run) return null
  return prisma.decisionMakerCandidate.findFirst({
    where: { tenantId, dmRunId: run.id, outcome: 'shortlisted', companyMatch: { in: ['verified', 'probable'] } },
    orderBy: { rank: 'asc' },
    select: { id: true, fullName: true, rawTitle: true, email: true, profileUrl: true },
  })
}

const contactLine = (name: string, title: string | null) => (title?.trim() ? `${name.trim()} - ${title.trim()}` : name.trim())
const isLinkedInProfile = (url: string | null | undefined) => Boolean(url && /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+/i.test(url))

/** A person's work email that may be written: on the company's own domain, not a shared mailbox. */
function writableWorkEmail(email: string | null | undefined, companyWebsite: string | null | undefined): string | null {
  const e = String(email ?? '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || ROLE_MAILBOX.test(e)) return null
  const host = hostOf(companyWebsite ?? null)
  if (!host || registrableDomain(e.split('@')[1]!) !== registrableDomain(host)) return null
  return e
}

/** Emails that another NXT Sales company already holds (so they are never added again). */
async function emailsHeldElsewhere(emails: string[], excludeCompanyId: string | null): Promise<Set<string>> {
  if (!emails.length) return new Set()
  const r = await crmPost<{ conflicts?: Array<{ email?: string }> }>('/api/companies/email-conflicts', {
    emails,
    ...(excludeCompanyId ? { excludeCompanyId } : {}),
  })
  return new Set((r.conflicts ?? []).map((c) => String(c.email ?? '').toLowerCase()).filter(Boolean))
}

function existingFrom409(err: unknown): { id: string; name: string | null } | null {
  const d = (err as UpstreamError)?.details as { status?: number; body?: string } | undefined
  if (d?.status !== 409 || !d.body) return null
  try {
    const parsed = JSON.parse(d.body) as { existing?: { id?: string; name?: string } }
    return parsed.existing?.id ? { id: parsed.existing.id, name: parsed.existing.name ?? null } : null
  } catch {
    return null
  }
}

async function addOne(actor: Actor, id: string, status: LeadWriteStatus): Promise<AddResult> {
  const row = await loadDiscovered(actor.tenantId, id)
  const now = new Date()

  // The live CRM decides — checked again now, not from the last search.
  const checked = await checkDiscoveredCompany(actor.tenantId, id)
  if (checked.check.status === 'linked') {
    return { id, outcome: 'already_in_crm', crmCompanyId: checked.check.crmCompanyId, crmName: null, matchedOn: row.crmMatchedOn ?? 'linked' }
  }
  if (checked.check.status === 'found') {
    return { id, outcome: 'already_in_crm', crmCompanyId: checked.check.match.id, crmName: checked.check.match.name, matchedOn: checked.check.match.matchedOn }
  }
  if (checked.check.status === 'name_conflict') {
    return { id, outcome: 'name_conflict', message: `${checked.check.reason} Nothing was added.` }
  }
  if (checked.check.status === 'unreachable') {
    // Never create blind: without the duplicate check there is no add.
    return { id, outcome: 'error', message: `${checked.check.reason} Nothing was added.` }
  }

  // One create at a time for this company.
  const claimed = await prisma.discoveredCompany.updateMany({
    where: {
      id,
      tenantId: actor.tenantId,
      crmCompanyId: null,
      OR: [{ crmCreateStartedAt: null }, { crmCreateStartedAt: { lt: new Date(now.getTime() - CLAIM_MS) } }],
    },
    data: { crmCreateStartedAt: now },
  })
  if (claimed.count === 0) return { id, outcome: 'in_progress', message: 'This company is already being added. Check again in a moment.' }

  try {
    const verified = discoveredWebsiteDomain(row)
    const website = verified ? `https://${verified.replace(/^https?:\/\//, '')}` : null
    const host = hostOf(website)
    const dm = await topDecisionMaker(actor.tenantId, id)
    const dmEmail = dm ? writableWorkEmail(dm.email, website) : null
    const heldElsewhere = await emailsHeldElsewhere(dmEmail ? [dmEmail] : [], null)
    const email = dmEmail && !heldElsewhere.has(dmEmail) ? dmEmail : null
    const pdp = verifiedProductPageUrl(row.productPageUrl ? { url: row.productPageUrl } : null, host)

    const body: Record<string, unknown> = {
      name: row.companyName.trim(),
      ...(host ? { domain: host } : {}),
      ...(pdp ? { endPdpUrl: pdp } : {}),
      ownerId: actor.crmUserId,
      ...(dm ? { contactPersons: [contactLine(dm.fullName, dm.rawTitle)] } : {}),
      ...(dm && isLinkedInProfile(dm.profileUrl) ? { linkedProfiles: [dm.profileUrl] } : {}),
      ...(email ? { emails: [email] } : {}),
      customFields: { [status.sourceField!]: status.sourceValue },
    }
    assertCreatable(body, actor.crmUserId, status.sourceField!, status.sourceValue)

    let created: { id?: string; name?: string }
    try {
      created = await crmPost<{ id?: string; name?: string }>('/api/companies', body)
    } catch (err) {
      const existing = existingFrom409(err)
      if (existing) {
        // NXT Sales' own duplicate rule caught it: link, never create twice.
        await prisma.discoveredCompany.update({
          where: { id },
          data: { crmCompanyId: existing.id, status: 'matched_to_crm', crmMatchedOn: 'crm_rule', crmCheckedAt: new Date(), crmCheckNote: null, crmCreateStartedAt: null },
        })
        return { id, outcome: 'already_in_crm', crmCompanyId: existing.id, crmName: existing.name, matchedOn: 'crm_rule' }
      }
      if ((err as UpstreamError)?.details && (err as { details: { timedOut?: boolean } }).details.timedOut) {
        // Keep the claim: the next try re-checks the CRM first and finds it if it landed.
        await prisma.discoveredCompany.update({ where: { id }, data: { crmCheckNote: 'The add timed out and may or may not have landed. Check again before adding.' } })
        return { id, outcome: 'uncertain', message: 'NXT Sales did not answer in time. It may have been added — click Check NXT Sales before trying again.' }
      }
      throw err
    }
    if (!created?.id) throw new Error('NXT Sales answered without the new company id.')

    await prisma.discoveredCompany.update({
      where: { id },
      data: {
        crmCompanyId: created.id,
        status: 'matched_to_crm',
        crmMatchedOn: 'created',
        crmCheckedAt: new Date(),
        crmCheckNote: null,
        crmCreateStartedAt: null,
        crmCreatedAt: new Date(),
        crmCreatedByCrmUserId: actor.crmUserId,
      },
    })
    await audit({
      tenantId: actor.tenantId,
      actorType: 'user',
      actorCrmUserId: actor.crmUserId,
      action: 'crm.company_created',
      resourceType: 'DiscoveredCompany',
      resourceId: id,
      dataClass: 'customer_pii',
      summary: `Added "${row.companyName}" to NXT Sales (${status.target}) as ${created.id}, Lead Source "${status.sourceValue}"${dm ? ', with its decision maker' : ''}`,
      requestId: actor.requestId ?? null,
    })
    return { id, outcome: 'created', crmCompanyId: created.id }
  } catch (err) {
    await prisma.discoveredCompany.update({ where: { id }, data: { crmCreateStartedAt: null } }).catch(() => undefined)
    logger.warn({ err: (err as Error).message, discoveredCompanyId: id }, 'add to NXT Sales failed')
    return { id, outcome: 'error', message: `${(err as Error).message}`.slice(0, 400) }
  }
}

/** "Add to NXT Sales" for one or more discovered companies — each checked, then created or linked. */
export async function addDiscoveredCompaniesToCrm(actor: Actor, ids: string[]): Promise<AddResult[]> {
  const status = leadWriteStatus()
  if (!status.canWrite) throw new ConflictError(status.reason ?? 'Adding to NXT Sales is not possible right now.')
  // The owner is the person adding it, so they must be a user of THIS NXT
  // Sales — otherwise the CRM rejects the create with a bare server error.
  const users = await getCrm().listUsers()
  if (!users.some((u) => u.id === actor.crmUserId)) {
    throw new ConflictError(
      'Your login is not a user in this NXT Sales, so a company cannot be created with you as its owner. Nothing was added.',
    )
  }
  const out: AddResult[] = []
  for (const id of [...new Set(ids)]) out.push(await addOne(actor, id, status))
  return out
}

// ── Adding a decision maker to a company already in NXT Sales ─────────────

export type DmAddResult =
  | { outcome: 'added'; crmCompanyId: string; added: string[] }
  | { outcome: 'already_up_to_date'; crmCompanyId: string }

/** Is this stored contact line already this person? ("Jane Smith - Head of eCommerce") */
function samePerson(stored: string, fullName: string): boolean {
  const n = normalizeCompanyName(fullName)
  const s = normalizeCompanyName(stored.split(/\s[-–—]\s|,/)[0] ?? stored)
  return Boolean(n) && s === n
}

export async function addDecisionMakerToCrm(actor: Actor, candidateId: string): Promise<DmAddResult> {
  const status = leadWriteStatus()
  if (!status.canWrite) throw new ConflictError(status.reason ?? 'Adding to NXT Sales is not possible right now.')

  const c = await prisma.decisionMakerCandidate.findFirst({
    where: { id: candidateId, tenantId: actor.tenantId },
    select: { id: true, crmCompanyId: true, fullName: true, rawTitle: true, email: true, profileUrl: true, outcome: true, companyMatch: true },
  })
  if (!c) throw new NotFoundError('Decision maker not found.')
  if (c.outcome !== 'shortlisted' || !['verified', 'probable'].includes(c.companyMatch)) {
    throw new ConflictError('Only a shortlisted decision maker whose employment at this company is verified can be added to NXT Sales.')
  }

  // A company found by Prospects is only in NXT Sales once linked.
  const discovered = await prisma.discoveredCompany.findFirst({ where: { id: c.crmCompanyId, tenantId: actor.tenantId }, select: { crmCompanyId: true } })
  const crmCompanyId = discovered ? discovered.crmCompanyId : c.crmCompanyId
  if (!crmCompanyId) throw new ConflictError('This company is not in NXT Sales yet. Add the company to NXT Sales first.')

  const company = await getCrm().getCompany(crmCompanyId)
  if (!company) throw new NotFoundError('The company is no longer in NXT Sales (deleted or in the recycle bin).')

  const added: string[] = []
  const patch: Record<string, unknown> = {}

  if (!company.contactPersons.some((p) => samePerson(p, c.fullName))) {
    patch.contactPersons = [...company.contactPersons, contactLine(c.fullName, c.rawTitle)]
    added.push('name')
  }
  if (isLinkedInProfile(c.profileUrl)) {
    const slug = (u: string) => u.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '')
    if (!company.linkedProfiles.some((u) => slug(u) === slug(c.profileUrl!))) {
      patch.linkedProfiles = [...company.linkedProfiles, c.profileUrl]
      added.push('LinkedIn')
    }
  }
  const email = writableWorkEmail(c.email, company.domain)
  const onRecord = new Set([company.email, ...company.emails].map((e) => String(e ?? '').toLowerCase()).filter(Boolean))
  if (email && !onRecord.has(email)) {
    const elsewhere = await emailsHeldElsewhere([email], crmCompanyId)
    if (!elsewhere.has(email)) {
      // Appended, so the company's primary email (the first) never changes.
      patch.emails = [...(company.email && !company.emails.length ? [company.email] : company.emails), email]
      added.push('email')
    }
  }

  if (!added.length) return { outcome: 'already_up_to_date', crmCompanyId }

  for (const field of FORBIDDEN_FIELDS) if (field in patch) throw new ForbiddenCrmWriteError(field)
  await crmPut(`/api/companies/${encodeURIComponent(crmCompanyId)}`, patch)
  await audit({
    tenantId: actor.tenantId,
    actorType: 'user',
    actorCrmUserId: actor.crmUserId,
    action: 'crm.decision_maker_added',
    resourceType: 'DecisionMakerCandidate',
    resourceId: c.id,
    dataClass: 'customer_pii',
    summary: `Decision maker added to NXT Sales company ${crmCompanyId} (${status.target}): ${added.join(', ')}`,
    requestId: actor.requestId ?? null,
  })
  return { outcome: 'added', crmCompanyId, added }
}
