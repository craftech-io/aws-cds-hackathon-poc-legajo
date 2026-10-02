// The `…Text` of a deferred send (docs/tool-catalog.md "Fechas"): the instant already formatted for the
// side that decides, so the model copies it and never computes it. The importer's side reads Buenos
// Aires time (`16/10 09:00`); the supplier's reads its own zone with the zone named
// (`16/10 09:00 Asia/Shanghai`), the same instant `nextAllowedAt` gives with its offset.
import { ARGENTINA_TIME_ZONE, zonedParts } from "../services/business-hours";
import type { SendContext } from "./context";

function dayMonth(date: string): string {
  const [, month = "", day = ""] = date.split("-");
  return `${day}/${month}`;
}

/** The zone whose clock decides a send: the supplier's for an email to it, Buenos Aires otherwise. */
export function decidingZone(context: Pick<SendContext, "counterpart" | "supplier">): string {
  return context.counterpart === "SUPPLIER" && context.supplier !== undefined ? context.supplier.timezone : ARGENTINA_TIME_ZONE;
}

export function instantText(instant: string, zone: string): string {
  const parts = zonedParts(new Date(instant), zone);
  const text = `${dayMonth(parts.date)} ${parts.time}`;
  return zone === ARGENTINA_TIME_ZONE ? text : `${text} ${zone}`;
}
