// National holidays that close business hours (`CP-HOURS-AR`, docs/design-brief.md §5.7). The
// calendar is data: `Reference/REF#HOLIDAY#AR` rows seeded from docs/seed-spec.md §12 and checked by
// `seed-generator` against the official calendar. Suppliers' countries have no calendar on purpose:
// `CP-HOURS-SUPPLIER` only follows their weekdays, hours and daylight saving time.
import { z } from "zod";
import { CalendarDate } from "@legajo/shared";
import { type Clock, systemClock } from "../lib/clock";

export const HolidayCountry = z.enum(["AR"]);
export type HolidayCountry = z.infer<typeof HolidayCountry>;

/** A `HOLIDAY` row as the connector returns it; extra attributes of the item are ignored. */
export const HolidayRow = z.object({
  date: CalendarDate,
  name: z.string().min(1).optional(),
  /** `false` until `seed-generator` checks the date against the official calendar. */
  verified: z.boolean().optional(),
});
export type HolidayRow = z.infer<typeof HolidayRow>;

/** Dates are local calendar dates of the country (Argentina: America/Argentina/Buenos_Aires). */
export interface HolidayCalendar {
  readonly country: HolidayCountry | "NONE";
  has(date: CalendarDate): boolean;
  dates(): readonly CalendarDate[];
}

export function holidayCalendar(country: HolidayCountry, rows: Iterable<HolidayRow | CalendarDate>): HolidayCalendar {
  const set = new Set<CalendarDate>();
  for (const row of rows) set.add(typeof row === "string" ? CalendarDate.parse(row) : HolidayRow.parse(row).date);
  const sorted = [...set].sort();
  return { country: HolidayCountry.parse(country), has: (date) => set.has(date), dates: () => sorted };
}

/** No holidays: the calendar of a supplier's zone. */
export const NO_HOLIDAYS: HolidayCalendar = { country: "NONE", has: () => false, dates: () => [] };

/** Reads the `HOLIDAY` rows of a country (the connector's `Reference` query). */
export type HolidayReader = (country: HolidayCountry) => Promise<readonly unknown[]>;

export interface HolidayProviderOptions {
  /** How long a loaded calendar is reused inside a warm container, in real milliseconds. */
  readonly ttlMs?: number;
  /** Real time for the cache (never the simulated clock of a world). */
  readonly realClock?: Clock;
}

export const HOLIDAY_CACHE_TTL_MS = 5 * 60_000;

/** A cached loader of calendars; rows are validated with zod (a bad row fails the load, never skips). */
export function createHolidayProvider(read: HolidayReader, options: HolidayProviderOptions = {}): (country: HolidayCountry) => Promise<HolidayCalendar> {
  const ttlMs = options.ttlMs ?? HOLIDAY_CACHE_TTL_MS;
  const realClock = options.realClock ?? systemClock;
  const cache = new Map<HolidayCountry, { calendar: HolidayCalendar; loadedAtMs: number }>();
  return async (country) => {
    const nowMs = (await realClock.now()).getTime();
    const hit = cache.get(country);
    if (hit !== undefined && nowMs - hit.loadedAtMs < ttlMs) return hit.calendar;
    const rows = z.array(HolidayRow).parse(await read(country));
    const calendar = holidayCalendar(country, rows);
    cache.set(country, { calendar, loadedAtMs: nowMs });
    return calendar;
  };
}
