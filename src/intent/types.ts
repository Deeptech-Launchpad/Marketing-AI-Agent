import crypto from 'node:crypto'

// STAGE 3 — INTENT SIGNAL CONTRACT.
//
// The engine answers "what evidence suggests this company may have a current
// business need?" It does NOT answer "this company needs our solution."
//
// There is deliberately NO composite intent score here. Scoring is a later
// stage, and collapsing signals into one number at collection time would
// destroy the thing that makes them useful: each signal's own evidence,
// source, age and confidence.

export const SIGNAL_CATEGORIES = [
  'crm',
  'hiring',
  'technology',
  'website',
  'business',
  'news',
  'catalog',
] as const
export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number]

export const POLARITIES = ['positive', 'negative', 'neutral'] as const
export type Polarity = (typeof POLARITIES)[number]

export const CONFIDENCES = ['high', 'medium', 'low'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export const FRESHNESS = ['fresh', 'aging', 'stale', 'unknown'] as const
export type Freshness = (typeof FRESHNESS)[number]

/**
 * Where a signal came from. This drives confidence deterministically — see
 * confidence.ts — so it is a closed set rather than free text.
 */
export const SOURCE_TYPES = [
  'crm_record', // NXT Sales, read-only
  'company_website', // the company's own site, fetched by us
  'job_board', // third-party job board via a collection provider
  'news_article', // third-party publication
  'third_party', // anything else with a URL
] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export interface IntentSignalDraft {
  crmCompanyId: string
  signalType: string
  signalCategory: SignalCategory
  /** What happened, in one line. */
  summary: string
  /** WHY this may indicate current need. Never asserts that it does. */
  interpretation: string
  /** The literal thing observed: a job title, a meta tag, an activity row. */
  evidence: string
  sourceUrl: string | null
  sourceType: SourceType
  /** When the source says the event happened. Null when it does not say. */
  observedAt: Date | null
  polarity: Polarity
  provider: string
  metadata?: Record<string, unknown>
}

/**
 * Identifies the underlying EVENT rather than the report of it.
 *
 * The same acquisition can surface on the company site, in a news article and
 * on a job board. Those are three pieces of evidence for one event, not three
 * events, and counting them separately would triple the apparent intent of any
 * company that happens to get press coverage.
 *
 * Keyed on company + category + a normalised subject, so two reports of "we
 * hired a Product Data Manager" collapse while a genuinely different role does
 * not.
 */
export function eventFingerprint(input: {
  crmCompanyId: string
  signalCategory: SignalCategory
  subject: string
}): string {
  const subject = input.subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    // Word-set rather than word-order: "Manager, Product Data" and "Product
    // Data Manager" are the same job.
    .sort()
    .join(' ')

  return crypto
    .createHash('sha256')
    .update(`${input.crmCompanyId}|${input.signalCategory}|${subject}`)
    .digest('hex')
    .slice(0, 32)
}
