// `<input type="datetime-local">` speaks the browser's wall clock; the BFF wants instants with their
// zone. These helpers read the input as a wall time of a given zone (Argentina unless told
// otherwise), never of the browser, and turn an instant back into the input's value. They also
// write instants with the zone's own offset (`2026-10-15T10:00:00-03:00`), the form the tools use.
import { AR_TIME_ZONE, wallClockOf } from "./format";

const pad = (value: number) => String(value).padStart(2, "0");

/** `2026-10-15T10:00` → date and time parts; undefined when incomplete. */
export function splitLocalDateTime(value: string): { readonly date: string; readonly time: string } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return match?.[1] && match[2] ? { date: match[1], time: match[2] } : undefined;
}

/** Minutes the zone is ahead of UTC at that instant (Argentina: −180). */
export function offsetMinutesOf(instant: Date, timeZone: string): number {
  const wall = wallClockOf(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a wall time of the zone stands for; undefined when that wall time does not exist. */
export function zonedToInstant(date: string, time: string, timeZone: string = AR_TIME_ZONE): Date | undefined {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return undefined;
  const [year, month, day, hour, minute] = [dateMatch[1], dateMatch[2], dateMatch[3], timeMatch[1], timeMatch[2]].map(Number) as [number, number, number, number, number];
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes: the offset at the guess, then the offset at the corrected instant (a DST edge).
  let instant = guess - offsetMinutesOf(new Date(guess), timeZone) * 60_000;
  instant = guess - offsetMinutesOf(new Date(instant), timeZone) * 60_000;
  const wall = wallClockOf(instant, timeZone);
  const same = wall.year === year && wall.month === month && wall.day === day && wall.hour === hour && wall.minute === minute;
  return same ? new Date(instant) : undefined;
}

/** An instant written with the zone's offset: `2026-10-15T10:00:00-03:00`. */
export function isoWithOffset(instant: Date | string, timeZone: string = AR_TIME_ZONE): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  const wall = wallClockOf(date, timeZone);
  const offset = offsetMinutesOf(date, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** `2026-10-15T10:00` read in the zone → `2026-10-15T10:00:00-03:00`; undefined when not a valid input. */
export function localInputToIso(value: string, timeZone: string = AR_TIME_ZONE): string | undefined {
  const parts = splitLocalDateTime(value);
  if (!parts) return undefined;
  const instant = zonedToInstant(parts.date, parts.time, timeZone);
  return instant ? isoWithOffset(instant, timeZone) : undefined;
}

/** An instant as the value a datetime-local input shows, in the zone. */
export function isoToLocalInput(instant: Date | string, timeZone: string = AR_TIME_ZONE): string {
  const wall = wallClockOf(instant, timeZone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}
