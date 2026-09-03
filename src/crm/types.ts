import { z } from 'zod'

// Domain-side CRM shapes. Deliberately NOT the raw NXT Sales response shapes —
// those live in nxtSales/mappers.ts and never escape the adapter. Everything
// above this file is written against these types, which is what makes a second
// CRM a new adapter rather than a rewrite.

/**
 * Mirrors NXT Sales' buildCompanyWhere() exactly. Two wire-encoding quirks are
 * load-bearing and are handled in the adapter, not here:
 *
 *  - `industries` must be sent as a REPEATED array param (industries[]=A&
 *    industries[]=B), never comma-joined: several real industry values contain
 *    a literal comma in their own name.
 *  - `customFilters` is a JSON-encoded object STRING, not a nested object.
 *
 * `view: 'unassigned'` is also not what it looks like: over there it means
 * "owner is null OR owner is one of a hardcoded list of names", so it is
 * exposed but never used to mean "has no owner".
 */
export const CrmCompanyQuerySchema = z.object({
  search: z.string().optional(),
  view: z.enum(['mine', 'unassigned']).optional(),
  owners: z.array(z.string()).optional(),
  leadStatuses: z.array(z.string()).optional(),
  industries: z.array(z.string()).optional(),
  countries: z.array(z.string()).optional(),
  cmsValues: z.array(z.string()).optional(),
  remarksValues: z.array(z.string()).optional(),
  hasDeal: z.boolean().optional(),
  createDate: z.string().optional(),
  customFilters: z.record(z.string()).optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).optional(),
  sort: z.enum(['recent']).optional(),
})
export type CrmCompanyQuery = z.infer<typeof CrmCompanyQuerySchema>

export interface CrmCompany {
  id: string
  name: string
  email: string | null
  emails: string[]
  phone: string | null
  domain: string | null
  industry: string | null
  country: string | null
  cms: string | null
  leadStatus: string | null
  status: string | null
  remarks: string | null
  notes: string | null
  endPdpUrl: string | null
  contactPersons: string[]
  linkedProfiles: string[]
  ownerId: string | null
  ownerName: string | null
  dealCount: number
  createdAt: string
  updatedAt: string
}

export interface CrmDeal {
  id: string
  title: string
  value: number
  currency: string
  stage: string
  companyId: string | null
  companyName: string | null
  ownerId: string | null
  country: string | null
  clientType: string | null
  serviceRequirement: string | null
  opportunityType: string | null
  strategicImportance: string | null
  expectedOutcome: string | null
  poc: boolean
  proposalShared: boolean
  openDate: string | null
  createdAt: string
}

export interface CrmDealStats {
  totalDeals: number
  activeDeals: number
  wonDeals: number
  lostDeals: number
  totalValue: number
  /** Surfaced because Deal.companyId is nullable: these deals join to no company. */
  dealsWithoutCompany: number
  stageBreakdown: Array<{ stage: string; count: number }>
}

export interface CrmEmailThread {
  subject: string
  messageCount: number
  lastAt: string
  lastDirection: string
  /** UNTRUSTED free text written by third parties — delimited in every prompt. */
  excerpts: Array<{ direction: string; at: string; text: string }>
}

export interface CrmEmailSummary {
  ok: boolean
  threadCount: number
  messageCount: number
  lastContactAt: string | null
  threads: CrmEmailThread[]
}

export interface CrmActivity {
  id: string
  type: string
  companyId: string | null
  subject: string | null
  direction: string | null
  createdAt: string
}

export interface CrmDropdownOption {
  value: string
  label: string
}

export interface CrmDropdownField {
  fieldKey: string
  label: string
  group: string
}

export interface CrmCustomFieldDef {
  key: string
  label: string
  type: string
  required: boolean
}

export interface CrmUser {
  id: string
  name: string
  email: string
  role: string
}

export interface CrmPage<T> {
  items: T[]
  total: number
  /** True when a hard page cap stopped collection — never a silent partial set. */
  truncated: boolean
}
