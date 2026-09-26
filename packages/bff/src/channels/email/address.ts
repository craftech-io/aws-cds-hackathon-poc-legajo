// Strict addresses and header values for everything that goes into or comes out of SES
// (docs/architecture.md §13 "Direcciones", docs/architecture-integrations.md §1 "Encabezados" and "Cerco").
//
// An address is a strict subset of RFC 5322's dot-atom: ASCII only, lower case, no display name, no
// quotes, no comments, no whitespace or control characters, exactly one `@`, a local part of letters,
// digits and `._%+-` without leading, trailing or doubled dots, and a domain of lower-case LDH labels
// with an alphabetic TLD, no trailing dot and no IDN (`xn--`) label. That is also the shape the
// registry stores (`EmailAddress` of domain/common.ts), so a parsed address compares by string
// equality. A received `From` is lower-cased first (`parseReceivedAddress`); a recipient is never
// rewritten: an upper-case domain is refused, not fixed.
import { addressParser } from "postal-mime";
import { ChannelError, isReservedDomain } from "@legajo/shared";

export type AddressProblem =
  | "EMPTY"
  | "TOO_LONG"
  | "CONTROL_CHARACTERS"
  | "NON_ASCII"
  | "WHITESPACE"
  | "SPECIAL_CHARACTERS"
  | "AT_COUNT"
  | "UPPER_CASE"
  | "LOCAL_PART"
  | "TRAILING_DOT"
  | "IDN"
  | "DOMAIN";

export interface ParsedAddress {
  /** `local@domain`, exactly as parsed. */
  readonly address: string;
  readonly local: string;
  readonly domain: string;
}

export type AddressParse = { readonly ok: true; readonly value: ParsedAddress } | { readonly ok: false; readonly problem: AddressProblem };

const MAX_ADDRESS = 254;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;
const LOCAL_PART = /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z]{2,63}$/;

function problemOf(raw: string): AddressProblem | undefined {
  if (raw.length === 0) return "EMPTY";
  if (raw.length > MAX_ADDRESS) return "TOO_LONG";
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "CONTROL_CHARACTERS";
  if (/[^\u0020-\u007e]/.test(raw)) return "NON_ASCII";
  if (/\s/.test(raw)) return "WHITESPACE";
  if (/["\\()<>,;:[\]]/.test(raw)) return "SPECIAL_CHARACTERS";
  if (raw.split("@").length !== 2) return "AT_COUNT";
  if (raw !== raw.toLowerCase()) return "UPPER_CASE";
  return undefined;
}

function domainProblem(domain: string): AddressProblem | undefined {
  if (domain.endsWith(".")) return "TRAILING_DOT";
  if (domain.length === 0 || domain.length > MAX_DOMAIN) return "DOMAIN";
  const labels = domain.split(".");
  if (labels.some((label) => label.startsWith("xn--"))) return "IDN";
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return "DOMAIN";
  return TLD.test(labels[labels.length - 1] ?? "") ? undefined : "DOMAIN";
}

export function parseAddress(raw: string): AddressParse {
  const problem = problemOf(raw);
  if (problem !== undefined) return { ok: false, problem };
  const at = raw.indexOf("@");
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (local.length === 0 || local.length > MAX_LOCAL || !LOCAL_PART.test(local)) return { ok: false, problem: "LOCAL_PART" };
  const bad = domainProblem(domain);
  return bad === undefined ? { ok: true, value: { address: raw, local, domain } } : { ok: false, problem: bad };
}

/** The address of a received `From` or `To`: surrounding spaces trimmed and lower-cased, then parsed strictly. */
export function parseReceivedAddress(raw: string): AddressParse {
  return parseAddress(raw.trim().toLowerCase());
}

// ---- The author of a received mail ---------------------------------------------------------------

/** `addr`, `"Name" <addr>` or `Name <addr>` (an unquoted name without specials, so no second mailbox hides in it). */
const MAILBOX = /^(?:"(?:[^"\\\r\n]|\\.)*"|[^"<>@,;:\\()[\]]*)\s*<([^<>\s]+)>$/;
const ADDRESS_LIKE = /[^\s<>"@,;:()[\]]+@[^\s<>"@,;:()[\]]+/g;

/**
 * The one author of a received mail, from every value of its `From` header: exactly one header that
 * holds exactly one mailbox (no group, no second address), strictly parsed and lower-cased; postal-mime
 * has to read the same single mailbox. Anything else is `undefined`. `dmarcVerdict` speaks for one
 * RFC5322.From only (RFC 7489 §6.6.1 leaves several to the receiver), so an ambiguous author is never
 * trusted, whichever of its mailboxes SES evaluated.
 */
export function singleAuthor(fromValues: readonly string[]): string | undefined {
  if (fromValues.length !== 1) return undefined;
  const value = (fromValues[0] ?? "").trim();
  const angle = MAILBOX.exec(value);
  const parsed = parseReceivedAddress(angle === null ? value : (angle[1] ?? ""));
  if (!parsed.ok) return undefined;
  const entries = addressParser(value);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined || entry.group !== undefined || entry.address.trim().toLowerCase() !== parsed.value.address) return undefined;
  return parsed.value.address;
}

/**
 * Whether SES's `commonHeaders.from` names exactly `author` and nobody else: one value, and every
 * address-shaped token in it is that address (SES may decode the display name, so it is not parsed
 * as a mailbox list here).
 */
export function namesOnly(commonFrom: readonly string[], author: string): boolean {
  if (commonFrom.length !== 1) return false;
  const found = new Set([...(commonFrom[0] ?? "").matchAll(ADDRESS_LIKE)].map((match) => match[0].toLowerCase()));
  return found.size === 1 && found.has(author);
}

/** Exact domain comparison; a look-alike suffix (`sim.legajo….attacker.example`) never matches. */
export function hasDomain(address: ParsedAddress, domain: string): boolean {
  return address.domain === domain;
}

export function isReserved(address: ParsedAddress): boolean {
  return isReservedDomain(address.domain);
}

// ---- Header values -------------------------------------------------------------------------------

/** SES's limit on a header value (the name counts too; 996 characters together). */
const MAX_HEADER_VALUE = 900;
const HEADER_NAME = /^[!-9;-~]{1,126}$/;

/**
 * A header value built from registry data or the agent's input (subject, display name, invoice
 * number): no CR, LF or other control character, bounded length. A value that fails aborts the send
 * with `INVALID` (docs/architecture-integrations.md §1, "Encabezados").
 */
export function assertHeaderValue(name: string, value: string): string {
  if (!HEADER_NAME.test(name)) throw new ChannelError("INVALID", "EMAIL", `invalid header name "${name}"`);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) throw new ChannelError("INVALID", "EMAIL", `header ${name} carries a control character`);
  if (value.trim().length === 0) throw new ChannelError("INVALID", "EMAIL", `header ${name} is empty`);
  if (value.length > MAX_HEADER_VALUE) throw new ChannelError("INVALID", "EMAIL", `header ${name} is longer than ${MAX_HEADER_VALUE} characters`);
  return value;
}

/** RFC 2047 encoded word in base64 (`=?UTF-8?B?…?=`), split so no word passes 75 characters. */
function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    const next = chunk + char;
    if (Buffer.byteLength(next, "utf8") > 45) {
      words.push(chunk);
      chunk = char;
    } else chunk = next;
  }
  if (chunk !== "") words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join(" ");
}

/**
 * `"Estudio Delta via Legajo listo" <op-4471-k7p2q9@legajo.demo.craftech.io>`: the display name as an
 * ASCII quoted string, or RFC 2047-encoded when it holds anything outside printable ASCII.
 */
export function formatMailbox(displayName: string, address: ParsedAddress): string {
  const name = assertHeaderValue("From", displayName.trim());
  const printable = /^[\u0020-\u007e]+$/.test(name);
  const rendered = printable ? `"${name.replace(/["\\]/g, (char) => `\\${char}`)}"` : encodedWords(name);
  return `${rendered} <${address.address}>`;
}

// ---- Message-IDs ---------------------------------------------------------------------------------

const MSG_ID = /<([^<>\s@]{1,250}@[^<>\s@]{1,250})>/g;

/** Every `<id@domain>` of a `Message-ID`, `In-Reply-To` or `References` value, in order, without repeats. */
export function parseMessageIds(value: string | undefined): string[] {
  if (value === undefined) return [];
  const ids: string[] = [];
  for (const match of value.matchAll(MSG_ID)) {
    const id = `<${match[1] ?? ""}>`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Domain of the `Message-ID` SES gives every mail it sends (`<SesMessageId@email.amazonses.com>`). */
export const SES_MESSAGE_ID_DOMAIN = "email.amazonses.com";

/** `<SesMessageId@email.amazonses.com>` of a mail we sent. */
export function sesRfcMessageId(sesMessageId: string): string {
  return `<${sesMessageId}@${SES_MESSAGE_ID_DOMAIN}>`;
}

/** The SES message id inside one of our `Message-ID`s, or `undefined` for anyone else's. */
export function sesMessageIdOf(rfcMessageId: string): string | undefined {
  const match = /^<([A-Za-z0-9-]{1,128})@email\.amazonses\.com>$/.exec(rfcMessageId.trim());
  return match?.[1];
}
