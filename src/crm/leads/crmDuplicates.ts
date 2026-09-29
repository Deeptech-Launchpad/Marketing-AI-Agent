import { env } from '../../config/env.js'
import { hostOf, normalizeCompanyName } from '../../decisionmakers/companyMatch.js'
import { registrableDomain } from '../../enrichment/siteIdentity.js'
import { classifyCompanyUrl } from '../companySource.js'
import { getCrm } from '../index.js'
import { crmGet } from '../nxtSales/httpClient.js'
import type { CrmCompany } from '../types.js'

// IS THIS COMPANY ALREADY IN NXT SALES? (2026-09-29)
//
// The live CRM is the source of truth, so every answer here is a READ of it
// at the moment of asking — nothing is cached, and "could not check" is its
// own answer, never "not found". Three checks, strongest first:
//
//   1. NXT Sales' own duplicate rule (GET /api/companies/check-duplicate):
//      exact name (any case), primary email, phone, and the Company URL with
//      protocol/www/trailing slash removed — the same rule its create uses.
//   2. The same REGISTRABLE domain under any spelling: shop.acme.com,
//      https://www.acme.com/ and acme.com are one company.
//   3. The same NAME once punctuation and legal endings are ignored:
//      "Acme Supply Co., Inc." and "ACME Supply" are one company.
//
// A match on any of them means "already in NXT Sales" — the same answer the
// CRM itself would give on create (it refuses a duplicate name outright).
//
// Two traps, both seen in real data and both refused (2026-09-29):
//   · A social or platform page is nobody's website: two companies whose
//     "website" is a facebook.com page are not the same company. Only a real
//     company website counts, on either side.
//   · The same NAME with a DIFFERENT website is a different company ("Ideal
//     Electrical" in the US and in South Africa). It is reported as
//     name_conflict — never linked, never created (NXT Sales would refuse the
//     name anyway) — for a person to decide.

export type CrmMatchedOn = 'domain' | 'name' | 'email' | 'crm_rule'

export interface CrmMatch {
  id: string
  name: string
  matchedOn: CrmMatchedOn
}

export type CrmCheck =
  | { status: 'found'; match: CrmMatch }
  | { status: 'name_conflict'; match: CrmMatch; reason: string }
  | { status: 'not_found' }
  | { status: 'unreachable'; reason: string }

export interface CompanyIdentityForCheck {
  name: string
  /** The company's website (any form), when known. */
  website?: string | null
  /** Emails that identify the company (e.g. a verified company mailbox). */
  emails?: string[]
}

/** The registrable domain of a real company website — null for a social/platform page or nothing. */
export const regOf = (value: string | null | undefined): string | null => {
  const c = classifyCompanyUrl(value)
  if (c.kind !== 'primary_website' || !c.url) return null
  const host = hostOf(c.url)
  return host ? registrableDomain(host) : null
}

/** Same name, but both have a real website and they differ: a different company. */
function nameConflict(company: CrmCompany, input: CompanyIdentityForCheck): string | null {
  const mine = regOf(input.website)
  const theirs = regOf(company.domain)
  if (!mine || !theirs || mine === theirs) return null
  return `NXT Sales already has a company named "${company.name}" with a different website (${theirs}, not ${mine}). NXT Sales does not allow two companies with the same name — check whether they are the same company.`
}

/** Which of our identifiers a CRM record matches — for the reason shown to Sales. */
export function matchedOnFor(company: CrmCompany, input: CompanyIdentityForCheck): CrmMatchedOn | null {
  const reg = regOf(input.website)
  if (reg && regOf(company.domain) === reg) return 'domain'
  const n = normalizeCompanyName(input.name)
  if (n && normalizeCompanyName(company.name) === n) return 'name'
  const mine = new Set((input.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))
  const theirs = [company.email, ...(company.emails ?? [])].map((e) => String(e ?? '').trim().toLowerCase())
  if (theirs.some((e) => e && mine.has(e))) return 'email'
  return null
}

export async function findCompanyInCrm(input: CompanyIdentityForCheck): Promise<CrmCheck> {
  const name = input.name.trim()
  if (!name) return { status: 'unreachable', reason: 'The company has no name to check.' }
  const reg = regOf(input.website)
  const host = reg ? hostOf(input.website ?? null) : null
  const email = (input.emails ?? []).map((e) => e.trim().toLowerCase()).find(Boolean) ?? ''
  const crm = getCrm()

  try {
    // 1. The CRM's own rule (the real adapter only — the fake has no endpoint).
    if (env.CRM_DRIVER === 'real') {
      const r = await crmGet<{ isDuplicate?: boolean; existing?: { id?: string; name?: string } | null }>(
        '/api/companies/check-duplicate',
        { name, domain: host ?? undefined, email: email || undefined },
      )
      if (r?.isDuplicate && r.existing?.id) {
        const full = await crm.getCompany(r.existing.id)
        const on = (full && matchedOnFor(full, input)) ?? 'crm_rule'
        const match: CrmMatch = { id: r.existing.id, name: r.existing.name ?? full?.name ?? name, matchedOn: on }
        const conflict = full && on !== 'domain' && on !== 'email' ? nameConflict(full, input) : null
        return conflict ? { status: 'name_conflict', match, reason: conflict } : { status: 'found', match }
      }
    }

    // 2. Same registrable domain, however it was typed.
    if (reg) {
      const page = await crm.searchCompanies({ search: reg, page: 1, limit: 100 })
      const hit = page.items.find((c) => regOf(c.domain) === reg)
      if (hit) return { status: 'found', match: { id: hit.id, name: hit.name, matchedOn: 'domain' } }
    }

    // 3. Same name, ignoring punctuation and legal endings.
    const core = normalizeCompanyName(name)
    if (core.length >= 3) {
      const page = await crm.searchCompanies({ search: core, page: 1, limit: 100 })
      const hit = page.items.find((c) => normalizeCompanyName(c.name) === core)
      if (hit) {
        const match: CrmMatch = { id: hit.id, name: hit.name, matchedOn: 'name' }
        const conflict = nameConflict(hit, input)
        return conflict ? { status: 'name_conflict', match, reason: conflict } : { status: 'found', match }
      }
    }

    return { status: 'not_found' }
  } catch (err) {
    return { status: 'unreachable', reason: `NXT Sales could not be checked: ${(err as Error).message}`.slice(0, 400) }
  }
}
