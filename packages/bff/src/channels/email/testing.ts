// Test world of the email channel: the in-memory connector with a slice of the demo world
// (`firm-delta`, op 4471 of `sup-qingdao` with an ACTIVE and a PENDING_CONFIRMATION contact, op 4483 of
// `sup-santosverde`), thread addresses whose tags verify with a fixed test key, a paused clock, an
// in-memory mail store, a recording queue sink and builders of the receipt events of SES.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeThreadTag, threadAddress } from "@legajo/shared";
import { CLOCK, FIRM, REAL_NOW, contactFixture, hashOf, importerFixture, memoryStores, operationFixture, supplierFixture } from "../../connector/testing";
import type { MemoryStores } from "../../connector/memory/index";
import type { Operation } from "../../domain/operations";
import { createLogger } from "../../lib/log";
import type { ChannelEvent, ChannelEventSink } from "../adapter";
import type { FenceDeps } from "./fence";
import type { InboundEmailDeps } from "./inbound";
import type { MailStore } from "./store";
import { resolveThread } from "./thread";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const STAGE = "poc";
/** Fixed test key of the thread tags (never a secret of the stage). */
export const TEST_THREAD_KEY = new TextEncoder().encode("legajo-test-thread-key-0123456789ab");
/** Simulated instant of the paused demo clock in these tests. */
export const SIM_NOW = "2026-10-15T22:10:00.000Z";

export const QINGDAO = "supplier-qingdao@sim.legajo.demo.craftech.io";
export const QINGDAO_PENDING = "supplier-qingdao-ops@sim.legajo.demo.craftech.io";
export const SANTOSVERDE = "supplier-santosverde@sim.legajo.demo.craftech.io";
/** SES id of the outbound request the fixture `reply.eml` answers (`In-Reply-To`). */
export const ANSWERED_SES_ID = "0100019a2b3c4d5e-6f708192-a3b4-45c6-97d8-e9fa0b1c2d3e-000000";
/** `X-Legajo-Mail-Id` of `reply.eml`. */
export const REPLY_MAIL_ID = "01JQ7ZK8X4M2N6P9R3T5V7W9Y1";

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

export function jsonFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

export interface EmailWorld {
  readonly stores: MemoryStores;
  readonly op4471: Operation;
  readonly op4483: Operation;
  readonly mailStore: MailStore & { readonly raw: Map<string, Uint8Array>; readonly quarantined: Map<string, Uint8Array> };
  readonly sink: ChannelEventSink & { readonly events: ChannelEvent[] };
  readonly lines: string[];
}

async function tagOf(operationNumber: string, clockId: string = CLOCK, worldEpoch = 1): Promise<string> {
  return computeThreadTag(TEST_THREAD_KEY, { operationNumber, clockId, worldEpoch });
}

async function createOperation(stores: MemoryStores, operationNumber: string, supplierId: string, overrides: Parameters<typeof operationFixture>[0] = {}): Promise<Operation> {
  const clockId = overrides.clockId ?? CLOCK;
  const threadTag = await tagOf(operationNumber, clockId, overrides.worldEpoch ?? 1);
  const input = operationFixture({ operationNumber, threadTag, supplierId, ...overrides });
  return stores.connector.operations.createOperation({ ...input, threadAddress: threadAddress(operationNumber, threadTag), threadClaimHash: hashOf(threadAddress(operationNumber, threadTag)) });
}

export async function emailWorld(): Promise<EmailWorld> {
  const stores = memoryStores();
  const { parties, world } = stores.connector;
  await parties.createImporter(importerFixture());
  await parties.createSupplier(supplierFixture());
  await parties.createContact(contactFixture({ email: QINGDAO, emailHash: hashOf(QINGDAO) }));
  await parties.createContact(contactFixture({ contactId: "ctc-qingdao-2", email: QINGDAO_PENDING, emailHash: hashOf(QINGDAO_PENDING), status: "PENDING_CONFIRMATION", confirmedBy: undefined, confirmedAt: undefined }));
  await parties.createSupplier(supplierFixture({ supplierId: "sup-santosverde", name: "Santos Verde Alimentos Ltda", country: "BR", timezone: "America/Sao_Paulo", behaviour: "INJECTION" }));
  await parties.createContact(contactFixture({ contactId: "ctc-santosverde-1", supplierId: "sup-santosverde", email: SANTOSVERDE, emailHash: hashOf(SANTOSVERDE) }));
  await world.createClock({ clockId: CLOCK, firmId: FIRM, mode: "PAUSED", pausedSimNow: SIM_NOW, startAtSim: "2026-10-14T13:30:00.000Z", worldEpoch: 1 });
  const op4471 = await createOperation(stores, "4471", "sup-qingdao");
  const op4483 = await createOperation(stores, "4483", "sup-santosverde", { invoiceNumber: "SVA-2026-0311" });

  const raw = new Map<string, Uint8Array>();
  const quarantined = new Map<string, Uint8Array>();
  const mailStore = {
    raw,
    quarantined,
    rawKey: (sesMessageId: string) => `${STAGE}/ops/${sesMessageId}`,
    readRaw: async (sesMessageId: string) => {
      const bytes = raw.get(`${STAGE}/ops/${sesMessageId}`);
      if (bytes === undefined) throw new Error(`no raw mail for ${sesMessageId}`);
      return bytes;
    },
    putQuarantine: async (key: string, bytes: Uint8Array) => {
      quarantined.set(key, bytes);
    },
  };
  const events: ChannelEvent[] = [];
  const sink = {
    events,
    enqueue: async (event: ChannelEvent) => {
      await stores.connector.world.markInFlight({ operationId: event.operationId, clockId: event.clockId, eventId: event.eventId });
      events.push(event);
    },
  };
  return { stores, op4471, op4483, mailStore, sink, lines: [] };
}

export function inboundDeps(world: EmailWorld): InboundEmailDeps {
  return {
    data: world.stores.connector,
    store: world.mailStore,
    events: world.sink,
    threadKey: TEST_THREAD_KEY,
    now: () => new Date(REAL_NOW),
    log: createLogger({ correlationId: "corr-inbound-test", level: "debug", sink: (line) => world.lines.push(line) }),
  };
}

export function fenceDeps(world: EmailWorld, demoRecipients: readonly string[] = []): FenceDeps {
  return {
    resolveThread: (address) => resolveThread({ operations: world.stores.connector.operations, world: world.stores.connector.world, threadKey: TEST_THREAD_KEY, now: () => new Date(REAL_NOW) }, address),
    parties: world.stores.connector.parties,
    emailHash: hashOf,
    demoRecipients: () => demoRecipients,
  };
}

export interface ReceiptOptions {
  readonly sesMessageId: string;
  readonly recipient: string;
  readonly fromHeader?: string;
  readonly rfcMessageId?: string;
  readonly mailIdHeader?: string | null;
  readonly verdicts?: Partial<Record<"spamVerdict" | "virusVerdict" | "spfVerdict" | "dkimVerdict" | "dmarcVerdict", string>>;
}

interface ReceiptShape {
  Records: Array<{ ses: { mail: Record<string, unknown> & { headers: Array<{ name: string; value: string }>; commonHeaders: Record<string, unknown> }; receipt: Record<string, unknown> } }>;
}

/** `receipt.json` (the real shape of a receipt rule's Lambda event) with the given ids, recipient and verdicts. */
export function receiptEvent(options: ReceiptOptions): unknown {
  const event = jsonFixture<ReceiptShape>("receipt.json");
  const record = event.Records[0];
  if (record === undefined) throw new Error("receipt.json has no record");
  const { mail, receipt } = record.ses;
  mail.messageId = options.sesMessageId;
  mail.destination = [options.recipient];
  receipt.recipients = [options.recipient];
  const from = options.fromHeader ?? `"Qingdao Bluewave Textiles Co., Ltd." <${QINGDAO}>`;
  mail.commonHeaders = { ...mail.commonHeaders, from: [from], to: [options.recipient], ...(options.rfcMessageId === undefined ? {} : { messageId: options.rfcMessageId }) };
  mail.headers = mail.headers
    .filter((header) => header.name !== "X-Legajo-Mail-Id" || options.mailIdHeader !== null)
    .map((header) => (header.name === "X-Legajo-Mail-Id" && typeof options.mailIdHeader === "string" ? { ...header, value: options.mailIdHeader } : header.name === "From" ? { ...header, value: from } : header));
  for (const [name, status] of Object.entries(options.verdicts ?? {})) receipt[name] = { status };
  return event;
}

/** Stores the raw MIME where the receipt rule's S3 action would have written it. */
export function deliver(world: EmailWorld, sesMessageId: string, raw: Uint8Array): void {
  world.mailStore.raw.set(world.mailStore.rawKey(sesMessageId), raw);
}

/** The documents request of op 4471 that `reply.eml` answers (`In-Reply-To`), as the pipeline recorded it. */
export async function seedAnsweredRequest(world: EmailWorld): Promise<void> {
  await world.stores.connector.conversations.appendMessage({
    messageId: "msg-4471out1",
    operationId: world.op4471.operationId,
    firmId: FIRM,
    clockId: CLOCK,
    direction: "OUT",
    channel: "EMAIL",
    kind: "DOCS_REQUEST",
    counterpart: "SUPPLIER",
    contactId: "ctc-qingdao-1",
    to: QINGDAO,
    from: world.op4471.threadAddress,
    body: "Hello, we are still missing the packing list and the certificate of origin of invoice QBT-2026-0917.",
    status: "SENT",
    author: "AGENT",
    sentAtSim: "2026-10-15T12:00:00.000Z",
    sentAtReal: REAL_NOW,
    providerMessageId: ANSWERED_SES_ID,
    rfcMessageId: `<${ANSWERED_SES_ID}@email.amazonses.com>`,
  });
}

/** The pending item SimMail's reply opened before its `SendEmail` (awaiting `INBOUND`). */
export async function seedPending(world: EmailWorld, input: { readonly mailId: string; readonly from: string; readonly to?: string }): Promise<void> {
  await world.stores.connector.world.putMailPending({
    clockId: CLOCK,
    mailId: input.mailId,
    from: input.from,
    to: input.to ?? world.op4471.threadAddress,
    profile: "SIMULATOR",
    awaiting: "INBOUND",
    sentAtReal: REAL_NOW,
  });
}

export interface MimeOptions {
  readonly from: string;
  readonly messageId: string;
  readonly headers?: readonly string[];
  readonly text?: string;
  readonly pdfs?: number;
}

/** A small MIME message for the variants the fixtures do not cover (same shape as the fixtures). */
export function mime(options: MimeOptions): Uint8Array {
  const boundary = "=_legajo_test";
  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");
  const parts = [`--${boundary}`, 'Content-Type: text/plain; charset="utf-8"', "", options.text ?? "Please find the documents attached."];
  for (let index = 0; index < (options.pdfs ?? 0); index += 1) {
    parts.push(`--${boundary}`, `Content-Type: application/pdf; name="doc-${index}.pdf"`, `Content-Disposition: attachment; filename="doc-${index}.pdf"`, "Content-Transfer-Encoding: base64", "", pdf);
  }
  const lines = [`From: ${options.from}`, "To: op-4471@legajo.demo.craftech.io", "Subject: Documents", `Message-ID: ${options.messageId}`, ...(options.headers ?? []), "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts, `--${boundary}--`, ""];
  return new TextEncoder().encode(lines.join("\r\n"));
}

export { CLOCK, FIRM, REAL_NOW };
