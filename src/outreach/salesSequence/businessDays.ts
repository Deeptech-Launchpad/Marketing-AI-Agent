// DAYS AS THE SEQUENCE COUNTS THEM.
//
// "Day 9–10" and "within 1 business day" are days on a salesperson's calendar,
// not multiples of 24 hours from a timestamp. So every window here is built
// from local calendar days in one time zone (OUTREACH_SEQUENCE_TIMEZONE):
// a window opens at the start of its first day and closes at the end of its
// last. Business days are Monday to Friday; public holidays are not modelled,
// and the UI says "business day" rather than implying it knows the calendar.

const DAY_MS = 86_400_000

interface LocalParts {
  y: number
  m: number
  d: number
  weekday: number // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function localParts(at: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday: WEEKDAYS.indexOf(get('weekday')) }
}

/** The zone's offset from UTC at an instant, in ms (positive east of UTC). */
function offsetAt(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** Midnight at the start of the local calendar day containing `at`. */
export function startOfLocalDay(at: Date, tz: string): Date {
  const p = localParts(at, tz)
  const guess = new Date(Date.UTC(p.y, p.m - 1, p.d))
  // Midnight local = midnight UTC minus the offset in force at that moment.
  const first = new Date(guess.getTime() - offsetAt(guess, tz))
  return new Date(guess.getTime() - offsetAt(first, tz))
}

/** The start of the local day `n` calendar days after `dayStart`. DST-safe. */
export function addLocalDays(dayStart: Date, n: number, tz: string): Date {
  return startOfLocalDay(new Date(dayStart.getTime() + n * DAY_MS + 12 * 3_600_000), tz)
}

/** The last millisecond of the local day that starts at `dayStart`. */
export function endOfLocalDay(dayStart: Date, tz: string): Date {
  return new Date(addLocalDays(dayStart, 1, tz).getTime() - 1)
}

export function isBusinessDay(at: Date, tz: string): boolean {
  const w = localParts(at, tz).weekday
  return w >= 1 && w <= 5
}

/** The start of the `n`th business day after the day containing `at` (n ≥ 1). */
export function addBusinessDays(at: Date, n: number, tz: string): Date {
  let day = startOfLocalDay(at, tz)
  let left = n
  while (left > 0) {
    day = addLocalDays(day, 1, tz)
    if (isBusinessDay(day, tz)) left -= 1
  }
  return day
}

export interface Window {
  start: Date
  end: Date
}

/** "Day a–b" after day zero: from the start of day a to the end of day b. */
export function dayWindow(dayZero: Date, a: number, b: number, tz: string): Window {
  const d0 = startOfLocalDay(dayZero, tz)
  return { start: addLocalDays(d0, a, tz), end: endOfLocalDay(addLocalDays(d0, b, tz), tz) }
}

/**
 * "Same day or next business day" after something happened: from the start of
 * that day to the end of the next business day. A Friday reply is due by the
 * end of Monday; a Saturday reply too.
 */
export function sameOrNextBusinessDay(at: Date, tz: string): Window {
  return { start: startOfLocalDay(at, tz), end: endOfLocalDay(addBusinessDays(at, 1, tz), tz) }
}

/** "Within 1 business day" of something: the same shape as above. */
export const withinOneBusinessDay = sameOrNextBusinessDay

/** A calendar date (YYYY-MM-DD) as the start of that local day. */
export function localDateStart(isoDate: string, tz: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number)
  return startOfLocalDay(new Date(Date.UTC(y!, m! - 1, d!, 12)), tz)
}
