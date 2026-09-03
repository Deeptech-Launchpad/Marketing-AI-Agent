import { env } from '../config/env.js'
import { QUALIFICATION_STATUSES } from '../salesqualification/types.js'

// THE CRM WRITE GATE.
//
// Team Answer Section 30 approves a controlled write adapter. This is the
// single place that decides whether the approved scope may actually run, and
// it is written to refuse for a STATED reason rather than to permit by default.
//
// Three conditions, all required:
//
//   1. CRM_WRITE_ENABLED is on              — a deliberate operator decision
//   2. the destination fields are configured — confirmed present on LIVE:
//        Intent Score        Number    key intentScore
//        Qualification Status Dropdown key qualificationStatus
//      (they are absent from the local restored snapshot, which simply
//       predates them; the live application is the source of truth)
//   3. every status maps to a real dropdown option — see the note below
//   4. the payload contains only the approved scope — enforced structurally
//
// WHAT IS PERMANENTLY REFUSED, whatever the configuration says:
//
//   Company.ownerId    Section 33: owner reassignment requires human approval.
//                      The NXT Sales PUT /companies/:id endpoint DOES accept an
//                      ownerId and applies it, so excluding it is not a matter
//                      of not sending one — it is checked before every write.
//   Deal creation      Section 32: a qualified lead does not imply a Deal.
//   Deal value/stage   Section 30, listed under DO NOT AUTOMATE.
//
// Those three are not configurable. There is no environment variable that
// turns them on, because the decision to allow them is not an operator's.

/** Fields this platform may never send to NXT Sales, at any setting. */
export const FORBIDDEN_FIELDS = ['ownerId', 'owner', 'stage', 'dealStage', 'value', 'dealValue', 'amount'] as const

export interface WriteCapability {
  /** Whether a write may be attempted at all. */
  enabled: boolean
  /** Per-resource readiness, so a partial capability is visible. */
  resources: {
    companyFields: { ready: boolean; reason: string }
    activity: { ready: boolean; reason: string }
  }
  /** Internal status -> live dropdown option. Empty until configured. */
  statusMap: Map<string, string>
  /** One sentence for a report or an API response. */
  summary: string
}

/**
 * What the write adapter may do right now, and why not otherwise.
 *
 * Deliberately returns a description rather than a boolean: "blocked" and
 * "blocked because nobody has created the destination field" call for
 * completely different actions, and collapsing them loses the one that says
 * what to do next.
 */
/** Hosts where a mistake costs nothing. Anything else is treated as real. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

export function isLocalTarget(baseUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname)
  } catch {
    // An unparseable URL is not demonstrably local, so it is treated as live.
    return false
  }
}

/**
 * Refuses a write whose identity does not belong to the host being written to.
 *
 * Every write is signed with NXT_SALES_SERVICE_USER_ID, and NXT Sales verifies
 * the SIGNATURE ONLY — no user lookup, no role check. A token naming the wrong
 * person is therefore accepted without complaint, and the CRM's audit trail
 * records that person as having made the change.
 *
 * That is not hypothetical: this platform ran for months configured with a real
 * colleague's id, pointed at localhost. The id is harmless against a dev
 * snapshot and becomes a false audit record the moment the base URL changes.
 * Because those are two independent settings, discipline alone will not keep
 * them in step — so writing to a non-local host requires the configured
 * identity to equal the one confirmed against that host.
 *
 * Local targets are exempt: a dev snapshot has no audit trail worth protecting.
 */
export function assertServiceIdentity(): void {
  if (isLocalTarget(env.NXT_SALES_BASE_URL)) return

  const confirmed = env.NXT_SALES_LIVE_SERVICE_USER_ID.trim()
  const configured = env.NXT_SALES_SERVICE_USER_ID.trim()

  if (!confirmed) {
    throw new Error(
      'Refusing to write to a non-local NXT Sales host: NXT_SALES_LIVE_SERVICE_USER_ID is not set, so there is ' +
        'no confirmed identity to check against. Verify the service user with `npm run verify:live-crm` and record ' +
        'the id it reports.',
    )
  }
  if (configured !== confirmed) {
    throw new Error(
      'Refusing to write to a non-local NXT Sales host: NXT_SALES_SERVICE_USER_ID is not the identity confirmed ' +
        'for this host. Every write is signed with it and NXT Sales checks the signature only, so the change would ' +
        'be recorded against whoever that id belongs to. Set NXT_SALES_SERVICE_USER_ID to the confirmed service user.',
    )
  }
}

export function writeCapability(): WriteCapability {
  if (!env.CRM_WRITE_ENABLED) {
    const reason =
      'CRM_WRITE_ENABLED is off. The approved write scope exists but has not been switched on, so this platform ' +
      'reads NXT Sales and writes nothing.'
    return {
      enabled: false,
      resources: {
        companyFields: { ready: false, reason },
        activity: { ready: false, reason },
      },
      statusMap: new Map(),
      summary: reason,
    }
  }

  const intentField = env.CRM_WRITE_FIELD_INTENT_SCORE.trim()
  const statusField = env.CRM_WRITE_FIELD_QUALIFICATION_STATUS.trim()
  const missing = [
    intentField ? null : 'CRM_WRITE_FIELD_INTENT_SCORE',
    statusField ? null : 'CRM_WRITE_FIELD_QUALIFICATION_STATUS',
  ].filter(Boolean)

  // The live `qualificationStatus` field is a DROPDOWN. NXT Sales rejects any
  // value outside its option list, so an unmapped status is a guaranteed 400 —
  // caught here rather than discovered on the first real write.
  const statusMap = parseStatusMap(env.CRM_WRITE_QUALIFICATION_VALUE_MAP)
  const unmapped = QUALIFICATION_STATUSES.filter((s) => !statusMap.has(s))

  const companyFields = missing.length
    ? {
        ready: false,
        reason:
          `Writes are enabled, but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not configured. ` +
          'The live Company record defines "intentScore" (Number) and "qualificationStatus" (Dropdown); name ' +
          'them here so the write has a destination.',
      }
    : unmapped.length
      ? {
          ready: false,
          reason:
            `Writes are enabled and both fields are named, but "${statusField}" is a dropdown on the live Company ` +
            `record and ${unmapped.length} of our statuses have no mapped option (${unmapped.join(', ')}). NXT Sales ` +
            'rejects an unlisted dropdown value, so the write would fail. Set CRM_WRITE_QUALIFICATION_VALUE_MAP ' +
            'using the options shown under "Manage values" on the live field.',
        }
      : { ready: true, reason: `Configured to write into "${intentField}" and "${statusField}" on the Company record.` }

  return {
    enabled: true,
    statusMap,
    resources: {
      companyFields,
      // Activities need no custom field: NXT Sales accepts a note against a
      // company through its existing endpoint.
      activity: { ready: true, reason: 'Activities and notes may be written against the company record.' },
    },
    summary: companyFields.ready
      ? 'Writes enabled for the approved scope: Company custom fields and Activities.'
      : `Writes enabled, but Company fields are blocked. ${companyFields.reason}`,
  }
}

/**
 * Parses `internal=Live Option;internal=Live Option`.
 *
 * Values are taken verbatim, including spacing and capitalisation, because a
 * dropdown option is matched exactly by NXT Sales.
 */
export function parseStatusMap(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const pair of String(raw ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const key = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (key && value) out.set(key, value)
  }
  return out
}

export class ForbiddenCrmWriteError extends Error {
  constructor(public readonly field: string) {
    super(
      `Refusing to write "${field}" to NXT Sales. Owner reassignment, Deal creation and Deal value or stage ` +
        'changes are outside the approved automation scope and are not configurable.',
    )
    this.name = 'ForbiddenCrmWriteError'
  }
}

/**
 * The last check before a payload leaves this process.
 *
 * Called on every write regardless of how the payload was built, so a future
 * change that adds a field cannot bypass the rule by constructing the object
 * somewhere new.
 */
export function assertWritable(payload: Record<string, unknown>): void {
  for (const field of FORBIDDEN_FIELDS) {
    if (field in payload) throw new ForbiddenCrmWriteError(field)
  }
  const custom = payload.customFields
  if (custom && typeof custom === 'object') {
    for (const field of FORBIDDEN_FIELDS) {
      if (field in (custom as Record<string, unknown>)) throw new ForbiddenCrmWriteError(`customFields.${field}`)
    }
  }
}
