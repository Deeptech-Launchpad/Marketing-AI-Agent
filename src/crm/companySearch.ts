import type { CrmPort } from './crmPort.js'
import type { CrmCompany } from './types.js'
import { resolveCompanySource } from './companySource.js'

// FINDING A COMPANY THAT IS IN THE CRM.
//
// The company picker used to offer only what this platform had already worked
// on — the enrichment register — so a company sitting in NXT Sales could not be
// selected until some engine had happened to touch it. This asks the CRM.
//
// TWO WAYS A COMPANY IS FOUND, and a reader is told which one applied:
//
//   name      NXT Sales' own text search, exactly as its company list does it.
//   industry  the typed words matched a CRM INDUSTRY, so the companies filed
//             under it are offered. "medical" finds "Medical Equipment", and
//             a country named in the same breath narrows it: "industrial
//             suppliers in Malta" is an industry AND a country, not either.
//
// The industry side matches against the CRM's own vocabulary and nothing else.
// There is no synonym table and no model call: a word that names no industry in
// NXT Sales finds no companies through it, and the caller is told the query
// matched no industry rather than shown a widened guess.
//
// READ-ONLY. Both paths are GETs on the company list, which is what the CRM
// itself serves its own search box from.

export interface CompanySearchHit {
  crmCompanyId: string
  companyName: string
  website: string | null
  industry: string | null
  country: string | null
  /** Which of the two readings put this company in the results. */
  matchedOn: 'name' | 'industry'
}

export interface CompanySearchResult {
  companies: CompanySearchHit[]
  /** CRM industries the words matched, so the interface can say so. */
  industries: string[]
  /** CRM countries the words matched. Narrows the industry reading. */
  countries: string[]
  /** True when the CRM holds more than was returned. */
  truncated: boolean
  /** Set when a vocabulary could not be read; never silent. */
  industryReadError: string | null
}

/** Below this, a query is too short to be worth a CRM round trip. */
const MIN_QUERY = 2
/** At most this many industries are searched, so one word cannot fan out. */
const MAX_INDUSTRIES = 5
/**
 * How long the industry vocabulary is held.
 *
 * It is a dropdown list that changes rarely, and re-reading it on every
 * keystroke would put avoidable load on the CRM — which is the one thing this
 * feature must not do.
 */
const VOCAB_TTL_MS = 10 * 60 * 1000

const vocabCache = new Map<string, { values: string[]; readAt: number }>()

/** Forgets the cached vocabularies. For tests, and for a CRM that changed. */
export function resetIndustryVocabulary(): void {
  vocabCache.clear()
}

async function vocabulary(crm: CrmPort, fieldKey: string): Promise<{ values: string[]; error: string | null }> {
  const held = vocabCache.get(fieldKey)
  if (held && Date.now() - held.readAt < VOCAB_TTL_MS) return { values: held.values, error: null }
  try {
    const options = await crm.getDropdownOptions(fieldKey)
    const values = options.map((o) => o.value).filter(Boolean)
    vocabCache.set(fieldKey, { values, readAt: Date.now() })
    return { values, error: null }
  } catch (err) {
    // Not cached: a failed read must be retried, not remembered as "no
    // values exist".
    return { values: [], error: err instanceof Error ? err.message : String(err) }
  }
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The CRM industries a typed phrase names.
 *
 * Both directions, because both are things people type: "medical" is inside
 * "Medical Equipment", and "medical supplies wholesaler" contains "medical".
 * Short words are not matched on their own — "and", "ltd" and "co" would
 * otherwise drag in half the vocabulary.
 */
export function industriesMatching(query: string, vocabulary: string[]): string[] {
  const q = normalise(query)
  if (q.length < MIN_QUERY) return []
  const out: string[] = []
  for (const industry of vocabulary) {
    const value = normalise(industry)
    if (!value) continue
    const hit =
      value.includes(q) ||
      value.split(' ').some((word) => word.length >= 4 && q.split(' ').includes(word))
    if (hit && !out.includes(industry)) out.push(industry)
  }
  // The closest reading first: an industry the query names outright beats one
  // that merely shares a word with it.
  return out.sort((a, b) => Number(normalise(b).includes(q)) - Number(normalise(a).includes(q)))
}

/**
 * The CRM countries a typed phrase names.
 *
 * Stricter than the industry reading. A country is a proper noun that people
 * type whole — "in Malta", "UK companies" — while a loose substring match
 * turns "Mali" into a match for "malignant" and "IE" into a match for almost
 * anything. So the phrase must contain the country as a whole word, or as the
 * whole of its own name.
 */
export function countriesMatching(query: string, vocabulary: string[]): string[] {
  const q = normalise(query)
  if (q.length < MIN_QUERY) return []
  const words = new Set(q.split(' '))
  const out: string[] = []
  for (const country of vocabulary) {
    const value = normalise(country)
    if (!value) continue
    const whole = value.split(' ').every((w) => words.has(w))
    if ((whole || q === value) && !out.includes(country)) out.push(country)
  }
  return out
}

function toHit(company: CrmCompany, matchedOn: 'name' | 'industry'): CompanySearchHit {
  const source = resolveCompanySource(company)
  return {
    crmCompanyId: company.id,
    companyName: company.name,
    // The resolved website only — never an email domain treated as a site.
    website: source.websiteUrl,
    industry: company.industry ?? null,
    country: company.country ?? null,
    matchedOn,
  }
}

export async function searchCrmCompanies(
  crm: CrmPort,
  query: string,
  limit: number,
): Promise<CompanySearchResult> {
  const q = query.trim()
  const empty: CompanySearchResult = {
    companies: [],
    industries: [],
    countries: [],
    truncated: false,
    industryReadError: null,
  }
  if (q.length < MIN_QUERY) return empty

  const [industryVocab, countryVocab] = await Promise.all([
    vocabulary(crm, 'company.industry'),
    vocabulary(crm, 'company.country'),
  ])
  const industries = industriesMatching(q, industryVocab.values).slice(0, MAX_INDUSTRIES)
  const countries = countriesMatching(q, countryVocab.values)

  // A country named alongside an industry NARROWS it — "industrial suppliers
  // in Malta" asks for both — so the filters go in one query rather than two.
  // A country on its own is not a search: "Malta" would return the whole
  // country's worth of companies, which answers nothing.
  const filtered = industries.length ? { industries, ...(countries.length ? { countries } : {}), limit } : null

  // Both readings are asked for at once — they are independent GETs, and a
  // person waiting on a picker should wait for one round trip, not two.
  const [byName, byIndustry] = await Promise.all([
    crm.searchCompanies({ search: q, limit }),
    filtered ? crm.searchCompanies(filtered) : Promise.resolve(null),
  ])

  const hits: CompanySearchHit[] = []
  const seen = new Set<string>()
  // A company found by name is reported as such even when its industry also
  // matched: the stronger reason is the one worth showing.
  for (const c of byName.items) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    hits.push(toHit(c, 'name'))
  }
  for (const c of byIndustry?.items ?? []) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    hits.push(toHit(c, 'industry'))
  }

  const total = byName.total + (byIndustry?.total ?? 0)
  return {
    companies: hits.slice(0, limit),
    industries,
    countries: industries.length ? countries : [],
    truncated: hits.length > limit || total > hits.length,
    industryReadError: industryVocab.error ?? countryVocab.error,
  }
}

/**
 * One company, as the CRM holds it.
 *
 * What a lead card needs and nothing more: no scores, no rankings, no
 * derived fields. A value the CRM does not hold comes back null, so the
 * screen can say "not recorded in the CRM" rather than leave a reader to
 * guess whether the fetch failed.
 */
export interface CrmCompanyRecord {
  crmCompanyId: string
  companyName: string
  website: string | null
  /** Why there is no website, when the record holds none we can use. */
  websiteNote: string | null
  industry: string | null
  country: string | null
  email: string | null
  phone: string | null
  contactPersons: string[]
  endPdpUrl: string | null
  linkedProfiles: string[]
  ownerName: string | null
  dealCount: number
  createdAt: string
}

export async function readCrmCompany(crm: CrmPort, id: string): Promise<CrmCompanyRecord | null> {
  const company = await crm.getCompany(id)
  if (!company) return null
  const source = resolveCompanySource(company)
  return {
    crmCompanyId: company.id,
    companyName: company.name,
    website: source.websiteUrl,
    websiteNote: source.websiteUrl ? null : source.reason,
    industry: company.industry,
    country: company.country,
    email: company.email,
    phone: company.phone,
    contactPersons: company.contactPersons ?? [],
    endPdpUrl: company.endPdpUrl,
    linkedProfiles: company.linkedProfiles ?? [],
    ownerName: company.ownerName,
    dealCount: company.dealCount,
    createdAt: company.createdAt,
  }
}

/**
 * The one company a typed name names, when it names exactly one.
 *
 * "ACO Medical Supply" either IS a company in the CRM or it is not. A search
 * that returns forty near-misses has not answered that question, so the exact
 * match is picked out and reported separately from the rest — and when two
 * records carry the same name, neither is chosen, because guessing which one
 * the person meant is not something this can do.
 */
export function exactMatch(query: string, companies: CompanySearchHit[]): CompanySearchHit | null {
  const q = normalise(query)
  if (!q) return null
  const exact = companies.filter((c) => normalise(c.companyName) === q)
  return exact.length === 1 ? exact[0]! : null
}
