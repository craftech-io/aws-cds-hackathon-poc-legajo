// `CP-ONE-PER-DAY` (docs/design-brief.md §5.7): at most one `DOCS_REQUEST` or `REMINDER` per contact
// and simulated day. The contact is the importer's registered phone (WhatsApp) or the supplier's
// contact (email), across every operation; the day is the contact's own local day (Buenos Aires for
// the importer, the supplier's zone for the supplier). What counts is what already went out before
// the decided send; an acknowledgement or a reply never counts. A second one is deferred to the next
// business opening of the contact's side after that day.
import { addCalendarDays, formatDate } from "@legajo/shared";
import { type BusinessHours, ARGENTINA_TIME_ZONE, argentinaBusinessHours, localDateOf, nextBusinessOpening, toZonedIso, zonedInstant } from "../services/business-hours";
import { NO_HOLIDAYS } from "../services/holidays";
import { defer, missing, pass, skip } from "./checks";
import type { PolicyContext } from "./context";
import { supplierHoursOf } from "./hours";
import { ONCE_A_DAY_KINDS, wentOut } from "./kinds";
import type { HistoryMessage, RuleCheck } from "./types";

interface ContactSide {
  readonly hours: BusinessHours;
  readonly isSameContact: (entry: HistoryMessage) => boolean;
}

function importerSide(ctx: PolicyContext): ContactSide {
  const { importerId } = ctx.operation;
  return {
    // Without a calendar the next opening only skips weekends (a proactive send already failed closed on CP-HOURS-AR).
    hours: argentinaBusinessHours(ctx.holidays ?? NO_HOLIDAYS),
    isSameContact: (entry) => entry.counterpart === "IMPORTER" && entry.channel === "WHATSAPP" && (entry.importerId === undefined || entry.importerId === importerId),
  };
}

function supplierSide(hours: BusinessHours, contactId: string): ContactSide {
  return { hours, isSameContact: (entry) => entry.counterpart === "SUPPLIER" && entry.channel === "EMAIL" && entry.contactId === contactId };
}

/** Went out before the decided send: earlier simulated instant, then earlier real instant, then id. */
function isBefore(entry: HistoryMessage, at: Date, ctx: PolicyContext): boolean {
  const sim = Date.parse(entry.sentAtSim) - at.getTime();
  if (sim !== 0) return sim < 0;
  // A later instant than "now" is a candidate of the engine's search: everything known went out before it.
  if (at.getTime() !== ctx.simNow.getTime()) return true;
  const real = Date.parse(entry.sentAtReal) - ctx.realNow.getTime();
  if (real !== 0) return real < 0;
  return ctx.message.messageId === undefined || entry.messageId < ctx.message.messageId;
}

/** `CP-ONE-PER-DAY` at `at`. */
export function checkOnePerDay(ctx: PolicyContext, at: Date): RuleCheck {
  const { kind } = ctx.message;
  if (kind === undefined || !ONCE_A_DAY_KINDS.includes(kind)) return skip("only DOCS_REQUEST and REMINDER count against the daily cap");
  let side: ContactSide;
  if (ctx.toImporterByWhatsApp) side = importerSide(ctx);
  else if (ctx.toSupplierByEmail) {
    const hours = supplierHoursOf(ctx);
    const contactId = ctx.message.contactId ?? ctx.input.contact?.contactId;
    if (hours === undefined) return missing(ctx, "the supplier's time zone");
    if (contactId === undefined) return missing(ctx, "the supplier contact");
    side = supplierSide(hours, contactId);
  } else return skip("the daily cap applies to the importer by WhatsApp and the supplier by email");
  if (ctx.history === undefined) return missing(ctx, "the contact's message history");

  const zone = side.hours.timeZone;
  const day = localDateOf(at, zone);
  const earlier = ctx.history.find(
    (entry) =>
      side.isSameContact(entry) &&
      wentOut(entry) &&
      entry.kind !== undefined &&
      ONCE_A_DAY_KINDS.includes(entry.kind) &&
      localDateOf(new Date(entry.sentAtSim), zone) === day &&
      isBefore(entry, at, ctx),
  );
  const date = formatDate(day).slice(0, 5);
  if (earlier === undefined) return pass(`no other request or reminder reached this contact on ${date} (${zone})`);
  const next = nextBusinessOpening(zonedInstant(addCalendarDays(day, 1), "00:00", zone), side.hours);
  const place = zone === ARGENTINA_TIME_ZONE ? "Buenos Aires" : zone;
  return defer(`a ${earlier.kind} already reached this contact on ${date} (${place}): deferred to ${toZonedIso(next, zone)}`, next, zone);
}
