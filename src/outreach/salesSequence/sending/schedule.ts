import { addLocalDays, startOfLocalDay } from '../businessDays.js'

// WHEN A TEST EMAIL MAY GO (2026-09-28).
//
// A batch sets only the things the PDF leaves open: when the first emails go,
// the spacing between companies, the days and hours the sender works, and a
// daily cap. The sequence's own timing — Day 9–10, 12–14, 16–18, 18–20, "within
// one business day" — is the stage machine's and is never changed here: a
// follow-up is only ever placed INSIDE its PDF window, or not at all.
// Pure: no database, no clock of its own.

export interface SendWindow {
  tz: string
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  days: number[]
  /** Minutes after local midnight. */
  startMinute: number
  endMinute: number
}

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as const

export function isoWeekday(at: Date, tz: string): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at) as keyof typeof WEEKDAY
  return WEEKDAY[w]
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

/** The planned time of each company's initial email: in order, spaced, inside the window. */
export function plannedInitialSlots(firstSendAt: Date, count: number, spacingMinutes: number, w: SendWindow): Array<Date | null> {
  const out: Array<Date | null> = []
  let t: Date | null = firstSendAt
  for (let i = 0; i < count; i++) {
    const slot: Date | null = t ? nextSendSlot(t, w) : null
    out.push(slot)
    t = slot ? new Date(slot.getTime() + spacingMinutes * 60_000) : null
  }
  return out
}

/**
 * When an approved follow-up goes: inside its PDF window, offset by the
 * company's place in the batch so the batch's emails do not leave together.
 * Null when no slot is left in the window — it is then not sent automatically.
 */
export function followUpSlot(input: {
  window: { start: Date; end: Date }
  index: number
  spacingMinutes: number
  w: SendWindow
  now: Date
}): Date | null {
  const base = Math.max(input.now.getTime(), input.window.start.getTime()) + input.index * input.spacingMinutes * 60_000
  const slot = nextSendSlot(new Date(base), input.w)
  return slot && slot.getTime() <= input.window.end.getTime() ? slot : null
}

/** "09:00" → 540. */
export function parseClock(hhmm: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
