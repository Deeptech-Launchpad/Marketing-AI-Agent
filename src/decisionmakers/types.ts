import type { RolePriority, Seniority } from './roleTaxonomy.js'

// STAGE 4 — shared vocabulary.
//
// Everything here is designed around one rule: a candidate exists because a
// source SAID SO, and the thing the source said is carried along with the
// candidate forever. There is no field on this type that a model may fill in.

/**
 * Why a provider did or did not produce results. Distinguishing these matters:
 * "no results" is a fact about the company, "unauthorized" is a fact about us,
 * and reporting the second as the first would make an unbought subscription
 * look like an empty market.
 */
export const PROVIDER_STATUSES = [
  'available',
  'unavailable',
  'unauthorized',
  'rate_limited',
  'no_results',
  'error',
  // Never called, because an earlier provider in the approved order had
  // already answered. Distinct from `no_results` on purpose: one means the
  // source was asked and knew nothing, the other means it was never asked, and
  // reading a skip as an empty market would be wrong.
  'skipped',
] as const
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number]

/** How strongly the person is tied to THIS company, at the time observed. */
export const COMPANY_MATCH_LEVELS = ['verified', 'probable', 'unverified', 'rejected'] as const
export type CompanyMatchLevel = (typeof COMPANY_MATCH_LEVELS)[number]

export const CANDIDATE_CONFIDENCES = ['high', 'medium', 'low'] as const
export type CandidateConfidence = (typeof CANDIDATE_CONFIDENCES)[number]

/**
 * How reachable this person is, stated separately from confidence so the two
 * are never confused: a HIGH-confidence candidate with no email is a solid
 * finding, not a weak one.
 *
 * `withheld_by_policy` exists so a suppressed contact detail is visible AS a
 * policy decision rather than looking like an absent one.
 */
export const CONTACTABILITY = ['contactable', 'withheld_by_policy', 'profile_only', 'none'] as const
export type Contactability = (typeof CONTACTABILITY)[number]

/**
 * Source types, ordered by how much they can be trusted about employment.
 * A company's own leadership page is the strongest claim available about who
 * works there, because the company is the authority on its own staff.
 */
export const DM_SOURCE_TYPES = [
  'company_website',
  'crm_record',
  'linkedin',
  'data_provider',
  'press_release',
  'third_party',
] as const
export type DmSourceType = (typeof DM_SOURCE_TYPES)[number]

/**
 * One provider's claim about one person. This is the ONLY thing a provider is
 * allowed to emit: an observation with the text that supports it.
 *
 * Note what is absent: no confidence, no rank, no score. Those are computed by
 * the engine from the evidence, uniformly, so no provider can flatter itself.
 */
export interface CandidateEvidence {
  provider: string
  sourceType: DmSourceType
  sourceUrl: string | null
  /** The literal text from the source that supports the claim. Never a summary. */
  snippet: string
  /** When the source published or last changed, if the source says. */
  observedAt: Date | null
  /** Which fields this evidence actually supports. */
  supports: Array<'name' | 'title' | 'company' | 'profile_url' | 'contact'>
}

/**
 * A person as one provider saw them. Fields are null when the provider did not
 * state them — never inferred, never defaulted, never guessed.
 */
export interface CandidateDraft {
  fullName: string
  /** Exactly as the source wrote it, before normalisation. */
  rawTitle: string | null
  /** Employer as the SOURCE states it, for company-match verification. */
  statedCompany: string | null
  /** Public profile URL only when the provider returned one verbatim. */
  profileUrl: string | null
  /** Provider's own stable ID for this person, when it has one. */
  providerPersonId: string | null
  /**
   * Contact details ONLY when a provider states them explicitly.
   * Never derived from a name, never pattern-guessed from a domain.
   */
  email: string | null
  phone: string | null
  location: string | null
  evidence: CandidateEvidence[]
}

/** A candidate after the engine has verified, merged and scored it. */
export interface ScoredCandidate {
  identityKey: string
  fullName: string
  rawTitle: string | null
  normalizedTitle: string | null
  roleGroup: string | null
  rolePriority: RolePriority | null
  /**
   * True when the only match was the executive-sponsor fallback (Owner, GM,
   * Managing Director, VP Sales/Marketing). Such a candidate is shortlisted
   * only where the company has no specialist — see the fallback policy.
   */
  roleIsFallback: boolean
  seniority: Seniority | null
  statedCompany: string | null
  profileUrl: string | null
  email: string | null
  phone: string | null
  location: string | null
  companyMatch: CompanyMatchLevel
  companyMatchReasons: string[]
  confidence: CandidateConfidence
  confidenceReasons: string[]
  /** Distinct providers that independently reported this person. */
  corroboratingProviders: string[]
  contactability: Contactability
  rankScore: number
  rankReasons: string[]
  evidence: CandidateEvidence[]
}
