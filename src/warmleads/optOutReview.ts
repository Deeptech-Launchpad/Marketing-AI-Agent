import { Prisma } from '@prisma/client'
import { prisma } from '../platform/db.js'
import { fingerprintKeyConfigured, fingerprintKeyId } from './optOut.js'

// WARM LEADS — THE OPT-OUT REVIEW LIST (pilot review). Read only.
//
// While WARM_LEADS_RECORD_OPT_OUTS is off, every opt-out the module finds is only PROPOSED, and the proposal lives in the reasons of the
// evaluation that found it. This lists them across ALL of a tenant's evaluations - not only each company's latest one - so a proposal is not
// hidden by a later failed re-check, and is still there when the email itself has left the 90-day window. Each line carries the masked
// address, the date, the status and the NXT Sales activity id, so a reviewer can open exactly that email in NXT Sales (where NXT Sales' own
// access rules apply). No raw address and no message text is stored or returned.
//
// NOTHING IS SILENTLY LEFT OUT: the evaluations are read in batches (keyset paging) until there are no more; the result says how many proposals
// are pending in total and whether the whole history was read (`complete`). A ceiling on the number of evaluations read exists only as a
// backstop against a runaway table, and if it is ever reached `complete` is false and the screen says so.

export type OptOutReviewKind = 'proposal' | 'not_recorded' | 'reconsent' | 'omitted'

export interface OptOutReviewItem {
  kind: OptOutReviewKind
  crmCompanyId: string
  companyName: string | null
  /** The company's CURRENT Warm Leads classification (existing_customer / active_opportunity / do_not_contact are warnings), when it has one. */
  companyClassification: string | null
  evaluationId: string
  evaluatedAt: string | null
  /** dry_run | awaiting_approval | recorded | already_listed | needs_person | failed | for_review */
  status: string
  /** The masked sender, for a proposal or a re-consent candidate. */
  masked: string | null
  receivedOn: string | null
  /** The NXT Sales activity the opt-out was read from. */
  activityId: string | null
  /** SERVER SIDE ONLY - never sent to a browser (see toPublicItem): keyed fingerprint of the proposed address, what an approval is checked against. */
  fingerprint: string | null
  /** SERVER SIDE ONLY: id of the key that made the fingerprint. */
  keyId: string | null
  /** For the line of kind 'omitted' only: how many senders / messages were found but not listed. */
  omittedProposals: number
  omittedNotRecorded: number
  /** The standard phrase the email consists of, by OUR canonical label ("UNSUBSCRIBE", "STOP"...); never the person's words. */
  phrase: string | null
  /** The exact reason this proposal was generated, in words (from the phrase). */
  reason: string | null
  summary: string
  /** The person who approved this proposal (from the audit trail), when one did. */
  approvedBy: string | null
}

export interface OptOutReviewResult {
  /** Every listed line (proposals, not-recorded, re-consent), WITHOUT the 'omitted' counters. */
  items: OptOutReviewItem[]
  /** Proposals not yet recorded (dry run, awaiting approval, failed or held for a person), INCLUDING those counted but not listed (omitted): the number still to be decided. */
  pendingCount: number
  /** Found by the evaluations but NOT listed because of their per-check caps (the newest check of each company): counted, never silently dropped. */
  omitted: { proposals: number; notRecorded: number }
  /** false only if the backstop ceiling was reached: more evaluations exist than were read. */
  complete: boolean
}

interface StoredReason {
  signal?: unknown
  summary?: unknown
  evidence?: unknown
}

const KIND: Record<string, OptOutReviewKind> = { opt_out_proposal: 'proposal', opt_out_not_recorded: 'not_recorded', reconsent_candidate: 'reconsent', opt_out_omitted: 'omitted' }
const EVIDENCE = /^status: (\w+) · NXT activity (.+?) · received (\d{4}-\d{2}-\d{2})(?: · fp ([0-9a-f]{16}))?(?: · key ([0-9a-f]{8}))?(?: · phrase: ([A-Z][A-Z /-]{0,60}))?/
const OMITTED = /^omitted proposals: (\d{1,9}) · not recorded: (\d{1,9})/
const MASKED = /(\S*\*\*\*@\S+)/

/** The words for the reviewer: why this email became a proposal. */
function reasonFor(phrase: string | null): string | null {
  if (!phrase) return null
  return `The email consists only of the standard request ${phrase.split(' / ').map((p) => `“${p}”`).join(' and ')}, sent from one address that is not ours, with no other request, address or colleague in it. That is all this proposal rests on: the sender is not authenticated.`
}

/** The review lines found in one evaluation's stored reasons. Pure: tolerates anything stored. */
export function itemsFromReasons(reasons: unknown, base: { crmCompanyId: string; companyName: string | null; evaluationId: string; evaluatedAt: string | null }): OptOutReviewItem[] {
  if (!Array.isArray(reasons)) return []
  const out: OptOutReviewItem[] = []
  for (const r of reasons as StoredReason[]) {
    const kind = typeof r?.signal === 'string' ? KIND[r.signal] : undefined
    if (!kind || typeof r.summary !== 'string') continue
    const om = kind === 'omitted' && typeof r.evidence === 'string' ? OMITTED.exec(r.evidence) : null
    if (kind === 'omitted' && !om) continue
    const ev = kind !== 'omitted' && typeof r.evidence === 'string' ? EVIDENCE.exec(r.evidence) : null
    const phrase = kind === 'proposal' ? (ev?.[6]?.trim() || null) : null
    out.push({
      kind,
      ...base,
      companyClassification: null,
      status: kind === 'omitted' ? 'info' : (ev?.[1] ?? 'unknown'),
      masked: kind === 'not_recorded' ? null : (MASKED.exec(r.summary)?.[1] ?? null),
      receivedOn: ev?.[3] ?? null,
      activityId: ev?.[2] ?? null,
      fingerprint: ev?.[4] ?? null,
      keyId: ev?.[5] ?? null,
      omittedProposals: om ? Number(om[1]) : 0,
      omittedNotRecorded: om ? Number(om[2]) : 0,
      phrase,
      reason: reasonFor(phrase),
      summary: r.summary.slice(0, 600),
      approvedBy: null,
    })
  }
  return out
}

/** One line per (company, source activity, kind): the MOST RECENT evaluation's version of it wins. */
export function latestPerSource(items: OptOutReviewItem[]): OptOutReviewItem[] {
  const seen = new Set<string>()
  const out: OptOutReviewItem[] = []
  for (const it of items) {
    const key = it.kind === 'omitted' ? `${it.crmCompanyId}|omitted` : `${it.crmCompanyId}|${it.kind}|${it.activityId ?? it.masked ?? it.summary}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

const BATCH = 500
/** Backstop only: 100,000 evaluations is far more than a tenant of 1,200 companies can ever hold. */
const MAX_BATCHES = 200
const CHUNK = 500
const DONE = new Set(['recorded', 'already_listed'])

type Row = { id: string; crmCompanyId: string; companyName: string | null; evaluatedAt: Date | null; createdAt: Date; reasons: unknown }

async function readBatch(tenantId: string, crmCompanyId: string | undefined, after: { createdAt: Date; id: string } | null): Promise<Row[]> {
  // newest evaluation first; keyset paging on (createdAt, id) so that no row is skipped or repeated between batches
  const pattern = '(opt_out_proposal|opt_out_not_recorded|reconsent_candidate)'
  const onlyCompany = crmCompanyId !== undefined ? Prisma.sql`AND "crmCompanyId" = ${crmCompanyId}` : Prisma.empty
  const afterRow = after ? Prisma.sql`AND ("createdAt", "id") < (${after.createdAt}, ${after.id})` : Prisma.empty
  return prisma.$queryRaw<Row[]>`
    SELECT "id", "crmCompanyId", "companyName", "evaluatedAt", "createdAt", "reasons" FROM "WarmLeadEvaluation"
    WHERE "tenantId" = ${tenantId} ${onlyCompany} AND "status" IN ('done', 'failed') AND "reasons" IS NOT NULL
      AND "reasons"::text ~ ${pattern} ${afterRow}
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT ${BATCH}`
}

async function load(tenantId: string, crmCompanyId?: string): Promise<OptOutReviewResult> {
  let items: OptOutReviewItem[] = []
  let after: { createdAt: Date; id: string } | null = null
  let complete = true
  for (let n = 0; ; n++) {
    if (n >= MAX_BATCHES) {
      complete = false
      break
    }
    const rows = await readBatch(tenantId, crmCompanyId, after)
    for (const r of rows) items.push(...itemsFromReasons(r.reasons, { crmCompanyId: r.crmCompanyId, companyName: r.companyName, evaluationId: r.id, evaluatedAt: r.evaluatedAt ? r.evaluatedAt.toISOString() : null }))
    // only the newest version of each source is kept, so memory stays bounded by the number of distinct emails, not evaluations
    items = latestPerSource(items)
    if (rows.length < BATCH) break
    const last = rows[rows.length - 1]!
    after = { createdAt: last.createdAt, id: last.id }
  }

  // the company's current classification (for the warnings an approver needs to see)
  const classification = new Map<string, string | null>()
  const companyIds = [...new Set(items.map((i) => i.crmCompanyId))]
  for (let i = 0; i < companyIds.length; i += CHUNK) {
    const rows = await prisma.warmLeadCompany.findMany({ where: { tenantId, crmCompanyId: { in: companyIds.slice(i, i + CHUNK) } }, select: { crmCompanyId: true, classification: true } })
    for (const r of rows) classification.set(r.crmCompanyId, r.classification ?? null)
  }

  // a proposal a person approved is shown as recorded: the audit trail (append-only) says who. Looked up for exactly these proposals.
  const keys = [...new Set(items.filter((i) => i.kind === 'proposal').map((i) => `${i.crmCompanyId}|${i.activityId}`))]
  const approvedBy = new Map<string, string>()
  for (let i = 0; i < keys.length; i += CHUNK) {
    const events = await prisma.auditEvent.findMany({ where: { tenantId, action: 'warmleads.opt_out_approved', resourceId: { in: keys.slice(i, i + CHUNK) } }, select: { resourceId: true, actorCrmUserId: true }, orderBy: { createdAt: 'asc' } })
    for (const e of events) if (!approvedBy.has(e.resourceId ?? '')) approvedBy.set(e.resourceId ?? '', e.actorCrmUserId ?? 'a person')
  }

  const counters = items.filter((i) => i.kind === 'omitted')
  items = items.filter((i) => i.kind !== 'omitted')
  const omitted = { proposals: counters.reduce((n, c) => n + c.omittedProposals, 0), notRecorded: counters.reduce((n, c) => n + c.omittedNotRecorded, 0) }
  const out = items.map((it) => {
    const withClass = { ...it, companyClassification: classification.get(it.crmCompanyId) ?? null }
    const who = it.kind === 'proposal' ? approvedBy.get(`${it.crmCompanyId}|${it.activityId}`) : undefined
    return who ? { ...withClass, status: 'recorded', approvedBy: who } : withClass
  })
  return { items: out, pendingCount: out.filter((i) => i.kind === 'proposal' && !DONE.has(i.status)).length + omitted.proposals, omitted, complete }
}

/** Every opt-out proposal, "not recorded" opt-out and re-consent candidate of the tenant, newest evaluation first, with the total still pending. Tenant-scoped by the query itself. */
export async function optOutReview(tenantId: string): Promise<OptOutReviewResult> {
  return load(tenantId)
}

/** The same, for ONE company (what an approval checks the request against). */
export async function optOutReviewForCompany(tenantId: string, crmCompanyId: string): Promise<OptOutReviewItem[]> {
  return (await load(tenantId, crmCompanyId)).items
}

// ── What a browser may see ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type ApprovalBlockedReason =
  | 'switch_off' // WARM_LEADS_RECORD_OPT_OUTS is off on this server: proposals are read-only
  | 'key_not_configured' // the dedicated fingerprint key is not set: nothing can be approved (fail closed)
  | 'key_changed' // the key was changed since this proposal was made: the company must be evaluated again and the new proposal reviewed
  | 'no_fingerprint' // an older proposal without a fingerprint: evaluate the company again

export type PublicOptOutItem = Omit<OptOutReviewItem, 'fingerprint' | 'keyId' | 'omittedProposals' | 'omittedNotRecorded'> & {
  /** true only when an administrator may approve this proposal right now. A boolean - the fingerprint itself never leaves the server. */
  approvable: boolean
  /** For a pending proposal that cannot be approved: why, in a code the screen turns into words. */
  approvalBlockedReason: ApprovalBlockedReason | null
}

const PENDING = new Set(['dry_run', 'awaiting_approval'])

/** The line as a browser may receive it: no fingerprint, no key id - only whether (and if not, why not) it can be approved. */
export function toPublicItem(it: OptOutReviewItem, recordingEnabled: boolean): PublicOptOutItem {
  const { fingerprint, keyId, omittedProposals: _op, omittedNotRecorded: _on, ...rest } = it
  let reason: ApprovalBlockedReason | null = null
  if (it.kind === 'proposal' && PENDING.has(it.status)) {
    const current = fingerprintKeyId()
    if (!recordingEnabled) reason = 'switch_off'
    else if (!fingerprintKeyConfigured() || !current) reason = 'key_not_configured'
    else if (!fingerprint || !keyId) reason = 'no_fingerprint'
    else if (keyId !== current) reason = 'key_changed'
  }
  return { ...rest, approvable: it.kind === 'proposal' && PENDING.has(it.status) && reason === null, approvalBlockedReason: reason }
}

/** Pending proposals first (newest first), then everything else (newest first) - and at most `limit` of them. The total is reported separately. */
export function pageOfItems(items: OptOutReviewItem[], limit: number): OptOutReviewItem[] {
  const rank = (i: OptOutReviewItem) => (i.kind === 'proposal' && !DONE.has(i.status) ? 0 : 1)
  const day = (i: OptOutReviewItem) => i.receivedOn ?? ''
  return [...items].sort((a, b) => rank(a) - rank(b) || (day(a) < day(b) ? 1 : day(a) > day(b) ? -1 : 0)).slice(0, limit)
}
