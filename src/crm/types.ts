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
  /** NXT Sales' own date token for the company's NEWEST activity, e.g. 'last_90' (read-only filter). */
  lastActivity: z.string().optional(),
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
  /**
   * The message text (plain text, tags removed, at most ACTIVITY_BODY_MAX characters), present ONLY when the caller asked for it
   * with `withBody`. Written by third parties: it is read in memory by Warm Leads to tell a refusal from interest and is never
   * stored, logged, sent to a model or copied into a result.
   */
  body?: string | null
  /**
   * Who sent an INBOUND email: the bare, lower-case addresses found in NXT Sales' raw `fromEmail` header ("Name <A@B.com>"), at most
   * ACTIVITY_ADDRESSES_MAX. Present only with `withBody`, only for inbound mail inside the window, like `body`. Used by Warm Leads to
   * identify the contact who sent an explicit opt-out; never logged or copied into a result (only a masked form is shown).
   */
  fromAddresses?: string[]
  /** The company address this conversation was matched to (NXT Sales `matchedCompanyEmail`), bare and lower-case. Same conditions. */
  matchedAddress?: string | null
  /** Our own addresses on the message (connected mailbox, the CRM user, the inbound `toEmail`): never the contact. Same conditions. */
  ownAddresses?: string[]
}

/** At most this many addresses are read from one header. */
export const ACTIVITY_ADDRESSES_MAX = 10

/** At most this much of the cleaned text is kept. */
export const ACTIVITY_BODY_MAX = 6000
/**
 * At most this much of the RAW text is looked at, and it is cut BEFORE any pattern is run on it: a sender controls the size of an
 * email, so no cost may grow with it. Real replies keep their own words at the top; the rest is quoted history, a signature or markup.
 */
export const ACTIVITY_BODY_RAW_MAX = 60_000
/** The text is read only for messages inside this many days (the same window Warm Leads reads replies in; a test pins them equal). */
export const ACTIVITY_BODY_WINDOW_DAYS = 90

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
