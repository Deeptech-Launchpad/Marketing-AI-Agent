import type {
  CrmActivity,
  CrmCompany,
  CrmCompanyQuery,
  CrmCustomFieldDef,
  CrmDeal,
  CrmDealStats,
  CrmDropdownField,
  CrmDropdownOption,
  CrmEmailSummary,
  CrmUser,
} from '../types.js'
import type { QueryParams } from './httpClient.js'

// ALL knowledge of NXT Sales' literal response shapes is confined to this file.
// If the CRM changes, this is the only place that needs to change, and the
// contract tests in tests/ are what catch the drift.

type Raw = Record<string, unknown>

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const bool = (v: unknown): boolean => v === true || v === 'true'

const iso = (v: unknown): string => (v ? new Date(String(v)).toISOString() : new Date(0).toISOString())

/** Company.emails / phones / contactPersons / linkedProfiles are JSON arrays that may be null. */
const jsonArray = (v: unknown): string[] => {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean)
}

/**
 * Domain query -> NXT Sales wire params.
 *
 * Encoding rules taken directly from server/src/routes/companies.js:
 *  - industries  : REPEATED array param (buildQuery emits `industries[]=`)
 *  - owners / leadStatuses / countries / cmsValues / remarksValues : comma-joined
 *  - customFilters : JSON-encoded object STRING
 * Getting either of the first two wrong fails silently — the CRM returns a
 * wrong-but-plausible result set rather than an error.
 */
export function toCompanyParams(q: CrmCompanyQuery): QueryParams {
  const p: QueryParams = {}
  if (q.search) p.search = q.search
  if (q.view) p.view = q.view
  if (q.owners?.length) p.owners = q.owners.join(',')
  if (q.leadStatuses?.length) p.leadStatuses = q.leadStatuses.join(',')
  if (q.countries?.length) p.countries = q.countries.join(',')
  if (q.cmsValues?.length) p.cmsValues = q.cmsValues.join(',')
  if (q.remarksValues?.length) p.remarksValues = q.remarksValues.join(',')
  if (q.industries?.length) p.industries = q.industries // array -> repeated param
  // NXT Sales accepts only the literal strings 'yes' / 'no' (deals some / none).
  // A boolean serialises as "true"/"false", which it ignores — silently
  // returning every company, with or without deals.
  if (q.hasDeal !== undefined) p.hasDeal = q.hasDeal ? 'yes' : 'no'
  if (q.createDate) p.createDate = q.createDate
  if (q.customFilters && Object.keys(q.customFilters).length) {
    p.customFilters = JSON.stringify(q.customFilters)
  }
  if (q.sort) p.sort = q.sort
  if (q.page) p.page = q.page
  if (q.limit) p.limit = q.limit
  return p
}

export function toCompany(raw: Raw): CrmCompany {
  const owner = raw.owner as Raw | undefined
  const count = raw._count as Raw | undefined
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    email: str(raw.email),
    emails: jsonArray(raw.emails),
    phone: str(raw.phone),
    domain: str(raw.domain),
    industry: str(raw.industry),
    country: str(raw.country),
    cms: str(raw.cms),
    leadStatus: str(raw.leadStatus),
    status: str(raw.status),
    remarks: str(raw.remarks),
    notes: str(raw.notes),
    endPdpUrl: str(raw.endPdpUrl),
    contactPersons: jsonArray(raw.contactPersons),
    linkedProfiles: jsonArray(raw.linkedProfiles),
    ownerId: str(raw.ownerId),
    ownerName: owner ? str(owner.name) : null,
    dealCount: num(count?.deals),
    createdAt: iso(raw.createdAt),
    updatedAt: iso(raw.updatedAt),
  }
}

export function toDeal(raw: Raw): CrmDeal {
  const company = raw.company as Raw | undefined
  return {
    id: String(raw.id),
    title: String(raw.title ?? ''),
    value: num(raw.value),
    currency: String(raw.currency ?? 'USD'),
    stage: String(raw.stage ?? ''),
    companyId: str(raw.companyId),
    companyName: company ? str(company.name) : str(raw.companyName),
    ownerId: str(raw.ownerId),
    country: str(raw.country),
    clientType: str(raw.clientType),
    serviceRequirement: str(raw.serviceRequirement),
    opportunityType: str(raw.opportunityType),
    strategicImportance: str(raw.strategicImportance),
    expectedOutcome: str(raw.expectedOutcome),
    poc: bool(raw.poc),
    proposalShared: bool(raw.proposalShared),
    openDate: raw.openDate ? iso(raw.openDate) : null,
    createdAt: iso(raw.createdAt),
  }
}

export function toDealStats(raw: Raw): CrmDealStats {
  const breakdown = Array.isArray(raw.stageBreakdown) ? (raw.stageBreakdown as Raw[]) : []
  return {
    totalDeals: num(raw.totalDeals),
    activeDeals: num(raw.activeDeals),
    wonDeals: num(raw.wonDeals),
    lostDeals: num(raw.lostDeals),
    totalValue: num(raw.totalValue),
    dealsWithoutCompany: num(raw.dealsWithoutCompany),
    stageBreakdown: breakdown.map((b) => ({ stage: String(b.stage ?? ''), count: num(b.count) })),
  }
}

export function toEmailSummary(raw: Raw): CrmEmailSummary {
  const threads = Array.isArray(raw.threads) ? (raw.threads as Raw[]) : []
  return {
    ok: raw.ok !== false,
    threadCount: num(raw.threadCount),
    messageCount: num(raw.messageCount),
    lastContactAt: raw.lastContactAt ? iso(raw.lastContactAt) : null,
    threads: threads.map((t) => ({
      subject: String(t.subject ?? '(no subject)'),
      messageCount: num(t.messageCount),
      lastAt: iso(t.lastAt),
      lastDirection: String(t.lastDirection ?? 'unknown'),
      excerpts: (Array.isArray(t.excerpts) ? (t.excerpts as Raw[]) : []).map((e) => ({
        direction: String(e.direction ?? 'unknown'),
        at: iso(e.at),
        text: String(e.text ?? ''),
      })),
    })),
  }
}

export function toActivity(raw: Raw): CrmActivity {
  return {
    id: String(raw.id),
    type: String(raw.type ?? ''),
    companyId: str(raw.companyId),
    subject: str(raw.subject) ?? str(raw.title),
    direction: str(raw.direction),
    createdAt: iso(raw.createdAt),
  }
}

/**
 * GET /api/dropdowns/:fieldKey returns DropdownOption rows for curated fields,
 * but computed {value,label} objects for Lead Owner and for derived fields
 * (CMS, Remarks). Both shapes carry value/label, so one mapper covers them.
 */
export function toDropdownOption(raw: Raw): CrmDropdownOption {
  const value = String(raw.value ?? '')
  return { value, label: String(raw.label ?? value) }
}

export function toDropdownField(raw: Raw): CrmDropdownField {
  return {
    fieldKey: String(raw.fieldKey ?? ''),
    label: String(raw.label ?? ''),
    group: String(raw.group ?? ''),
  }
}

export function toCustomFieldDef(raw: Raw): CrmCustomFieldDef {
  return {
    key: String(raw.key ?? ''),
    label: String(raw.label ?? ''),
    type: String(raw.type ?? 'text'),
    required: bool(raw.required),
  }
}

export function toUser(raw: Raw): CrmUser {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    email: String(raw.email ?? ''),
    role: String(raw.role ?? 'member'),
  }
}
