import { describe, expect, it } from "vitest";
import { derivedEventId } from "../channels/adapter";
import { timerEventId } from "../timers/events";
import type { OperationQueueEventInput } from "./events";
import { MalformedEventError } from "./events";
import { PoisonedEventError } from "./probe";
import { CLOCK, FIRM, OPERATION, START_SIM, auditActions, completed, sqsEvent, takeControl, turnEvent, workerWorld } from "./testing";

const base = { operationId: OPERATION, clockId: CLOCK, firmId: FIRM, eventAtSim: START_SIM } as const;
const SHA = "a".repeat(64);
const QA_ID = `qa-${"1".repeat(40)}`;

const EVENTS: Record<string, OperationQueueEventInput> = {
  INTAKE_DOCUMENT: { ...base, type: "INTAKE_DOCUMENT", eventId: derivedEventId("INTAKE_DOCUMENT", "uploads/k1"), source: { party: "IMPORTER", channel: "UPLOAD_LINK" }, object: { store: "UPLOADS", key: "uploads/op-4471/k1.pdf" }, sha256: SHA, sizeBytes: 2048 },
  TIMER: { ...base, type: "TIMER", eventId: timerEventId(OPERATION, "TIMER#FOLLOWUP#fu-1", START_SIM, 1), timerKey: "TIMER#FOLLOWUP#fu-1", version: 1, dueAtSim: START_SIM, firedBy: "SCHEDULER" },
  ETA_CHANGED: { ...base, type: "ETA_CHANGED", eventId: "evt_01JAAAAAAAAAAAAAAAAAAAAAAA", eta: "2026-10-24T08:00:00-03:00", occurredAtSim: START_SIM },
  DISPATCH_STATUS: { ...base, type: "DISPATCH_STATUS", eventId: "evt_01JAAAAAAAAAAAAAAAAAAAAAAB", status: "OFICIALIZADO", occurredAtSim: START_SIM },
  EMAIL_EVENT: { ...base, type: "EMAIL_EVENT", eventId: derivedEventId("EMAIL_EVENT", "ses-1#BOUNCE#x"), messageId: "msg-01JAAAA", sesEventType: "BOUNCE", bounceType: "Permanent", occurredAtReal: "2026-09-26T15:00:00.000Z" },
  OUTBOUND_SEND: { ...base, type: "OUTBOUND_SEND", eventId: "evt_01JAAAAAAAAAAAAAAAAAAAAAAC", author: "BROKER:brk-delta-diego", kind: "REPLY", channel: "WHATSAPP", text: "Hola, lo vemos hoy." },
};

const HANDLER_OF: Record<string, string> = {
  INTAKE_DOCUMENT: "intakeDocument",
  TIMER: "fireTimer",
  ETA_CHANGED: "rescheduleOnEtaChange",
  DISPATCH_STATUS: "notifyDispatchStatus",
  EMAIL_EVENT: "applyEmailEvent",
  OUTBOUND_SEND: "outboundSend",
};

describe("OperationWorker dispatch (docs/architecture.md §7)", () => {
  it.each(Object.keys(EVENTS))("hands %s to its module's handler, marks it processed and takes it out of inFlight", async (type) => {
    const world = await workerWorld();
    const event = EVENTS[type] as OperationQueueEventInput;
    await world.sink.enqueue(event);
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight).toContain(event.eventId);
    await world.deliver(event);
    expect(world.handlers.calls.map((call) => call.handler)).toEqual([HANDLER_OF[type]]);
    expect(await world.stores.connector.runtime.getIdempotency(type, event.eventId)).toBeDefined();
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight ?? []).not.toContain(event.eventId);
    expect((await world.stores.connector.world.getWorldState(CLOCK))?.inFlight ?? []).toEqual([]);
  });

  it("ESCALATE escalates with the channel's reason and its fixed label, never the message", async () => {
    const world = await workerWorld();
    await world.deliver({ ...base, type: "ESCALATE", eventId: derivedEventId("ESCALATE", "<m1@x>"), reason: "UNTRUSTED_SENDER", messageId: "msg-01JAAAA" });
    expect(world.escalations).toHaveLength(1);
    expect(world.escalations[0]).toMatchObject({ operationId: OPERATION, reason: "UNTRUSTED_SENDER" });
    expect(world.escalations[0]?.summary).not.toContain("msg-");
  });

  it("HEALTH_PROBE writes the reader's health to Runtime/PROBE#<probeId>, ok or not", async () => {
    const up = await workerWorld();
    await up.deliver({ type: "HEALTH_PROBE", eventId: QA_ID, probeId: "smk-3-a" });
    expect(await up.stores.connector.runtime.getProbe("smk-3-a")).toMatchObject({ ok: true, kind: "READER_HEALTH" });
    const down = await workerWorld({ readerOk: false });
    await down.deliver({ type: "HEALTH_PROBE", eventId: QA_ID, probeId: "smk-3-b" });
    expect(await down.stores.connector.runtime.getProbe("smk-3-b")).toMatchObject({ ok: false });
  });

  it("a malformed body fails the delivery and never reaches a handler", async () => {
    const world = await workerWorld();
    await expect(createRaw(world, "{not json")).rejects.toBeInstanceOf(MalformedEventError);
    await expect(createRaw(world, JSON.stringify({ type: "AGENT_TURN", eventId: "nope" }))).rejects.toBeInstanceOf(MalformedEventError);
    expect(world.handlers.calls).toEqual([]);
  });
});

async function createRaw(world: Awaited<ReturnType<typeof workerWorld>>, body: string): Promise<void> {
  const { createOperationWorker } = await import("./worker");
  await createOperationWorker(world.deps)(sqsEvent(body));
}

describe("FL-069: inbound messages while the firm holds the conversation", () => {
  it("records TURN_SKIPPED_CONTROL_BROKER, invokes no Harness and settles the event [FL-069]", async () => {
    const world = await workerWorld();
    await takeControl(world.stores);
    const event = turnEvent({ trigger: "SUPPLIER_EMAIL", key: "<m1@x>" });
    await world.sink.enqueue(event);
    await world.deliver(event);
    expect(world.harness.requests).toEqual([]);
    expect(world.prefilter.texts).toEqual([]);
    expect(await auditActions(world.stores)).toContain("TURN_SKIPPED_CONTROL_BROKER");
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight ?? []).toEqual([]);
  });
});

describe("FL-098: an event on its last attempt", () => {
  it("the last attempt empties inFlight, writes processError and audits EVENT_DEAD_LETTERED before rethrowing [FL-098]", async () => {
    const boom = new Error("handler failed");
    const world = await workerWorld({ fail: { fireTimer: boom } });
    const event = EVENTS["TIMER"] as OperationQueueEventInput;
    await world.sink.enqueue(event);
    await expect(world.deliver(event, 2)).rejects.toBe(boom);
    const state = await world.stores.connector.world.getOpState(OPERATION);
    expect(state?.inFlight ?? []).toEqual([]);
    expect(state?.processError).toMatchObject({ eventId: event.eventId, type: "TIMER" });
    expect((await world.stores.connector.world.getWorldState(CLOCK))?.inFlight ?? []).toEqual([]);
    expect(await auditActions(world.stores)).toContain("EVENT_DEAD_LETTERED");
    expect(world.metrics("EventDeadLettered")).toHaveLength(1);
  });

  it("an earlier attempt leaves the event in flight, without processError [FL-098]", async () => {
    const boom = new Error("handler failed");
    const world = await workerWorld({ fail: { fireTimer: boom } });
    const event = EVENTS["TIMER"] as OperationQueueEventInput;
    await world.sink.enqueue(event);
    await expect(world.deliver(event, 1)).rejects.toBe(boom);
    const state = await world.stores.connector.world.getOpState(OPERATION);
    expect(state?.inFlight).toContain(event.eventId);
    expect(state?.processError).toBeUndefined();
    expect(await auditActions(world.stores)).not.toContain("EVENT_DEAD_LETTERED");
  });

  it("POISON releases its own delivery (visibility 0) and fails; its last attempt takes the dead-letter path [FL-098]", async () => {
    const world = await workerWorld();
    const poison: OperationQueueEventInput = { type: "POISON", eventId: QA_ID, operationId: OPERATION, clockId: "qa-run1-sc19", firmId: "firm-qa", eventAtSim: START_SIM };
    await world.sink.enqueue(poison);
    await expect(world.deliver(poison, 1)).rejects.toBeInstanceOf(PoisonedEventError);
    expect(world.released).toEqual(["receipt-1"]);
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight).toContain(QA_ID);
    await expect(world.deliver(poison, 2)).rejects.toBeInstanceOf(PoisonedEventError);
    expect(world.released).toHaveLength(2);
    const state = await world.stores.connector.world.getOpState(OPERATION);
    expect(state?.inFlight ?? []).toEqual([]);
    expect(state?.processError).toMatchObject({ eventId: QA_ID, type: "POISON" });
  });

  it("POISON outside a qa-* world is a malformed event", async () => {
    const world = await workerWorld();
    await expect(world.deliver({ type: "POISON", eventId: QA_ID, ...base })).rejects.toBeInstanceOf(MalformedEventError);
    expect(world.released).toEqual([]);
  });
});

describe("agent turns through the worker", () => {
  it("runs the turn once and writes its note", async () => {
    const world = await workerWorld({ harness: [completed()] });
    const event = turnEvent({ trigger: "MILESTONE", milestone: "DOCS_REQUEST" });
    await world.sink.enqueue(event);
    await world.deliver(event);
    expect(world.harness.requests).toHaveLength(1);
    expect((await world.stores.connector.conversations.listTurnNotes(OPERATION)).map((note) => note.text)).toEqual([completed().note]);
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight ?? []).toEqual([]);
  });
});
