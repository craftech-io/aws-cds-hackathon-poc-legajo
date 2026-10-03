// The driver's ports over the real modules (stage-ports.ts, stage-channels.ts, batch.ts), with the AWS
// edges recorded: the clock moves a paused QA world and dispatches what fell due, the worker gets its
// events through the producer (`inFlight` first), a stale timer is refused unless it is older, the
// phone simulator's envelope is the one a real event has, `email.inject` goes through the `QA` profile,
// a redelivery carries the recorded mail's receipt, and the batch stops at its caps and resumes.
import { describe, expect, it } from "vitest";
import { parseSimMediaRef } from "@legajo/shared";
import { parseReceiptEvent } from "../channels/email/receipt";
import { REAL_NOW, START_SIM } from "../connector/testing";
import type { DueTimer } from "../timers/timers";
import { createLogger } from "../lib/log";
import { fakeScheduler } from "../milestones/testing";
import { recordingSink } from "../services/operations-admin/testing";
import type { OperationQueueEventInput } from "../worker/events";
import { type BatchDeps, batchPort, parseJsonl, worldBatchId } from "./batch";
import type { ActionContext } from "./ports";
import { redeliveryEvent, stageChannels } from "./stage-channels";
import { clockPort, workerPort } from "./stage-ports";
import { QA_CLOCK, qaDriverStores } from "./testing";

const log = createLogger({ level: "error" });

function context(idempotencyKey = "812-1/sc01/3/m1"): ActionContext {
  let at = Date.parse(REAL_NOW);
  return { idempotencyKey, scope: { name: "x", firmId: "firm-qa", clockId: QA_CLOCK, operations: [] }, data: undefined as never, now: () => new Date(at), sleep: (ms) => Promise.resolve(void (at += ms)), log };
}

async function world() {
  const stores = await qaDriverStores();
  const dispatched: DueTimer[] = [];
  const clockDeps = () => ({ data: stores.connector, scheduler: fakeScheduler(), dispatcher: { dispatch: async (due: DueTimer) => void dispatched.push(due) }, realClock: () => new Date(REAL_NOW), log });
  return { stores, dispatched, clockDeps };
}

describe("clock port: the clock module as caller QA", () => {
  it("[FL-065] advances a paused QA world to its next timer and dispatches it, without the console's busy gate", async () => {
    const { stores, dispatched, clockDeps } = await world();
    await stores.connector.timers.createTimer({ operationId: "op-7001", clockId: QA_CLOCK, kind: "MILESTONE", timerId: "DOCS_REQUEST", dueAtSim: "2026-10-15T10:00:00-03:00", status: "SCHEDULED", payload: {} });
    const moved = await clockPort(clockDeps).advance(QA_CLOCK, { next: true }, context());
    expect(Date.parse(moved.simNow)).toBe(Date.parse("2026-10-15T10:00:00-03:00"));
    expect(dispatched.map((due) => due.firedBy)).toEqual(["CLOCK"]);
    await expect(clockPort(clockDeps).advance(QA_CLOCK, { to: START_SIM }, context())).rejects.toMatchObject({ reason: "CLOCK_BACKWARDS" });
  });
});

describe("worker port: the queue producer", () => {
  it("[FL-098] enqueues POISON and HEALTH_PROBE, arms a forced failure and fires only an older timer version", async () => {
    const { stores } = await world();
    const events: OperationQueueEventInput[] = [];
    const port = workerPort(stores.connector, () => recordingSink(events));
    await port.poison({ operationId: "op-7001", clockId: QA_CLOCK, eventId: `qa-${"a".repeat(40)}` }, context());
    await port.healthProbe({ probeId: "qa-health-1" }, context());
    await port.forceNextTurnFailure({ operationId: "op-7001", clockId: QA_CLOCK }, context());
    expect(events.map((event) => event.type)).toEqual(["POISON", "HEALTH_PROBE"]);
    expect(events[0]).toMatchObject({ operationId: "op-7001", clockId: QA_CLOCK, firmId: "firm-qa", eventAtSim: new Date(START_SIM).toISOString() });
    expect(await stores.connector.runtime.getProbe("force-turn-failure-op-7001")).toMatchObject({ detail: { state: "REQUESTED" } });
    const timer = await stores.connector.timers.createTimer({ operationId: "op-7001", clockId: QA_CLOCK, kind: "MILESTONE", timerId: "FOLLOWUP", dueAtSim: "2026-10-16T10:00:00-03:00", status: "SCHEDULED", payload: {} });
    const moved = await stores.connector.timers.rescheduleTimer({ operationId: "op-7001", timerKey: "TIMER#MILESTONE#FOLLOWUP", dueAtSim: "2026-10-17T10:00:00-03:00" });
    await expect(port.fireStale({ operationId: "op-7001", clockId: QA_CLOCK, timerKey: "TIMER#MILESTONE#FOLLOWUP", version: moved.version }, context())).rejects.toMatchObject({ reason: "NOT_STALE" });
    await port.fireStale({ operationId: "op-7001", clockId: QA_CLOCK, timerKey: "TIMER#MILESTONE#FOLLOWUP", version: timer.version }, context());
    expect(events.at(-1)).toMatchObject({ type: "TIMER", version: timer.version, firedBy: "SCHEDULER" });
  });
});

describe("channels port: the production entries", () => {
  function channels(stores: Awaited<ReturnType<typeof qaDriverStores>>) {
    const delivered: unknown[] = [];
    const copies: string[] = [];
    const sent: unknown[] = [];
    const redelivered: unknown[] = [];
    const port = stageChannels({
      data: stores.connector,
      log,
      phone: () => ({ simEnvelopeKey: "k".repeat(32), delivery: { deliver: async (event) => (delivered.push(event), { outcome: "RECORDED", messageId: "msg-in-1" }) }, realClock: { now: async () => new Date(REAL_NOW) } }),
      media: { presign: () => Promise.reject(new Error("unused")), copySeedPdf: async (input) => void copies.push(input.key) },
      seedPdfs: () => ({ latestVersion: async () => 1, read: async () => new Uint8Array([37, 80, 68, 70]), unknownCount: 0, readUnknown: async () => new Uint8Array() }),
      email: () => ({ send: async (request) => (sent.push(request), { status: "SENT" as const, providerMessageId: "ses-1", rfcMessageId: "<x@y>", mailId: "qa1", awaiting: "INBOUND" as const, from: "a", to: "b" }) }),
      inboundEmail: async (event) => (redelivered.push(event), { outcome: "DUPLICATE" }),
    });
    return { port, delivered, copies, sent, redelivered };
  }

  it("[FL-083] sends the importer's registered phone, a leased unregistered one, and a template PDF under the run's prefix", async () => {
    const { stores } = await world();
    const { port, delivered, copies } = channels(stores);
    expect(await port.whatsappInbound({ operationId: "op-7001", clockId: QA_CLOCK, from: "IMPORTER", wamid: `wamid.SIM.${"1".repeat(64)}`, message: { type: "text", text: "hola" } }, context())).toEqual({ messageId: "msg-in-1" });
    await port.whatsappInbound({ operationId: "op-7001", clockId: QA_CLOCK, from: "UNREGISTERED", wamid: `wamid.SIM.${"2".repeat(64)}`, message: { type: "text", text: "hola" } }, context());
    const senders = delivered.map((event) => /5491155\d{6}/.exec(JSON.stringify(event))?.[0]);
    expect(senders[0]).toBe("5491155590001");
    expect(senders[1]).toMatch(/^5491155509\d{3}$/);
    const [lease] = await Promise.all([stores.connector.world.getLease("PHONE", `+${senders[1] ?? ""}`)]);
    expect(lease?.holder).toBe(QA_CLOCK);
    await port.whatsappInbound({ operationId: "op-7001", clockId: QA_CLOCK, from: "IMPORTER", wamid: `wamid.SIM.${"3".repeat(64)}`, message: { type: "document", docType: "PACKING_LIST", version: 1, templateOperation: "op-4471" } }, context());
    expect(copies).toHaveLength(1);
    expect(JSON.stringify(delivered.at(-1))).toContain("sim-media:");
    expect(parseSimMediaRef(`sim-media:${copies[0] ?? ""}`)).toBe(copies[0]);
  });

  it("[FL-033] injects through the QA profile with the template's PDFs and redelivers the recorded receipt", async () => {
    const { stores } = await world();
    const { port, sent, redelivered } = channels(stores);
    const injected = await port.injectEmail({ clockId: QA_CLOCK, from: "qainject-812-1-sc15@sim.legajo.demo.craftech.io", to: "op-7001-q7p2q9@legajo.demo.craftech.io", subject: "Docs", body: "Attached.", autoReply: false, attachments: [{ docType: "PACKING_LIST", version: 2, templateOperation: "op-4471" }], mailId: "qa1234567890" }, context());
    expect(injected).toEqual({ sesMessageId: "ses-1" });
    expect(sent[0]).toMatchObject({ profile: "QA", firmId: "firm-qa", kind: "QA_INJECT", mailId: "qa1234567890", attachments: [{ filename: "packing_list-v2.pdf" }] });
    await stores.connector.conversations.appendMessage({ messageId: "msg-01JQA0007", operationId: "op-7001", firmId: "firm-qa", clockId: QA_CLOCK, direction: "IN", channel: "EMAIL", counterpart: "SUPPLIER", to: "op-7001-q7p2q9@legajo.demo.craftech.io", from: "qa-sc01a@sim.legajo.demo.craftech.io", body: "Here.", status: "RECEIVED", author: "SUPPLIER", trusted: true, sentAtSim: START_SIM, sentAtReal: REAL_NOW, providerMessageId: "ses-abc", rfcMessageId: "<m1@sim.legajo.demo.craftech.io>", buttons: [] });
    expect(await port.redeliverEmail({ operationId: "op-7001", clockId: QA_CLOCK, messageId: "msg-01JQA0007" }, context())).toEqual({ redelivered: true, outcome: "DUPLICATE", reason: null });
    const received = parseReceiptEvent(redelivered[0]);
    expect(received.mail.messageId).toBe("ses-abc");
    expect(received.receipt).toMatchObject({ recipients: ["op-7001-q7p2q9@legajo.demo.craftech.io"], dmarcVerdict: { status: "PASS" } });
    await expect(port.redeliverEmail({ operationId: "op-7001", clockId: "qa-812-1-sc02", messageId: "msg-01JQA0007" }, context())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(() => redeliveryEvent({ from: "a", to: undefined, sentAtReal: REAL_NOW } as never)).toThrow();
  });
});

describe("batch.run: worlds of firm-sim, caps and resume", () => {
  it("parses the seed's JSONL and names one world per entry", () => {
    expect(parseJsonl('{"a":1}\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(worldBatchId("b1", 0)).toBe("b1-0001");
  });

  it("refuses more entries than the seed has, and stops at the turn cap before starting a world", async () => {
    const { stores, clockDeps } = await world();
    const deps: BatchDeps = { data: stores.connector, worlds: () => undefined as never, clock: clockDeps, inputs: async () => [], whatsappSimulated: () => true };
    await expect(batchPort(deps).run({ batchId: "b1", entries: 1, maxTurns: 10, maxCostUsd: 5 }, context())).rejects.toMatchObject({ code: "INVALID" });
    const capped = await batchPort({ ...deps, inputs: async () => [{}] }).run({ batchId: "b1", entries: 1, maxTurns: 0, maxCostUsd: 5 }, context());
    expect(capped).toMatchObject({ batchId: "b1", entries: 1, finished: 0, turns: 0, stopped: "MAX_TURNS" });
  });
});
