// Opting out by keyword (FL-016): a text that is exactly one of these words, after folding case,
// accents, punctuation and spaces, revokes the WhatsApp consent without the model. A longer or
// ambiguous sentence is not a keyword: it goes to the agent, which cannot revoke anything. The title of
// the `OPT_OUT` button counts too, so a tap whose nonce no longer resolves still means what it says.
import { BUTTON_LABELS } from "../../copy/buttons";

/** Lower case, no diacritics, no punctuation, single spaces: "¡BAJA!" → "baja". */
export function foldKeyword(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Exact texts that opt out (docs/flows-catalog.md FL-016), already folded. */
export const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set(
  ["BAJA", "STOP", "no quiero recibir más", "no quiero recibir más avisos", "no quiero recibir más mensajes", BUTTON_LABELS.OPT_OUT.template].map(foldKeyword),
);

export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_KEYWORDS.has(foldKeyword(text));
}
