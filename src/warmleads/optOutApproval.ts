import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { withCrmReadOnly } from '../crm/nxtSales/httpClient.js'
import { ConflictError, NotFoundError } from '../platform/errors.js'
import { prisma } from '../platform/db.js'
import { proposeOptOuts, writeApprovedOptOut } from './optOut.js'
import { optOutReviewForCompany } from './optOutReview.js'
import { summariseInbound } from './replies.js'

// WARM LEADS — A PERSON APPROVES ONE OPT-OUT PROPOSAL (2026-11-06, tightened 2026-11-10).
//
// The `From` header of an email is not authenticated (NXT Sales stores it raw, with no SPF / DKIM / DMARC result), so NOTHING email-derived is ever
// written automatically, with or without the switch WARM_LEADS_RECORD_OPT_OUTS. With the switch on, an administrator approves each proposal
// individually - and must confirm that the request was independently verified through a trusted contact channel (reading the unverified email itself is
// not verification). This runs in the API (never in the worker) and:
//   1. needs the switch on, a known approver and that explicit confirmation;
//   2. needs a STORED proposal of THIS tenant for this company and this NXT Sales activity (so an activity id from anywhere else is refused);
//   3. re-reads that one email from NXT Sales (READ ONLY) and works the proposal out AGAIN from it, by the same strict rules - the address
//      comes from the source email, never from the browser, so the request cannot choose or alter the address;
//   4. refuses if the email no longer qualifies, is no longer readable (older than 90 days: add the address by hand in the suppression list
//      screen instead), belongs to another company, or if its sender is not EXACTLY the address that was proposed (keyed fingerprint);
//   5. writes the one row AND its audit entry in ONE transaction (writeApprovedOptOut: validated again, idempotent, never revives an expired
//      row), naming the approver. If the audit entry cannot be written, the row is rolled back too.
// Nothing here emails anyone, writes to NXT Sales, or removes anything.

export interface ApprovalResult {
  status: 'recorded' | 'already_listed'
  masked: string
  activityId: string
  message: string
}

export async function approveOptOut(input: { tenantId: string; approverCrmUserId: string; crmCompanyId: string; activityId: string; independentlyVerified: boolean }): Promise<ApprovalResult> {
  const { tenantId, approverCrmUserId, crmCompanyId, activityId } = input
  if (!env.WARM_LEADS_RECORD_OPT_OUTS) throw new ConflictError('Recording opt-outs is switched off on this server (WARM_LEADS_RECORD_OPT_OUTS), so nothing can be added to the suppression list from here.')
  if (!approverCrmUserId) throw new ConflictError('Who approves this could not be determined.')
  if (input.independentlyVerified !== true) throw new ConflictError('Confirm that this request was verified independently through a trusted contact channel first. Reading the email itself is not verification: its sender is not authenticated.')

  // 2. a stored proposal of THIS tenant, for a company on THIS tenant's list
  const company = await prisma.warmLeadCompany.findUnique({ where: { tenantId_crmCompanyId: { tenantId, crmCompanyId } }, select: { id: true } })
  if (!company) throw new NotFoundError('That company is not in your Warm Leads list.')
  const stored = (await optOutReviewForCompany(tenantId, crmCompanyId)).find((i) => i.kind === 'proposal' && i.crmCompanyId === crmCompanyId && i.activityId === activityId)
  if (!stored) throw new NotFoundError('There is no opt-out proposal for that email.')

  // 3. the source email, read again from NXT Sales (read only)
  const activities = await withCrmReadOnly(() => getCrm().listActivities({ companyId: crmCompanyId, type: 'email', withBody: true }))
  const activity = activities.find((a) => a.id === activityId && (a.companyId == null || a.companyId === crmCompanyId))
  if (!activity) throw new ConflictError('That email can no longer be read from NXT Sales, so it cannot be approved here. If the contact really opted out, add the address in the suppression list screen.')

  // 3/4. worked out again from the email itself, by the same strict rules
  const proposal = proposeOptOuts(summariseInbound([activity], new Date(), undefined, true).assessed, true).proposals.find((p) => p.activityId === activityId)
  if (!proposal) throw new ConflictError('That email is no longer a plain standalone opt-out from one safe sender (it may be older than 90 days, or changed), so it was not approved. A person can add the address in the suppression list screen.')
  // the address must be EXACTLY the one that was proposed: a mask (first letter + domain) would let a similar address through, so the keyed
  // fingerprint stored with the proposal is compared as well; a stored proposal without one cannot be approved (it is evaluated again first)
  if (!stored.fingerprint || stored.fingerprint !== proposal.fingerprint || (stored.masked && stored.masked !== proposal.masked)) throw new ConflictError('The sender of that email is not the address that was proposed, so nothing was added.')

  // 5. the one write, with its audit entry in the same transaction (masked address and activity id only; the confirmation is recorded)
  const result = await writeApprovedOptOut(tenantId, proposal, approverCrmUserId, {
    resourceId: `${crmCompanyId}|${activityId}`,
    summary: (status) =>
      `A person approved the opt-out of ${proposal.masked} (NXT activity ${activityId}, received ${proposal.receivedOn}; SENDER NOT AUTHENTICATED; the administrator confirmed it was verified independently through a trusted contact channel); it ${status === 'recorded' ? 'was added to' : 'was already on'} the suppression list.`,
    metadata: { independentlyVerifiedConfirmed: true, senderAuthentication: 'not available', phrase: proposal.phrase, companyClassification: stored.companyClassification },
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
