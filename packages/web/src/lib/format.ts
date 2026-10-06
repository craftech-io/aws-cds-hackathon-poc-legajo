// Display formatting of the console. Every business date it shows is simulated time of the world
// (ADR-0007), read in the zone that means something to the reader: Argentina for the firm and the
// importer, the supplier's own zone for a supplier deadline. Intl only supplies numeric parts and the
// words (weekdays, months, the order of day and month) come from copy, so the text does not depend on the
// browser's locale data. The console's language (lib/console-lang.ts) picks the wording and the number
// notation: es-AR (`14/10`, `12.480,5`) or English (`14 Oct`, `12,480.5`); the zone never changes.
import type { Language } from "@legajo/shared";
import { copy } from "../copy/console";
import { activeLang } from "./console-lang";

/** Zone of the firm, the importer and every "hora simulada" of the console. */
export const AR_TIME_ZONE = "America/Argentina/Buenos_Aires";

/** Wall-clock reading of an instant in a zone; `weekday` 0 = Sunday. */
export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timeZone, created);
  return created;
}

function toDate(instant: string | Date | number): Date {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new RangeError(`not an instant: ${String(instant)}`);
  return date;
}

export function wallClockOf(instant: string | Date | number, timeZone: string = AR_TIME_ZONE): WallClock {
  const parts = formatterOf(timeZone).formatToParts(toDate(instant));
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return {
    year,
    month,
    day,
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "10:30" */
export function formatTime(instant: string | Date | number, timeZone: string = AR_TIME_ZONE): string {
  const wall = wallClockOf(instant, timeZone);
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** "14/10" (Spanish), "14 Oct" (English). */
export function formatDayMonth(instant: string | Date | number, timeZone: string = AR_TIME_ZONE): string {
  const wall = wallClockOf(instant, timeZone);
  return copy.time.dayMonth(wall.day, wall.month);
}

/** "mié 14/10 10:30" / "Wed 14 Oct 10:30": the simulated hour as the shell and the timelines show it. */
export function formatSimDateTime(instant: string | Date | number, timeZone: string = AR_TIME_ZONE): string {
  const wall = wallClockOf(instant, timeZone);
  return `${copy.time.weekdays[wall.weekday] ?? ""} ${copy.time.dayMonth(wall.day, wall.month)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** "14/10/2026 10:30" / "14 Oct 2026 10:30" */
export function formatDateTime(instant: string | Date | number, timeZone: string = AR_TIME_ZONE): string {
  const wall = wallClockOf(instant, timeZone);
  return `${copy.time.dayMonthYear(wall.day, wall.month, wall.year)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** A number the document reader writes the way the exporter's documents print it: "12,840", "12,840.5". */
const READER_NUMBER = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s+([A-Za-z%]+))?$/;

/**
 * A value of a reader observation as the console shows it: a number (with its unit, if any) in the
 * notation of the console's language (es-AR: "12,840 kg" reads as twelve kilos in Argentina, so it
 * becomes "12.840 kg"); anything else ("not signed", a name) as the reader wrote it.
 */
export function formatReaderValue(raw: string): string {
  const match = READER_NUMBER.exec(raw.trim());
  if (!match) return raw;
  const [, whole = "", fraction, unit] = match;
  const value = Number(`${whole.replace(/,/g, "")}${fraction === undefined ? "" : `.${fraction}`}`);
  const number = formatNumber(value, fraction?.length ?? 0);
  return unit === undefined ? number : `${number} ${unit}`;
}

/**
 * The marks of a language, the console's by default: es-AR 12480.5 → "12.480,5", English → "12,480.5".
 * The landing passes its own language: it is not the console's.
 */
export function formatNumber(value: number, fractionDigits = 0, lang: Language = activeLang()): string {
  const [group, decimal] = lang === "en" ? [",", "."] : [".", ","];
  const fixed = Math.abs(value).toFixed(fractionDigits);
  const [whole = "0", fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const sign = value < 0 && Number(fixed) !== 0 ? "-" : "";
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}${decimal}${fraction}`;
}
