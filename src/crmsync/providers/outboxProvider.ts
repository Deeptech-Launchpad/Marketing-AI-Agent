import { notSupported, type CrmSyncProvider } from './provider.js'
import type {
  CrmSyncPayload,
  ProviderAvailability,
  ProviderCapabilities,
  ResourceOutcome,
  SyncResource,
} from '../types.js'

// TASK #986 — the outbox, which is the honest end of the line today.
//
// WHAT IT IS
//
// A durable, inspectable queue of prepared handoff packages that no approved
// provider can yet deliver. When a write adapter is approved, the outbox is
// what gets drained — nothing has to be reconstructed, because every package
// was already validated and mapped at the time the lead qualified.
//
// WHAT IT IS NOT
//
// It is not a sync. Holding a package is not delivering one, and this provider
// never reports `created` or `updated`. The engine records
// `blocked_provider_unavailable`, and every API response says the CRM
// synchronisation has been PREPARED rather than completed.

export class OutboxSyncProvider implements CrmSyncProvider {
  readonly name = 'outbox'
  readonly destination = 'Internal pending-handoff outbox in the Marketing AI platform'

  capabilities(): ProviderCapabilities {
    return {
      canLookup: false,
      canCreate: false,
      canUpdate: false,
      canUpsert: false,
      canAttach: false,
      resources: [],
    }
  }

  /**
   * Always available — it depends on nothing but our own database.
   *
   * Available to HOLD a package. The reason says so, so that "available" is
   * never mistaken for "the CRM got it".
   */
  availability(): ProviderAvailability {
    return {
      status: 'available',
      reason:
        'The package is prepared and held for delivery. Nothing has been written to any CRM.',
      remediation: 'Approve a CRM write adapter, then drain the outbox.',
    }
  }

  async findExisting(): Promise<null> {
    return null
  }

  async create(resource: SyncResource): Promise<ResourceOutcome> {
    return notSupported(resource, 'Held in the outbox. No CRM write was attempted.')
  }

  async update(resource: SyncResource): Promise<ResourceOutcome> {
    return notSupported(resource, 'Held in the outbox. No CRM write was attempted.')
  }

  async upsert(resource: SyncResource): Promise<ResourceOutcome> {
    return notSupported(resource, 'Held in the outbox. No CRM write was attempted.')
  }
}

/** Unused parameter kept for interface symmetry. */
export type { CrmSyncPayload }
