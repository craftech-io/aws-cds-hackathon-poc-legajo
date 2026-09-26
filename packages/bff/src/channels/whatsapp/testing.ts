// Test support for channels/whatsapp/: the demo slice of the in-memory connector (`firm-delta`,
// `imp-norpampa` with its phone hashed by the test subkey, `sup-qingdao`, `op-4471`) with its paused
// clock and the eight templates in `Reference`, the simulated transport over a fake `Media` bucket,
// recording ports, the real-shape SNS fixtures of fixtures/ and signed simulated envelopes. Not
// imported by runtime code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WhatsAppTemplateName } from "@legajo/shared";
import { REFERENCE_SCOPES, referenceKey } from "../../connector/keys";
import type { MemoryStores } from "../../connector/index";
import { CLOCK, FIRM, REAL_NOW, START_SIM, contactFixture, hashOf, importerFixture, memoryStores, operationFixture, supplierFixture } from "../../connector/testing";
import { BUTTON_LABELS } from "../../copy/buttons";
import { TEMPLATES } from "../../copy/templates";
import type { Message } from "../../domain/conversations";
import type { CreateOperationInput } from "../../connector/ports";
import { deriveSubkey, phoneHash, sha256Hex } from "../../lib/crypto";
import { createLogger } from "../../lib/log";
import type { ChannelEvent } from "../adapter";
import { startsWithPdfMagic } from "../email/mime";
import { STAGE_ACCOUNT_ID, waInboundTopicArn } from "./config";
import { type ButtonToIssue, issueNonces } from "./nonces";
import type { SystemReplyRequest, WhatsAppInboundDeps, WhatsAppKeys } from "./ports";
import { derivedMessageId } from "./records";
import { type SimulatedContent, buildSimulatedEvent } from "./sim-envelope";
import { type SimulatedWhatsAppTransport, simulatedWhatsAppTransport } from "./simulated-transport";
import type { MediaStore } from "./transport";

export { CLOCK, FIRM, REAL_NOW, START_SIM };

/** A master key for tests only (the stage's is an `sst.Secret`); the subkeys derive from it as in a Lambda. */
const TEST_MASTER = "test-only-session-token-key-000000000000000000";
export const KEYS: WhatsAppKeys = { phoneHash: deriveSubkey(TEST_MASTER, "phone-hash"), simEnvelope: deriveSubkey(TEST_MASTER, "sim-envelope"), nonce: deriveSubkey(TEST_MASTER, "nonce") };

/** Phones of the seed's fictitious blocks (docs/seed-spec.md §2): Norpampa, a second importer, the QA reserve. */
export const PHONE = "+5491155500101";
export const OTHER_PHONE = "+5491155500102";
export const RESERVE_PHONE = "+5491155509001";
export const TOPIC_ARN = waInboundTopicArn();
export const META_PHONE_NUMBER_ID = "1098765432109876";

const STAMP = { createdAt: REAL_NOW, updatedAt: REAL_NOW, version: 1, synthetic: true };

export interface FakeObject {
  readonly sizeBytes: number;
  readonly contentType: string;
  /** The first bytes; a PDF (`%PDF-…`) unless a test says otherwise. */
  readonly bytes?: string;
}

/** A fake `Media` bucket: objects by key, a PDF unless their bytes say otherwise. */
export function fakeMedia(): MediaStore & { readonly objects: Map<string, FakeObject> } {
  const objects = new Map<string, FakeObject>();
  return {
    objects,
    head: async (key) => {
      const object = objects.get(key);
      return object === undefined ? undefined : { sizeBytes: object.sizeBytes, contentType: object.contentType };
    },
    digest: async (key) => {
      const object = objects.get(key);
      if (object === undefined) throw new Error(`no media object ${key}`);
      const bytes = new TextEncoder().encode(object.bytes ?? `%PDF-1.4 ${key}`);
      return { sha256: sha256Hex(bytes), isPdf: startsWithPdfMagic(bytes), sizeBytes: object.sizeBytes };
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
}

export interface WaWorld {
  readonly stores: MemoryStores;
  readonly deps: WhatsAppInboundDeps;
  readonly transport: SimulatedWhatsAppTransport;
  readonly media: ReturnType<typeof fakeMedia>;
  readonly events: ChannelEvent[];
  readonly replies: SystemReplyRequest[];
  readonly revoked: Array<Parameters<WhatsAppInboundDeps["services"]["revokeConsent"]>[0]>;
  readonly contacts: Array<Parameters<WhatsAppInboundDeps["services"]["confirmContact"]>[0]>;
  readonly logs: () => Array<Record<string, unknown>>;
  /** Moves the real clock (nonce expiry, synthetic statuses). */
  setNow(iso: string): void;
}

export interface WaWorldOptions {
  readonly mode?: WhatsAppInboundDeps["mode"];
  readonly rateLimitPerHour?: number;
}

/** Templates as the seed writes them to `Reference/TEMPLATE#WHATSAPP` (`LOCAL_ONLY` until P-01). */
export function templateItems(status: "LOCAL_ONLY" | "APPROVED" = "LOCAL_ONLY") {
  return WhatsAppTemplateName.options.map((name) => {
    const definition = TEMPLATES[name];
    return {
      ...STAMP,
      ...referenceKey("TEMPLATE", REFERENCE_SCOPES.TEMPLATE, name),
      entity: "Template",
      name,
      language: "es_AR",
      category: "UTILITY",
      body: definition.body,
      paramCount: definition.params.length,
      buttons: definition.buttons.map((button) => ({ type: button.type, text: button.text, action: button.action, ...(button.type === "URL" ? { url: button.url.replace("{{1}}", "x") } : {}) })),
      status,
      gloss: `gloss of ${name}`,
    };
  });
}

/** Demo slice with Norpampa's phone hashed by the test subkey, the clock paused at 14/10 10:30 and the templates. */
export async function waWorld(options: WaWorldOptions = {}): Promise<WaWorld> {
  let now = new Date(REAL_NOW);
  const stores = memoryStores();
  const { parties, operations, world } = stores.connector;
  await parties.createImporter(importerFixture({ phoneE164: PHONE, phoneHash: phoneHash(KEYS.phoneHash, PHONE) }));
  await parties.createSupplier(supplierFixture());
  await parties.createContact(contactFixture());
  const operation = operationFixture();
  await operations.createOperation({ ...operation, threadClaimHash: hashOf(operation.threadAddress) });
  await world.createClock({ clockId: CLOCK, firmId: FIRM, mode: "PAUSED", offsetMs: 0, pausedSimNow: START_SIM, startAtSim: START_SIM, worldEpoch: 1, settings: { rateLimitPerHour: options.rateLimitPerHour ?? 20 } });
  await stores.seed.loadItems("Reference", templateItems());
  const lines: string[] = [];
  const log = createLogger({ correlationId: "test-whatsapp-0001", level: "debug", sink: (line) => lines.push(line), now: () => now });
  const media = fakeMedia();
  const realClock = { now: async () => new Date(now.getTime()) };
  let wamids = 0;
  const transport = simulatedWhatsAppTransport({ conversations: stores.connector.conversations, templates: stores.connector.reference, media, realClock, log, newWamid: () => `wamid.SIM.OUT${String(++wamids).padStart(6, "0")}` });
  const events: ChannelEvent[] = [];
  const replies: SystemReplyRequest[] = [];
  const revoked: WaWorld["revoked"] = [];
  const contacts: WaWorld["contacts"] = [];
  const deps: WhatsAppInboundDeps = {
    mode: options.mode ?? "simulated",
    data: stores.connector,
    keys: KEYS,
    source: { topicArn: TOPIC_ARN, accountId: STAGE_ACCOUNT_ID },
    transport,
    media,
    events: { enqueue: async (event) => void events.push(event) },
    replies: { reply: async (request) => (replies.push(request), { status: "SENT" }) },
    services: { revokeConsent: async (input) => void revoked.push(input), confirmContact: async (input) => void contacts.push(input) },
    realClock,
    log,
  };
  return { stores, deps, transport, media, events, replies, revoked, contacts, logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>), setNow: (iso) => void (now = new Date(iso)) };
}

/** A second open operation of Norpampa (FL-019), or of another importer with `importerId`. */
export async function addOperation(stores: MemoryStores, overrides: Partial<CreateOperationInput> & { readonly operationNumber: string }): Promise<string> {
  const operation = operationFixture({ threadTag: `m${overrides.operationNumber}q`, ...overrides });
  await stores.connector.operations.createOperation({ ...operation, threadClaimHash: hashOf(operation.threadAddress) });
  return operation.operationId;
}

export interface SentButtons {
  readonly messageId: string;
  readonly wamid: string;
  readonly nonces: readonly string[];
}

/** A `Message OUT` of an operation with buttons, and their nonces, as `send_whatsapp` leaves them. */
export async function sentWithButtons(
  world: Pick<WaWorld, "stores">,
  buttons: readonly ButtonToIssue[],
  options: { readonly operationId?: string; readonly wamid?: string; readonly template?: boolean; readonly kind?: Message["kind"] } = {},
): Promise<SentButtons> {
  const operationId = options.operationId ?? "op-4471";
  const operation = await world.stores.connector.operations.getOperation(operationId);
  const importer = await world.stores.connector.parties.getImporter(operation.importerId);
  const wamid = options.wamid ?? `wamid.SIM.OUT-${operationId}-${buttons.map((button) => button.action).join("-")}`;
  const messageId = derivedMessageId(wamid, "OUT");
  const nonces = await issueNonces(world.stores.connector.runtime, { nonceKey: KEYS.nonce, messageId, operationId, importerId: importer.importerId, phoneHash: importer.phoneHash, clockId: operation.clockId, buttons, now: new Date(REAL_NOW) });
  await world.stores.connector.conversations.appendMessage({
    messageId,
    operationId,
    firmId: operation.firmId,
    clockId: operation.clockId,
    direction: "OUT",
    channel: "WHATSAPP",
    kind: options.kind ?? "CONTACT_CONFIRMATION",
    counterpart: "IMPORTER",
    importerId: importer.importerId,
    to: importer.phoneE164,
    from: META_PHONE_NUMBER_ID,
    body: "¿Le escribimos a tu proveedor?",
    ...(options.template ? { template: { name: "legajo_docs_pendientes", params: [] } } : {}),
    buttons: buttons.map((button, index) => ({ action: button.action, title: BUTTON_LABELS[button.action].interactive, nonce: nonces[index] })),
    status: "DELIVERED",
    providerMessageId: wamid,
    author: "AGENT",
    simulated: true,
    sentAtSim: START_SIM,
    sentAtReal: REAL_NOW,
  });
  return { messageId, wamid, nonces };
}

const FIXTURES = join(import.meta.dirname, "fixtures");

/** A real-shape SNS event of fixtures/ with its placeholders (`__WAMID__`, `__NONCE__`, …) filled. */
export function liveEvent(name: string, values: Readonly<Record<string, string>> = {}): unknown {
  let text = readFileSync(join(FIXTURES, name), "utf8");
  for (const [placeholder, value] of Object.entries({ FROM: PHONE.slice(1), WAMID: "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFDNBQjI4RjdEMkUzOTVDNjE2RDQ2AA==", ...values })) {
    text = text.replaceAll(`__${placeholder}__`, value);
  }
  return JSON.parse(text) as unknown;
}

/** A signed envelope of the phone simulator. */
export function simEvent(content: SimulatedContent, options: { readonly wamid?: string; readonly from?: string; readonly contextWamid?: string } = {}): unknown {
  return buildSimulatedEvent(KEYS.simEnvelope, {
    from: options.from ?? PHONE,
    wamid: options.wamid ?? "wamid.SIM.01JAB3C4D5E6F7G8H9J0KMNPQR",
    content,
    at: new Date(REAL_NOW),
    ...(options.contextWamid === undefined ? {} : { contextWamid: options.contextWamid }),
  });
}
