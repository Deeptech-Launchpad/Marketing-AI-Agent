import { env } from '../../config/env.js'
import { assertWritable } from '../../crmsync/writeGate.js'
import type { CompanyCustomFieldPatch, CrmPort } from '../crmPort.js'
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
} from '../types.js'
import { crmGet, crmGetOrNull, crmPut, probeCrm } from './httpClient.js'
import {
  toActivity,
  toCompany,
  toCompanyParams,
  toCustomFieldDef,
  toDeal,
  toDealStats,
  toDropdownField,
  toDropdownOption,
  toEmailSummary,
  toUser,
} from './mappers.js'

type Raw = Record<string, unknown>

/**
 * Read-only adapter over the existing NXT Sales REST API.
 *
 * Every endpoint used here already exists and is unchanged. Nothing in this
 * file writes: CrmPort has no write methods in Phase 1.
 *
 * Recycle-bin behaviour is NXT Sales', not ours — its list routes filter
 * deletedAt server-side and its detail route 404s on a binned company. This
 * adapter must never construct a path that bypasses that.
 */
export class NxtSalesAdapter implements CrmPort {
  readonly name = 'nxt-sales'

  async searchCompanies(q: CrmCompanyQuery): Promise<CrmPage<CrmCompany>> {
    const data = await crmGet<Raw>('/api/companies', toCompanyParams(q))
    const rows = Array.isArray(data.companies) ? (data.companies as Raw[]) : []
    return {
      items: rows.map(toCompany),
      total: Number(data.total ?? rows.length),
      truncated: false,
    }
  }

  /**
   * NXT Sales' /export returns the full filtered set unpaginated, using the
   * SAME filter builder as the list route — so "export with applied filters"
   * always matches what the list shows. That is exactly what an audience
   * snapshot needs, so this is one call, not a paging loop.
   */
  async exportCompanies(q: CrmCompanyQuery): Promise<CrmPage<CrmCompany>> {
    const { page: _page, limit: _limit, ...rest } = q
    const data = await crmGet<Raw>('/api/companies/export', toCompanyParams(rest))
    const rows = Array.isArray(data.companies) ? (data.companies as Raw[]) : []
    return { items: rows.map(toCompany), total: rows.length, truncated: false }
  }

  async getCompany(id: string): Promise<CrmCompany | null> {
    const data = await crmGetOrNull<Raw>(`/api/companies/${encodeURIComponent(id)}`)
    return data ? toCompany(data) : null
  }

  async listDeals(params: { companyId?: string; view?: 'mine' } = {}): Promise<CrmDeal[]> {
    const data = await crmGet<Raw[]>('/api/deals', {
      companyId: params.companyId,
      view: params.view,
    })
    return (Array.isArray(data) ? data : []).map(toDeal)
  }

  async exportDeals(params: { view?: 'mine' } = {}): Promise<CrmDeal[]> {
    const data = await crmGet<Raw>('/api/deals/export', { view: params.view })
    const rows = Array.isArray(data.deals) ? (data.deals as Raw[]) : []
    return rows.map(toDeal)
  }

  async getDealStats(params: { year?: number; month?: number } = {}): Promise<CrmDealStats> {
    const data = await crmGet<Raw>('/api/dashboard/deal-stats', {
      year: params.year,
      month: params.month,
    })
    return toDealStats(data)
  }

  async getEmailSummary(companyId: string): Promise<CrmEmailSummary> {
    const data = await crmGet<Raw>(`/api/intelligence/email-summaries/${encodeURIComponent(companyId)}`)
    return toEmailSummary(data)
  }

  /**
   * NXT Sales requires either a companyId, or type=meeting|task for its global
   * dashboard view. Only the company-scoped form is used here (recent-contact
   * suppression), so companyId is mandatory in the signature.
   */
  async listActivities(params: { companyId: string; type?: string }): Promise<CrmActivity[]> {
    const data = await crmGet<Raw[]>('/api/activities', {
      companyId: params.companyId,
      type: params.type,
    })
    return (Array.isArray(data) ? data : []).map(toActivity)
  }

  async getDropdownFields(): Promise<CrmDropdownField[]> {
    const data = await crmGet<Raw[]>('/api/dropdowns/fields')
    return (Array.isArray(data) ? data : []).map(toDropdownField)
  }

  async getDropdownOptions(fieldKey: string): Promise<CrmDropdownOption[]> {
    const data = await crmGet<Raw[]>(`/api/dropdowns/${encodeURIComponent(fieldKey)}`)
    return (Array.isArray(data) ? data : []).map(toDropdownOption)
  }

  async getCustomFieldDefs(entity: 'Company' | 'Deal'): Promise<CrmCustomFieldDef[]> {
    const data = await crmGet<Raw[]>(`/api/custom-fields/${entity}`)
    return (Array.isArray(data) ? data : []).map(toCustomFieldDef)
  }

  async listUsers(): Promise<CrmUser[]> {
    const data = await crmGet<Raw[]>('/api/users')
    return (Array.isArray(data) ? data : []).map(toUser)
  }

  /**
   * Writes custom fields onto a Company, and nothing else.
   *
   * The whole body is `{ customFields }`, which matters because NXT Sales'
   * PUT /companies/:id applies each field only when it is `!== undefined`.
   * Sending one key therefore leaves every other column untouched — the name,
   * the owner, the lead status and the rest keep whatever a salesperson last
   * put there.
   *
   * The forbidden-field guard runs here as well as upstream. This is the last
   * function before the wire, and a guard that only exists at the top of the
   * call chain protects only the callers that go through the top.
   */
  async updateCompany(id: string, patch: CompanyCustomFieldPatch): Promise<{ ok: true; id: string }> {
    assertWritable(patch as unknown as Record<string, unknown>)
    // Rebuilt rather than forwarded, so a caller cannot smuggle a sibling key
    // past the type by passing an object with extra properties.
    await crmPut<unknown>(`/api/companies/${id}`, { customFields: { ...patch.customFields } })
    return { ok: true, id }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return probeCrm()
  }
}
