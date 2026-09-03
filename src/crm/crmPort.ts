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
  CrmPage,
  CrmUser,
} from './types.js'

/**
 * The ONLY contract the orchestrator knows about the CRM.
 *
 * Phase 1 is entirely read-only. No write method exists on this interface —
 * not "exists but disabled", not "exists and gated". That is the strongest
 * available guarantee that a Phase 1 run cannot alter NXT Sales data, and it
 * is why the tool registry has no write tools to gate in the first place.
 *
 * Write methods (createLead, logActivity, sendEmail) arrive with Phase 4/5,
 * together with the approval-hash precondition that governs them.
 */
export interface CrmPort {
  readonly name: string

  searchCompanies(q: CrmCompanyQuery): Promise<CrmPage<CrmCompany>>
  /** Unpaginated, filter-identical to searchCompanies — for audience snapshots. */
  exportCompanies(q: CrmCompanyQuery): Promise<CrmPage<CrmCompany>>
  getCompany(id: string): Promise<CrmCompany | null>

  listDeals(params?: { companyId?: string; view?: 'mine' }): Promise<CrmDeal[]>
  exportDeals(params?: { view?: 'mine' }): Promise<CrmDeal[]>
  getDealStats(params?: { year?: number; month?: number }): Promise<CrmDealStats>

  getEmailSummary(companyId: string): Promise<CrmEmailSummary>
  listActivities(params: { companyId: string; type?: string }): Promise<CrmActivity[]>

  getDropdownFields(): Promise<CrmDropdownField[]>
  getDropdownOptions(fieldKey: string): Promise<CrmDropdownOption[]>
  getCustomFieldDefs(entity: 'Company' | 'Deal'): Promise<CrmCustomFieldDef[]>

  listUsers(): Promise<CrmUser[]>

  /**
   * The only write this port declares.
   *
   * OPTIONAL on purpose. A port with a required write method forces every
   * adapter — including the fake one used throughout the tests — to have a way
   * to mutate a CRM, and the safest adapter is one with no such code at all.
   * `capabilities()` reports whether an adapter implements it, so a caller
   * asks rather than assumes.
   *
   * The signature accepts ONLY custom fields. There is no parameter for a
   * name, an owner, a lead status or a Deal, so the approved scope is a
   * property of the type rather than a rule a caller has to remember. Adding
   * one would be a visible change to this interface.
   */
  updateCompany?(id: string, patch: CompanyCustomFieldPatch): Promise<{ ok: true; id: string }>

  health(): Promise<{ ok: boolean; detail?: string }>
}

/**
 * The complete shape of what may be written to a Company.
 *
 * A closed object with one key. Custom fields are the approved surface, and
 * anything outside it has nowhere to go in this type.
 */
export interface CompanyCustomFieldPatch {
  customFields: Record<string, number | string>
}
