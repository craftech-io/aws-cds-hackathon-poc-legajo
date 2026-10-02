// Test world of `SimMail`: the email channel's world (channels/email/testing.ts: firm `firm-delta`,
// op 4471 of `sup-qingdao` and op 4483 of `sup-santosverde` with their ACTIVE mailboxes, a paused
// clock), the firm's mailbox claim, outbound messages recorded the way the pipeline and the
// escalations record them, their pending mails, the raw MIME of the `sim` route, an in-memory seed
// of template PDFs, and the single SES client over a mocked SES.
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { type DocType, type MessageKind, type SupplierBehaviour, computeThreadTag, threadAddress } from "@legajo/shared";
import { createEmailClient } from "../channels/email/outbound";
import { CLOCK, FIRM, REAL_NOW, TEST_THREAD_KEY, type EmailWorld, emailWorld, fenceDeps, receiptEvent } from "../channels/email/testing";
import { resolveThread } from "../channels/email/thread";
import { contactFixture, hashOf, operationFixture, supplierFixture } from "../connector/testing";
import type { Message } from "../domain/conversations";
import type { Operation } from "../domain/operations";
import { createLogger } from "../lib/log";
import type { ScheduleSpec, SchedulerPort } from "../timers/scheduler-client";
import type { SimMailDeps } from "./receive";
import type { SeedPdfStore } from "./seed-pdfs";

export { CLOCK, FIRM, REAL_NOW, QINGDAO, QINGDAO_PENDING, SANTOSVERDE, SIM_NOW } from "../channels/email/testing";

export const FIRM_MAILBOX = "estudio-delta@sim.legajo.demo.craftech.io";
export const SIGNUP_MAILBOX = "qa-signup-812-1-a@sim.legajo.demo.craftech.io";
export const INJECTOR = "qainject-812-1-sc15@sim.legajo.demo.craftech.io";

/** Versions of every template PDF of the seed slice: op 4471 has PL v2, op 4479 has CO v3 (docs/seed-spec.md §8). */
export const SEED_VERSIONS: Readonly<Record<string, Partial<Record<DocType, number>>>> = {
  "op-4471": { COMMERCIAL_INVOICE: 1, PACKING_LIST: 2, CERTIFICATE_OF_ORIGIN: 1 },
  "op-4479": { COMMERCIAL_INVOICE: 1, PACKING_LIST: 1, CERTIFICATE_OF_ORIGIN: 3 },
  "op-4483": { COMMERCIAL_INVOICE: 1, PACKING_LIST: 1, CERTIFICATE_OF_ORIGIN: 1 },
};

/** The bytes of a template PDF in the fake seed: recognizable in a test, `%PDF-` for the client's check. */
export function templateBytes(templateOperation: string, docType: DocType, version: number): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${templateOperation} ${docType} v${version}\n%%EOF\n`);
}

export function fakeSeed(): SeedPdfStore & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    unknownCount: 3,
    latestVersion: async (templateOperation, docType) => {
      const version = SEED_VERSIONS[templateOperation]?.[docType];
      if (version === undefined) throw new Error(`no ${docType} of ${templateOperation} in the fake seed`);
      return version;
    },
    read: async (templateOperation, docType, version) => {
      if (version > (SEED_VERSIONS[templateOperation]?.[docType] ?? 0)) throw new Error("not in the fake seed");
      reads.push(`${templateOperation}/${docType}-v${version}`);
      return templateBytes(templateOperation, docType, version);
    },
    readUnknown: async (index) => {
      reads.push(`unknown/${index}`);
      return new TextEncoder().encode(`%PDF-1.4\n% unknown ${index}\n%%EOF\n`);
    },
  };
}

/** An in-memory Scheduler: what a RUNNING world asked for, by schedule name. */
export function fakeScheduler(): SchedulerPort & { readonly schedules: Map<string, ScheduleSpec>; readonly deleted: string[] } {
  const schedules = new Map<string, ScheduleSpec>();
  const deleted: string[] = [];
  return {
    schedules,
    deleted,
    put: async (spec) => {
      schedules.set(spec.name, spec);
    },
    delete: async (name) => {
      deleted.push(name);
      schedules.delete(name);
    },
  };
}

export interface SimWorld {
  readonly email: EmailWorld;
  readonly scheduler: ReturnType<typeof fakeScheduler>;
  readonly raw: Map<string, Uint8Array>;
  readonly seed: ReturnType<typeof fakeSeed>;
  readonly lines: string[];
  readonly deps: SimMailDeps;
}

export async function simWorld(): Promise<SimWorld> {
  const email = await emailWorld();
  await email.stores.connector.parties.claimAddress({ addressHash: hashOf(FIRM_MAILBOX), kind: "EMAIL", ownerType: "FIRM", ownerId: FIRM, firmId: FIRM, clockId: CLOCK });
  const raw = new Map<string, Uint8Array>();
  const seed = fakeSeed();
  const scheduler = fakeScheduler();
  const lines: string[] = [];
  const log = createLogger({ correlationId: "corr-sim-mail-test", level: "debug", sink: (line) => lines.push(line) });
  const data = email.stores.connector;
  const now = () => new Date(REAL_NOW);
  let sequence = 0;
  const client = createEmailClient({
    fence: fenceDeps(email),
    world: data.world,
    runtime: data.runtime,
    audit: data.audit,
    configurationSet: (profile) => `aws-cds-hackathon-poc-legajo-${profile === "SYSTEM" ? "email" : "sim"}-poc`,
    stage: "poc",
    now,
    newMailId: () => `01JQSIMREPLY${String(++sequence).padStart(14, "0")}`,
    log,
    ses: new SESv2Client({ region: "us-east-1" }),
  });
  const deps: SimMailDeps = {
    data,
    store: {
      readRaw: async (sesMessageId) => {
        const bytes = raw.get(sesMessageId);
        if (bytes === undefined) throw new Error(`no raw mail for ${sesMessageId}`);
        return bytes;
      },
    },
    email: client,
    seed,
    resolveThread: (address) => resolveThread({ operations: data.operations, world: data.world, threadKey: TEST_THREAD_KEY, now }, address),
    emailHash: hashOf,
    scheduler,
    now,
    log,
  };
  return { email, scheduler, raw, seed, lines, deps };
}

export interface ExtraOperation {
  readonly number: string;
  readonly templateOperation: string;
  readonly clockId?: string;
  readonly firmId?: string;
  /** A supplier of its own with this ACTIVE mailbox; else the operation is `sup-qingdao`'s. */
  readonly mailbox?: string;
  readonly behaviour?: SupplierBehaviour;
}

/** Another operation with a verified thread address (another model operation, or a QA world). */
export async function addOperation(world: SimWorld, input: ExtraOperation): Promise<Operation> {
  const { parties, operations, world: state } = world.email.stores.connector;
  const clockId = input.clockId ?? CLOCK;
  const firmId = input.firmId ?? FIRM;
  if ((await state.findClock(clockId)) === undefined) await state.createClock({ clockId, firmId, mode: "PAUSED", pausedSimNow: "2026-10-15T22:10:00.000Z", startAtSim: "2026-10-15T12:58:00.000Z", worldEpoch: 1 });
  let supplierId = "sup-qingdao";
  if (input.mailbox !== undefined) {
    supplierId = `sup-x${input.number}`;
    await parties.createSupplier(supplierFixture({ supplierId, firmId, clockId, ...(input.behaviour === undefined ? {} : { behaviour: input.behaviour }) }));
    await parties.createContact(contactFixture({ contactId: `ctc-x${input.number}-1`, supplierId, firmId, clockId, email: input.mailbox, emailHash: hashOf(input.mailbox) }));
  }
  const tag = await computeThreadTag(TEST_THREAD_KEY, { operationNumber: input.number, clockId, worldEpoch: 1 });
  const address = threadAddress(input.number, tag);
  const fixture = operationFixture({ operationId: `op-${input.number}`, operationNumber: input.number, firmId, clockId, supplierId, templateOperation: input.templateOperation, threadTag: tag, threadAddress: address });
  return operations.createOperation({ ...fixture, threadClaimHash: hashOf(address) });
}

export interface OutboundOptions {
  readonly messageId: string;
  readonly providerMessageId: string;
  readonly to: string;
  readonly from?: string;
  readonly operationId?: string;
  readonly firmId?: string;
  readonly clockId?: string;
  readonly counterpart?: Message["counterpart"];
  readonly kind?: MessageKind;
  readonly docTypes?: readonly DocType[];
  readonly subject?: string;
  readonly mailId?: string;
}

/** A `Message OUT` as the pipeline (or an escalation) records it, and its pending mail (`awaiting SIMMAIL`). */
export async function recordOutbound(world: SimWorld, options: OutboundOptions): Promise<Message> {
  const operation = await world.email.stores.connector.operations.getOperation(options.operationId ?? "op-4471");
  const from = options.from ?? operation.threadAddress;
  const message = await world.email.stores.connector.conversations.appendMessage({
    messageId: options.messageId,
    operationId: operation.operationId,
    firmId: options.firmId ?? operation.firmId,
    clockId: options.clockId ?? operation.clockId,
    direction: "OUT",
    channel: "EMAIL",
    kind: options.kind ?? "DOCS_REQUEST",
    counterpart: options.counterpart ?? "SUPPLIER",
    to: options.to,
    from,
    body: "Hello, please send the documents of invoice QBT-2026-0917.",
    subject: options.subject ?? "[Op 4471] Missing documents: packing list, certificate of origin (Invoice QBT-2026-0917)",
    status: "SENT",
    author: "AGENT",
    sentAtSim: "2026-10-15T22:00:00.000Z",
    sentAtReal: REAL_NOW,
    providerMessageId: options.providerMessageId,
    rfcMessageId: `<${options.providerMessageId}@email.amazonses.com>`,
    refs: { docTypes: [...(options.docTypes ?? ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"])] },
    ...(options.mailId === undefined ? {} : { mailId: options.mailId }),
  });
  if (options.mailId !== undefined) {
    await world.email.stores.connector.world.putMailPending({ clockId: message.clockId, mailId: options.mailId, operationId: message.operationId, from, to: options.to, profile: "SYSTEM", awaiting: "SIMMAIL", sentAtReal: REAL_NOW });
  }
  return message;
}

export interface SimMimeOptions {
  readonly from: string;
  readonly to: string;
  readonly messageId: string;
  readonly subject?: string;
  readonly operationNumber?: string;
  readonly request?: string;
  readonly headers?: readonly string[];
  readonly text?: string;
  readonly html?: string;
}

/** The raw MIME of one of our emails as the `sim` route stores it. */
export function simMime(options: SimMimeOptions): Uint8Array {
  const own = [
    ...(options.operationNumber === undefined ? [] : [`X-Legajo-Operation: ${options.operationNumber}`]),
    ...(options.request === undefined ? [] : [`X-Legajo-Request: ${options.request}`]),
    ...(options.headers ?? []),
  ];
  const body =
    options.html === undefined
      ? ['Content-Type: text/plain; charset="utf-8"', "", options.text ?? "Hello,\n\nWe still need the packing list and the certificate of origin."]
      : ['Content-Type: text/html; charset="utf-8"', "", options.html];
  const lines = [`From: ${options.from}`, `To: ${options.to}`, `Subject: ${options.subject ?? "[Op 4471] Missing documents: packing list, certificate of origin (Invoice QBT-2026-0917)"}`, `Message-ID: ${options.messageId}`, ...own, "MIME-Version: 1.0", ...body, ""];
  return new TextEncoder().encode(lines.join("\r\n"));
}

export interface DeliveryOptions extends Omit<SimMimeOptions, "from" | "to" | "messageId"> {
  readonly sesMessageId: string;
  readonly recipient: string;
  readonly from: string;
  /** Default: `<providerMessageId@email.amazonses.com>`. */
  readonly rfcMessageId: string;
  readonly mailIdHeader?: string | null;
  readonly fromHeaders?: readonly string[];
  readonly recipients?: readonly string[];
  readonly dmarc?: string;
  /** The raw MIME's own `From` and `Message-ID`, when a test makes them disagree with the receipt. */
  readonly mimeFrom?: string;
  readonly mimeMessageId?: string;
}

/** Stores the raw MIME and returns the receipt event of the `sim` rule. */
export function deliverSim(world: SimWorld, options: DeliveryOptions): unknown {
  world.raw.set(options.sesMessageId, simMime({ ...options, from: options.mimeFrom ?? options.from, to: options.recipient, messageId: options.mimeMessageId ?? options.rfcMessageId }));
  const event = receiptEvent({
    sesMessageId: options.sesMessageId,
    recipient: options.recipient,
    fromHeader: options.from,
    rfcMessageId: options.rfcMessageId,
    mailIdHeader: options.mailIdHeader ?? null,
    ...(options.fromHeaders === undefined ? {} : { fromHeaders: options.fromHeaders }),
    verdicts: { dmarcVerdict: options.dmarc ?? "PASS" },
  }) as { Records: Array<{ ses: { receipt: { recipients: string[] } } }> };
  if (options.recipients !== undefined) for (const record of event.Records) record.ses.receipt.recipients = [...options.recipients];
  return event;
}

export const mailboxOf = (world: SimWorld, address: string) => world.email.stores.connector.conversations.listMailbox(address);
export const probeOf = (world: SimWorld, mailId: string) => world.email.stores.connector.runtime.getMailProbe(mailId);
export const pendingOf = (world: SimWorld) => world.email.stores.connector.world.listPending(CLOCK);
export const simTimers = (world: SimWorld, operationId = "op-4471") => world.email.stores.connector.timers.listTimers(operationId, { kind: "SIM_REPLY" });
export const metricLines = (world: SimWorld, metric: string) => world.lines.filter((line) => line.includes(`"metric":"${metric}"`));
