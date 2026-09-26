// The WhatsApp opt-in text the importer's contact accepts (FL-001) and the exact opt-out keywords
// (FL-016). `record_consent` stores the version shown, so a text that changes gets a new version and
// the old one stays here: `PolicyAudit` and the console read the version a consent was given with.
import type { ConsentMedium } from "@legajo/shared";
import { BUTTON_LABELS } from "./buttons";
import { PRODUCT_NAME } from "./helpers";

export const CONSENT_TEXT_VERSIONS = ["v1"] as const;
export type ConsentTextVersion = (typeof CONSENT_TEXT_VERSIONS)[number];
export const CURRENT_CONSENT_TEXT_VERSION: ConsentTextVersion = "v1";

export interface ConsentTextParams {
  readonly firmName: string;
}

/**
 * Exact opt-out words: `InboundWhatsApp` revokes only on one of these (or the `OPT_OUT` button); an
 * ambiguous phrase goes to the agent, which cannot revoke. The first one is the one the texts name.
 */
export const OPT_OUT_KEYWORDS = ["BAJA", "STOP", "no quiero recibir más"] as const;

function normalizeKeyword(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s.!¡?¿,;:]+/gu, " ")
    .trim();
}

const OPT_OUT_SET = new Set<string>(OPT_OUT_KEYWORDS.map(normalizeKeyword));

/** True only for a whole message that is an opt-out keyword, ignoring case, accents and end punctuation. */
export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_SET.has(normalizeKeyword(text));
}

export const CONSENT_TEXTS: Readonly<Record<ConsentTextVersion, (params: ConsentTextParams) => string>> = {
  v1: ({ firmName }) =>
    `Acepto que ${firmName} me escriba por WhatsApp, vía ${PRODUCT_NAME}, sobre la documentación de mis operaciones de importación: documentos faltantes, correcciones, plazos y estado del despacho. ` +
    `El estudio nunca me va a pedir por este chat datos bancarios, claves ni documentos de identidad. ` +
    `Puedo dejar de recibir estos avisos cuando quiera respondiendo ${OPT_OUT_KEYWORDS[0]} o tocando «${BUTTON_LABELS.OPT_OUT.template}».`,
};

export function consentText(version: ConsentTextVersion, params: ConsentTextParams): string {
  return CONSENT_TEXTS[version](params);
}

/** How the opt-in was given (`record_consent.medium`), as the console shows it. */
export const CONSENT_MEDIUM_LABELS: Readonly<Record<ConsentMedium, string>> = {
  SIGNED_FORM: "formulario firmado",
  EMAIL: "email",
  IN_PERSON: "en persona",
};
