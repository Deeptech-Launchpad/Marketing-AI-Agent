import { presentSignals, type StoredSignalLike } from '../intent/signalView.js'

/** What an IntentSignal row needs beyond StoredSignalLike for this view. */
export interface UnderstandingSignalRow extends StoredSignalLike {
  signalType: string
  signalCategory: string
  summary: string
  sourceUrl: string | null
}

// UNDERSTANDING (2026-09-24 restructure) — Intent Source, Engagement and
// Qualification, side by side, for one company.
//
// The one deliberate exception to engagement.routes.ts's own stated rule ("no
// score, no ranking, no qualification verdict"): the CEO's new workflow asks
// for these three factors combined into one view. This stays inside that
// rule's SPIRIT rather than breaking it — nothing here is combined into a
// single number, each keeps its own evidence, and the values Task #984/#985's
// own locked screens withhold stay withheld here too:
//
//   - the engagement score is read as its LEVEL (LOW/MEDIUM/HIGH), never the
//     raw normalizedScore — the same thing IntentScoring.tsx itself withholds.
//   - the qualification's `reason` field is NEVER returned: it is a full
//     sentence that states the raw score and threshold inline (e.g. "The
//     current intent score of 100 meets the configured threshold of 70"), so
//     returning it would leak exactly the number the lock exists to hold
//     back. Only `status` is returned.

export interface IntentScoreRow {
  level: string
  policyStatus: string
}

export interface QualificationRow {
  status: string
}

export interface UnderstandingSignal {
  id: string
  signalType: string
  signalCategory: string
  summary: string
  sourceUrl: string | null
  detectedAt: Date
}

export interface Understanding {
  crmCompanyId: string
  intentSource: {
    count: number
    byCategory: Record<string, number>
    signals: UnderstandingSignal[]
  }
  engagement: { level: string; policyStatus: string } | null
  qualification: { status: string } | null
  disclaimers: string[]
}

export function buildUnderstanding(
  crmCompanyId: string,
  signalRows: UnderstandingSignalRow[],
  score: IntentScoreRow | null,
  qualification: QualificationRow | null,
): Understanding {
  const signals = presentSignals(signalRows).filter((s) => s.status === 'active')
  const byCategory: Record<string, number> = {}
  signals.forEach((s) => {
    byCategory[s.signalCategory] = (byCategory[s.signalCategory] ?? 0) + 1
  })

  return {
    crmCompanyId,
    intentSource: {
      count: signals.length,
      byCategory,
      signals: signals.slice(0, 5).map((s) => ({
        id: s.id,
        signalType: s.signalType,
        signalCategory: s.signalCategory,
        summary: s.summary,
        sourceUrl: s.sourceUrl,
        detectedAt: s.detectedAt,
      })),
    },
    engagement: score ? { level: score.level, policyStatus: score.policyStatus } : null,
    qualification: qualification ? { status: qualification.status } : null,
    disclaimers: [
      'Intent Source, Engagement and Qualification are shown side by side, not combined into one number. Each keeps its own evidence.',
      score
        ? 'The engagement level uses a provisional, business-unapproved calculation (Task #984). Shown as a level, not a score, for that reason.'
        : 'No engagement score has been calculated for this company yet.',
      qualification
        ? 'Qualification uses a provisional, business-unapproved threshold (Task #985). Shown as a status only.'
        : 'No qualification has been evaluated for this company yet.',
    ],
  }
}
