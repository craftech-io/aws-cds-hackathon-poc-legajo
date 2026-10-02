// FL-034 on the worker's side: double idempotency (FIFO deduplication by `eventId` plus
// `Runtime/IDEMP#<type>#<eventId>` written after the effect) and the balanced `inFlight` sets.
import { describe, expect, it } from "vitest";
import { HarnessError } from "../agent/harness-client";
import { CLOCK, OPERATION, completed, enqueued, seedInbound, turnEvent, workerWorld } from "./testing";

describe("FL-034: a repeated event never runs twice", () => {
  it("SendMessage groups by operation and deduplicates by event id; a repeated enqueue leaves one id in flight", async () => {
    const world = await workerWorld();
    const event = turnEvent({ trigger: "IMPORTER_MESSAGE", key: "wamid.1", messageId: "msg-01JAAAA" });
    await world.sink.enqueue(event);
    await world.sink.enqueue(event);
    expect(world.sent.map((input) => [input.MessageGroupId, input.MessageDeduplicationId])).toEqual([
      [OPERATION, event.eventId],
      [OPERATION, event.eventId],
    ]);
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight).toEqual([event.eventId]);
    expect((await world.stores.connector.world.getWorldState(CLOCK))?.inFlight).toEqual([`${OPERATION}#${event.eventId}`]);
  });

  it("a redelivery after the event finished is acknowledged without a second turn and leaves the sets empty [FL-034]", async () => {
    const world = await workerWorld({ harness: [completed(), completed()] });
    await seedInbound(world.stores, { messageId: "msg-01JAAAA", body: "¿Qué les falta?" });
    const event = turnEvent({ trigger: "IMPORTER_MESSAGE", key: "wamid.1", messageId: "msg-01JAAAA" });
    await world.sink.enqueue(event);
    await world.deliver(event);
    await world.sink.enqueue(event);
    await world.deliver(event);
    expect(world.harness.requests).toHaveLength(1);
    expect(world.prefilter.texts).toHaveLength(1);
    expect(await world.stores.connector.conversations.listTurnNotes(OPERATION)).toHaveLength(1);
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight ?? []).toEqual([]);
    expect((await world.stores.connector.world.getWorldState(CLOCK))?.inFlight ?? []).toEqual([]);
  });

  it("a delivery that failed halfway runs again, and the turn is done exactly once [FL-034]", async () => {
    const world = await workerWorld({ harness: [new HarnessError("THROTTLED", "throttled"), completed()] });
    const event = turnEvent({ trigger: "MILESTONE", milestone: "DOCS_REQUEST" });
    await world.sink.enqueue(event);
    await expect(world.deliver(event, 1)).rejects.toBeInstanceOf(HarnessError);
    expect(await world.stores.connector.runtime.getIdempotency("AGENT_TURN", event.eventId)).toBeUndefined();
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight).toEqual([event.eventId]);
    await world.deliver(event, 2);
    expect(world.harness.requests).toHaveLength(2);
    expect((await world.stores.connector.conversations.listTurnNotes(OPERATION)).map((note) => note.text)).toEqual([completed().note]);
    expect(await world.stores.connector.runtime.getIdempotency("AGENT_TURN", event.eventId)).toBeDefined();
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight ?? []).toEqual([]);
  });

  it("a retried event never doubles its follow-up: the fixed reply's id derives from the blocked turn", async () => {
    const world = await workerWorld({ verdicts: [{ action: "BLOCKED", policy: "DENIED_TOPIC", topics: ["tariffs"] }, { action: "BLOCKED", policy: "DENIED_TOPIC", topics: ["tariffs"] }] });
    await seedInbound(world.stores, { messageId: "msg-01JAAAA", body: "¿Cuánto pago de arancel?" });
    const event = turnEvent({ trigger: "IMPORTER_MESSAGE", key: "wamid.2", messageId: "msg-01JAAAA" });
    // Two deliveries before the idempotency mark (a crash right after the escalation).
    const { runAgentTurn } = await import("../turns/turn");
    const parsed = (await import("./events")).TurnEvent.parse(event);
    const ctx = { log: world.log, sink: world.sink, now: world.realNow, receiveCount: 1, deadlineMs: world.realNow().getTime() + 60_000 };
    await runAgentTurn({ ...world.deps.turn, data: world.deps.data, escalation: world.deps.escalation }, parsed, ctx);
    await runAgentTurn({ ...world.deps.turn, data: world.deps.data, escalation: world.deps.escalation }, parsed, ctx);
    const replies = enqueued(world).filter((body) => body["type"] === "OUTBOUND_SEND");
    expect(new Set(replies.map((body) => body["eventId"])).size).toBe(1);
    expect(new Set(world.sent.filter((input) => input.MessageBody?.includes("OUTBOUND_SEND")).map((input) => input.MessageDeduplicationId)).size).toBe(1);
    expect((await world.stores.connector.operations.listEscalations(OPERATION, { status: "OPEN" })).length).toBe(1);
    const blocks = (await world.stores.connector.audit.listByOperation(OPERATION)).filter((decision) => decision.action === "GUARDRAIL_BLOCK");
    expect(blocks).toHaveLength(1);
  });
});
