import { addLocalDays, nextSendSlot, offsetAt, startOfLocalDay, type SendWindow } from './clock.js'

// WHEN EACH BULK EMAIL GOES (2026-10-07). Pure.
//
// One after another, `interval` minutes apart, only inside the sending hours
// and days of the chosen time zone, and never more than the daily limit in
// one local day — the rest continue in the next allowed period. 8:00 AM in
// Indianapolis is 8:00 AM in Indianapolis, whatever time zone the person
// scheduling it is in.

/** "2026-10-12" + "08:00" in `tz` → the UTC instant. */
export function localToUtc(date: string, time: string, tz: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  const t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim())
  if (!d || !t) return null
  const wanted = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]))
  // The offset at the guess, applied twice so a DST edge settles.
  let guess = wanted
  for (let i = 0; i < 2; i++) guess = wanted - offsetAt(new Date(guess), tz)
  return new Date(guess)
}

/** The local calendar day of `at` in `tz`, as "YYYY-MM-DD". */
export function localDay(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** "Mon 12 Oct 2026, 8:05 AM" in `tz`. */
export function fmtLocal(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(at)
}

/** Each email's time, in order. Null when no allowed time is left within the horizon. */
export function planBulkSlots(start: Date, count: number, intervalMinutes: number, w: SendWindow, dailyCap: number, maxDays = 365): Array<Date | null> {
  const out: Array<Date | null> = []
  const perDay = new Map<string, number>()
  let t: Date | null = start
  for (let i = 0; i < count; i++) {
    let slot: Date | null = t ? nextSendSlot(t, w, maxDays) : null
    // A day already at its limit: move to the start of the next local day.
    while (slot && (perDay.get(localDay(slot, w.tz)) ?? 0) >= dailyCap) {
      slot = nextSendSlot(addLocalDays(startOfLocalDay(slot, w.tz), 1, w.tz), w, maxDays)
    }
    out.push(slot)
    if (slot) perDay.set(localDay(slot, w.tz), (perDay.get(localDay(slot, w.tz)) ?? 0) + 1)
    t = slot ? new Date(slot.getTime() + intervalMinutes * 60_000) : null
  }
  return out
}
