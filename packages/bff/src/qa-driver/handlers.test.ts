import { describe, expect, it } from "vitest";
import type { NewEntity } from "../domain/common";
import type { Message } from "../domain/conversations";
import { REAL_NOW, START_SIM } from "../connector/testing";
import { testDocumentUrls } from "../auth/testing";
import { createLogger } from "../lib/log";
import { buildHandlers, type HandlerDeps } from "./handlers";
import { type QaPorts, unwiredPorts } from "./ports";
import { QA_CLOCK, driverUnderTest, key, qaDriverStores } from "./testing";

const TOKEN = "A".repeat(43);

const toImporter: NewEntity<typeof Message> = {
  messageId: "msg-01JQA0001",
  operationId: "op-7001",
  firmId: "firm-qa",
  clockId: QA_CLOCK,
  direction: "OUT",
  channel: "WHATSAPP",
  kind: "DOCS_REQUEST",
  counterpart: "IMPORTER",
  importerId: "imp-sc01a",
  to: "+5491155590001",
  from: "simulated",
  body: "Operación 7001: faltan documentos.",
  status: "SENT",
  author: "AGENT",
  sentAtSim: "2026-10-15T10:00:00-03:00",
  sentAtReal: REAL_NOW,
  buttons: [
    { action: "SUPPLIER_SENDS", title: "Los manda el proveedor", nonce: "nonce-supplier-01" },
    { action: "UPLOAD", title: "Subir documentos", url: `https://legajo.demo.craftech.io/u/${TOKEN}` },
  ],
};

const unused = () => Promise.reject(new Error("not used by this test"));

function deps(overrides: Partial<HandlerDeps> = {}, ports: QaPorts = unwiredPorts()): HandlerDeps {
  return {
    table: undefined as never,
    ports,
    platform: { get: unused, moveEta: unused, customsStatus: unused },
    mocksHealth: () => Promise.resolve({ reader: "ok", platform: "ok" }),
    readerFaults: unused,
    dlq: { find: unused, remove: unused },
    alarmHistory: unused,
    guardrailProbe: unused,
    memory: { listEvents: () => Promise.resolve([]), listRecords: () => Promise.resolve([]) },
    memoryIdentity: { of: (operation) => ({ actorId: `${operation.importerId}-e${operation.worldEpoch}`, sessionId: "s".repeat(48) }) },
    upload: { presign: unused, done: unused },
    console: { documents: testDocumentUrls, whatsappMode: () => "simulated", loggerFor: (correlationId) => createLogger({ correlationId, sink: () => undefined }) },
    ...overrides,
  };
}

async function setup(overrides: Partial<HandlerDeps> = {}, ports?: QaPorts) {
  const stores = await qaDriverStores();
  const handlers = buildHandlers(deps({ table: stores.client, ...overrides }, ports));
  return driverUnderTest(handlers, stores);
}

describe("QaDriver actions over stored state", () => {
  it("snapshots an operation with its documents, timers, messages and the world's simulated now", async () => {
    const { driver, stores } = await setup();
    await stores.connector.conversations.appendMessage(toImporter);
    const answer = await driver({ action: "snapshot", idempotencyKey: key(1), input: { operationId: "op-7001" } });
    expect(answer).toMatchObject({ ok: true, result: { operation: { operationId: "op-7001", clockId: QA_CLOCK, dossierStatus: "OPEN" }, clock: { mode: "PAUSED", simNow: new Date(START_SIM).toISOString() } } });
    const result = (answer as { result: { documents: unknown[]; messages: unknown[]; processError: unknown } }).result;
    expect(result.documents).toHaveLength(3);
    expect(result.messages).toHaveLength(1);
    expect(result.processError).toBeNull();
  });

  it("sets the simulated supplier's behaviour on the operation", async () => {
    const { driver, stores } = await setup();
    expect(await driver({ action: "supplier.setBehaviour", idempotencyKey: key(2), input: { operationId: "op-7001", behaviour: "LATE", delayHours: 30 } })).toMatchObject({ ok: true, result: { simBehaviour: "LATE" } });
    expect(await stores.connector.operations.getOperation("op-7001")).toMatchObject({ simBehaviour: "LATE", simBehaviourParams: { delayHours: 30 } });
  });

  it("answers the outcome of a mail only inside its world", async () => {
    const { driver, stores } = await setup();
    await stores.connector.runtime.putMailProbe({ mailId: "qa0000000001", outcome: "DISCARDED", reason: "THREAD_ADDRESS_UNKNOWN", clockId: QA_CLOCK, atReal: REAL_NOW });
    expect(await driver({ action: "mail.outcome", idempotencyKey: key(3), input: { clockId: QA_CLOCK, mailId: "qa0000000001", timeoutSec: 5 } })).toMatchObject({ ok: true, result: { outcome: "DISCARDED", reason: "THREAD_ADDRESS_UNKNOWN" } });
    expect(await driver({ action: "mail.outcome", idempotencyKey: key(3, "b"), input: { clockId: "qa-812-1-sc02", mailId: "qa0000000001", timeoutSec: 5 } })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", reason: "NO_OUTCOME" } });
  });

  it("expires the last upload link and the last nonce of a button, only in a qa-* world", async () => {
    const { driver, stores } = await setup();
    await stores.connector.conversations.appendMessage(toImporter);
    await stores.connector.runtime.putUploadLink({ token: TOKEN, operationId: "op-7001", importerId: "imp-sc01a", firmId: "firm-qa", clockId: QA_CLOCK, docTypes: ["PACKING_LIST"], createdAtReal: REAL_NOW, expiresAtReal: "2026-09-29T15:00:00.000Z" });
    await stores.connector.runtime.putNonce({ nonce: "nonce-supplier-01", action: "SUPPLIER_SENDS", operationId: "op-7001", importerId: "imp-sc01a", phoneHash: "b".repeat(64), clockId: QA_CLOCK });
    expect(await driver({ action: "link.expire", idempotencyKey: key(4), input: { operationId: "op-7001" } })).toMatchObject({ ok: true });
    expect((await stores.connector.runtime.getUploadLink(TOKEN))?.expiresAtReal).toBe("2026-09-26T14:59:59.000Z");
    expect(await driver({ action: "nonce.expire", idempotencyKey: key(4, "b"), input: { operationId: "op-7001", action: "SUPPLIER_SENDS" } })).toMatchObject({ ok: true });
    expect((await stores.connector.runtime.getNonce("nonce-supplier-01"))?.expiresAt).toBe(Date.parse(REAL_NOW) / 1000 - 1);
    expect(await driver({ action: "nonce.expire", idempotencyKey: key(4, "c"), input: { operationId: "op-7001", action: "OPT_OUT" } })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("runs the policy audit of the world and the console as a firm-qa user", async () => {
    const { driver } = await setup();
    expect(await driver({ action: "policyAudit.run", idempotencyKey: key(5), input: { clockId: QA_CLOCK } })).toMatchObject({ ok: true, result: { clockId: QA_CLOCK, violations: [] } });
    const list = await driver({ action: "console", idempotencyKey: key(5, "b"), input: { procedure: "operations.list", input: { clockId: QA_CLOCK } } });
    expect(list).toMatchObject({ ok: true, result: { clockId: QA_CLOCK, operations: [{ operationId: "op-7001" }] } });
    expect(await driver({ action: "console", idempotencyKey: key(5, "c"), input: { procedure: "operations.get", input: { operationId: "op-4471" } } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "CROSS_FIRM" } });
    expect(await driver({ action: "console", idempotencyKey: key(5, "d"), input: { procedure: "dossier.approve", input: { operationId: "op-7001" } } })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await driver({ action: "metrics.get", idempotencyKey: key(5, "e"), input: { clockId: QA_CLOCK } })).toMatchObject({ ok: true, result: { usage: { dossiers: 0, turns: 0 } } });
  });

  it("inspects the Memory actor and session of an operation", async () => {
    const seen: string[] = [];
    const memory = {
      listEvents: (actorId: string, sessionId: string) => {
        seen.push(`${actorId}/${sessionId}`);
        return Promise.resolve([]);
      },
      listRecords: (namespace: string) => {
        seen.push(namespace);
        return Promise.resolve([]);
      },
    };
    const { driver } = await setup({ memory });
    expect(await driver({ action: "memory.inspect", idempotencyKey: key(6), input: { operationId: "op-7001" } })).toMatchObject({ ok: true, result: { actorId: "imp-sc01a-e1", records: [] } });
    expect(seen).toContain(`/importers/imp-sc01a-e1/${"s".repeat(48)}/summary/`);
    expect(await driver({ action: "memory.inspect", idempotencyKey: key(6, "b"), input: { actorId: "imp-sc01a-e1" } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("resolves the nonce of the last button and derives the wamid before handing the message to the channel", async () => {
    const received: unknown[] = [];
    const whatsappInbound = (input: unknown) => {
      received.push(input);
      return Promise.resolve({ messageId: "msg-in-1" });
    };
    const ports = { ...unwiredPorts(), channels: { ...unwiredPorts().channels, whatsappInbound } };
    const { driver, stores } = await setup({}, ports);
    await stores.connector.conversations.appendMessage(toImporter);
    const answer = await driver({ action: "wa.inbound", idempotencyKey: key(7), input: { operationId: "op-7001", message: { type: "button", action: "SUPPLIER_SENDS" } } });
    expect(answer).toMatchObject({ ok: true, result: { wamid: expect.stringMatching(/^wamid\.SIM\./), messageId: "msg-in-1" } });
    expect(received).toEqual([expect.objectContaining({ clockId: QA_CLOCK, from: "IMPORTER", message: { type: "button", action: "SUPPLIER_SENDS", nonce: "nonce-supplier-01" } })]);
  });

  it("answers NOT_WIRED for a module that is not deployed with the driver, never a shortcut", async () => {
    const { driver } = await setup();
    const answer = await driver({ action: "clock.advanceToNext", idempotencyKey: key(8), input: { clockId: QA_CLOCK } });
    expect(answer).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", reason: "NOT_WIRED" } });
    expect(await driver({ action: "probe.mocks", idempotencyKey: key(8, "b"), input: {} })).toMatchObject({ ok: true, result: { reader: "ok", platform: "ok", worker: "not-wired" } });
  });
});
