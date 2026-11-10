import type { CompanyRow, Filter } from './types'

type Tone = 'accent' | 'info' | 'neutral' | 'danger' | 'warn' | 'ok'

export const CLASS: Record<string, { label: string; tone: Tone }> = {
  warm: { label: 'Warm', tone: 'accent' },
  cold: { label: 'Cold', tone: 'info' },
  early_signal: { label: 'Early signal — needs review', tone: 'warn' },
  insufficient_data: { label: 'Not enough data', tone: 'neutral' },
  existing_customer: { label: 'Existing customer', tone: 'ok' },
  active_opportunity: { label: 'Active opportunity', tone: 'info' },
  do_not_contact: { label: 'Do not contact', tone: 'danger' },
  human_review: { label: 'Human review required — a reply refused', tone: 'warn' },
}

export const DEEP: Record<string, string> = {
  done: 'Web research done',
  not_needed: 'Screened only — web research not needed',
  skipped_cap: 'Web research not done (limit reached)',
  skipped_ceiling: 'Web research incomplete (Gemini call limit)',
  failed: 'Web research failed',
}

export const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All companies' },
  { value: 'warm', label: 'Warm' },
  { value: 'early_signal', label: 'Early signal' },
  { value: 'cold', label: 'Cold' },
  { value: 'insufficient_data', label: 'Not enough data' },
  { value: 'research_incomplete', label: 'Research incomplete' },
  { value: 'failed', label: 'Failed' },
  { value: 'needs_reevaluation', label: 'Needs re-check' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'existing_customer', label: 'Existing customer' },
  { value: 'active_opportunity', label: 'Active opportunity' },
  { value: 'do_not_contact', label: 'Do not contact' },
  { value: 'human_review', label: 'Human review required' },
]

/** The one status a company row shows. Incomplete research and "not enough data" are never merged, and neither is ever called Cold. */
export function statusOf(c: Pick<CompanyRow, 'state' | 'classification' | 'researchIncomplete'> & { nextAttemptAt?: string | null }): { label: string; tone: Tone } {
  if (c.state === 'running') return { label: 'Evaluating now', tone: 'warn' }
  if (c.state === 'queued') return { label: 'Queued (pilot)', tone: 'warn' }
  if (c.state === 'pending') return { label: 'Pending', tone: 'neutral' }
  // After the automatic attempts are used up nothing retries it by itself: an admin presses "Retry failed".
  if (c.state === 'failed') return { label: c.nextAttemptAt === undefined || c.nextAttemptAt ? 'Failed — will retry' : 'Failed — use Retry failed', tone: 'danger' }
  if (c.researchIncomplete && !c.classification) return { label: 'Research incomplete', tone: 'warn' }
  const cls = c.classification ? CLASS[c.classification] : null
  const base = cls ?? { label: 'Evaluated', tone: 'neutral' as Tone }
  if (c.state === 'needs_reevaluation') return { label: `${base.label} · re-check due`, tone: base.tone }
  return base
}

export const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—')
export const num = (n: number) => n.toLocaleString()

export const STOPPED: Record<string, string> = {
  company_limit: 'the daily company limit was reached',
  gemini_ceiling: 'the Gemini call ceiling was reached',
  nothing_to_do: 'nothing was left to evaluate',
  repeated_failures: 'too many companies failed in a row, so it paused for 30 minutes before trying again',
  error: 'an error stopped it',
}

/** "day:2026-11-04" -> "Night of 4 Nov 2026" */
export function bucketLabel(bucket: string): string {
  if (bucket === 'pilot') return 'Pilot'
  const m = /^day:(\d{4})-(\d{2})-(\d{2})$/.exec(bucket)
  if (!m) return bucket
  return `Night of ${new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
}
