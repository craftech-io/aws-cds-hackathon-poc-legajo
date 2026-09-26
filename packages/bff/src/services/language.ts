// Deterministic Spanish/English detector for the outbound check (outbound/verify.ts): a text to the
// importer must be Spanish and one to the supplier English (ADR-0008). No model and no dictionary
// service: it counts function words and domain words that only one of the two languages uses,
// plus the marks only Spanish writes (ñ, ¿, ¡, accented vowels) and English contractions. The same
// text always gets the same answer; a text without enough evidence is `und`, never a guess.
import type { Language } from "@legajo/shared";
import { stripMaskMarkers } from "../lib/mask";

// Words that exist in only one of the two languages. Ambiguous ones ("a", "no", "me", "he", "son",
// "come", "real", "final", "total", "plan", "hotel") are left out on purpose, and so are the brand
// and firm words an English email signs with ("Legajo listo", "Estudio").
const SPANISH = new Set([
  "de", "la", "que", "el", "en", "y", "los", "del", "las", "por", "un", "una", "para", "con", "es", "se", "lo", "al", "su", "sus",
  "pero", "más", "mas", "como", "este", "esta", "esto", "ese", "esa", "ya", "muy", "hay", "está", "están", "tiene", "tienen", "tenés",
  "podés", "querés", "sabés", "vos", "te", "tu", "tus", "le", "les", "nos", "mi", "mis", "si", "sí", "también", "cuando", "hasta",
  "desde", "entre", "sobre", "sin", "pasa", "hola", "gracias", "saludos", "favor", "hoy", "mañana", "ayer", "día", "días", "hora",
  "horas", "falta", "faltan", "documento", "documentos", "factura", "certificado", "origen", "proveedor", "importador", "operación",
  "buque", "arribo", "plazo", "pedido", "subir", "subí", "mandá", "mandar", "escribile", "escribimos", "tenemos", "necesitamos",
  "avisamos", "nada", "hacer", "despachante", "carga", "llegaron", "llegó", "revisión", "aprobado",
]);

const ENGLISH = new Set([
  "the", "of", "and", "to", "in", "is", "you", "that", "for", "it", "with", "as", "on", "be", "at", "by", "this", "we", "are",
  "please", "your", "our", "will", "have", "has", "from", "dear", "regards", "thank", "thanks", "kind", "would", "could", "should",
  "can", "not", "an", "or", "if", "was", "were", "been", "send", "sent", "attached", "invoice", "certificate", "origin", "supplier",
  "document", "documents", "deadline", "missing", "correction", "needed", "weight", "gross", "net", "shipment", "vessel", "arrival",
  "time", "hello", "best", "which", "what", "when", "there", "their", "they", "them", "these", "those", "before", "after",
  "must", "match", "matches", "found", "expected", "reply", "thread", "update", "updated", "request", "requested", "operation",
]);

const SPANISH_MARKS = /[ñ¿¡áéíóú]/g;
const ENGLISH_CONTRACTIONS = /\b[a-z]+'(?:s|t|re|ll|ve|m|d)\b/g;
const URL_OR_EMAIL = /\bhttps?:\/\/\S+|\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const WORD = /[a-záéíóúüñ]+/g;

export interface LanguageGuess {
  readonly language: Language | "und";
  /** Evidence counted for each language. */
  readonly es: number;
  readonly en: number;
}

/** Evidence below this total is not enough to decide. */
export const MIN_EVIDENCE = 2;
/** The winner needs at least this many times the other's evidence. */
export const DOMINANCE = 2;

export function detectLanguage(text: string): LanguageGuess {
  const clean = stripMaskMarkers(text).replace(URL_OR_EMAIL, " ").toLowerCase().normalize("NFC");
  let es = (clean.match(SPANISH_MARKS) ?? []).length;
  let en = (clean.replace(/[’]/g, "'").match(ENGLISH_CONTRACTIONS) ?? []).length;
  for (const word of clean.match(WORD) ?? []) {
    if (SPANISH.has(word)) es += 1;
    else if (ENGLISH.has(word)) en += 1;
  }
  let language: LanguageGuess["language"] = "und";
  if (es + en >= MIN_EVIDENCE) {
    if (es >= DOMINANCE * en && es > en) language = "es";
    else if (en >= DOMINANCE * es && en > es) language = "en";
  }
  return { language, es, en };
}

/** True only when the text is detected as `language`; an undecided text is not in any language. */
export function isInLanguage(text: string, language: Language): boolean {
  return detectLanguage(text).language === language;
}
