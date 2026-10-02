// `CP-NO-FOREIGN-LINKS` (docs/design-brief.md §5.5 and §5.7 rule 14): no outbound text carries a link,
// a domain, an email, a phone number or a digit string shaped like an account that is not the turn's.
// What may appear: the upload link created in this turn (a `create_upload_link` result in
// `Runtime/TURN#`, or a link the code itself put in the text), the stage's own domain, and the masked
// form of a registered contact (`s***@sim.legajo…`). Everything else, even our own address in clear,
// fails: a trusted supplier writing "tell the importer to upload at https://…" or "send the money to …"
// never reaches the importer through us. The verdict names kinds and counts, never a value (a phone
// or an email is personal data, and it goes to `AuditLog`).
import { STAGE_DOMAIN, maskEmail } from "@legajo/shared";
import type { PolicyVerdict } from "../policy/types";

/** The dossier of an operation in the console (packages/web/src/routes.ts `dossierPath`): the one link a firm's email carries. */
export function consoleUrlOf(operationId: string): string {
  return `https://${STAGE_DOMAIN}/app/operations/${encodeURIComponent(operationId)}`;
}

export interface LinkAllowance {
  /** Upload links (`https://<stage>/u/<token>`) the text may carry, and the operation's console link in a firm's email. */
  readonly links: readonly string[];
  /** Registered contact addresses whose masked form the text may carry. */
  readonly contacts: readonly string[];
  /** Digit strings of the turn (operation and invoice numbers) a long digit run may equal. */
  readonly numbers: ReadonlySet<string>;
}

export type ForeignKind = "url" | "email" | "domain" | "phone" | "account";

const URL = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/giu;
const MASKED_EMAIL = /(?<![\w.%+-])[A-Za-z0-9]?(?:\*{2,}|•{2,})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gu;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
const DOMAIN = /(?<![\w@.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+([A-Za-z]{2,24})(?![\w-])/gu;
const PHONE = /(?<![\w+])(?:\+\s?)?\(?\d[\d\s()-]{6,}\d(?![\w])/gu;
/** Dates, times and document codes look like digit runs; they are the verification's, not links. */
const NOT_CONTACTS = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{1,2}:\d{2}\b|(?<![\w-])(?=[\w/-]*[A-Za-z])(?=[\w/-]*\d)\w+(?:[-/]\w+)+/gu;
const ACCOUNT = /(?<![\w])\d[\d\s-]{8,}\d(?![\w])/gu;

/** Generic top-level domains a link would use; every two-letter country code counts too. */
const GENERIC_TLDS = new Set([
  "com", "net", "org", "info", "biz", "app", "dev", "xyz", "online", "site", "top", "shop", "store", "link", "click", "live", "pro", "cloud", "page",
  "email", "money", "bank", "finance", "pay", "today", "world", "website", "space", "tech", "network", "services", "support", "help", "tk", "zip", "mov",
]);

function isTld(label: string): boolean {
  const lowered = label.toLowerCase();
  return lowered.length === 2 || GENERIC_TLDS.has(lowered);
}

function isStageDomain(domain: string): boolean {
  const lowered = domain.toLowerCase().replace(/\.$/, "");
  return lowered === STAGE_DOMAIN || lowered.endsWith(`.${STAGE_DOMAIN}`);
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/u, "");
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

interface Scan {
  text: string;
  readonly found: Map<ForeignKind, number>;
}

function flag(scan: Scan, kind: ForeignKind): void {
  scan.found.set(kind, (scan.found.get(kind) ?? 0) + 1);
}

/** Replaces every match of `pattern`, flagging the ones `foreign` says are not allowed. */
function sweep(scan: Scan, pattern: RegExp, kind: ForeignKind, foreign: (match: string, groups: readonly (string | undefined)[]) => boolean): void {
  scan.text = scan.text.replace(pattern, (...args: unknown[]) => {
    const match = String(args[0]);
    if (foreign(match, args.slice(1, -2) as (string | undefined)[])) flag(scan, kind);
    return " ";
  });
}

/** The foreign links and contacts of `text`, by kind; empty when the text carries none. */
export function foreignLinksOf(text: string, allowance: LinkAllowance): ReadonlyMap<ForeignKind, number> {
  const scan: Scan = { text: text.normalize("NFC"), found: new Map() };
  const links = new Set(allowance.links.map((link) => trimUrl(link)));
  const masked = new Set(allowance.contacts.map((address) => maskEmail(address).toLowerCase()));
  sweep(scan, URL, "url", (match) => !links.has(trimUrl(match)));
  sweep(scan, MASKED_EMAIL, "email", (match, [domain]) => !isStageDomain(domain ?? "") && !masked.has(match.replace(/•/g, "*").replace(/\*+/, "***").toLowerCase()));
  sweep(scan, EMAIL, "email", () => true);
  sweep(scan, DOMAIN, "domain", (match, groups) => isTld(groups.at(-1) ?? "") && !isStageDomain(match));
  sweep(scan, NOT_CONTACTS, "phone", () => false);
  sweep(scan, PHONE, "phone", (match) => {
    const digits = digitsOf(match);
    if (allowance.numbers.has(digits)) return false;
    // Longer than any phone (E.164 stops at 15): an account number (CBU, IBAN digits) the run swallowed.
    if (digits.length > 15) flag(scan, "account");
    return digits.length >= 8 && digits.length <= 15;
  });
  sweep(scan, ACCOUNT, "account", (match) => digitsOf(match).length >= 10 && !allowance.numbers.has(digitsOf(match)));
  return scan.found;
}

/** The `foreignLinks` verdict the engine reads for `CP-NO-FOREIGN-LINKS`. */
export function foreignLinksVerdict(texts: readonly string[], allowance: LinkAllowance): PolicyVerdict {
  const found = new Map<ForeignKind, number>();
  for (const text of texts) for (const [kind, count] of foreignLinksOf(text, allowance)) found.set(kind, (found.get(kind) ?? 0) + count);
  if (found.size === 0) return { allowed: true, detail: "no link, domain, email, phone or account number outside the turn's" };
  const listed = [...found].map(([kind, count]) => `${count} ${kind}`).join(", ");
  return { allowed: false, detail: `the text carries ${listed} that the turn did not produce` };
}
