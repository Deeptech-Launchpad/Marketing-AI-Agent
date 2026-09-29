import type { SendWindow } from './schedule.js'

/** A test batch's sending days and hours, as the pure schedule helpers take them. */
export function windowOfBatch(batch: { timezone: string; sendDays: unknown; sendStartMinute: number; sendEndMinute: number }): SendWindow {
  const days = Array.isArray(batch.sendDays) ? (batch.sendDays as unknown[]).map(Number).filter((d) => d >= 1 && d <= 7) : [1, 2, 3, 4, 5]
  return { tz: batch.timezone, days, startMinute: batch.sendStartMinute, endMinute: batch.sendEndMinute }
}
