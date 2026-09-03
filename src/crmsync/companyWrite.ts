import { env } from '../config/env.js'
import { assertWritable, writeCapability, type WriteCapability } from './writeGate.js'

// THE COMPANY WRITE BODY.
//
// Builds the exact object that would be sent to NXT Sales' PUT /companies/:id,
// and nothing else. Kept separate from the sync service so the body can be
// inspected, tested and reviewed on its own — a payload nobody can look at
// before it is sent is a payload nobody has approved.
//
// Two properties this file exists to guarantee:
//
//   IT IS A PARTIAL UPDATE. NXT Sales applies `...(x !== undefined && {x})`
//   per field, so sending only `customFields` leaves every other column alone.
//   The body therefore contains ONE key. Adding a second would put a field a
//   salesperson maintains at risk.
//
//   THE STATUS IS TRANSLATED, NEVER PASSED THROUGH. `qualificationStatus` is a
//   dropdown on the live record and NXT Sales rejects an unlisted value with a
//   400. Our internal status is mapped to a configured option label, and an
//   unmapped status refuses rather than sending something that will fail.

export interface CompanyWriteInput {
  /** 0-100, as the intent engine produced it. */
  intentScore: number
  /** The engine's internal status, e.g. `qualified_unassigned`. */
  qualificationStatus: string
}

export interface CompanyWriteBody {
  customFields: Record<string, number | string>
}

export interface CompanyWritePlan {
  /** Whether this body may actually be sent. */
  ready: boolean
  /** The exact request body. Null when it must not be sent. */
  body: CompanyWriteBody | null
  /** HTTP method and path, so a reviewer sees the whole request. */
  request: { method: 'PUT'; path: string } | null
  reason: string
  capability: WriteCapability
}

/**
 * Plans the Company update for one qualified lead.
 *
 * Returns a PLAN rather than performing anything, so the same function serves
 * the dry-run a reviewer reads and the write that follows their approval —
 * there is no second code path that could build a different body.
 */
export function planCompanyWrite(crmCompanyId: string, input: CompanyWriteInput): CompanyWritePlan {
  const capability = writeCapability()

  if (!capability.resources.companyFields.ready) {
    return {
      ready: false,
      body: null,
      request: null,
      reason: capability.resources.companyFields.reason,
      capability,
    }
  }

  const option = capability.statusMap.get(input.qualificationStatus)
  if (!option) {
    return {
      ready: false,
      body: null,
      request: null,
      reason:
        `"${input.qualificationStatus}" has no configured option on the qualificationStatus dropdown. NXT Sales ` +
        'rejects an unlisted dropdown value, so nothing was sent.',
      capability,
    }
  }

  const score = Math.round(input.intentScore)
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return {
      ready: false,
      body: null,
      request: null,
      reason: `An intent score of ${input.intentScore} is outside the 0-100 range the field holds.`,
      capability,
    }
  }

  // Exactly two custom fields, in one key. Nothing else.
  const body: CompanyWriteBody = {
    customFields: {
      [env.CRM_WRITE_FIELD_INTENT_SCORE.trim()]: score,
      [env.CRM_WRITE_FIELD_QUALIFICATION_STATUS.trim()]: option,
    },
  }

  // The same guard every payload passes, however it was constructed.
  assertWritable(body as unknown as Record<string, unknown>)

  return {
    ready: true,
    body,
    request: { method: 'PUT', path: `/api/companies/${crmCompanyId}` },
    reason: `Writes ${Object.keys(body.customFields).join(' and ')} on the Company record. No other field is touched.`,
    capability,
  }
}
