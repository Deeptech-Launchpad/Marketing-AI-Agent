import type { CrmCompany } from '../crm/types.js'
import type { CandidateDraft, CompanyMatchLevel } from './types.js'

// STAGE 4 — "is this person actually at THIS company?"
//
// The failure this file exists to prevent: a person-search returns a
// Director of Ecommerce named in the right industry, and the pipeline quietly
// assumes they work at the prospect. Getting that wrong is worse than finding
// nobody, because it produces a confident, wrong, contactable human.
//
// So company association is verified independently of who returned the person,
// and a candidate that cannot be tied to the company does not become a
// verified result no matter how good the title is.

const LEGAL_SUFFIXES =
  /\b(ltd|limited|inc|incorporated|llc|l\.l\.c|corp|corporation|co|company|plc|gmbh|bv|nv|ag|sa|srl|pty|pvt|private|group|holdings|international|intl|usa|uk)\b/g

/** Words too common to prove anything on their own. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'supply', 'supplies', 'solutions', 'services',
  'products', 'industrial', 'industries', 'systems', 'technologies', 'equipment',
  'distribution', 'distributors', 'wholesale', 'trading', 'global', 'national',
])

export function normalizeCompanyName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Significant tokens — what is left after suffixes and generic industry words. */
export function significantTokens(raw: string): string[] {
  return normalizeCompanyName(raw)
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Same registrable site, allowing subdomains (careers.acme.com ~ acme.com). */
export function sameSite(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

export interface CompanyMatchResult {
  level: CompanyMatchLevel
  reasons: string[]
}

/**
 * Verifies the person-to-company link from whatever the sources actually said.
 *
 * - `verified`   the company itself published this person, or the stated
 *                employer matches by full name or by domain.
 * - `probable`   a distinctive token of the company name matches, but not the
 *                whole name — enough to keep, not enough to assert.
 * - `unverified` no source stated an employer at all.
 * - `rejected`   a source stated a DIFFERENT employer.
 */
export function verifyCompanyMatch(
  draft: CandidateDraft,
  company: CrmCompany,
  companyDomain: string | null,
): CompanyMatchResult {
  const reasons: string[] = []
  const targetHost = hostOf(companyDomain ?? company.domain)

  // 1. First-party publication is the strongest possible claim: the company
  //    listed this person on its own website, so the employer IS the source.
  const firstParty = draft.evidence.find(
    (e) => e.sourceType === 'company_website' && sameSite(hostOf(e.sourceUrl), targetHost),
  )
  if (firstParty && targetHost) {
    reasons.push(
      `Published by the company itself on ${hostOf(firstParty.sourceUrl)}, which matches the verified company domain ${targetHost}.`,
    )
    return { level: 'verified', reasons }
  }

  // 2. The CRM already records this person against this company record.
  const crmEvidence = draft.evidence.find((e) => e.sourceType === 'crm_record')
  if (crmEvidence) {
    reasons.push(`Recorded against CRM company ${company.id} ("${company.name}").`)
    return { level: 'verified', reasons }
  }

  // 3. A work email on the company's own domain ties the person to it.
  const emailHost = draft.email?.includes('@') ? draft.email.split('@').pop()!.toLowerCase() : null
  if (emailHost && sameSite(emailHost, targetHost)) {
    reasons.push(`Stated work email is on the company domain (${emailHost}).`)
    return { level: 'verified', reasons }
  }

  // 4. Employer as stated by the source, compared with the CRM company name.
  const stated = draft.statedCompany?.trim()
  if (!stated) {
    reasons.push('No source stated an employer for this person, so the company link is unproven.')
    return { level: 'unverified', reasons }
  }

  const statedNorm = normalizeCompanyName(stated)
  const targetNorm = normalizeCompanyName(company.name)

  if (statedNorm && statedNorm === targetNorm) {
    reasons.push(`Stated employer "${stated}" matches "${company.name}" after removing legal suffixes.`)
    return { level: 'verified', reasons }
  }

  const statedTokens = significantTokens(stated)
  const targetTokens = new Set(significantTokens(company.name))
  const shared = statedTokens.filter((t) => targetTokens.has(t))

  if (!targetTokens.size || !statedTokens.length) {
    // Nothing distinctive to compare — e.g. a company literally named
    // "Industrial Supply". Refuse to guess in either direction.
    reasons.push(
      `Neither "${stated}" nor "${company.name}" contains a distinctive token to compare, so the link cannot be checked.`,
    )
    return { level: 'unverified', reasons }
  }

  if (!shared.length) {
    reasons.push(
      `Stated employer "${stated}" shares no distinctive word with "${company.name}", so this person works somewhere else.`,
    )
    return { level: 'rejected', reasons }
  }

  if (shared.length === targetTokens.size) {
    reasons.push(`Stated employer "${stated}" contains every distinctive word of "${company.name}" (${shared.join(', ')}).`)
    return { level: 'verified', reasons }
  }

  reasons.push(
    `Stated employer "${stated}" shares ${shared.join(', ')} with "${company.name}" but is not the full name — could be a subsidiary, a division, or a different company.`,
  )
  return { level: 'probable', reasons }
}
