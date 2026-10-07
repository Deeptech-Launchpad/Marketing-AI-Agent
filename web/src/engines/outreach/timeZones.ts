// THE TIME ZONES A BATCH CAN SEND IN.
//
// The field used to be free text, so it could be left empty or mistyped and
// the batch was refused with '"" is not a time zone' (2026-10-07). It is now a
// list of real time zone names — the ones the server accepts — with the most
// used first, each shown with its current offset from UTC.

/** Shown at the top of the list, in this order. */
const COMMON = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Malta',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Africa/Johannesburg',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Perth',
  'Pacific/Auckland',
  'UTC',
]

/** "UTC−04:00", or "" when the browser cannot say. */
function offsetOf(zone: string, at: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value
    if (!part) return ''
    return part === 'GMT' ? 'UTC+00:00' : part.replace('GMT', 'UTC').replace('-', '−')
  } catch {
    return ''
  }
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export interface TimeZoneOption {
  value: string
  label: string
}

/** Common zones first, then every other zone the browser knows, A–Z. */
export function timeZoneOptions(at: Date = new Date(), pinned: string[] = []): { common: TimeZoneOption[]; others: TimeZoneOption[] } {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  const label = (z: string) => {
    const off = offsetOf(z, at)
    return `${z.replace(/_/g, ' ')}${off ? ` (${off})` : ''}`
  }
  // `pinned` goes first (Bulk email pins Indianapolis); the list is otherwise unchanged.
  const common = [...new Set([...pinned, ...COMMON])].filter(isZone)
  const others = supported.filter((z) => !common.includes(z) && isZone(z)).sort()
  return {
    common: common.map((value) => ({ value, label: label(value) })),
    others: others.map((value) => ({ value, label: label(value) })),
  }
}
