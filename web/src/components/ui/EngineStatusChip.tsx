import { Chip } from './primitives'

// ─────────────────────────────────────────────────────────────────────────
// The seven words an engine run's state is said in.
//
//   NOT RUN · QUEUED · RUNNING · COMPLETED · PARTIAL · BLOCKED · FAILED
//
// Wherever a run is shown, its state is shown in one of these, so a reader
// learns the vocabulary once. The mapping is deliberately narrow: `toUiStatus`
// in primitives folds "queued" into "running", and on this platform that is
// the one distinction that matters most — every run answers 202 and is worked
// by a separate process (src/worker.ts), so a row that stays QUEUED means the
// worker is not consuming, and drawing it as RUNNING would hide exactly that.
// ─────────────────────────────────────────────────────────────────────────

export type EngineStatusWord = 'NOT RUN' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED'

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info'

/**
 * The word and the tint for a backend status.
 *
 * A status the vocabulary has no word for — "cancelled", say — is shown as the
 * backend spelt it rather than forced into the nearest word: FAILED would be a
 * claim the run never made.
 */
export function engineStatus(raw: string | null | undefined): { word: string; tone: Tone; known: boolean } {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return { word: 'NOT RUN', tone: 'neutral', known: true }
  if (s === 'queued' || s === 'pending' || s === 'scheduled') return { word: 'QUEUED', tone: 'warn', known: true }
  if (/^(running|in_progress|crawling|fetching|processing)$/.test(s)) return { word: 'RUNNING', tone: 'info', known: true }
  if (s === 'partial') return { word: 'PARTIAL', tone: 'warn', known: true }
  if (/^(completed|complete|succeeded|success|ready|approved)$/.test(s)) return { word: 'COMPLETED', tone: 'ok', known: true }
  if (/^(blocked|no_product_page|not_configured|unavailable|skipped|suppressed)$/.test(s)) {
    return { word: 'BLOCKED', tone: 'warn', known: true }
  }
  if (/^(failed|error|errored|rejected)$/.test(s)) return { word: 'FAILED', tone: 'danger', known: true }
  return { word: s.replace(/_/g, ' ').toUpperCase(), tone: 'neutral', known: false }
}

export function EngineStatusChip({
  status,
  title,
}: {
  status: string | null | undefined
  /** What the reader should know beside the word — "waiting for the worker", say. */
  title?: string
}) {
  const { word, tone } = engineStatus(status)
  return (
    <Chip tone={tone} title={title ?? (status ? `Status "${status}"` : 'No run recorded')}>
      {word}
    </Chip>
  )
}
