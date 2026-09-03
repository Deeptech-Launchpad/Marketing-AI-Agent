import { env } from '../config/env.js'
import type { Confidence, Freshness, IntentSignalDraft, SourceType } from './types.js'

// Confidence and freshness are computed by RULES, not by a model.
//
// A model asked "how confident are you?" produces a number that reads like a
// measurement and is actually a vibe. These rules are dull, inspectable, and
// give the same answer twice — which is what makes a confidence label worth
// putting next to evidence.
//
// Confidence describes EVIDENCE QUALITY only. It is not an intent score, and it
// says nothing about how likely the company is to buy.

/** Ranked by how directly the source witnesses the event. */
const SOURCE_BASE: Record<SourceType, Confidence> = {
  // The CRM is our own system of record.
  crm_record: 'high',
  // The company declaring something on its own site.
  company_website: 'high',
  // A real listing with a URL, but reported by a third party.
  job_board: 'medium',
  news_article: 'medium',
  third_party: 'low',
}

function demote(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low'
}

export interface ConfidenceResult {
  confidence: Confidence
  reasons: string[]
}

/**
 * Starts from the source's inherent quality and demotes for concrete evidence
 * defects. Nothing is ever promoted: a weak source cannot become strong because
 * its text happened to look convincing.
 */
export function scoreConfidence(draft: IntentSignalDraft): ConfidenceResult {
  const reasons: string[] = []
  let confidence = SOURCE_BASE[draft.sourceType]
  reasons.push(`Source type "${draft.sourceType}" is treated as ${confidence} quality.`)

  // Evidence that cannot be re-checked is worth less, whatever it says.
  if (!draft.sourceUrl && draft.sourceType !== 'crm_record') {
    confidence = demote(confidence)
    reasons.push('No source URL, so the claim cannot be independently re-checked. Demoted.')
  }

  if (!draft.evidence || draft.evidence.trim().length < 8) {
    confidence = demote(confidence)
    reasons.push('Evidence is missing or too short to inspect. Demoted.')
  }

  // An undated event cannot be shown to be current, and intent is about now.
  if (!draft.observedAt) {
    confidence = demote(confidence)
    reasons.push('Source gave no date, so the signal cannot be shown to be current. Demoted.')
  }

  return { confidence, reasons }
}

export interface FreshnessResult {
  freshness: Freshness
  ageDays: number | null
}

/**
 * Age of the EVENT, not of our observation of it. A job posting found today but
 * published two years ago is stale intent, and recording the fetch time as its
 * age would hide exactly that.
 */
export function scoreFreshness(observedAt: Date | null, now: Date = new Date()): FreshnessResult {
  if (!observedAt || Number.isNaN(observedAt.getTime())) return { freshness: 'unknown', ageDays: null }

  const ageDays = Math.floor((now.getTime() - observedAt.getTime()) / 86_400_000)

  // A future date means the source is wrong or was misparsed. Treated as
  // unknown rather than "extremely fresh".
  if (ageDays < 0) return { freshness: 'unknown', ageDays }

  if (ageDays <= env.INTENT_FRESH_DAYS) return { freshness: 'fresh', ageDays }
  if (ageDays <= env.INTENT_AGING_DAYS) return { freshness: 'aging', ageDays }
  return { freshness: 'stale', ageDays }
}

/**
 * A signal is only worth surfacing as CURRENT intent when its evidence is both
 * inspectable and datable. Everything else is retained — deletion loses
 * evidence — but flagged so a later stage does not treat it as live.
 */
export function signalStatus(confidence: Confidence, freshness: Freshness): 'active' | 'weak' | 'expired' {
  if (freshness === 'stale') return 'expired'
  if (confidence === 'low' || freshness === 'unknown') return 'weak'
  return 'active'
}
