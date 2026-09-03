import type {
  CrmSyncPayload,
  ProviderAvailability,
  ProviderCapabilities,
  ResourceOutcome,
  SyncResource,
} from '../types.js'

// TASK #986 — the CRM write boundary.
//
// The engine talks to this interface and nothing else. It knows no SQL, no
// table layout and no vendor endpoint, which is what makes "there is no
// approved adapter" a configuration fact rather than a code change.
//
// A provider that cannot do something says so. There is no path by which an
// unimplemented operation returns success.

export interface CrmSyncProvider {
  readonly name: string
  /** Human-readable target, shown in the API. */
  readonly destination: string

  /** What this provider can actually do. Detected, never assumed. */
  capabilities(): ProviderCapabilities

  /** Whether it can be used at all right now. */
  availability(): ProviderAvailability

  /**
   * Whether the CRM already holds a record for this correlation key.
   *
   * Returns null when lookup is unsupported — which is different from "no
   * record exists", and the engine treats the two differently.
   */
  findExisting(externalKey: string): Promise<{ found: boolean; externalId: string | null } | null>

  create(resource: SyncResource, payload: CrmSyncPayload): Promise<ResourceOutcome>
  update(resource: SyncResource, externalId: string, payload: CrmSyncPayload): Promise<ResourceOutcome>
  /** Convenience for providers that support it natively. */
  upsert(resource: SyncResource, payload: CrmSyncPayload): Promise<ResourceOutcome>
}

/** A resource outcome for something the provider simply cannot do. */
export function notSupported(resource: SyncResource, reason: string): ResourceOutcome {
  return {
    resource,
    result: 'not_supported',
    externalId: null,
    reason,
    errorCode: 'write_not_supported',
    retryable: false,
  }
}
