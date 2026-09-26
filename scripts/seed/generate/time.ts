// Hand-written date helpers of the generator (no Intl, no toLocale*: docs/seed-spec.md §1). Business
// dates of the seed are written in Buenos Aires time, which has a fixed UTC−03:00 offset; the few
// instants in a supplier's zone carry the fixed offset that zone has on that date. Milestones follow
// CONTEXT.md "Hito": ETA − 7, − 5 and − 3 days at 10:00 AR, ETA − 48 h and the ETA itself.
import type { MilestoneName } from "@legajo/shared";

const AR_OFFSET_MINUTES = -180;
const MINUTE = 60_000;
const DAY = 86_400_000;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function msOf(instant: string): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`invalid instant ${instant}`);
  return ms;
}

/** `2026-10-14T10:30:00-03:00` style: the instant `ms` written with a fixed UTC offset. */
function withOffset(ms: number, offsetMinutes: number): string {
  const local = new Date(ms + offsetMinutes * MINUTE);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const date = `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return `${date}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Buenos Aires time of an instant. */
export function ar(ms: number): string {
  return withOffset(ms, AR_OFFSET_MINUTES);
}

/** `2026-10-15T10:00:00-03:00` from a calendar date and a wall-clock time in Buenos Aires. */
export function arAt(date: string, time: string): string {
  return `${date}T${time}:00-03:00`;
}

export function plusMinutes(instant: string, minutes: number): string {
  return ar(msOf(instant) + minutes * MINUTE);
}

export function plusDays(instant: string, days: number): string {
  return ar(msOf(instant) + days * DAY);
}

/** The calendar date of an instant in Buenos Aires (`YYYY-MM-DD`). */
export function arDate(instant: string): string {
  return ar(msOf(instant)).slice(0, 10);
}

/** A calendar date `days` later (earlier with a negative number). */
export function addDays(date: string, days: number): string {
  return arDate(plusDays(arAt(date, "12:00"), days));
}

/** Canonical UTC with milliseconds (sort keys and GSI range keys). */
export function utc(instant: string): string {
  return new Date(msOf(instant)).toISOString();
}

export const MILESTONES: readonly MilestoneName[] = ["DOCS_REQUEST", "FOLLOWUP", "FOLLOWUP_FINAL", "ESCALATION", "ARRIVAL"];

/** `dueAtSim` of the five milestones of an ETA. */
export function milestoneTimes(eta: string): Readonly<Record<MilestoneName, string>> {
  const etaDate = arDate(eta);
  return {
    DOCS_REQUEST: arAt(addDays(etaDate, -7), "10:00"),
    FOLLOWUP: arAt(addDays(etaDate, -5), "10:00"),
    FOLLOWUP_FINAL: arAt(addDays(etaDate, -3), "10:00"),
    ESCALATION: ar(msOf(eta) - 2 * DAY),
    ARRIVAL: ar(msOf(eta)),
  };
}

/** `22/10`: how the texts to the importer write a date. */
export function dayMonth(instant: string): string {
  const date = arDate(instant);
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A wall-clock time in a zone that has the fixed offset `offsetMinutes` on that date. */
export function zonedAt(date: string, time: string, offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${date}T${time}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** `Oct 16, 2026` in the zone of `offsetMinutes`. */
export function enDate(instant: string, offsetMinutes: number): string {
  const local = withOffset(msOf(instant), offsetMinutes);
  const month = MONTHS_EN[Number(local.slice(5, 7)) - 1] ?? "";
  return `${month} ${Number(local.slice(8, 10))}, ${local.slice(0, 4)}`;
}

/** `Oct 16, 2026, 17:00` in the zone of `offsetMinutes`: how the emails to a supplier write a deadline. */
export function enDateTime(instant: string, offsetMinutes: number): string {
  return `${enDate(instant, offsetMinutes)}, ${withOffset(msOf(instant), offsetMinutes).slice(11, 16)}`;
}
