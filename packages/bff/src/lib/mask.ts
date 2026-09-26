// The one masker of sensitive data (docs/architecture.md §13, "PII"). Three consumers share it so
// they can never drift apart:
//
//   - channels/normalizer.ts masks every inbound text with `maskSensitive` (CUIT/CUIL, DNI, CBU/CVU,
//     cards, IBAN) before persisting it and before building the turn envelope;
//   - lib/log.ts masks every log line with `maskText(…, LOG_KINDS)` (the same kinds plus E.164
//     phones and emails);
//   - infra/guardrail-policies.ts builds the G1 regexes (ANONYMIZE, the second layer) from
//     `GUARDRAIL_REGEXES`.
//
// The G1 kinds (CUIT, DNI, CBU) are masked with exactly the regex G1 receives, and every match is
// masked (no extra validation), so a text that went through the normalizer never triggers a G1
// regex again (`mask.test.ts` checks it; infra/guardrail-policies.test.ts checks the fixtures).
// Bedrock does not support lookarounds in custom regexes and some engines give `\d` a Unicode
// meaning, so those patterns only use `[0-9]`, `\b` and plain groups. Cards (Luhn) and IBAN
// (mod 97) are not G1 regexes (G1 blocks cards with its managed PII type), so they may validate.
//
// Pure module on purpose: no imports, so the SST program can load it from infra/.

export const MASK_KINDS = ["EMAIL", "PHONE", "IBAN", "CBU", "CARD", "CUIT", "DNI"] as const;
export type MaskKind = (typeof MASK_KINDS)[number];

/** Typed markers that replace a masked value (`[CUIT]`, `[CBU]`, …); the model and the logs see only these. */
export const MASK_MARKERS: Readonly<Record<MaskKind, string>> = {
  EMAIL: "[EMAIL]",
  PHONE: "[TELEFONO]",
  IBAN: "[IBAN]",
  CBU: "[CBU]",
  CARD: "[TARJETA]",
  CUIT: "[CUIT]",
  DNI: "[DNI]",
};

/** What the normalizer masks before persisting and before the envelope; contacts stay (they are registry data). */
export const SENSITIVE_KINDS: readonly MaskKind[] = ["IBAN", "CBU", "CARD", "CUIT", "DNI"];

/** What a log line never carries. Phones and emails go first so their digits are not read as documents. */
export const LOG_KINDS: readonly MaskKind[] = ["EMAIL", "PHONE", "IBAN", "CBU", "CARD", "CUIT", "DNI"];

/** Kinds that G1 anonymizes with a custom regex; the rest are either managed types or not in G1. */
export const GUARDRAIL_KINDS = ["CUIT", "DNI", "CBU"] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

// CUIT/CUIL: type prefix (20, 23-27 people, 30, 33, 34 companies), 8 digits and a check digit,
// with or without separators. The check digit is not validated: G1 masks every match, so must we.
const CUIT_SOURCE = "\\b(?:2[03-7]|3[034])[-. ]?[0-9]{8}[-. ]?[0-9]\\b";
// DNI: 7 or 8 digits, optionally with thousands dots (12.345.678).
const DNI_SOURCE = "\\b[0-9]{1,2}\\.?[0-9]{3}\\.?[0-9]{3}\\b";
// CBU/CVU: 22 digits (8 of bank and branch, 14 of account), optionally split after the eighth.
const CBU_SOURCE = "\\b[0-9]{8}[- ]?[0-9]{14}\\b";

export interface GuardrailRegex {
  readonly kind: GuardrailKind;
  /** `name` of the `regexesConfig` entry (1-100 characters). */
  readonly name: string;
  /** `pattern` of the entry (1-500 characters, no lookarounds). */
  readonly pattern: string;
  readonly description: string;
}

/** Regexes of G1 (`sensitiveInformationPolicy.regexesConfig`, action ANONYMIZE), docs/design-brief.md §5.5. */
export const GUARDRAIL_REGEXES: readonly GuardrailRegex[] = [
  { kind: "CUIT", name: "AR_CUIT_CUIL", pattern: CUIT_SOURCE, description: "Argentine tax id (CUIT/CUIL): prefix, 8 digits and check digit, with or without separators" },
  { kind: "DNI", name: "AR_DNI", pattern: DNI_SOURCE, description: "Argentine national identity number (DNI): 7 or 8 digits, optionally with thousands dots" },
  { kind: "CBU", name: "AR_CBU_CVU", pattern: CBU_SOURCE, description: "Argentine bank or virtual account key (CBU/CVU): 22 digits" },
];

const EMAIL_SOURCE = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
// E.164 as people write it: "+", a digit, then digits and the usual separators.
const PHONE_SOURCE = "\\+[0-9][0-9\\s().-]{6,18}[0-9]";
// Card: 13 to 19 digits, optionally grouped by spaces or dashes; never right after "+" (a phone).
const CARD_SOURCE = "(?<![0-9+])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])";
// IBAN: country code, check digits and 11 to 30 alphanumerics, compact or in groups of four, in
// either case (the mod-97 check decides).
const IBAN_SOURCE = "\\b[A-Za-z]{2}[0-9]{2}(?: ?[A-Za-z0-9]){11,30}\\b";

/** Source of the regex of each kind; the G1 kinds are the exact strings of `GUARDRAIL_REGEXES`. */
export const MASK_SOURCES: Readonly<Record<MaskKind, string>> = {
  EMAIL: EMAIL_SOURCE,
  PHONE: PHONE_SOURCE,
  IBAN: IBAN_SOURCE,
  CBU: CBU_SOURCE,
  CARD: CARD_SOURCE,
  CUIT: CUIT_SOURCE,
  DNI: DNI_SOURCE,
};

/** A fresh global regex of a kind (a shared global regex would carry `lastIndex` between callers). */
export function maskPattern(kind: MaskKind): RegExp {
  return new RegExp(MASK_SOURCES[kind], "g");
}

/** Luhn check over the digits of `value` (separators are ignored). */
export function luhnValid(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 12) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** ISO 13616 check: move the first four characters to the end, letters to numbers, remainder 97 must be 1. */
export function ibanValid(value: string): boolean {
  const compact = value.replace(/ /g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char >= "A" && char <= "Z" ? char.charCodeAt(0) - 55 : Number(char);
    remainder = Number(`${remainder}${code}`) % 97;
  }
  return remainder === 1;
}

// An IBAN candidate may run into the words after it ("… 1332 AND THEN"): drop trailing groups
// until the checksum holds, and mask only that part. The longest valid prefix wins: in the rare
// case a trailing word also passes the checksum it is masked too, which is better than leaving the
// last digits of an account in clear.
function validIbanPrefix(candidate: string): string | undefined {
  let current = candidate;
  while (current.replace(/ /g, "").length >= 15) {
    if (ibanValid(current)) return current;
    const cut = current.lastIndexOf(" ");
    if (cut === -1) return undefined;
    current = current.slice(0, cut);
  }
  return undefined;
}

type Replacer = (match: string) => { masked: string; hit: boolean };

function replacerOf(kind: MaskKind): Replacer {
  const marker = MASK_MARKERS[kind];
  if (kind === "CARD") return (match) => (luhnValid(match) ? { masked: marker, hit: true } : { masked: match, hit: false });
  if (kind === "IBAN") {
    return (match) => {
      const valid = validIbanPrefix(match);
      return valid === undefined ? { masked: match, hit: false } : { masked: marker + match.slice(valid.length), hit: true };
    };
  }
  return () => ({ masked: marker, hit: true });
}

export interface MaskResult {
  readonly text: string;
  /** How many values of each kind were replaced (kinds with none are absent). */
  readonly counts: Readonly<Partial<Record<MaskKind, number>>>;
  /** Kinds that were replaced at least once, in masking order (for the audit of the normalizer). */
  readonly kinds: readonly MaskKind[];
}

// Upper bound of the fixpoint loop: a replacement only removes digits, so the second pass already
// finds nothing; the bound keeps a pathological input from looping.
const MAX_PASSES = 4;

/**
 * Replaces every value of `kinds` with its typed marker. Kinds run in the order of `MASK_KINDS`
 * (emails and phones before documents, IBAN and CBU before cards, CUIT before DNI), and the passes
 * repeat until nothing changes, so no match of a masked kind is left behind.
 */
export function maskSensitive(text: string, kinds: readonly MaskKind[] = SENSITIVE_KINDS): MaskResult {
  const selected = MASK_KINDS.filter((kind) => kinds.includes(kind));
  const counts: Partial<Record<MaskKind, number>> = {};
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const before = current;
    for (const kind of selected) {
      const replace = replacerOf(kind);
      current = current.replace(maskPattern(kind), (match) => {
        const { masked, hit } = replace(match);
        if (hit) counts[kind] = (counts[kind] ?? 0) + 1;
        return masked;
      });
    }
    if (current === before) break;
  }
  return { text: current, counts, kinds: selected.filter((kind) => counts[kind] !== undefined) };
}

/** `maskSensitive(text, kinds).text`. */
export function maskText(text: string, kinds: readonly MaskKind[] = SENSITIVE_KINDS): string {
  return maskSensitive(text, kinds).text;
}

/** True when `text` still holds a value that `maskSensitive(text, kinds)` would replace. */
export function containsSensitive(text: string, kinds: readonly MaskKind[] = SENSITIVE_KINDS): boolean {
  return maskSensitive(text, kinds).kinds.length > 0;
}

const MARKER_PATTERN = new RegExp(`(?:${Object.values(MASK_MARKERS).map((marker) => marker.replace(/[[\]]/g, "\\$&")).join("|")})`, "g");

/** Removes the markers (the language detector and length checks ignore them). */
export function stripMaskMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, " ");
}
