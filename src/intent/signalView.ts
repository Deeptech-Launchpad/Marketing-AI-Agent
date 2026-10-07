import { scoreFreshness, signalStatus } from './confidence.js'
import { isJobSignal } from './jobSignals.js'
import type { Confidence } from './types.js'

// HOW A STORED SIGNAL IS READ BACK.
//
// Two things about a stored row are not true for ever, and both used to be
// frozen at the moment the row was written:
//
//   1. AGE. `ageDays`, `freshness` and the `status` derived from them were
//      computed once, at detection. A job posting seen when it was 3 days old
//      still read "fresh · active" two months later, because nothing ever
//      recomputed it. They are derived here from the source's own date and the
//      clock at READ time, so every consumer sees the signal as it is today.
//
//   2. COPIES. Before the engine refreshed an already-recorded event in place,
//      every run inserted the same event again. Those rows are kept — deleting
//      evidence is not a read-path decision — but a reader is shown ONE row per
//      event fingerprint: the most recently seen one, with the number of stored
//      copies stated rather than silently summed into a total.
//
// Pure functions: no database, no network. The routes and any other reader of
// intent signals apply the same rule.

export interface StoredSignalLike {
  id: string
  eventFingerprint: string
  crmCompanyId: string
  observedAt: Date | null
  detectedAt: Date
  confidence: string
  status: string
  ageDays?: number | null
  freshness?: string
  metadata?: unknown
  signalType?: string | null
  signalCategory?: string | null
}

function metaOf(row: { metadata?: unknown }): Record<string, unknown> {
  const m = row.metadata
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {}
}

/** True when a later observation withdrew this signal (see applySupersessions). */
export function isSuperseded(row: { metadata?: unknown }): boolean {
  return Boolean(metaOf(row).supersededBy)
}

/** When the engine last observed this event: the refresh stamp, else first detection. */
export function lastSeenAt(row: { detectedAt: Date; metadata?: unknown }): Date {
  const raw = metaOf(row).lastSeenAt
  if (typeof raw === 'string') {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) return d
  }
  return row.detectedAt
}

/**
 * Age, freshness and status as of `now`.
 *
 * A signal a later run WITHDREW stays expired whatever its age says. Otherwise
 * the status is recomputed from the stored confidence and the live freshness,
 * so a signal that has aged past the stale threshold stops reading "active".
 */
export function presentSignal<T extends StoredSignalLike>(
  row: T,
  now: Date = new Date(),
): T & { ageDays: number | null; freshness: string; status: string } {
  const { freshness, ageDays } = scoreFreshness(row.observedAt ? new Date(row.observedAt) : null, now)
  const confidence = (['high', 'medium', 'low'].includes(row.confidence) ? row.confidence : 'low') as Confidence
  const status = isSuperseded(row) ? 'expired' : signalStatus(confidence, freshness)
  return { ...row, ageDays, freshness, status }
}

/**
 * One row per event fingerprint, newest-seen first, with `storedCopies`.
 *
 * Ordering within an event: a withdrawn copy never outranks a standing one of
 * the same event, then the most recently seen wins.
 */
export function latestPerFingerprint<T extends StoredSignalLike>(rows: T[]): Array<T & { storedCopies: number }> {
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const key = `${r.crmCompanyId}|${r.eventFingerprint}`
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }

  const out: Array<T & { storedCopies: number }> = []
  for (const g of groups.values()) {
    const best = [...g].sort((a, b) => {
      const sa = isSuperseded(a) ? 1 : 0
      const sb = isSuperseded(b) ? 1 : 0
      if (sa !== sb) return sa - sb
      return lastSeenAt(b).getTime() - lastSeenAt(a).getTime()
    })[0]!
    out.push({ ...best, storedCopies: g.length })
  }

  return out.sort((a, b) => lastSeenAt(b).getTime() - lastSeenAt(a).getTime())
}

/** Deduplicate, then compute age and status at read time. */
/**
 * A signal that only said a social profile exists, or what its description
 * says. Not activity, so not a signal; earlier runs stored these.
 */
export function isProfileOnlySignal(s: { signalType?: string | null }): boolean {
  return Boolean(s.signalType && /^social_(presence|description)_/.test(s.signalType))
}

export function presentSignals<T extends StoredSignalLike>(
  rows: T[],
  now: Date = new Date(),
): Array<T & { storedCopies: number; ageDays: number | null; freshness: string; status: string }> {
  // Job postings are not intent signals: ones stored by earlier runs stay off
  // every screen and every consumer that reads through here (jobSignals.ts).
  // Nor is a social profile's existence or description (2026-10-07): ones
  // stored by earlier runs stay off the same way.
  return latestPerFingerprint(rows.filter((r) => !isJobSignal(r) && !isProfileOnlySignal(r))).map((r) => presentSignal(r, now))
}
