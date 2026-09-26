// What no outbound text may do or say. `findSensitiveAsk` is the single definition of
// CP-NO-SENSITIVE-ASK (docs/design-brief.md §5.7, rule 13): the outbound verifier (outbound/verify.ts)
// runs it on every text the agent or the firm writes, and copy.test.ts runs it on every text of
// copy/. `findAvoidedWord` keeps our own copy on the CONTEXT.md vocabulary. Matching is whole-word,
// case- and accent-insensitive, and sentence by sentence.

/** Identity documents, bank data, cards and credentials (Spanish and English). */
export const SENSITIVE_TERMS = [
  "dni",
  "documento de identidad",
  "pasaporte",
  "cuit",
  "cuil",
  "cbu",
  "cvu",
  "alias bancario",
  "alias del cbu",
  "cuenta bancaria",
  "numero de cuenta",
  "datos bancarios",
  "tarjeta",
  "tarjetas",
  "codigo de seguridad",
  "clave fiscal",
  "clave bancaria",
  "clave de acceso",
  "contrasena",
  "iban",
  "cvv",
  "tax id",
  "national id",
  "id number",
  "passport",
  "bank account",
  "bank details",
  "banking details",
  "account number",
  "routing number",
  "swift code",
  "card number",
  "credit card",
  "debit card",
  "security code",
  "password",
] as const;

/** Words that turn a sentence into a request to the reader (imperatives, questions, "we need"). */
export const REQUEST_CUES = [
  // Spanish, voseo and neutral forms, without accents.
  "manda",
  "mandame",
  "mandanos",
  "mandar",
  "mandes",
  "pasa",
  "pasame",
  "pasanos",
  "pasar",
  "pases",
  "envia",
  "enviame",
  "envianos",
  "enviar",
  "envies",
  "comparti",
  "compartime",
  "compartinos",
  "compartir",
  "indica",
  "indicanos",
  "indicar",
  "informa",
  "informanos",
  "informar",
  "confirma",
  "confirmanos",
  "confirmar",
  "decime",
  "decinos",
  "escribi",
  "escribinos",
  "ingresa",
  "ingresar",
  "completa",
  "completar",
  "adjunta",
  "adjuntar",
  "necesitamos",
  "necesito",
  "pedimos",
  "pedir",
  "me pasas",
  "nos pasas",
  "me mandas",
  "nos mandas",
  "cual es",
  "cuales son",
  // English.
  "send",
  "provide",
  "share",
  "confirm",
  "enter",
  "type",
  "submit",
  "attach",
  "forward",
  "tell us",
  "tell me",
  "give us",
  "give me",
  "reply with",
  "we need",
  "what is your",
  "whats your",
] as const;

/** A request right after one of these is a warning ("no nos mandes", "never send"), not an ask. */
export const NEGATION_CUES = ["no", "nunca", "jamas", "ni", "sin", "not", "never", "dont", "without"] as const;

/** CONTEXT.md "_Avoid_" words that our own copy never uses in public texts. */
export const AVOIDED_WORDS = [
  "expediente",
  "expedientes",
  "carpeta",
  "carpetas",
  "embarque",
  "embarques",
  "vencimiento",
  "vencimientos",
  "multa",
  "multas",
  "penalidad",
  "penalidades",
  "rechazo",
  "rechazos",
  "discrepancia",
  "discrepancias",
  "cliente",
  "clientes",
  "bot",
  "ocr",
  "ticket",
  "tickets",
  "shipper",
  "vendor",
  "penalty",
  "penalties",
] as const;

export function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Lower case, no accents, apostrophes dropped ("what's" → "whats"), one space between words; a comma
 * stays as a " , " token so a negation never reaches across clauses.
 */
function normalized(text: string): string {
  return stripAccents(text)
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N},]+/gu, " ")
    .replace(/ *, */g, " , ")
    .replace(/ +/g, " ")
    .trim();
}

function phrasePattern(phrases: readonly string[]): RegExp {
  const alternatives = [...phrases].sort((a, b) => b.length - a.length).map((phrase) => phrase.replace(/ /g, " +"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

const SENSITIVE = phrasePattern(SENSITIVE_TERMS);
const REQUEST = phrasePattern(REQUEST_CUES);
const NEGATION = new Set<string>(NEGATION_CUES);
const AVOIDED = phrasePattern(AVOIDED_WORDS);
/** Words before a cue (or a term) that a negation may sit in: "nunca te vamos a pedir". */
const NEGATION_WINDOW = 4;

function sentences(text: string): string[] {
  return text
    .split(/[.!?¿¡;:\n]+/u)
    .map(normalized)
    .filter((sentence) => sentence !== "");
}

/** A negation among the last words before `at`, inside the same clause. */
function isNegated(sentence: string, at: number): boolean {
  const clause = sentence.slice(0, at).split(",").pop() ?? "";
  const before = clause.trim().split(" ").slice(-NEGATION_WINDOW);
  return before.some((word) => NEGATION.has(word));
}

function firstAsserted(sentence: string, pattern: RegExp): string | undefined {
  for (const match of sentence.matchAll(pattern)) if (!isNegated(sentence, match.index ?? 0)) return match[0];
  return undefined;
}

export interface SensitiveAsk {
  /** The sensitive term found, normalized (never the value that followed it). */
  readonly term: string;
  /** The request cue of the same sentence. */
  readonly cue: string;
}

/**
 * A sentence that asks the reader for identity, bank, card or credential data: it names a sensitive
 * term that is not negated ("sin datos bancarios") and carries a request cue that is not negated
 * either ("no nos mandes", "never send"). Conservative on purpose: a false positive only makes the
 * agent rewrite the text; a false negative would break Meta's policy.
 */
export function findSensitiveAsk(text: string): SensitiveAsk | undefined {
  for (const sentence of sentences(text)) {
    const term = firstAsserted(sentence, SENSITIVE);
    const cue = term === undefined ? undefined : firstAsserted(sentence, REQUEST);
    if (term !== undefined && cue !== undefined) return { term, cue };
  }
  return undefined;
}

/** First CONTEXT.md "_Avoid_" word of a text, if any. */
export function findAvoidedWord(text: string): string | undefined {
  return normalized(text).match(AVOIDED)?.[0];
}
