// The ETA filter of the scope bar: an operation is in range when the calendar date of its ETA in
// Argentina (the firm's zone) falls between the two ends, both included; an open end is unbounded.
import { AR_TIME_ZONE, wallClockOf } from "./format";

export interface EtaRangeBounds {
  readonly from?: string;
  readonly to?: string;
}

/** `2026-10-22T08:00:00-03:00` → `2026-10-22` in the zone. */
export function calendarDateOf(instant: string | Date, timeZone: string = AR_TIME_ZONE): string {
  const wall = wallClockOf(instant, timeZone);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

export function etaInRange(eta: string, range: EtaRangeBounds, timeZone: string = AR_TIME_ZONE): boolean {
  const date = calendarDateOf(eta, timeZone);
  if (range.from !== undefined && date < range.from) return false;
  if (range.to !== undefined && date > range.to) return false;
  return true;
}
