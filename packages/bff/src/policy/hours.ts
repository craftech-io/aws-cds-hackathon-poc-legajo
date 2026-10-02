// Business hours of each side (docs/design-brief.md §5.7), always on the world's simulated clock:
//
//   CP-HOURS-AR        a proactive WhatsApp to the importer goes out Monday to Friday 09:00-18:00 in
//                      Buenos Aires, never on a national holiday of `Reference/REF#HOLIDAY#AR`; a
//                      reply to the importer's own message is exempt (window.ts)
//   CP-HOURS-SUPPLIER  an email to the supplier goes out Monday to Friday 09:00-18:00 in the
//                      supplier's zone, with its daylight saving time and without holidays
//
// Out of hours is a deferral, not a denial: the send waits for `nextAllowedAt`, the next opening.
// Both rules take the instant they guest, so the engine also asks them about a later instant when it
// looks for the first moment every time rule allows the send.
import { formatDate } from "@legajo/shared";
import { type BusinessHours, ARGENTINA_TIME_ZONE, argentinaBusinessHours, isBusinessDate, isBusinessOpen, nextBusinessOpening, supplierBusinessHours, toZonedIso, zonedParts } from "../services/business-hours";
import { defer, missing, pass, skip } from "./checks";
import type { PolicyContext } from "./context";
import type { RuleCheck } from "./types";

/** Buenos Aires hours with the national holidays; `undefined` without a calendar. */
function importerHoursOf(ctx: PolicyContext): BusinessHours | undefined {
  return ctx.holidays === undefined ? undefined : argentinaBusinessHours(ctx.holidays);
}

/** Hours of the supplier's zone; `undefined` without the supplier. */
export function supplierHoursOf(ctx: PolicyContext): BusinessHours | undefined {
  const zone = ctx.input.supplier?.timezone;
  return zone === undefined ? undefined : supplierBusinessHours(zone);
}

/** "Mon 12/10 10:00 (holiday)": the local wall clock of `at` in the zone of `hours`. */
function wallClock(at: Date, hours: BusinessHours): string {
  const parts = zonedParts(at, hours.timeZone);
  const closedDay = hours.days.includes(parts.weekday) && !isBusinessDate(parts.date, hours) ? " (holiday)" : "";
  return `${parts.weekday} ${formatDate(parts.date).slice(0, 5)} ${parts.time}${closedDay}`;
}

function checkHours(at: Date, hours: BusinessHours, side: string): RuleCheck {
  const local = wallClock(at, hours);
  if (isBusinessOpen(at, hours)) return pass(`${local} is inside ${side} business hours`);
  const next = nextBusinessOpening(at, hours);
  return defer(`${local} is outside ${side} business hours: deferred to ${toZonedIso(next, hours.timeZone)}`, next, hours.timeZone);
}

/** `CP-HOURS-AR` at `at`. */
export function checkHoursAr(ctx: PolicyContext, at: Date): RuleCheck {
  if (!ctx.toImporterByWhatsApp) return skip("Argentina's hours only apply to WhatsApp to the importer");
  if (ctx.reply === undefined) return missing(ctx, "the importer's message history");
  if (ctx.reply) return skip("a reply to the importer's own message is exempt from business hours");
  const hours = importerHoursOf(ctx);
  if (hours === undefined) return missing(ctx, "the holiday calendar of Argentina");
  return checkHours(at, hours, `Buenos Aires (${ARGENTINA_TIME_ZONE})`);
}

/** `CP-HOURS-SUPPLIER` at `at`. */
export function checkHoursSupplier(ctx: PolicyContext, at: Date): RuleCheck {
  if (!ctx.toSupplierByEmail) return skip("the supplier's hours only apply to email to the supplier");
  const hours = supplierHoursOf(ctx);
  if (hours === undefined) return missing(ctx, "the supplier's time zone");
  return checkHours(at, hours, `the supplier's (${hours.timeZone})`);
}
