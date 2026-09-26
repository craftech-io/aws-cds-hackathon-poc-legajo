// Business hours by IANA zone (docs/design-brief.md §5.7): `CP-HOURS-AR` (Monday to Friday
// 09:00-18:00 in Buenos Aires, without national holidays) and `CP-HOURS-SUPPLIER` (the same hours in
// the supplier's zone, with its daylight saving time, without holidays). Milestones and deadlines
// ("ETA − 7 days at 10:00 AR", "ETA − 4 days at 17:00 in the supplier's zone") use the same
// wall-clock helpers. Every function takes the instant it evaluates; none reads a clock.
//
// Zone offsets come from the runtime's time zone database (`Intl.DateTimeFormat`, full ICU in Node
// 22 and Lambda); no formatting depends on the locale: texts are built by the callers from parts.
import { z } from "zod";
import { CalendarDate, Weekday, addCalendarDays, weekdayOf } from "@legajo/shared";
import { type HolidayCalendar, NO_HOLIDAYS } from "./holidays";

export const ARGENTINA_TIME_ZONE = "America/Argentina/Buenos_Aires";

/** `HH:mm`, 24 h. */
export const LocalTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/, "expected HH:mm");
export type LocalTime = z.infer<typeof LocalTime>;

export const MONDAY_TO_FRIDAY: readonly Weekday[] = ["MON", "TUE", "WED", "THU", "FRI"];
export const DEFAULT_OPEN: LocalTime = "09:00";
export const DEFAULT_CLOSE: LocalTime = "18:00";

export interface BusinessHours {
  readonly timeZone: string;
  readonly days: readonly Weekday[];
  /** Inclusive. */
  readonly open: LocalTime;
  /** Exclusive: at 18:00 sharp the window is closed. */
  readonly close: LocalTime;
  /** Local dates of `timeZone` that are closed all day. */
  readonly holidays: HolidayCalendar;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** An IANA zone the runtime knows (`Asia/Shanghai`, `Europe/Berlin`, …). */
export const TimeZone = z.string().refine(isValidTimeZone, "expected an IANA time zone");

export interface ZonedParts {
  readonly date: CalendarDate;
  /** `HH:mm`. */
  readonly time: LocalTime;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: Weekday;
  /** Local time minus UTC, in minutes (−180 in Buenos Aires, +480 in Shanghai, +330 in Kolkata). */
  readonly offsetMinutes: number;
}

function pad(value: number, width = 2): string {
  return value.toString().padStart(width, "0");
}

function validInstant(instant: Date): number {
  const ms = instant.getTime();
  if (Number.isNaN(ms)) throw new RangeError("invalid instant");
  return ms;
}

/** Wall clock of `instant` in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const ms = validInstant(instant);
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const year = values.year ?? 0;
  const month = values.month ?? 1;
  const day = values.day ?? 1;
  const hour = (values.hour ?? 0) % 24;
  const minute = values.minute ?? 0;
  const second = values.second ?? 0;
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  const offsetMinutes = Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / 1000) * 1000) / 60_000);
  return { date, time: `${pad(hour)}:${pad(minute)}`, hour, minute, second, weekday: weekdayOf(date), offsetMinutes };
}

/** Local calendar date of `instant` in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): CalendarDate {
  return zonedParts(instant, timeZone).date;
}

/**
 * The instant a wall clock shows `date time` in `timeZone`. A time skipped by a spring-forward
 * change lands after the gap (02:30 → 03:30); a repeated time takes the second occurrence.
 */
export function zonedInstant(date: CalendarDate, time: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = CalendarDate.parse(date).split("-").map(Number);
  const [hour = 0, minute = 0] = LocalTime.parse(time).split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAtWall = zonedParts(new Date(wall), timeZone).offsetMinutes;
  let guess = wall - offsetAtWall * 60_000;
  const offsetAtGuess = zonedParts(new Date(guess), timeZone).offsetMinutes;
  if (offsetAtGuess !== offsetAtWall) guess = wall - offsetAtGuess * 60_000;
  return new Date(guess);
}

/** `2026-10-16T09:00:00+08:00`: ISO 8601 with the zone's offset, as tools return business dates. */
export function toZonedIso(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  const sign = parts.offsetMinutes < 0 ? "-" : "+";
  const offset = Math.abs(parts.offsetMinutes);
  return `${parts.date}T${parts.time}:${pad(parts.second)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

/** `dayOffset` local days from `instant`'s local date, at `time` in `timeZone` (milestones, deadlines). */
export function atLocalTime(instant: Date, dayOffset: number, time: string, timeZone: string): Date {
  if (!Number.isInteger(dayOffset)) throw new RangeError(`dayOffset must be an integer, got ${dayOffset}`);
  return zonedInstant(addCalendarDays(localDateOf(instant, timeZone), dayOffset), time, timeZone);
}

function minutesOf(time: LocalTime): number {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export interface BusinessHoursOptions {
  readonly holidays?: HolidayCalendar;
  readonly days?: readonly Weekday[];
  readonly open?: string;
  readonly close?: string;
}

export function businessHours(timeZone: string, options: BusinessHoursOptions = {}): BusinessHours {
  const open = LocalTime.parse(options.open ?? DEFAULT_OPEN);
  const close = LocalTime.parse(options.close ?? DEFAULT_CLOSE);
  if (minutesOf(open) >= minutesOf(close)) throw new RangeError(`business hours must open before they close (${open}-${close})`);
  const days = z.array(Weekday).min(1).parse(options.days ?? MONDAY_TO_FRIDAY);
  return { timeZone: TimeZone.parse(timeZone), days, open, close, holidays: options.holidays ?? NO_HOLIDAYS };
}

/** `CP-HOURS-AR`: Monday to Friday 09:00-18:00 in Buenos Aires, closed on national holidays. */
export function argentinaBusinessHours(holidays: HolidayCalendar): BusinessHours {
  return businessHours(ARGENTINA_TIME_ZONE, { holidays });
}

/** `CP-HOURS-SUPPLIER`: Monday to Friday 09:00-18:00 in the supplier's zone, no holidays. */
export function supplierBusinessHours(timeZone: string): BusinessHours {
  return businessHours(timeZone);
}

/** A weekday of the schedule that is not a holiday. */
export function isBusinessDate(date: CalendarDate, hours: BusinessHours): boolean {
  return hours.days.includes(weekdayOf(date)) && !hours.holidays.has(date);
}

export function isBusinessOpen(instant: Date, hours: BusinessHours): boolean {
  const parts = zonedParts(instant, hours.timeZone);
  if (!isBusinessDate(parts.date, hours)) return false;
  const minutes = parts.hour * 60 + parts.minute + parts.second / 60;
  return minutes >= minutesOf(hours.open) && minutes < minutesOf(hours.close);
}

// A year covers any run of weekends and holidays; past it the schedule is broken, not closed.
const MAX_SEARCH_DAYS = 366;

/** `instant` itself when the window is open, otherwise the next opening (`nextAllowedAt` of a DEFER). */
export function nextBusinessOpening(instant: Date, hours: BusinessHours): Date {
  const ms = validInstant(instant);
  if (isBusinessOpen(instant, hours)) return new Date(ms);
  const today = localDateOf(instant, hours.timeZone);
  for (let day = 0; day <= MAX_SEARCH_DAYS; day += 1) {
    const date = addCalendarDays(today, day);
    if (!isBusinessDate(date, hours)) continue;
    const opening = zonedInstant(date, hours.open, hours.timeZone);
    if (opening.getTime() > ms) return opening;
  }
  throw new RangeError(`no business day within ${MAX_SEARCH_DAYS} days in ${hours.timeZone}`);
}
