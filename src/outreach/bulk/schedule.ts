// WHEN EACH BULK EMAIL GOES (2026-10-08). Pure. Indian Standard Time only.
//
// Sales chooses a date, a time and the minutes between emails — nothing
// else. Email 1 goes at the start time, then one every `interval` minutes,
// one after another, until the list is done:
//
//   10:00 AM → email 1, 10:05 AM → email 2, 10:10 AM → email 3, …
//
// IST is UTC+05:30 all year (India has no daylight saving).

export const IST = 'Asia/Kolkata'
const IST_OFFSET_MS = 330 * 60_000

/** "2026-10-10" + "10:00" in IST → the UTC instant. */
export function istToUtc(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  const t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim())
  if (!d || !t) return null
  const at = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])) - IST_OFFSET_MS)
  return Number.isNaN(at.getTime()) ? null : at
}

/** "Sat, Oct 10, 2026, 10:05 AM IST". */
export function fmtIst(at: Date): string {
  return `${new Intl.DateTimeFormat('en-US', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(at)} IST`
}

/** Each email's time: the start, then every `intervalMinutes` after it. */
export function planSequential(start: Date, count: number, intervalMinutes: number): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * intervalMinutes * 60_000))
}
