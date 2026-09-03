import { getCrm } from '../../crm/index.js'
import type { CrmPort } from '../../crm/crmPort.js'
import { planCompanyWrite } from '../companyWrite.js'
import { notSupported, type CrmSyncProvider } from './provider.js'
import type {
  CrmSyncPayload,
  ProviderAvailability,
  ProviderCapabilities,
  ResourceOutcome,
  SyncResource,
} from '../types.js'

// TASK #986 — the NXT Sales adapter.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED, AND WHAT DID NOT
//
// For most of this platform's life this adapter wrote nothing: `CrmPort`
// declared no write method and the HTTP client hard-coded `method: 'GET'`, so
// no code path could issue a write. That was deliberate, and it held until the
// business approved a specific, narrow scope.
//
// It now performs EXACTLY ONE write — `updateCompany`, carrying two confirmed
// custom fields — and everything else about the old posture is unchanged:
//
//   · NXT Sales' API exposes POST/PUT/DELETE on companies, activities and
//     deals, and its auth middleware performs no role check on any write
//     route. Nothing on the CRM side would catch a mistake, so every guard is
//     on this side.
//   · `create` and `upsert` remain unimplemented. Creating a record is outside
//     the approved scope and has no code to be enabled by accident.
//   · Activity and Task remain unsupported: NXT Sales has no Task object, and
//     whether a qualification belongs in the Activity feed is undecided.
//   · No second HTTP client, and no direct database access.
//
// The write is reachable only through: CRM_WRITE_ENABLED, configured
// destination fields, a complete dropdown mapping, and an explicit human
// approval naming the approver. Those are enforced elsewhere and none of them
// is assumed here.
// ─────────────────────────────────────────────────────────────────────────────

/** Write methods an approved adapter would have to expose on CrmPort. */
const REQUIRED_WRITE_METHODS = ['createCompany', 'updateCompany', 'createActivity', 'createDeal', 'updateDeal']

export class NxtSalesSyncProvider implements CrmSyncProvider {
  readonly name = 'nxt_sales'
  readonly destination = 'NXT Sales CRM'

  /**
   * Detects, rather than asserts, whether the port can write.
   *
   * If an approved adapter is added later, this notices without anyone editing
   * this file — which is the point of checking the live object.
   */
  private portWriteMethods(): string[] {
    const crm = getCrm() as unknown as Record<string, unknown>
    return REQUIRED_WRITE_METHODS.filter((m) => typeof crm[m] === 'function')
  }

  capabilities(): ProviderCapabilities {
    const available = this.portWriteMethods()
    return {
      // Reads genuinely work — the port has getCompany and listUsers, and this
      // pipeline has used them throughout.
      canLookup: true,
      canCreate: available.includes('createCompany') || available.includes('createActivity'),
      canUpdate: available.includes('updateCompany'),
      canUpsert: false,
      canAttach: false,
      // What the CRM MODELS support, which is not the same as what we may write.
      // NXT Sales has no Lead object and no Task object at all.
      resources: ['company', 'activity'],
    }
  }

  availability(): ProviderAvailability {
    const available = this.portWriteMethods()
    if (available.length === 0) {
      return {
        status: 'write_not_supported',
        reason:
          'NXT Sales is reachable and readable, but the CRM port exposes no write method. The NXT Sales API does have write endpoints; this platform has deliberately never been given a path to them.',
        remediation:
          'Approve a CRM write adapter, add the specific write methods to CrmPort, and implement them in the NXT Sales adapter behind this provider. Do not write to NXT Sales tables directly, and do not add a second HTTP client.',
      }
    }
    return { status: 'available' }
  }

  /**
   * Looks up an existing CRM record by correlation key.
   *
   * Returns null — lookup by our own external key is not possible. The two
   * Company custom fields that do exist hold a score and a status, not a
   * correlation key, so a previous handoff leaves no mark the CRM could be
   * searched by. Idempotency is enforced on our side instead, by the unique
   * qualificationId on the sync record.
   */
  async findExisting(_externalKey: string): Promise<{ found: boolean; externalId: string | null } | null> {
    return null
  }

  async create(resource: SyncResource, _payload: CrmSyncPayload): Promise<ResourceOutcome> {
    return notSupported(
      resource,
      'The CRM port exposes no write method, so nothing was created in NXT Sales.',
    )
  }

  /**
   * The approved write, and the only one.
   *
   * Reached only after: the write gate is on, the destination fields are
   * configured, every status maps to a real dropdown option, AND a person has
   * approved this specific package. Each of those is checked elsewhere; this
   * method assumes none of them and re-derives the body from the payload
   * through the same planner the dry run used, so what is sent is what was
   * reviewed.
   *
   * `company` is the only resource that writes. `activity` and `task` remain
   * unsupported: NXT Sales has no Task object, and whether a qualification
   * belongs in the Activity feed is still a business decision.
   */
  async update(resource: SyncResource, externalId: string, payload: CrmSyncPayload): Promise<ResourceOutcome> {
    if (resource !== 'company') {
      return notSupported(
        resource,
        resource === 'task'
          ? 'NXT Sales has no Task object, so a follow-up task cannot be written.'
          : 'Writing an Activity from a qualification has not been agreed, so nothing was written.',
      )
    }

    const crm = getCrm() as CrmPort
    if (typeof crm.updateCompany !== 'function') {
      return notSupported(resource, 'The CRM port exposes no updateCompany method.')
    }

    const plan = planCompanyWrite(externalId, {
      intentScore: payload.intent.score ?? 0,
      qualificationStatus: payload.qualification.status,
    })
    if (!plan.ready || !plan.body) {
      return notSupported(resource, plan.reason)
    }

    try {
      await crm.updateCompany(externalId, plan.body)
      return {
        resource,
        result: 'updated',
        externalId,
        reason:
          `Updated ${Object.keys(plan.body.customFields).join(' and ')} on the Company record. ` +
          'No other field was sent.',
        errorCode: null,
        retryable: false,
      }
    } catch (err) {
      const e = err as { message?: string; details?: { status?: number } }
      return {
        resource,
        result: 'failed',
        externalId: null,
        reason: e.message ?? 'The update failed without a stated reason.',
        errorCode: e.details?.status === 400 ? 'invalid_field_value' : 'write_failed',
        // A write that may or may not have landed is never retried
        // automatically; a person decides.
        retryable: false,
      }
    }
  }

  async upsert(resource: SyncResource, _payload: CrmSyncPayload): Promise<ResourceOutcome> {
    return notSupported(resource, 'The CRM port exposes no write method.')
  }
}
