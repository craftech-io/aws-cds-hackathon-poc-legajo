// The internal notice of a new lead to Craftech (ADR-0015 §6, docs/landing-spec.md §8.10): plain text
// in Spanish with exactly what the ADR lists (email; name, company and job title if given; language;
// whether contact was accepted, with its version; UTM and the referrer's host; sign-up time in
// Buenos Aires) and nothing more. One subject, no variants.
import type { Lead } from "../lead";

export const LEAD_NOTICE_SUBJECT = "[Legajo listo] Nuevo registro en la demo";
export const LEAD_NOTICE_FROM_NAME = "Legajo listo";

const ART_OFFSET_MS = -3 * 60 * 60 * 1000;
const two = (value: number): string => String(value).padStart(2, "0");

/** `14/10/2026 10:30 (hora de Buenos Aires)`: Argentina keeps UTC−3 all year. */
export function artTime(instant: string): string {
  const at = new Date(Date.parse(instant) + ART_OFFSET_MS);
  return `${two(at.getUTCDate())}/${two(at.getUTCMonth() + 1)}/${at.getUTCFullYear()} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} (hora de Buenos Aires)`;
}

function hostOf(referrer: string | undefined): string | undefined {
  if (referrer === undefined) return undefined;
  try {
    return new URL(referrer).host;
  } catch {
    return undefined;
  }
}

export function leadNoticeBody(lead: Lead): string {
  const contact = lead.consents.contact;
  const utm = Object.entries(lead.utm).map(([key, value]) => `${key}=${value}`);
  const host = hostOf(lead.referrer);
  const lines = [
    "Nuevo registro en la demo de Legajo listo.",
    "",
    `Email: ${lead.email}`,
    ...(lead.name === undefined ? [] : [`Nombre: ${lead.name}`]),
    ...(lead.company === undefined ? [] : [`Empresa: ${lead.company}`]),
    ...(lead.jobTitle === undefined ? [] : [`Cargo: ${lead.jobTitle}`]),
    `Idioma: ${lead.language}`,
    `Acepta que Craftech lo contacte: ${contact.accepted ? "sí" : "no"} (versión ${contact.version})`,
    `UTM: ${utm.length === 0 ? "ninguno" : utm.join(", ")}`,
    `Sitio de origen: ${host ?? "ninguno"}`,
    `Alta: ${artTime(lead.signupAt)}`,
  ];
  return `${lines.join("\n")}\n`;
}
