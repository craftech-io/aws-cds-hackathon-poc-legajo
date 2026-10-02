// The `…Text` of every date a tool returns (docs/tool-catalog.md "Fechas"): already formatted, so the
// model copies it and never computes it. For the importer and the firm it is Argentina's wall clock
// (`22/10 08:00`, the form outbound/text-facts.ts reads back in Rioplatense texts); for the supplier
// it is the wall clock of its zone with the zone named (`2026-10-18 17:00 (Asia/Shanghai)`), read back
// the same way in English texts. No `Intl` formatting of words: digits only, no language to pick.
import { ARGENTINA_TIME_ZONE, toZonedIso, zonedParts } from "../../services/business-hours";

function instantOf(value: string | Date): Date {
  const instant = typeof value === "string" ? new Date(Date.parse(value)) : value;
  if (Number.isNaN(instant.getTime())) throw new RangeError("invalid instant");
  return instant;
}

/** `22/10 08:00`: the instant on Argentina's wall clock. */
export function textAr(value: string | Date): string {
  const parts = zonedParts(instantOf(value), ARGENTINA_TIME_ZONE);
  const [, month = "", day = ""] = parts.date.split("-");
  return `${day}/${month} ${parts.time}`;
}

/** `2026-10-18 17:00 (Asia/Shanghai)`: the instant on the wall clock of `timeZone`. */
export function textInZone(value: string | Date, timeZone: string): string {
  const parts = zonedParts(instantOf(value), timeZone);
  return `${parts.date} ${parts.time} (${timeZone})`;
}

/** The instant as a business date of a tool: ISO 8601 with Argentina's offset. */
export function isoAr(value: string | Date): string {
  return toZonedIso(instantOf(value), ARGENTINA_TIME_ZONE);
}
