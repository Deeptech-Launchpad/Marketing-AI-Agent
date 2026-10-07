// BULK EMAIL'S OWN CLOCK (2026-10-07). Pure.
//
// Bulk Email is a standalone workflow: it shares no code with the One company
// or Several companies flows. These are its own local-day and sending-window
// helpers — "8:00 AM in Indianapolis" means 8:00 AM in Indianapolis, and a day
// is a calendar day in the chosen time zone, across daylight-saving changes.

const DAY_MS = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface SendWindow {
  tz: string
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  days: number[]
  /** Minutes after local midnight. */
  startMinute: number
  endMinute: number
}

function parts(at: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
  }).formatToParts(at)
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    hh: Number(get('hour')),
    mm: Number(get('minute')),
    ss: Number(get('second')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  }
}

/** The zone's offset from UTC at an instant, in ms (positive east of UTC). */
export function offsetAt(at: Date, tz: string): number {
  const p = parts(at, tz)
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(at.getTime() / 1000) * 1000
}

/** Midnight at the start of the local calendar day containing `at`. */
export function startOfLocalDay(at: Date, tz: string): Date {
  const p = parts(at, tz)
  const guess = new Date(Date.UTC(p.y, p.m - 1, p.d))
  const first = new Date(guess.getTime() - offsetAt(guess, tz))
  return new Date(guess.getTime() - offsetAt(first, tz))
}

/** The start of the local day `n` calendar days after `dayStart`. DST-safe. */
export function addLocalDays(dayStart: Date, n: number, tz: string): Date {
  return startOfLocalDay(new Date(dayStart.getTime() + n * DAY_MS + 12 * 3_600_000), tz)
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(at: Date, tz: string): number {
  const w = parts(at, tz).weekday
  return w === 0 ? 7 : w
}

export function minuteOfDay(at: Date, tz: string): number {
  return Math.floor((at.getTime() - startOfLocalDay(at, tz).getTime()) / 60_000)
}

export function withinWindow(at: Date, w: SendWindow): boolean {
  const m = minuteOfDay(at, w.tz)
  return w.days.includes(isoWeekday(at, w.tz)) && m >= w.startMinute && m < w.endMinute
}

/** The earliest instant at or after `from` inside the sending window, or null within `maxDays`. */
export function nextSendSlot(from: Date, w: SendWindow, maxDays = 60): Date | null {
  const day0 = startOfLocalDay(from, w.tz)
  for (let i = 0; i <= maxDays; i++) {
    const day = i === 0 ? day0 : addLocalDays(day0, i, w.tz)
    // Midday names the weekday safely across a DST change.
    if (!w.days.includes(isoWeekday(new Date(day.getTime() + 12 * 3_600_000), w.tz))) continue
    const open = new Date(day.getTime() + w.startMinute * 60_000)
    const close = new Date(day.getTime() + w.endMinute * 60_000)
    const candidate = from.getTime() > open.getTime() ? from : open
    if (candidate.getTime() < close.getTime()) return candidate
  }
  return null
}

/** "08:00" → 480. */
export function parseClock(hhmm: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
