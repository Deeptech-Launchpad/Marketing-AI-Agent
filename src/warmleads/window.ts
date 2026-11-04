// THE PROCESSING WINDOW (default 23:00-06:00 Asia/Kolkata, configurable by an admin).
//
// Pure functions, no clock of their own: the caller passes `now`.
//
// A window that crosses midnight (23:00-06:00) is ONE night. Its daily limits
// belong to the day the window STARTED, so 01:00 on the 5th still spends the 4th's
// allowance - the limit does not reset at midnight in the middle of a night.
// start === end means "always open" (a 24-hour window); then the calendar date is the day.

export interface WindowConfig {
  /** "HH:MM", 24-hour, in `timezone`. */
  start: string
  end: string
  /** An IANA zone name, e.g. Asia/Kolkata. */
  timezone: string
}

export const DEFAULT_WINDOW: WindowConfig = { start: '23:00', end: '06:00', timezone: 'Asia/Kolkata' }

/** "HH:MM" -> minutes after midnight, or null when it is not a valid 24-hour time. */
export function parseClock(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

function zoneParts(now: Date, timezone: string): { minutes: number; year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  return { minutes: n('hour') * 60 + n('minute'), year: n('year'), month: n('month'), day: n('day') }
}

/** Why a window setting is not acceptable, or null. */
export function windowProblem(w: WindowConfig): string | null {
  if (parseClock(w.start) === null) return 'The start time must be HH:MM (24-hour), for example 23:00.'
  if (parseClock(w.end) === null) return 'The end time must be HH:MM (24-hour), for example 06:00.'
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: w.timezone })
  } catch {
    return `"${w.timezone}" is not a time zone name (for example Asia/Kolkata).`
  }
  return null
}

/** Whether `now` is inside the window. An invalid window is never open. */
export function windowOpen(now: Date, w: WindowConfig): boolean {
  if (windowProblem(w)) return false
  const start = parseClock(w.start)!
  const end = parseClock(w.end)!
  if (start === end) return true
  const { minutes } = zoneParts(now, w.timezone)
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Why the window cannot be changed right now, or null. The night's allowance is keyed by the window (bucketDay), so a window
 * saved in the middle of a night could start a second allowance; changes wait until tonight's processing is over.
 */
export function windowChangeProblem(now: Date, current: WindowConfig, usedTonight: { companiesStarted: number; geminiCalls: number } | null): string | null {
  if (!windowOpen(now, current)) return null
  if (!usedTonight || (usedTonight.companiesStarted === 0 && usedTonight.geminiCalls === 0)) return null
  return "Tonight's processing has already started. Change the window after it ends, so the night's limits are not counted twice."
}

/** The usage bucket of the night `now` belongs to: "day:YYYY-MM-DD" (the date the window started, in the window's zone). */
export function bucketDay(now: Date, w: WindowConfig): string {
  const { minutes, year, month, day } = zoneParts(now, w.timezone)
  const start = parseClock(w.start) ?? 0
  const end = parseClock(w.end) ?? 0
  let d = new Date(Date.UTC(year, month - 1, day))
  if (start > end && minutes < end) d = new Date(d.getTime() - 86_400_000)
  return `day:${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
