// Building blocks of the moments (docs/landing-spec.md §7.2.1): rows of operation 4471 in the template
// form of the seed (scripts/seed/lib/items.ts: the entity's fields and the seed's stamp, no keys), with
// the shapes the guest template already uses for the same events in its other operations, and the
// ground truth of the seed for what the reader returns (scripts/seed/data/ReaderCatalog.json). Ids are
// deterministic, so two runs build the same world byte for byte.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DISPATCH_GLOSSARY } from "@legajo/bff/copy/dispatch-glossary";
import { TEMPLATES, renderTemplate } from "@legajo/bff/copy/templates";
import type { WhatsAppTemplateName } from "@legajo/shared";
import { GUEST_TEMPLATE_CLOCK, GUEST_TEMPLATE_FIRM, SEED_REAL_NOW } from "../../../scripts/seed/lib/constants";
import type { WorldTemplateFile } from "../../../scripts/seed/lib/files";
import { type SeedItem, templateItem } from "../../../scripts/seed/lib/items";

export type Tables = { -readonly [Table in keyof WorldTemplateFile["items"]]: SeedItem[] };
type Table = keyof Tables;

export const OP = { operationId: "op-4471", clockId: GUEST_TEMPLATE_CLOCK, firmId: GUEST_TEMPLATE_FIRM } as const;
export const IMPORTER_PHONE = "+5491155510001";
export const SUPPLIER_CONTACT = { contactId: "ctc-qingdao-1", email: "g00-qingdao@sim.legajo.demo.craftech.io" } as const;
export const FIRM_MAILBOX = "estudio-g00@sim.legajo.demo.craftech.io";
export const GUEST_BROKER = "BROKER:brk-guest-00";

/** Simulated instant in Buenos Aires (`15/10 10:00` → `2026-10-15T10:00:00-03:00`). */
export function ar(dayMonth: string, time: string): string {
  const [day = "", month = ""] = dayMonth.split("/");
  return `2026-${month}-${day}T${time}:00-03:00`;
}

/** The same instant in canonical UTC, as messages and timers keep it. */
export function utc(instant: string): string {
  return new Date(instant).toISOString();
}

let sequence = 0;

/** Restarts the ids for a new world, so every build of a moment carries the same ones. */
export function resetIds(): void {
  sequence = 0;
}

function nextId(): string {
  sequence += 1;
  return `01M5LEGAJ0${String(sequence).padStart(4, "0")}`;
}

export function add(tables: Tables, table: Table, entity: Parameters<typeof templateItem>[0], fields: Record<string, unknown>): SeedItem {
  const item = templateItem(entity, { ...OP, ...fields });
  tables[table].push(item);
  return item;
}

/** Replaces the fields of the items of `table` that match. */
export function patch(tables: Tables, table: Table, match: (item: SeedItem) => boolean, fields: (item: SeedItem) => Record<string, unknown>): void {
  tables[table] = tables[table].map((item) => (match(item) ? { ...item, ...fields(item) } : item));
}

export function is4471(entity: string, extra: Record<string, unknown> = {}): (item: SeedItem) => boolean {
  return (item) => item.entity === entity && item.operationId === OP.operationId && Object.entries(extra).every(([key, value]) => item[key] === value);
}

const WA_POLICY = ["CP-CONTROL-BROKER", "CP-KIND-CHANNEL", "CP-RECIPIENT-FENCE", "CP-OPTIN", "CP-OPTOUT", "CP-APPROVED-SCOPE", "CP-WA-24H", "CP-NO-SENSITIVE-ASK", "CP-NO-FOREIGN-LINKS"];
const EMAIL_POLICY = ["CP-CONTROL-BROKER", "CP-KIND-CHANNEL", "CP-RECIPIENT-FENCE", "CP-SUPPLIER-AUTH", "CP-BOUNCED-CONTACT", "CP-APPROVED-SCOPE", "CP-HOURS-SUPPLIER", "CP-ONE-PER-DAY", "CP-NO-SENSITIVE-ASK", "CP-NO-FOREIGN-LINKS"];

interface WhatsAppOut {
  readonly at: string;
  readonly kind: string;
  readonly author?: string;
  readonly template?: { readonly name: WhatsAppTemplateName; readonly params: readonly string[] };
  readonly body?: string;
  readonly buttons?: readonly { readonly action: string; readonly title: string }[];
  readonly interactive?: Record<string, unknown>;
  readonly extraRules?: readonly string[];
}

/** The upload token of the moments' link: synthetic, deterministic, and valid only on the local server. */
export const MOMENT_UPLOAD_TOKEN = createHash("sha256").update("legajo-local-moment-4471").digest("base64url");

/** A WhatsApp the agent (or the code, or the broker) sent to the importer, as the simulated transport records it. */
export function whatsappOut(tables: Tables, out: WhatsAppOut): string {
  const messageId = `msg-${nextId()}`;
  const hasUrl = out.template ? TEMPLATES[out.template.name].buttons.some((button) => button.type === "URL") : false;
  const rendered = out.template ? renderTemplate(out.template.name, out.template.params, hasUrl ? MOMENT_UPLOAD_TOKEN : undefined) : undefined;
  add(tables, "Conversations", "Message", {
    messageId,
    author: out.author ?? "AGENT",
    body: rendered?.body ?? out.body ?? "",
    buttons: out.buttons ?? rendered?.buttons.map((button) => ({ action: button.action, title: button.text, ...(button.url ? { url: button.url } : {}) })) ?? [],
    channel: "WHATSAPP",
    counterpart: "IMPORTER",
    direction: "OUT",
    from: "simulated",
    to: IMPORTER_PHONE,
    importerId: "imp-norpampa",
    kind: out.kind,
    ...(out.template ? { template: { name: out.template.name, params: [...out.template.params] } } : {}),
    ...(out.interactive ? { interactive: out.interactive } : {}),
    policy: { decision: "ALLOW", ruleIds: [...WA_POLICY, ...(out.extraRules ?? [])] },
    refs: {},
    sentAtReal: SEED_REAL_NOW,
    sentAtSim: utc(out.at),
    simulated: true,
    status: "READ",
  });
  return messageId;
}

/** What the importer wrote or tapped, as the simulated phone records it. */
export function whatsappIn(tables: Tables, at: string, body: string, action?: string): string {
  const messageId = `msg-${nextId()}`;
  add(tables, "Conversations", "Message", {
    messageId,
    attachments: [],
    author: "IMPORTER",
    body,
    channel: "WHATSAPP",
    counterpart: "IMPORTER",
    direction: "IN",
    from: IMPORTER_PHONE,
    to: "simulated",
    importerId: "imp-norpampa",
    ...(action ? { interactive: { action, type: "button_reply" } } : {}),
    refs: {},
    sentAtReal: SEED_REAL_NOW,
    sentAtSim: utc(at),
    simulated: true,
    status: "RECEIVED",
    trusted: true,
  });
  return messageId;
}

/** An email of the agent to the supplier from the operation's address, and the copy its simulated mailbox received. */
export function emailOut(tables: Tables, at: string, kind: string, subject: string, body: string, inReplyTo?: string): string {
  const messageId = `msg-${nextId()}`;
  const rfcMessageId = `<${nextId().toLowerCase()}@email.amazonses.com>`;
  add(tables, "Conversations", "Message", {
    messageId,
    author: "AGENT",
    body,
    channel: "EMAIL",
    contactId: SUPPLIER_CONTACT.contactId,
    counterpart: "SUPPLIER",
    direction: "OUT",
    from: "{threadAddress}",
    kind,
    ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}),
    policy: { decision: "ALLOW", ruleIds: EMAIL_POLICY },
    rfcMessageId,
    refs: {},
    sentAtReal: SEED_REAL_NOW,
    sentAtSim: utc(at),
    simulated: false,
    status: "DELIVERED",
    subject,
    to: SUPPLIER_CONTACT.email,
  });
  add(tables, "Conversations", "MailboxMessage", { mailboxAddress: SUPPLIER_CONTACT.email, mailboxMessageId: `mbx-${messageId}`, from: "{threadAddress}", to: SUPPLIER_CONTACT.email, subject, bodyText: body, receivedAtReal: SEED_REAL_NOW, receivedAtSim: utc(at), ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}) });
  return rfcMessageId;
}

/** A reply of the simulated supplier in the operation's thread, with its PDFs. */
export function emailIn(tables: Tables, at: string, subject: string, body: string, inReplyTo: string, attachments: readonly { readonly docVersionId: string; readonly sizeBytes: number }[]): string {
  const messageId = `msg-${nextId()}`;
  add(tables, "Conversations", "Message", {
    messageId,
    attachments: attachments.map((attachment, index) => ({ index, contentType: "application/pdf", sizeBytes: attachment.sizeBytes, status: "ACCEPTED", docVersionId: attachment.docVersionId, s3Key: `sim/${messageId}/${index}.pdf` })),
    author: "SUPPLIER",
    body,
    channel: "EMAIL",
    contactId: SUPPLIER_CONTACT.contactId,
    counterpart: "SUPPLIER",
    direction: "IN",
    from: SUPPLIER_CONTACT.email,
    inReplyTo,
    references: [inReplyTo],
    refs: {},
    sentAtReal: SEED_REAL_NOW,
    sentAtSim: utc(at),
    simulated: true,
    status: "RECEIVED",
    subject,
    to: "{threadAddress}",
    trusted: true,
  });
  return messageId;
}

/** A decision of the audit log (policy or action) at a simulated instant. */
export function decision(tables: Tables, at: string, fields: { readonly action: string; readonly decision: string; readonly actor?: string; readonly ruleIds?: readonly string[]; readonly trigger?: string; readonly refs?: Record<string, unknown>; readonly detail?: Record<string, unknown>; readonly reason?: string }): void {
  add(tables, "AuditLog", "Decision", {
    decisionId: nextId(),
    actor: fields.actor ?? "AGENT",
    action: fields.action,
    decision: fields.decision,
    atReal: SEED_REAL_NOW,
    atSim: at,
    ts: utc(at),
    month: "2026-10",
    evaluated: [],
    ruleIds: [...(fields.ruleIds ?? [])],
    refs: { operationId: OP.operationId, ...(fields.refs ?? {}) },
    ...(fields.trigger ? { trigger: fields.trigger } : {}),
    ...(fields.detail ? { detail: fields.detail } : {}),
    ...(fields.reason ? { reason: fields.reason } : {}),
  });
}

interface CatalogReading {
  readonly sha256: string;
  readonly reading: Record<string, unknown>;
}

const CATALOG = (JSON.parse(readFileSync(new URL("../../../scripts/seed/data/ReaderCatalog.json", import.meta.url), "utf8")) as { readonly items: readonly (Record<string, unknown> & CatalogReading)[] }).items;

/** The reader's ground truth for a document of the seed (`LDOC-4471-PL-v1`). */
export function groundTruth(docId: string): CatalogReading {
  const found = CATALOG.find((item) => item.docId === docId && String(item.PK).startsWith("SHA#"));
  if (!found) throw new Error(`no ground truth for ${docId} in the seed`);
  return { sha256: found.sha256, reading: found.reading };
}

/** A version of a document as the intake keeps it, read by the (mock) reader with the seed's ground truth. */
export function readVersion(tables: Tables, docType: string, short: string, versionNo: number, receivedAt: string, readAt: string, sourceMessageId: string): string {
  const docVersionId = `dv-4471-${short}-${versionNo}`;
  const truth = groundTruth(`LDOC-4471-${short}-v${versionNo}`);
  add(tables, "Operations", "DocumentVersion", {
    docVersionId,
    docType,
    versionNo,
    receivedAtSim: receivedAt,
    readAtSim: readAt,
    readerAttempts: 1,
    reading: { ...truth.reading, matchedBy: "SHA256", readerVersion: "reader-mock-1.0.0", readingId: `rdg-${truth.sha256}-${docVersionId}` },
    s3Key: `ops/op-4471/${docType}/v${String(versionNo).padStart(3, "0")}-${truth.sha256.slice(0, 8)}.pdf`,
    sha256: truth.sha256,
    sizeBytes: 2048,
    source: { channel: "EMAIL", messageId: sourceMessageId, party: "SUPPLIER", contactId: SUPPLIER_CONTACT.contactId },
    state: "READ",
  });
  return docVersionId;
}

/** The status text and its explanation of a dispatch status, from the glossary the importer reads. */
export function dispatchText(key: keyof typeof DISPATCH_GLOSSARY): readonly [string, string] {
  const entry = DISPATCH_GLOSSARY[key];
  return [entry.statusText, entry.explanation];
}
