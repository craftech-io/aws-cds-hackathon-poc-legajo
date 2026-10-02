// One `AGENT_TURN` end to end over the in-memory world (docs/architecture.md §7 and §9.1): the gates,
// the session and its token, the identity sent to the Harness, the note, the tokens, the latency of a
// first response, a failed turn and its fallback, and a throttled Harness.
import { describe, expect, it } from "vitest";
import { HarnessError, type HarnessClient, type HarnessTurnRequest } from "../agent/harness-client";
import { operationFixture } from "../connector/testing";
import { CLOCK, FIRM, OPERATION, REAL_NOW, START_SIM, USAGE, completed, seedInbound, takeControl, turnEvent, workerWorld } from "../worker/testing";
import { TurnEvent } from "../worker/events";
import { requestForcedFailure } from "./forced-failure";
import { actorIdOf } from "./identity";
import { runAgentTurn } from "./turn";

type World = Awaited<ReturnType<typeof workerWorld>>;

function run(world: World, input: Parameters<typeof turnEvent>[0] = {}) {
  const event = TurnEvent.parse(turnEvent(input));
  const ctx = { log: world.log, sink: world.sink, now: world.realNow, receiveCount: 1, deadlineMs: world.realNow().getTime() + 300_000 };
  return runAgentTurn({ ...world.deps.turn, data: world.deps.data, escalation: world.deps.escalation }, event, ctx);
}

const tokenParts = (request: HarnessTurnRequest | undefined) => /<session token="([^"]+)"/.exec(request?.envelope ?? "")?.[1]?.split(".") ?? [];

describe("the session and the identity of a turn", () => {
  it("writes SESSION# with the operation's identity, signs a token for the turn and closes the turn after it", async () => {
    const world = await workerWorld({ harness: [completed()] });
    const outcome = await run(world, { trigger: "MILESTONE", milestone: "DOCS_REQUEST" });
    expect(outcome.kind).toBe("COMPLETED");
    const [sessionId, turnId, exp] = tokenParts(world.harness.requests[0]);
    const session = await world.stores.connector.runtime.getSession(sessionId ?? "");
    expect(session).toMatchObject({ operationId: OPERATION, firmId: FIRM, importerId: "imp-norpampa", supplierId: "sup-qingdao", trigger: "MILESTONE", clockId: CLOCK, eventAtSim: expect.any(String) });
    const turn = await world.stores.connector.runtime.getTurn(turnId ?? "");
    expect(turn?.closedAtReal).toBe(REAL_NOW);
    expect(Number(exp) - Date.parse(REAL_NOW) / 1000).toBeLessThanOrEqual(15 * 60);
  });

  it("invokes the Harness with the importer's actor of the world epoch and a session id without personal data", async () => {
    const world = await workerWorld({ harness: [completed()] });
    await run(world);
    const [request] = world.harness.requests;
    expect(request?.actorId).toBe("imp-norpampa-e1");
    expect(request?.runtimeSessionId).toMatch(/^[a-f0-9]{48}$/);
    expect(request?.runtimeSessionId).not.toContain("5491155500101");
    expect(request?.deadlineMs).toBeGreaterThan(world.realNow().getTime());
    expect(actorIdOf("imp-norpampa", 3)).toBe("imp-norpampa-e3");
    expect(() => actorIdOf("imp-norpampa", 0)).toThrow(RangeError);
  });
});

describe("what a completed turn leaves", () => {
  it("the note of the turn, its tokens on the dossier's KPI row and TurnLatency", async () => {
    const world = await workerWorld({ harness: [completed({ note: "Pedí el packing list. CUIT 20-12345678-9" })] });
    await run(world);
    const [note] = await world.stores.connector.conversations.listTurnNotes(OPERATION);
    expect(note?.text).toContain("Pedí el packing list.");
    expect(note?.text).not.toContain("20-12345678-9");
    expect(note?.usage).toEqual(USAGE);
    const kpi = await world.stores.connector.metrics.getKpi({ firmId: FIRM, source: "WORLD", clockId: CLOCK, operationId: OPERATION });
    expect(kpi).toMatchObject({ turns: 1, inputTokens: USAGE.inputTokens, outputTokens: USAGE.outputTokens, cacheReadTokens: USAGE.cacheReadTokens, agentMode: "SCRIPTED" });
    expect(world.metrics("TurnLatency")).toHaveLength(1);
  });

  it("records the first-response latency of a party's message from the first outbound of that turn", async () => {
    const world = await workerWorld();
    await seedInbound(world.stores, { messageId: "msg-01JAAAA", body: "¿Qué falta?" });
    const harness: HarnessClient = {
      async invoke(request) {
        const [, turnId] = tokenParts(request);
        world.advanceReal(4_000);
        await world.stores.connector.conversations.appendMessage({
          messageId: "msg-01JAAAO",
          operationId: OPERATION,
          firmId: FIRM,
          clockId: CLOCK,
          direction: "OUT",
          channel: "WHATSAPP",
          kind: "REPLY",
          counterpart: "IMPORTER",
          importerId: "imp-norpampa",
          to: "+5491155500101",
          from: "+5491100000000",
          body: "Falta el certificado de origen.",
          status: "SENT",
          author: "AGENT",
          turnId: turnId ?? "",
          sentAtSim: START_SIM,
          sentAtReal: world.realNow().toISOString(),
        });
        return completed();
      },
    };
    const event = TurnEvent.parse(turnEvent({ trigger: "IMPORTER_MESSAGE", key: "w", messageId: "msg-01JAAAA" }));
    const ctx = { log: world.log, sink: world.sink, now: world.realNow, receiveCount: 1, deadlineMs: world.realNow().getTime() + 300_000 };
    await runAgentTurn({ ...world.deps.turn, harness, data: world.deps.data, escalation: world.deps.escalation }, event, ctx);
    const kpi = await world.stores.connector.metrics.getKpi({ firmId: FIRM, source: "WORLD", clockId: CLOCK, operationId: OPERATION });
    expect(JSON.stringify(kpi)).toContain("4000");
  });
});

describe("a turn that fails", () => {
  it("an incomplete stop writes TURN_FAILED and a fixed note, and counts TurnErrors", async () => {
    const world = await workerWorld({ harness: [completed({ outcome: "INCOMPLETE", stopReason: "max_iterations_exceeded", note: "" })] });
    const outcome = await run(world);
    expect(outcome).toMatchObject({ kind: "FAILED", cause: "INCOMPLETE" });
    expect((await world.stores.connector.conversations.listTurnNotes(OPERATION)).map((note) => note.text)).toEqual(["TURN_FAILED"]);
    expect((await world.stores.connector.audit.listByOperation(OPERATION)).map((decision) => decision.action)).toContain("TURN_FAILED");
    expect(world.metrics("TurnErrors")).toHaveLength(1);
    expect(world.handlers.calls).toEqual([]);
  });

  it("FL-097: a failed first request (MILESTONE DOCS_REQUEST) hands over to the deterministic fallback", async () => {
    const world = await workerWorld({ harness: [new HarnessError("TIMEOUT", "late")] });
    const outcome = await run(world, { trigger: "MILESTONE", milestone: "DOCS_REQUEST" });
    expect(outcome).toMatchObject({ kind: "FAILED", cause: "TIMEOUT" });
    expect(world.handlers.calls).toEqual([{ handler: "milestoneFallback", input: expect.objectContaining({ cause: "TIMEOUT", turnId: expect.any(String) }) }]);
  });

  it("turn.forceFailure fails the next turn of a qa-* operation once, before the Harness", async () => {
    const world = await workerWorld({ harness: [completed()] });
    const settings = await world.stores.connector.firms.getSettings(FIRM);
    await world.stores.seed.loadItems("Firms", [{ ...settings, createdAt: REAL_NOW, updatedAt: REAL_NOW, version: 1, synthetic: true, PK: "FIRM#firm-qa", SK: "SETTINGS", entity: "FirmSettings", firmId: "firm-qa" }]);
    const qaClock = "qa-run1-sc19";
    const qaOperation = operationFixture({ operationNumber: "9019", threadTag: "q7p2q9", firmId: "firm-qa", clockId: qaClock });
    await world.stores.connector.operations.createOperation({ ...qaOperation, threadClaimHash: "b".repeat(64) });
    await requestForcedFailure(world.stores.connector.runtime, { operationId: "op-9019", clockId: qaClock, atReal: REAL_NOW });
    const input = { trigger: "MILESTONE" as const, milestone: "DOCS_REQUEST" as const, operationId: "op-9019", clockId: qaClock, firmId: "firm-qa" };
    expect(await run(world, { ...input, key: "f1" })).toMatchObject({ kind: "FAILED", cause: "TIMEOUT" });
    expect(world.harness.requests).toEqual([]);
    expect(await run(world, { ...input, key: "f2" })).toMatchObject({ kind: "COMPLETED" });
  });

  it("a throttled Harness closes the turn and puts the event back on the queue (rethrows)", async () => {
    const world = await workerWorld({ harness: [new HarnessError("THROTTLED", "busy")] });
    await expect(run(world)).rejects.toMatchObject({ kind: "THROTTLED" });
    const [, turnId] = tokenParts(world.harness.requests[0]);
    expect((await world.stores.connector.runtime.getTurn(turnId ?? ""))?.closedAtReal).toBe(REAL_NOW);
    expect(await world.stores.connector.conversations.listTurnNotes(OPERATION)).toEqual([]);
  });
});

describe("the gates before the Harness", () => {
  it("an operation gone from the event's world is skipped", async () => {
    const world = await workerWorld();
    expect(await run(world, { operationId: "op-4999" })).toEqual({ kind: "SKIPPED", reason: "NO_OPERATION" });
    expect(await run(world, { clockId: "GLOBAL#firm-norte" })).toEqual({ kind: "SKIPPED", reason: "NO_OPERATION" });
    expect(world.harness.requests).toEqual([]);
  });

  it("control BROKER skips the turn and audits it once per event, however often it is retried", async () => {
    const world = await workerWorld();
    await takeControl(world.stores);
    expect(await run(world, { trigger: "IMPORTER_MESSAGE", key: "w" })).toEqual({ kind: "SKIPPED", reason: "CONTROL_BROKER" });
    await run(world, { trigger: "IMPORTER_MESSAGE", key: "w" });
    const skipped = (await world.stores.connector.audit.listByOperation(OPERATION)).filter((decision) => decision.action === "TURN_SKIPPED_CONTROL_BROKER");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.ruleIds).toEqual(["CP-CONTROL-BROKER"]);
  });
});
