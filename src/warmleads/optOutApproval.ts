import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { withCrmReadOnly } from '../crm/nxtSales/httpClient.js'
import type { CrmActivity } from '../crm/types.js'
import { auditInTransaction } from '../platform/audit.js'
import { BadRequestError, ConflictError, NotFoundError } from '../platform/errors.js'
import { prisma } from '../platform/db.js'
import { fingerprintKeyConfigured, fingerprintKeyId, proposeOptOuts, writeApprovedOptOut, type OptOutProposal } from './optOut.js'
import { optOutReviewForCompany, type OptOutReviewItem } from './optOutReview.js'
import { summariseInbound } from './replies.js'

// WARM LEADS — A PERSON APPROVES ONE OPT-OUT PROPOSAL (2026-11-06, tightened 2026-11-10).
//
// The `From` header of an email is not authenticated (NXT Sales stores it raw, with no SPF / DKIM / DMARC result), so NOTHING email-derived is ever
// written automatically, with or without the switch WARM_LEADS_RECORD_OPT_OUTS. With the switch on, an administrator approves each proposal
// individually - and must confirm that the request was independently verified through a trusted contact channel (reading the unverified email itself is
// not verification), and say HOW (a fixed list of methods - never free text). This runs in the API (never in the worker) and:
//   1. needs the switch on, a known approver, the explicit confirmation and a verification method;
//   2. needs a company on THIS tenant's list and a STORED proposal of THIS tenant for that company and this NXT Sales activity (so an activity id
//      or a company id from anywhere else is refused);
//   3. re-reads that one email from NXT Sales (READ ONLY) and requires that NXT Sales ties it to EXACTLY the submitted company: an email with no
//      company (companyId null) or with another company's id is refused (fail closed; a person can add the address in the suppression list screen);
//   4. works the proposal out AGAIN from it, by the same strict rules - the address comes from the source email, never from the browser, so the
//      request cannot choose or alter the address;
//   5. refuses if the email no longer qualifies, is no longer readable (older than 90 days), or if its sender is not EXACTLY the address that was
//      proposed (keyed fingerprint);
//   6. writes the one row AND its audit entry in ONE transaction (writeApprovedOptOut: validated again, idempotent, never revives an expired
//      row), naming the approver, the time and the verification method. If the audit entry cannot be written, the row is rolled back too.
// To let the administrator check the EXACT contact (the list only shows a masked address), revealOptOutAddress shows the address from the freshly
// re-read email to ONE admin for ONE proposal, audited (who, when, which proposal - never the address), never stored, never logged.
// Nothing here emails anyone, writes to NXT Sales, or removes anything.

/** How the administrator verified the request, through a channel that is NOT the (unauthenticated) email itself. A fixed list: no free text is stored. */
export const VERIFICATION_METHODS = ['phone_call_known_number', 'email_to_address_on_file', 'account_owner_confirmed', 'meeting_or_video_call', 'other_trusted_channel'] as const
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number]

const isMethod = (v: unknown): v is VerificationMethod => typeof v === 'string' && (VERIFICATION_METHODS as readonly string[]).includes(v)

export interface ApprovalResult {
  status: 'recorded' | 'already_listed'
  masked: string
  activityId: string
  message: string
}

export interface RevealResult {
  /** The exact sender address of the email, as re-read from NXT Sales just now. Shown to the administrator; never stored or logged by this module. */
  address: string
  masked: string
  crmCompanyId: string
  companyName: string | null
  companyClassification: string | null
  activityId: string
  receivedOn: string
  phrase: string
  /** Always false: NXT Sales stores the From line as received (no SPF / DKIM / DMARC result). */
  authenticated: false
  notice: string
}

/** Steps 2-5: everything that must hold before an address may be shown or approved. Read only. */
async function loadVerifiedProposal(tenantId: string, crmCompanyId: string, activityId: string): Promise<{ stored: OptOutReviewItem; proposal: OptOutProposal; activity: CrmActivity }> {
  // a company on THIS tenant's list, and a stored proposal of THIS tenant for it
  const company = await prisma.warmLeadCompany.findUnique({ where: { tenantId_crmCompanyId: { tenantId, crmCompanyId } }, select: { id: true } })
  if (!company) throw new NotFoundError('That company is not in your Warm Leads list.')
  const stored = (await optOutReviewForCompany(tenantId, crmCompanyId)).find((i) => i.kind === 'proposal' && i.crmCompanyId === crmCompanyId && i.activityId === activityId)
  if (!stored) throw new NotFoundError('There is no opt-out proposal for that email.')
  // a proposal made without a fingerprint, or under another key, cannot be checked: a clear "review again" message, not a generic failure
  if (!stored.fingerprint || !stored.keyId) throw new ConflictError('This proposal was stored without a fingerprint, so it cannot be checked. Evaluate the company again and review the new proposal. Nothing was added.')
  if (stored.keyId !== fingerprintKeyId()) throw new ConflictError('The fingerprint key has changed since this proposal was made, so it can no longer be checked. This says nothing about the email: evaluate the company again and review the NEW proposal. Nothing was added.')

  // the source email, read again from NXT Sales (read only), and tied to EXACTLY the submitted company
  const activities = await withCrmReadOnly(() => getCrm().listActivities({ companyId: crmCompanyId, type: 'email', withBody: true }))
  const activity = activities.find((a) => a.id === activityId)
  if (!activity) throw new ConflictError('That email can no longer be read from NXT Sales, so it cannot be approved here. If the contact really opted out, add the address in the suppression list screen.')
  if (activity.companyId == null || activity.companyId === '') throw new ConflictError('NXT Sales does not link that email to any company, so it cannot be tied to this company and was not approved. If the contact really opted out, add the address in the suppression list screen.')
  if (activity.companyId !== crmCompanyId) throw new ConflictError('NXT Sales links that email to a different company than the one submitted, so it was not approved. If the contact really opted out, add the address in the suppression list screen.')

  // worked out again from the email itself, by the same strict rules
  const proposal = proposeOptOuts(summariseInbound([activity], new Date(), undefined, true).assessed, true).proposals.find((p) => p.activityId === activityId)
  if (!proposal) throw new ConflictError('That email is no longer a plain standalone opt-out from one safe sender (it may be older than 90 days, or changed), so it was not approved. A person can add the address in the suppression list screen.')
  // the address must be EXACTLY the one that was proposed: a mask (first letter + domain) would let a similar address through, so the keyed
  // fingerprint stored with the proposal is compared as well
  if (stored.fingerprint !== proposal.fingerprint || (stored.masked && stored.masked !== proposal.masked)) throw new ConflictError('The sender of that email is not the address that was proposed, so nothing was added.')
  return { stored, proposal, activity }
}

function requireReady(approverCrmUserId: string): void {
  if (!env.WARM_LEADS_RECORD_OPT_OUTS) throw new ConflictError('Recording opt-outs is switched off on this server (WARM_LEADS_RECORD_OPT_OUTS), so nothing can be added to the suppression list from here.')
  if (!approverCrmUserId) throw new ConflictError('Who approves this could not be determined.')
  if (!fingerprintKeyConfigured()) throw new ConflictError('The fingerprint key (WARM_LEADS_OPT_OUT_FINGERPRINT_KEY) is not configured on this server, so a proposal cannot be checked and nothing can be approved. Nothing was added.')
}

export async function approveOptOut(input: { tenantId: string; approverCrmUserId: string; crmCompanyId: string; activityId: string; independentlyVerified: boolean; verificationMethod: VerificationMethod }): Promise<ApprovalResult> {
  const { tenantId, approverCrmUserId, crmCompanyId, activityId } = input
  requireReady(approverCrmUserId)
  if (input.independentlyVerified !== true) throw new ConflictError('Confirm that this request was verified independently through a trusted contact channel first. Reading the email itself is not verification: its sender is not authenticated.')
  if (!isMethod(input.verificationMethod)) throw new BadRequestError('Say how the request was verified (phone call to a known number, email to the address on file, ...). It is recorded with the approval.')

  const { proposal, stored } = await loadVerifiedProposal(tenantId, crmCompanyId, activityId)

  // the one write, with its audit entry in the same transaction (masked address and activity id only; no message text; who, when and how recorded)
  const method = input.verificationMethod
  const approvedAt = new Date().toISOString()
  const result = await writeApprovedOptOut(tenantId, proposal, approverCrmUserId, {
    resourceId: `${crmCompanyId}|${activityId}`,
    verificationMethod: method,
    summary: (status) =>
      `A person approved the opt-out of ${proposal.masked} (NXT activity ${activityId}, received ${proposal.receivedOn}; SENDER NOT AUTHENTICATED; the administrator confirmed it was verified independently through a trusted contact channel, method: ${method}); it ${status === 'recorded' ? 'was added to' : 'was already on'} the suppression list.`,
    metadata: {
      approvedByCrmUserId: approverCrmUserId,
      approvedAt,
      verification: { method, independentlyVerifiedConfirmed: true, attestedByCrmUserId: approverCrmUserId },
      independentlyVerifiedConfirmed: true,
      senderAuthentication: 'not available',
      crmCompanyId,
      activityId,
      phrase: proposal.phrase,
      companyClassification: stored.companyClassification,
    },
  })
  if (result.status === 'failed') throw new ConflictError('The opt-out could not be recorded (a database error, or its audit record could not be written). Nothing was added; try again.')
  if (result.status === 'needs_person') throw new ConflictError('An entry for this address already exists but is temporary or has expired (or failed a safety check), so it was not changed. Renew it in the suppression list screen.')
  if (result.status === 'awaiting_approval') throw new ConflictError('Recording opt-outs is switched off, so nothing was added.')

  return {
    status: result.status,
    masked: proposal.masked,
    activityId,
    message: result.status === 'recorded' ? `${proposal.masked} was added to the suppression list.` : `${proposal.masked} was already on the suppression list.`,
  }
}

/**
 * Shows ONE administrator the exact sender address of ONE stored proposal, taken from the email as freshly re-read from NXT Sales (read only) and
 * checked against the proposal by the same fingerprint, so what is shown is exactly what an approval would add. Needs the same conditions as an
 * approval (switch on, key configured, a proposal of this tenant tied to this company). The address is returned to the caller only: it is never
 * stored, logged, put in an evaluation's reasons or in the audit text. The reveal itself IS audited (who, when, which proposal), and fails closed:
 * if that audit entry cannot be written the address is not returned.
 */
export async function revealOptOutAddress(input: { tenantId: string; adminCrmUserId: string; crmCompanyId: string; activityId: string }): Promise<RevealResult> {
  const { tenantId, adminCrmUserId, crmCompanyId, activityId } = input
  requireReady(adminCrmUserId)
  const { proposal, stored } = await loadVerifiedProposal(tenantId, crmCompanyId, activityId)
  try {
    await auditInTransaction(prisma as never, {
      tenantId,
      actorType: 'user',
      actorCrmUserId: adminCrmUserId,
      action: 'warmleads.opt_out_address_revealed',
      resourceType: 'WarmLeadOptOut',
      resourceId: `${crmCompanyId}|${activityId}`,
      dataClass: 'customer_pii',
      summary: `An administrator viewed the exact sender address of the opt-out proposal for ${proposal.masked} (NXT activity ${activityId}, received ${proposal.receivedOn}) to verify it before deciding. The address is not stored in this record.`,
      metadata: { revealedAt: new Date().toISOString(), crmCompanyId, activityId, senderAuthentication: 'not available', purpose: 'verify_before_approval' },
    })
  } catch {
    // the error text of a database failure can carry query arguments: nothing from it is logged or returned
    throw new ConflictError('The address was not shown because this view could not be recorded in the audit log. Try again.')
  }
  return {
    address: proposal.address,
    masked: proposal.masked,
    crmCompanyId,
    companyName: stored.companyName ?? null,
    companyClassification: stored.companyClassification ?? null,
    activityId,
    receivedOn: proposal.receivedOn,
    phrase: proposal.phrase,
    authenticated: false,
    notice: 'This address comes from the From line of the email, which NXT Sales stores as received and which anyone can forge. Reading it is NOT verification: confirm the request through a channel you already trust (a known phone number, or the address on file for this contact - not by replying to this email).',
  }
}
