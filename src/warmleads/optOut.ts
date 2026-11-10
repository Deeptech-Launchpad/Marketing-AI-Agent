import { createHmac } from 'node:crypto'
import { env } from '../config/env.js'
import { lookupAddresses, parseAddresses } from '../crm/nxtSales/mappers.js'
import type { CrmActivity, CrmCompany } from '../crm/types.js'
import { newId, prisma } from '../platform/db.js'
import { auditInTransaction } from '../platform/audit.js'
import { logger } from '../platform/logger.js'
import type { ReplyAssessment } from './replies.js'
import type { ObservedSignal, Reason } from './score.js'

// WARM LEADS — EXPLICIT MARKETING OPT-OUTS (owner decisions of 2026-11-05 and 2026-11-06).
//
// Buying intent and permission to contact are separate. A person who writes "unsubscribe / stop / remove me / do not email me" has
// withdrawn MARKETING permission. The shared suppression list (SuppressionEntry) is what Bulk Email, the outreach engine, the sales
// sequence and the campaign audience already check - Bulk Email before review, at start and again at the moment of sending - so
// recording the address there is all it takes to stop future marketing mail. Nothing in Bulk Email changes.
//
// What this module does, and the limits that go with it:
//   - Only a STRICT, STANDALONE, individual opt-out is ever recorded ("UNSUBSCRIBE", "STOP", "REMOVE ME [FROM YOUR MAILING LIST]", "DO NOT
//     EMAIL ME", "PLEASE STOP SENDING ME MARKETING EMAILS" and nothing else in the message). A message that also asks for a quotation or
//     any other action, mentions another address or a colleague or "us", mixes the phrase with other instructions, or is an opt-out only
//     in its subject or in quoted text is still an opt-out for the HUMAN-REVIEW hold - and nothing is written: a person decides.
//   - "Not interested", a rejection of one product, a wrong-person answer or a declined meeting never create a row.
//   - ONE address per message: the single, unambiguous sender (a whole, plain address - see parseAddresses). Refused: no sender or several,
//     our own mailbox / the CRM user / the inbound `toEmail` / any address on one of OUR domains (colleagues), a plus-alias, a no-reply /
//     postmaster / mailer-daemon / bounce / alert / system address, and any message when our own mailbox is not known. The address we
//     mailed on that conversation, when it differs, is shown as a masked SUGGESTION for a person - never recorded.
//   - NEVER a domain-level or company-level row, and never a second address.
//   - The `From` header is NOT authenticated (NXT Sales stores it raw, with no SPF / DKIM / DMARC result), so a forged "unsubscribe" cannot be told from a
//     real one. Therefore NO email-derived proposal is ever written automatically - not with the switch on, not by any flag: the only writer is
//     writeApprovedOptOut, called for an administrator's INDIVIDUAL approval (who must also confirm the request was verified through a trusted contact
//     channel). The row and its audit entry are written in one transaction. Fail closed.
//   - WARM_LEADS_RECORD_OPT_OUTS is OFF by default and stays off for development and the first pilot: every evaluation then lists the masked address it
//     PROPOSES (with the NXT activity id, the date and the status "dry run") and nothing can be approved. Turning it on needs the owner's separate approval,
//     and even then it only makes approval possible.
//   - Failure-safe: nothing is reported as "added" until the transaction committed; a failed approval is reported to the administrator and writes nothing.
//   - This module only ever ADDS. It never deletes or edits a suppression row. A clear, affirmative request to receive marketing mail again
//     only creates a review candidate; a person removes the row (DELETE /admin/suppression/:id).
//   - The row is durable (no expiry), so the opt-out outlives the 90-day window in which emails are read.
//   - This is the only file in src/warmleads that writes to SuppressionEntry (a test scans for it).

const log = logger.child({ module: 'warmleads-optout' })

/** At most this many distinct senders are proposed from one company's emails in one evaluation; the rest are listed as "not recorded". */
const MAX_PER_EVALUATION = 10

/**
 * A keyed fingerprint of an address (HMAC with a server secret, 16 hex characters). It is stored with a proposal so that the approval can prove
 * that the address it re-derives from the source email is EXACTLY the one that was proposed - a mask (first letter and domain) is not enough for
 * that. Without the server secret it can be neither turned back into an address nor checked against a guess.
 */
export function addressFingerprint(address: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`warmleads-optout|${address}`).digest('hex').slice(0, 16)
}

/** r***@acme.example - enough for a person to recognise, not the address itself. A one-letter local part is not shown at all. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 1) return '***'
  return `${at > 1 ? address.slice(0, 1) : ''}***${address.slice(at)}`
}

/** Local parts (without . _ - +) that belong to robots and mail systems: matched as a PREFIX, so `no-reply-sales`, `noreply2`, `alerts` all count. */
const AUTOMATED_LOCAL = /^(?:noreply|donotreply|dontreply|mailerdaemon|mailerdeamon|maildeliverysubsystem|postmaster|bounce|bounces|notification|notifications|notify|alert|alerts|system|automated|autoreply|autoresponder|daemon|abuse|root|webmaster|hostmaster|listserv|unsubscribe)/

const localOf = (address: string): string => address.slice(0, address.lastIndexOf('@'))
const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1)
/** Why this address can never be recorded automatically, or null. */
function unsafeSender(address: string, own: string[]): string | null {
  if (own.length === 0) return 'our own mailbox is not known for this message, so it cannot be checked that the sender is not one of us'
  if (own.includes(address)) return 'the sender is one of our own addresses'
  if (own.some((o) => domainOf(o) === domainOf(address) || domainOf(address).endsWith(`.${domainOf(o)}`))) return 'the sender is on one of our own domains (a colleague)'
  const local = localOf(address)
  if (local.includes('+')) return 'the sender is a plus-alias (a person may use several)'
  if (AUTOMATED_LOCAL.test(local.replace(/[._-]/g, ''))) return 'the sender is a no-reply, system or mail-system address'
  return null
}

export type OptOutStatus = 'dry_run' | 'awaiting_approval' | 'recorded' | 'already_listed' | 'needs_person' | 'failed'

export interface OptOutProposal {
  /** The bare, lower-case sender address. This is what would be written; it is never logged or put in a result. */
  address: string
  masked: string
  /** Keyed fingerprint of `address` (see addressFingerprint): what the approval compares, since a mask is not exact. */
  fingerprint: string
  /** The address we mailed on that conversation when it differs from the sender - masked, for a person to consider. */
  suggestion: string | null
  /** The day the opt-out message arrived. */
  receivedOn: string
  /** The NXT Sales activity the opt-out was read from, so a reviewer can open exactly that email there. A CRM id, not personal data. */
  activityId: string
  /** `record`: the switch is on, so a person may approve it. `dry_run`: the switch is off; nothing can be written. */
  mode: 'record' | 'dry_run'
  /** The exact reason this proposal exists: the canonical label of the standard phrase the email consists of ("UNSUBSCRIBE", "STOP", ...). Never the person's words. */
  phrase: string
}

export interface OptOutNotRecorded {
  reason: string
  activityId: string
  receivedOn: string
}

export interface OptOutDecision {
  proposals: OptOutProposal[]
  /** Opt-out messages that may not be recorded automatically, with why (no addresses in the text). A person decides. */
  refused: OptOutNotRecorded[]
}

/**
 * From the assessed messages of a company, the addresses an explicit opt-out would add to the suppression list. Pure: reads nothing, writes
 * nothing. Every opt-out message in the window counts - a later friendly message does not undo it.
 */
export function proposeOptOuts(assessed: ReplyAssessment[], record: boolean): OptOutDecision {
  const byAddress = new Map<string, OptOutProposal>()
  const refused = new Map<string, OptOutNotRecorded>()
  const refuse = (a: CrmActivity, reason: string) => {
    if (!refused.has(a.id)) refused.set(a.id, { reason, activityId: a.id, receivedOn: a.createdAt.slice(0, 10) })
  }
  for (const x of assessed) {
    if (x.verdict !== 'declined' || x.kind !== 'opt_out') continue
    const a = x.activity
    if (!x.strictOptOut) {
      refuse(a, 'it is not a plain standalone request to stop marketing mail to this one person (it also asks for something, mentions another address, a colleague or "us", or is only in the subject or in quoted text)')
      continue
    }
    const from = a.fromAddresses ?? []
    if (from.length === 0) {
      refuse(a, 'the sender is not available as one plain address')
      continue
    }
    if (from.length > 1) {
      refuse(a, 'the sender is not a single address')
      continue
    }
    const address = from[0]!
    // the writer checks again; an address that is not exactly one plain address never gets this far
    if (parseAddresses(address).length !== 1 || parseAddresses(address)[0] !== address) {
      refuse(a, 'the sender is not a plain address')
      continue
    }
    const unsafe = unsafeSender(address, a.ownAddresses ?? [])
    if (unsafe) {
      refuse(a, unsafe)
      continue
    }
    const matched = a.matchedAddress ?? null
    const suggestion = matched && matched !== address && !unsafeSender(matched, a.ownAddresses ?? []) ? maskAddress(matched) : null
    const receivedOn = a.createdAt.slice(0, 10)
    const earlier = byAddress.get(address)
    if (!earlier || receivedOn > earlier.receivedOn) byAddress.set(address, { address, masked: maskAddress(address), fingerprint: addressFingerprint(address), suggestion, receivedOn, activityId: a.id, mode: record ? 'record' : 'dry_run', phrase: x.strictPhrase ?? 'OPT-OUT' })
  }
  // newest first, and the sender of the conversation we actually mailed (no different address suggested) comes before a stranger: forged mail
  // from other senders cannot push the real contact out of the capped list
  const all = [...byAddress.values()].sort((x, y) => Number(y.suggestion === null) - Number(x.suggestion === null) || (x.receivedOn < y.receivedOn ? 1 : x.receivedOn > y.receivedOn ? -1 : 0))
  for (const extra of all.slice(MAX_PER_EVALUATION)) refused.set(extra.activityId, { reason: `more than ${MAX_PER_EVALUATION} different senders in one evaluation`, activityId: extra.activityId, receivedOn: extra.receivedOn })
  return { proposals: all.slice(0, MAX_PER_EVALUATION), refused: [...refused.values()] }
}

/** Every address that could be a contact of this company: its saved addresses and the senders of its recent inbound mail, never our own. */
export function candidateAddresses(company: CrmCompany, activities: CrmActivity[]): string[] {
  const out = new Set<string>()
  for (const e of [company.email, ...(company.emails ?? [])]) for (const a of lookupAddresses(e)) out.add(a)
  for (const a of activities) if (a.direction === 'inbound') for (const f of a.fromAddresses ?? []) if (!(a.ownAddresses ?? []).includes(f)) out.add(f)
  return [...out].slice(0, 200)
}

const MANUAL_OPT_OUT_REASON = /\b(?:un-?subscri\w*|opt(?:ed|ing)?[\s-]?out|do\s*not\s+(?:e-?mail|contact|mail)|don'?t\s+(?:e-?mail|contact|mail)|stop(?:\s+(?:e-?mailing|mailing|contacting|sending))?\s+(?:me|us)|remove\s+me|asked\s+(?:not\s+to\s+be\s+)?(?:contacted|to\s+be\s+removed))\b/i

/** Whether a suppression row says an individual opted out of marketing mail: automatically recorded ones, and manual ones whose own reason says so. */
export function isIndividualOptOutRow(row: { source: string; reason: string }): boolean {
  if (row.source === 'unsubscribe') return true
  return row.source === 'manual' && MANUAL_OPT_OUT_REASON.test(row.reason)
}

/**
 * Which of these addresses are ALREADY on the suppression list as an individual opt-out: a global, unexpired `email` row that is an
 * automatically recorded opt-out (source `unsubscribe`) or a manual one whose reason says so. Imported, policy, wrong-person, campaign-specific
 * and expired rows are NOT opt-outs here (the sending gates still enforce every valid row). Read only; matched ignoring case. This is how an
 * opt-out survives past the 90-day window.
 */
export async function persistedOptOuts(tenantId: string, addresses: string[]): Promise<string[]> {
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))]
  if (wanted.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ matchValue: string; source: string; reason: string }>>`
    SELECT "matchValue", "source", "reason" FROM "SuppressionEntry"
    WHERE "tenantId" = ${tenantId} AND "scope" = 'global' AND "matchType" = 'email'
      AND LOWER("matchValue") = ANY(${wanted}) AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
    LIMIT 200`
  return rows.filter(isIndividualOptOutRow).map((r) => r.matchValue.toLowerCase())
}

export interface OptOutResult {
  address: string
  masked: string
  activityId: string
  status: 'recorded' | 'already_listed' | 'needs_person' | 'failed' | 'awaiting_approval'
}

// NO AUTOMATIC WRITES (owner decision of 2026-11-10). NXT Sales does not authenticate the `From` header (it stores the raw line and no SPF / DKIM /
// DMARC / ARC result), so a forged "unsubscribe" cannot be told from a real one. There is therefore NO code path that turns an email-derived proposal
// into a suppression row by itself - not behind the switch, not behind any flag on the proposal. The only writer is writeApprovedOptOut below, and it
// is called only by an administrator's individual approval (optOutApproval.ts).

/** What the approval hands the writer so that the audit entry is written in the SAME transaction as the row. */
export interface ApprovalAudit {
  resourceId: string
  summary: (status: 'recorded' | 'already_listed') => string
  metadata: Record<string, unknown>
}

/**
 * The ONE place a suppression row is written, and only for a person's individual approval (the switch must also be on). Validates the address
 * AGAIN as exactly one plain, lower-case address. The row and its audit entry are written in ONE database transaction: if the audit entry cannot
 * be written, the row is rolled back too ("no record, no change"). Idempotent: an existing PERMANENT row is left as it is ("already_listed", still
 * audited as an approval); a temporary or expired one is never revived or reported as a success (a person decides). Returns what really happened -
 * "recorded" only after the transaction committed. The error text of a failure is never logged (a database message can carry the query's arguments).
 */
export async function writeApprovedOptOut(tenantId: string, p: OptOutProposal, approverCrmUserId: string, audit: ApprovalAudit): Promise<OptOutResult> {
  const base = { address: p.address, masked: p.masked, activityId: p.activityId }
  if (!env.WARM_LEADS_RECORD_OPT_OUTS || !approverCrmUserId) return { ...base, status: 'awaiting_approval' }
  try {
    const plain = parseAddresses(p.address)
    if (plain.length !== 1 || plain[0] !== p.address || p.address !== p.address.toLowerCase()) return { ...base, status: 'needs_person' }
    const key = { tenantId_scope_matchType_matchValue: { tenantId, scope: 'global', matchType: 'email', matchValue: p.address } }
    const status = await prisma.$transaction(async (tx) => {
      const existing = await tx.suppressionEntry.findUnique({ where: key, select: { expiresAt: true } })
      // only a PERMANENT row counts as "already listed": a temporary one lapses, and the opt-out would then be forgotten - a person decides
      if (existing && existing.expiresAt) return 'needs_person' as const
      if (!existing) {
        await tx.suppressionEntry.createMany({
          data: [
            {
              id: newId(),
              tenantId,
              scope: 'global',
              matchType: 'email',
              matchValue: p.address,
              reason: `Opt-out request in an email reply on ${p.receivedOn} (NXT activity ${p.activityId}); approved by a person who verified it through a trusted contact channel (read by Warm Leads)`,
              source: 'unsubscribe',
              createdByCrmUserId: approverCrmUserId,
            },
          ],
          skipDuplicates: true,
        })
      }
      const done = existing ? ('already_listed' as const) : ('recorded' as const)
      await auditInTransaction(tx, {
        tenantId,
        actorType: 'user',
        actorCrmUserId: approverCrmUserId,
        action: 'warmleads.opt_out_approved',
        resourceType: 'WarmLeadOptOut',
        resourceId: audit.resourceId,
        dataClass: 'customer_pii',
        summary: audit.summary(done),
        metadata: audit.metadata,
      })
      return done
    })
    if (status !== 'needs_person') log.info({ masked: p.masked, receivedOn: p.receivedOn, status }, 'opt-out approved by a person and recorded on the suppression list')
    return { ...base, status }
  } catch (err) {
    log.warn({ masked: p.masked, errorName: (err as Error).name }, 'opt-out could not be recorded on the suppression list (rolled back)')
    return { ...base, status: 'failed' }
  }
}

const base = { signalCategory: 'crm', confidence: 'high', freshness: 'unknown', status: 'active', sourceUrl: null }

const PROPOSAL_TEXT: Record<OptOutStatus, string> = {
  dry_run: 'is PROPOSED for the suppression list — DRY RUN: nothing was written (WARM_LEADS_RECORD_OPT_OUTS is off); even with the switch on, an administrator must approve it before anything is written',
  awaiting_approval: 'is NOT added yet: the sender of an email cannot be verified, so a person must approve it first (nothing is written until then)',
  recorded: 'was added to the suppression list',
  already_listed: 'is already on the suppression list',
  needs_person: 'was NOT added automatically (an existing entry for it has expired, or it failed a safety check): a person must decide',
  failed: 'could NOT be added to the suppression list (a database error); the company is checked again and it is tried again',
}

/** The line a reviewer sees for one proposed address: status, masked address, the day, and the NXT activity to open. */
export function proposalLine(p: Pick<OptOutProposal, 'masked' | 'receivedOn' | 'activityId' | 'suggestion'> & { fingerprint?: string; phrase?: string }, status: OptOutStatus): { summary: string; evidence: string } {
  return {
    summary: `${p.masked} (the sender of the opt-out of ${p.receivedOn}) ${PROPOSAL_TEXT[status]}`,
    evidence: `status: ${status} · NXT activity ${p.activityId} · received ${p.receivedOn}${p.fingerprint ? ` · fp ${p.fingerprint}` : ''}${p.phrase ? ` · phrase: ${p.phrase}` : ''}${p.suggestion ? ` · also for a person to consider: the address we mailed on that conversation, ${p.suggestion}, is a different address and was NOT suppressed` : ' · one address only; no domain or company is ever suppressed automatically'}`,
  }
}

/**
 * The signals that show all this on the company's result (all 0 points, all neutral, masked addresses only):
 *   contact_opt_out       a contact opted out (in a reply, or already on the suppression list as an opt-out): marketing permission stays withdrawn
 *                         until a person removes it - whatever a later message says. Keeps a would-be Warm company in human review.
 *   opt_out_proposal      the address that was (or, in a dry run, would be) added
 *   opt_out_not_recorded  an opt-out that may not be recorded automatically (a person decides)
 *   reconsent_candidate   a later message affirmatively asks for marketing mail again: for a person to review; the opt-out stays
 */
export function optOutSignals(input: { assessed: ReplyAssessment[]; decision: OptOutDecision; persisted: string[]; record: boolean }): ObservedSignal[] {
  const out: ObservedSignal[] = []
  const optedOutMessages = input.assessed.filter((x) => x.verdict === 'declined' && x.kind === 'opt_out')
  const addresses = new Set<string>([...input.persisted, ...input.decision.proposals.map((p) => p.address)])
  if (optedOutMessages.length || input.persisted.length) {
    const latest = optedOutMessages[0]?.activity.createdAt ?? null
    const basis = [optedOutMessages.length ? `${optedOutMessages.length} opt-out message(s) in the last 90 days` : null, input.persisted.length ? `${input.persisted.length} address(es) on the suppression list as an opt-out` : null].filter(Boolean).join('; ')
    out.push({
      ...base,
      signalType: 'contact_opt_out',
      polarity: 'neutral',
      summary: 'A contact of this company has opted out of marketing email — marketing permission stays withdrawn until a person removes it from the suppression list. A later friendly reply, quote request or enquiry does not restore it; buying intent is judged separately',
      evidence: `${basis}${addresses.size ? `; ${[...addresses].slice(0, 5).map(maskAddress).join(', ')}` : ''}`,
      observedAt: latest,
    })
  }
  for (const p of input.decision.proposals) {
    const line = proposalLine(p, input.record ? 'awaiting_approval' : 'dry_run')
    out.push({ ...base, signalType: 'opt_out_proposal', polarity: 'neutral', summary: line.summary, evidence: line.evidence, observedAt: p.receivedOn })
  }
  for (const r of input.decision.refused) {
    out.push({
      ...base,
      signalType: 'opt_out_not_recorded',
      polarity: 'neutral',
      summary: `An opt-out message of ${r.receivedOn} was found but nothing was suppressed automatically: ${r.reason}. A person decides whether to add the contact to the suppression list`,
      evidence: `status: needs_person · NXT activity ${r.activityId} · received ${r.receivedOn}`,
      observedAt: r.receivedOn,
    })
  }
  for (const x of input.assessed) {
    if (!x.reconsent) continue
    const senders = (x.activity.fromAddresses ?? []).filter((f) => addresses.has(f))
    if (senders.length !== 1) continue
    out.push({
      ...base,
      signalType: 'reconsent_candidate',
      polarity: 'neutral',
      summary: `A message of ${x.activity.createdAt.slice(0, 10)} from ${maskAddress(senders[0]!)} asks to receive marketing mail again. The opt-out stays in force until a person reviews this and removes the suppression row`,
      evidence: `status: for_review · NXT activity ${x.activity.id} · received ${x.activity.createdAt.slice(0, 10)}`,
      observedAt: x.activity.createdAt,
    })
  }
  return out
}

/** The same signals as stored reasons, for an evaluation that FAILED (website unreadable, research failed): the opt-out evidence is kept either way. */
export function signalsToReasons(signals: ObservedSignal[]): Reason[] {
  return signals.map((s) => ({
    signal: s.signalType,
    polarity: 'neutral' as const,
    points: 0,
    summary: s.summary,
    evidence: s.evidence || null,
    sourceUrl: null,
    observedAt: s.observedAt ? String(s.observedAt).slice(0, 10) : null,
    freshness: null,
    source: 'crm' as const,
  }))
}
