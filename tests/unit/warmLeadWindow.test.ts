import { describe, expect, it } from 'vitest'
import { bucketDay, DEFAULT_WINDOW, parseClock, windowChangeProblem, windowOpen, windowProblem } from '../../src/warmleads/window.js'

// The default window is 23:00-06:00 Asia/Kolkata (UTC+5:30, no daylight saving).
const IST = DEFAULT_WINDOW
const at = (iso: string) => new Date(iso)

describe('the processing window (23:00-06:00 Asia/Kolkata)', () => {
  it('opens at 23:00 IST and closes at 06:00 IST', () => {
    expect(windowOpen(at('2026-11-03T17:29:59Z'), IST)).toBe(false) // 22:59:59 IST
    expect(windowOpen(at('2026-11-03T17:30:00Z'), IST)).toBe(true) // 23:00 IST
    expect(windowOpen(at('2026-11-03T18:30:00Z'), IST)).toBe(true) // 00:00 IST
    expect(windowOpen(at('2026-11-03T20:00:00Z'), IST)).toBe(true) // 01:30 IST
    expect(windowOpen(at('2026-11-04T00:29:59Z'), IST)).toBe(true) // 05:59:59 IST
    expect(windowOpen(at('2026-11-04T00:30:00Z'), IST)).toBe(false) // 06:00 IST
    expect(windowOpen(at('2026-11-04T06:00:00Z'), IST)).toBe(false) // 11:30 IST
    expect(windowOpen(at('2026-11-04T12:00:00Z'), IST)).toBe(false) // 17:30 IST
  })

  it('an admin can change it: a same-day window, another zone, or always open', () => {
    const day = { start: '09:00', end: '17:00', timezone: 'Asia/Kolkata' }
    expect(windowOpen(at('2026-11-04T03:30:00Z'), day)).toBe(true) // 09:00 IST
    expect(windowOpen(at('2026-11-04T11:30:00Z'), day)).toBe(false) // 17:00 IST
    const utc = { start: '22:00', end: '02:00', timezone: 'UTC' }
    expect(windowOpen(at('2026-11-04T23:00:00Z'), utc)).toBe(true)
    expect(windowOpen(at('2026-11-04T03:00:00Z'), utc)).toBe(false)
    expect(windowOpen(at('2026-11-04T12:00:00Z'), { start: '00:00', end: '00:00', timezone: 'UTC' })).toBe(true)
  })

  it('an invalid window is never open, and says why', () => {
    expect(windowOpen(at('2026-11-04T00:00:00Z'), { start: '25:00', end: '06:00', timezone: 'Asia/Kolkata' })).toBe(false)
    expect(windowOpen(at('2026-11-04T00:00:00Z'), { start: '23:00', end: '06:00', timezone: 'Mars/Phobos' })).toBe(false)
    expect(windowProblem({ start: '7pm', end: '06:00', timezone: 'Asia/Kolkata' })).toMatch(/HH:MM/)
    expect(windowProblem({ start: '23:00', end: '06:00', timezone: 'Mars/Phobos' })).toMatch(/time zone/)
    expect(windowProblem(IST)).toBeNull()
    expect(parseClock('23:59')).toBe(1439)
    expect(parseClock('24:00')).toBeNull()
  })
})

describe('which night a moment belongs to', () => {
  it('23:00 and 05:59 are the same night: the limits do not reset at midnight', () => {
    expect(bucketDay(at('2026-11-03T17:30:00Z'), IST)).toBe('day:2026-11-03') // 23:00 IST on the 3rd
    expect(bucketDay(at('2026-11-03T18:29:59Z'), IST)).toBe('day:2026-11-03') // 23:59:59 IST
    expect(bucketDay(at('2026-11-03T18:30:00Z'), IST)).toBe('day:2026-11-03') // 00:00 IST on the 4th: still the night of the 3rd
    expect(bucketDay(at('2026-11-04T00:29:59Z'), IST)).toBe('day:2026-11-03') // 05:59:59 IST on the 4th
    expect(bucketDay(at('2026-11-04T17:30:00Z'), IST)).toBe('day:2026-11-04') // the next night starts
  })
  it('a same-day or always-open window uses the calendar date', () => {
    expect(bucketDay(at('2026-11-04T05:00:00Z'), { start: '09:00', end: '17:00', timezone: 'Asia/Kolkata' })).toBe('day:2026-11-04')
    expect(bucketDay(at('2026-11-04T20:00:00Z'), { start: '00:00', end: '00:00', timezone: 'Asia/Kolkata' })).toBe('day:2026-11-05') // 01:30 IST on the 5th
  })
  it('month and year boundaries', () => {
    expect(bucketDay(at('2026-12-31T18:50:00Z'), IST)).toBe('day:2026-12-31') // 00:20 IST on 1 Jan 2027 belongs to the night of 31 Dec
    expect(bucketDay(at('2026-12-31T17:40:00Z'), IST)).toBe('day:2026-12-31')
  })
})

// A window saved in the middle of a night would key tonight's allowance by a different date and start a second one.
describe('changing the window mid-night', () => {
  const night = at('2026-11-04T20:00:00Z') // 01:30 IST, inside the default window
  const day = at('2026-11-04T12:00:00Z') // 17:30 IST, outside it

  it('is refused while tonight has already used companies or Gemini calls', () => {
    expect(windowChangeProblem(night, IST, { companiesStarted: 3, geminiCalls: 0 })).toMatch(/already started/)
    expect(windowChangeProblem(night, IST, { companiesStarted: 0, geminiCalls: 12 })).toMatch(/already started/)
  })

  it('is allowed before anything ran tonight, and at any time outside the window', () => {
    expect(windowChangeProblem(night, IST, null)).toBeNull()
    expect(windowChangeProblem(night, IST, { companiesStarted: 0, geminiCalls: 0 })).toBeNull()
    expect(windowChangeProblem(day, IST, { companiesStarted: 25, geminiCalls: 300 })).toBeNull()
  })
})
