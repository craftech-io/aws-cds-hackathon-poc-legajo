import { describe, expect, it } from "vitest";
import type { NewEntity } from "../domain/common";
import type { Message } from "../domain/conversations";
import { REAL_NOW, START_SIM } from "../connector/testing";
import { testDocumentUrls } from "../auth/testing";
import { createLogger } from "../lib/log";
import { consoleServiceWorld } from "../routers/console-testing";
import { buildHandlers, type HandlerDeps } from "./handlers";
import type { QaPorts } from "./ports";
import { QA_CLOCK, driverUnderTest, key, qaDriverStores, refusingPorts } from "./testing";

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
  importerId: "imp-qa-812-1-sc01-a",
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

function deps(overrides: Partial<HandlerDeps> = {}, ports: QaPorts = refusingPorts()): HandlerDeps {
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
    signup: () => {
      throw new Error("SC-26's ports are not part of this test");
    },
    ...overrides,
  };
}

async function setup(overrides: Partial<HandlerDeps> = {}, ports?: QaPorts) {
  const stores = await qaDriverStores();
  // The console's mutations over the same stores (routers/console-testing.ts): real handlers, recorded AWS edges.
  const { services, events } = await consoleServiceWorld({ stores });
  const base = deps({ table: stores.client, ...overrides }, ports);
  const handlers = buildHandlers({ ...base, console: { ...base.console, services } });
  return { ...(await driverUnderTest(handlers, stores)), events };
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
    await stores.connector.runtime.putUploadLink({ token: TOKEN, operationId: "op-7001", importerId: "imp-qa-812-1-sc01-a", firmId: "firm-qa", clockId: QA_CLOCK, docTypes: ["PACKING_LIST"], createdAtReal: REAL_NOW, expiresAtReal: "2026-09-29T15:00:00.000Z" });
    await stores.connector.runtime.putNonce({ nonce: "nonce-supplier-01", action: "SUPPLIER_SENDS", operationId: "op-7001", importerId: "imp-qa-812-1-sc01-a", phoneHash: "b".repeat(64), clockId: QA_CLOCK });
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
    expect(await driver({ action: "console", idempotencyKey: key(5, "d"), input: { procedure: "dossier.approve", input: { operationId: "op-7001" } } })).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "NOT_READY_FOR_REVIEW" } });
    expect(await driver({ action: "metrics.get", idempotencyKey: key(5, "e"), input: { clockId: QA_CLOCK } })).toMatchObject({ ok: true, result: { usage: { dossiers: 0, turns: 0 } } });
  });

  it("[FL-067] [FL-068] signs what the console does as brk-qa-runner, the broker its principal stands for", async () => {
    const { driver, stores, events } = await setup();
    await stores.connector.conversations.appendMessage(toImporter);
    expect(await driver({ action: "console", idempotencyKey: key(7), input: { procedure: "conversation.take", input: { operationId: "op-7001" } } })).toMatchObject({ ok: true });
    expect((await stores.connector.operations.getOperation("op-7001")).controlHistory.at(-1)).toMatchObject({ control: "BROKER", by: "BROKER:brk-qa-runner" });
    expect(await driver({ action: "console", idempotencyKey: key(7, "b"), input: { procedure: "conversation.send", input: { operationId: "op-7001", text: "Te llamamos en un rato." } } })).toMatchObject({ ok: true });
    expect(events.at(-1)).toMatchObject({ type: "OUTBOUND_SEND", kind: "BROKER_MESSAGE", author: "BROKER:brk-qa-runner" });
  });

  it("[FL-001] finds the opt-in it records in the world's audit log, by importer (it belongs to no operation)", async () => {
    const { driver } = await setup();
    const importerId = "imp-qa-812-1-sc01-a";
    const record = { procedure: "registry.consent.record", input: { clockId: QA_CLOCK, importerId, medium: "SIGNED_FORM", grantedAt: START_SIM, textVersion: "v1" } };
    expect(await driver({ action: "console", idempotencyKey: key(8), input: record })).toMatchObject({ ok: true });
    const listed = await driver({ action: "console", idempotencyKey: key(8, "b"), input: { procedure: "audit.list", input: { clockId: QA_CLOCK, decision: "ACTION", limit: 200 } } });
    const decisions = (listed as { result: { decisions: Array<{ action: string; operationId?: string; refs: { importerId?: string } }> } }).result.decisions;
    expect(decisions.filter((row) => row.action === "CONSENT_GRANTED" && row.refs.importerId === importerId)).toMatchObject([{ actor: "BROKER:brk-qa-runner" }]);
    expect(decisions.find((row) => row.action === "CONSENT_GRANTED")?.operationId).toBeUndefined();
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
    expect(await driver({ action: "memory.inspect", idempotencyKey: key(6), input: { operationId: "op-7001" } })).toMatchObject({ ok: true, result: { actorId: "imp-qa-812-1-sc01-a-e1", records: [] } });
    expect(seen).toContain(`/importers/imp-qa-812-1-sc01-a-e1/${"s".repeat(48)}/summary/`);
    expect(await driver({ action: "memory.inspect", idempotencyKey: key(6, "b"), input: { actorId: "imp-qa-812-1-sc01-a-e1" } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("resolves the nonce of the last button and derives the wamid before handing the message to the channel", async () => {
    const received: unknown[] = [];
    const whatsappInbound = (input: unknown) => {
      received.push(input);
      return Promise.resolve({ messageId: "msg-in-1" });
    };
    const ports = { ...refusingPorts(), channels: { ...refusingPorts().channels, whatsappInbound } };
    const { driver, stores } = await setup({}, ports);
    await stores.connector.conversations.appendMessage(toImporter);
    const answer = await driver({ action: "wa.inbound", idempotencyKey: key(7), input: { operationId: "op-7001", message: { type: "button", action: "SUPPLIER_SENDS" } } });
    expect(answer).toMatchObject({ ok: true, result: { wamid: expect.stringMatching(/^wamid\.SIM\./), messageId: "msg-in-1" } });
    expect(received).toEqual([expect.objectContaining({ clockId: QA_CLOCK, from: "IMPORTER", message: { type: "tap", content: { type: "button_reply", nonce: "nonce-supplier-01", title: "Los manda el proveedor" } } })]);
  });

  it("probes the worker through the queue and waits for its PROBE#; platform.get reads only numbers of the world", async () => {
    let stores: Awaited<ReturnType<typeof qaDriverStores>> | undefined;
    const healthProbe = async (input: { readonly probeId: string }) => void (await stores?.connector.runtime.putProbe({ probeId: input.probeId, kind: "HEALTH", ok: true, detail: {}, atReal: REAL_NOW }));
    const platformRows: string[] = [];
    const get = (firmId: string, operationNumber: string) => {
      platformRows.push(`${firmId}#${operationNumber}`);
      return Promise.resolve({ eta: START_SIM } as never);
    };
    const platform = { get, moveEta: unused, customsStatus: unused };
    const test = await setup({ platform }, { ...refusingPorts(), worker: { ...refusingPorts().worker, healthProbe } });
    stores = test.stores;
    expect(await test.driver({ action: "probe.mocks", idempotencyKey: key(8), input: {} })).toMatchObject({ ok: true, result: { reader: "ok", platform: "ok", worker: "ok" } });
    expect(await test.driver({ action: "platform.get", idempotencyKey: key(8, "b"), input: { firmId: "firm-qa", operationNumber: "7001", clockId: QA_CLOCK } })).toMatchObject({ ok: true });
    expect(await test.driver({ action: "platform.get", idempotencyKey: key(8, "c"), input: { firmId: "firm-qa", operationNumber: "4471", clockId: QA_CLOCK } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "QA_FENCE" } });
    expect(platformRows).toEqual(["firm-qa#7001"]);
  });

  it("publishes a replayed platform event with the instant of its first publication", async () => {
    const calls: Array<{ occurredAtSim: string; idempotencyKey: string }> = [];
    const moveEta = (input: { occurredAtSim: string; idempotencyKey: string }) => {
      calls.push(input);
      return Promise.resolve({ event: { detail: { eventId: "evt-1" } }, replayed: calls.length > 1 });
    };
    const { driver, stores } = await setup({ platform: { get: unused, moveEta: moveEta as never, customsStatus: unused } });
    const first = key(9);
    expect(await driver({ action: "feed.eta", idempotencyKey: first, input: { operationId: "op-7001", newEta: "2026-10-20T08:00:00-03:00" } })).toMatchObject({ ok: true });
    const clock = await stores.connector.world.getClock(QA_CLOCK);
    await stores.connector.world.updateClock(QA_CLOCK, { pausedSimNow: "2026-10-16T09:00:00-03:00" }, clock.version);
    expect(await driver({ action: "feed.eta", idempotencyKey: key(9, "b"), input: { operationId: "op-7001", newEta: "2026-10-20T08:00:00-03:00", platformKey: first } })).toMatchObject({ ok: true });
    expect(calls.map((call) => call.idempotencyKey)).toEqual([first, first]);
    expect(calls[1]?.occurredAtSim).toBe(calls[0]?.occurredAtSim);
  });
});
