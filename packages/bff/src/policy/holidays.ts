// The holidays `CP-HOURS-AR` closes on (docs/design-brief.md §5.7): Argentina's national holidays,
// data of `Reference/REF#HOLIDAY#AR` (docs/seed-spec.md §12). The caller hands over either the dates
// or a calendar already built by services/holidays.ts; the engine only ever asks `has(date)`.
import { z } from "zod";
import { CalendarDate } from "@legajo/shared";
import { type HolidayCalendar, holidayCalendar } from "../services/holidays";

function isHolidayCalendar(value: unknown): value is HolidayCalendar {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HolidayCalendar>;
  return typeof candidate.has === "function" && typeof candidate.dates === "function";
}

export const PolicyHolidays = z.union([z.array(CalendarDate), z.custom<HolidayCalendar>(isHolidayCalendar, "expected holiday dates or a holiday calendar")]);
export type PolicyHolidays = z.infer<typeof PolicyHolidays>;

/** The calendar of Argentina the hours rules read. */
export function argentinaHolidays(holidays: PolicyHolidays): HolidayCalendar {
  return Array.isArray(holidays) ? holidayCalendar("AR", holidays) : holidays;
}
