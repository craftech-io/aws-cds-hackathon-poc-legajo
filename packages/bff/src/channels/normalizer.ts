// Every inbound text becomes data here, before anything stores it or shows it to the model
// (docs/architecture-integrations.md §2 step 6, docs/architecture.md §13, docs/design-brief.md §5.2):
//
//   1. the body of an email is its `text/plain` part, or its HTML as text (channels/email/html-text.ts);
//      quoted replies, `On … wrote:` headers and signatures are cut;
//   2. control characters go, line breaks are unified and runs of blank lines collapse;
//   3. CUIT/CUIL, DNI, CBU/CVU, cards (Luhn) and IBAN become typed markers (`[CUIT]`, `[CBU]`, …)
//      with the patterns of lib/mask.ts, the only source (also of lib/log.ts and of G1's regexes);
//   4. the text is capped at 4,000 characters; the caller audits a cut (`truncated`).
//
// The turn envelope then carries the text escaped (`<`, `>`, `&`, quotes) inside a block whose tag
// has a random suffix per turn, so an importer or a supplier can never close it and forge an
// `<event>`, `<facts>` or `<session>`. The subject, the file names and a PDF's metadata never reach
// that block: callers keep them on the stored message only.
import { randomBytes } from "node:crypto";
import { type MaskKind, SENSITIVE_KINDS, maskSensitive } from "../lib/mask";
import { htmlToText } from "./email/html-text";

/** Longest inbound text that is stored and shown to the model (docs/architecture-integrations.md §2). */
export const INBOUND_MAX_CHARS = 4_000;

export interface NormalizedText {
  /** Masked text, at most `INBOUND_MAX_CHARS` characters. */
  readonly text: string;
  /** The text was cut; the caller audits it. */
  readonly truncated: boolean;
  /** Characters of the masked text before the cut. */
  readonly originalChars: number;
  /** Kinds that were masked at least once, in masking order. */
  readonly masked: readonly MaskKind[];
  readonly maskCounts: Readonly<Partial<Record<MaskKind, number>>>;
}

// C0 and C1 controls except tab and line feed, plus the invisible format characters an attacker
// uses to hide or reorder text (zero-width, bidi overrides, BOM).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// A cut in the middle of a marker leaves "[CU": drop the partial marker.
const PARTIAL_MARKER = /\[[A-Z]{0,8}$/;

function cleanWhitespace(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Steps 2-4 for any inbound text (a WhatsApp message, an email body, a button's free text). */
export function normalizeInboundText(raw: string, maxChars: number = INBOUND_MAX_CHARS): NormalizedText {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError(`maxChars must be a positive integer, got ${maxChars}`);
  const { text: masked, counts, kinds } = maskSensitive(cleanWhitespace(raw), SENSITIVE_KINDS);
  const chars = [...masked];
  if (chars.length <= maxChars) return { text: masked, truncated: false, originalChars: chars.length, masked: kinds, maskCounts: counts };
  const cut = chars.slice(0, maxChars).join("").replace(PARTIAL_MARKER, "").trimEnd();
  return { text: cut, truncated: true, originalChars: chars.length, masked: kinds, maskCounts: counts };
}

// ---- Email bodies ------------------------------------------------------------------------------

// "On Tue, 15 Oct 2026 at 10:00, Someone <x@y> wrote:" (possibly wrapped on two lines), its Spanish
// form "El … escribió:", and the separators of Outlook-style forwards and replies.
const REPLY_HEADER = /^(?:on\s.{0,300}?\bwrote:|el\s.{0,300}?\bescribi[oó]:)\s*$/i;
const ORIGINAL_MESSAGE = /^-{2,}\s*(?:original message|mensaje original|forwarded message|mensaje reenviado)\s*-{2,}\s*$/i;
const OUTLOOK_HEADER = /^(?:from|de):\s.+$/i;
const OUTLOOK_NEXT = /^(?:sent|date|enviado|fecha|to|para|subject|asunto):\s/i;

/**
 * Cuts what the sender did not write in this message: every quoted line (`>`), everything from a
 * reply header (`On … wrote:`), an "Original Message" separator or an Outlook `From:`/`Sent:` block,
 * and the signature after the `-- ` delimiter.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (line === "-- " || trimmed === "--") break;
    if (ORIGINAL_MESSAGE.test(trimmed)) break;
    if (REPLY_HEADER.test(trimmed) || REPLY_HEADER.test(`${trimmed} ${(lines[index + 1] ?? "").trim()}`)) break;
    if (OUTLOOK_HEADER.test(trimmed) && OUTLOOK_NEXT.test((lines[index + 1] ?? "").trim())) break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export interface EmailBodyParts {
  readonly text?: string | undefined;
  readonly html?: string | undefined;
}

/** Step 1: the `text/plain` part if it exists (and says something), else the HTML as text. */
export function emailBodyText(parts: EmailBodyParts): string {
  if (parts.text !== undefined && parts.text.trim() !== "") return parts.text;
  return parts.html === undefined ? "" : htmlToText(parts.html);
}

/** Steps 1-4 for the body of an email. */
export function normalizeEmailBody(parts: EmailBodyParts, maxChars: number = INBOUND_MAX_CHARS): NormalizedText {
  return normalizeInboundText(stripQuotedReply(emailBodyText(parts)), maxChars);
}

// ---- The untrusted block of the turn envelope --------------------------------------------------

/** `inbound-<6 hex>`: the tag of the untrusted block, new every turn and named by that turn's system prompt. */
export const TURN_DELIMITER_PATTERN = /^inbound-[0-9a-f]{6}$/;

export function newTurnDelimiter(random: (size: number) => Uint8Array = randomBytes): string {
  const delimiter = `inbound-${Buffer.from(random(3)).toString("hex")}`;
  if (!TURN_DELIMITER_PATTERN.test(delimiter)) throw new RangeError("a turn delimiter needs 3 random bytes");
  return delimiter;
}

/** `&`, `<`, `>` and both quotes as entities: the text can hold no tag and close no attribute. */
export function escapeUntrusted(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export type BlockAttributes = Readonly<Record<string, string | number | boolean>>;

/**
 * `<inbound-7f3a9c channel="EMAIL" from-role="SUPPLIER" trusted="true" truncated="false">…</inbound-7f3a9c>`:
 * the text (already normalized) escaped inside the turn's delimiter.
 */
export function untrustedBlock(delimiter: string, text: string, attributes: BlockAttributes = {}): string {
  if (!TURN_DELIMITER_PATTERN.test(delimiter)) throw new RangeError("not a turn delimiter");
  const rendered = Object.entries(attributes).map(([name, value]) => {
    if (!ATTRIBUTE_NAME.test(name)) throw new RangeError(`invalid attribute name "${name}"`);
    return ` ${name}="${escapeUntrusted(String(value))}"`;
  });
  return `<${delimiter}${rendered.join("")}>\n${escapeUntrusted(text)}\n</${delimiter}>`;
}
