import { api } from './api'
import { useAsync } from './hooks'

// WHERE THE SELECTED COMPANY ACTUALLY COMES FROM.
//
// A company in Shared context is either a record the connected NXT Sales
// holds, or a company a Prospects search found on the public web — and the two
// must never be shown the same way. The answer comes from the backend's live
// check (GET /companies/:id/identity), never from what this browser remembers:
// a stored selection can outlive the record it pointed at.

export type CompanyIdentityKind = 'crm' | 'discovered' | 'not_in_crm' | 'unverified'

export interface CompanyIdentity {
  id: string
  kind: CompanyIdentityKind
  /** Set only when NXT Sales holds the record right now. */
  crmCompanyId: string | null
  discoveredCompanyId: string | null
  name: string | null
  website: string | null
  /** The Prospects search that found it, for a discovered company. */
  searchObjective: string | null
  checkedAt: string
  reason: string
}

export const IDENTITY_LABEL: Record<CompanyIdentityKind, string> = {
  crm: 'NXT Sales company',
  discovered: 'Found by Prospects',
  not_in_crm: 'Not in NXT Sales',
  unverified: 'NXT Sales not checked',
}

function isIdentity(v: unknown): v is CompanyIdentity {
  const o = v as CompanyIdentity | null
  return Boolean(o && typeof o === 'object' && typeof o.kind === 'string' && o.kind in IDENTITY_LABEL)
}

/** The live answer for one company id; null while loading or when the check itself failed. */
export function useCompanyIdentity(id: string | null | undefined) {
  const state = useAsync<unknown>(
    (signal) => (id ? api.get(`/companies/${encodeURIComponent(id)}/identity`, { signal }) : Promise.resolve(null)),
    [id],
    { enabled: Boolean(id) },
  )
  return { identity: isIdentity(state.data) ? state.data : null, loading: state.loading, error: state.error }
}
