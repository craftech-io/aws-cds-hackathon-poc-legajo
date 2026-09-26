import { describe, expect, it } from "vitest";
import { QA_ACTIONS, type QaActionName, qaEventId, qaMailId, qaMessageId, simulatedWamid } from "./contract";
import { GLOBAL_QA_ACTIONS, JUDGE_TEST_ACTIONS, type Scope, WORLDLESS_ACTIONS, checkFence } from "./guard";
import { OTHER_QA_CLOCK, QA_CLOCK, countingHandlers, driverUnderTest, key } from "./testing";

const scope = (name: string, clockId: string | undefined, firmId = "firm-qa", operations: Scope["operations"] = []): Scope => ({ name, firmId, operations, ...(clockId === undefined ? {} : { clockId }) });

function fenceCode(value: Scope): string | undefined {
  try {
    checkFence(value);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const WORLD_ACTIONS = QA_ACTIONS.filter((action) => !WORLDLESS_ACTIONS.has(action) && action !== "console" && action !== "batch.run");

describe("checkFence: the clocks and firms of ADR-0005", () => {
  it("lets every action act on a qa-* world of firm-qa, except the batch", () => {
    for (const action of WORLD_ACTIONS) expect(fenceCode(scope(action, QA_CLOCK)), action).toBeUndefined();
    expect(fenceCode(scope("console.operations.get", QA_CLOCK))).toBeUndefined();
    expect(fenceCode(scope("batch.run", QA_CLOCK))).toBe("FORBIDDEN");
  });

  it("closes GLOBAL#firm-qa to its list: wa.inbound, snapshot, op.settle, memory.inspect, console.clock.reset, metrics.get", () => {
    for (const action of [...WORLD_ACTIONS, "console.operations.get", "console.clock.reset"]) {
      expect(fenceCode(scope(action, "GLOBAL#firm-qa")), action).toBe(GLOBAL_QA_ACTIONS.includes(action) ? undefined : "FORBIDDEN");
    }
    expect(fenceCode(scope("world.destroy", "GLOBAL#firm-qa"))).toBe("FORBIDDEN");
  });

  it("closes JUDGE#firm-judge-test to world.destroy, snapshot, op.settle and platform.get", () => {
    for (const action of [...WORLD_ACTIONS, "console.clock.reset"]) {
      expect(fenceCode(scope(action, "JUDGE#firm-judge-test", "firm-judge-test")), action).toBe(JUDGE_TEST_ACTIONS.includes(action) ? undefined : "FORBIDDEN");
    }
  });

  it("refuses every demo, judge and batch world, whatever the action", () => {
    const worlds: Array<[string, string]> = [
      ["GLOBAL#firm-delta", "firm-delta"],
      ["GLOBAL#firm-norte", "firm-norte"],
      ["JUDGE#firm-judge-01", "firm-judge-01"],
      ["GLOBAL#firm-sim", "firm-sim"],
      ["JUDGE#firm-qa", "firm-qa"],
      ["sim-batch1", "firm-sim"],
    ];
    for (const [clockId, firmId] of worlds) {
      for (const action of [...WORLD_ACTIONS, "console.clock.reset"]) expect(fenceCode(scope(action, clockId, firmId)), `${action} on ${clockId}`).toBe("FORBIDDEN");
    }
    expect(fenceCode(scope("batch.run", "sim-batch1", "firm-sim"))).toBeUndefined();
  });

  it("refuses a firm that is not of QA type and a clock of another firm", () => {
    expect(fenceCode(scope("snapshot", "GLOBAL#firm-delta", "firm-delta"))).toBe("FORBIDDEN");
    expect(fenceCode(scope("snapshot", QA_CLOCK, "firm-judge-test"))).toBe("FORBIDDEN");
    expect(fenceCode(scope("guardrail.probe", undefined, "firm-delta"))).toBe("FORBIDDEN");
  });

  it("refuses an operation that is not of the world the action acts on", () => {
    const foreign = [{ operationId: "op-7002", firmId: "firm-qa", clockId: OTHER_QA_CLOCK }];
    expect(fenceCode(scope("snapshot", QA_CLOCK, "firm-qa", foreign))).toBe("FORBIDDEN");
  });

  it("lets a console call that names only other firms through to firmProcedure, and nothing else", () => {
    expect(fenceCode({ ...scope("console.operations.get", undefined), crossFirmProbe: true })).toBeUndefined();
    expect(fenceCode({ ...scope("snapshot", undefined), crossFirmProbe: true })).toBe("FORBIDDEN");
  });

  it("refuses an importer or supplier of another world, and a qa-* importer without the world's prefix", () => {
    const party = (id: string, clockId: string, firmId = "firm-qa", kind: "importer" | "supplier" = "importer") => ({ kind, id, firmId, clockId });
    const withParties = (parties: NonNullable<Scope["parties"]>): Scope => ({ ...scope("console.registry.consent.revoke", QA_CLOCK), parties });
    expect(fenceCode(withParties([party("imp-qa-812-1-sc01-a", QA_CLOCK)]))).toBeUndefined();
    expect(fenceCode(withParties([party("imp-qamin", "GLOBAL#firm-qa")]))).toBe("FORBIDDEN");
    expect(fenceCode(withParties([party("sup-qamin", "GLOBAL#firm-qa", "firm-qa", "supplier")]))).toBe("FORBIDDEN");
    expect(fenceCode(withParties([party("imp-qa-812-1-sc02-a", OTHER_QA_CLOCK)]))).toBe("FORBIDDEN");
    expect(fenceCode(withParties([party("imp-sc01a", QA_CLOCK)]))).toBe("FORBIDDEN");
  });

  it("admits a Memory actor only of an importer of the world, up to the world's epoch", () => {
    const importer = { kind: "importer" as const, id: "imp-qamin", firmId: "firm-qa", clockId: "GLOBAL#firm-qa" };
    const inspect = (epoch: number, worldEpoch?: number): Scope => ({
      ...scope("memory.inspect", "GLOBAL#firm-qa"),
      parties: [importer],
      actors: [{ actorId: `imp-qamin-e${epoch}`, importerId: "imp-qamin", epoch, ...(worldEpoch === undefined ? {} : { worldEpoch }) }],
    });
    expect(fenceCode(inspect(1, 2))).toBeUndefined();
    expect(fenceCode(inspect(2, 2))).toBeUndefined();
    expect(fenceCode(inspect(3, 2))).toBe("FORBIDDEN");
    expect(fenceCode(inspect(1))).toBe("FORBIDDEN");
    expect(fenceCode({ ...inspect(1, 2), parties: [] })).toBe("FORBIDDEN");
  });

  it("admits the world-less probes only without a world", () => {
    for (const action of WORLDLESS_ACTIONS) expect(fenceCode(scope(action, undefined)), action).toBeUndefined();
    expect(fenceCode(scope("snapshot", undefined))).toBe("FORBIDDEN");
  });
});

describe("QaDriver: the fence on stored data", () => {
  it("resolves the world from the operation itself, never from what the caller says", async () => {
    const { handlers, calls } = countingHandlers();
    const { driver } = await driverUnderTest(handlers);
    const demo = await driver({ action: "snapshot", idempotencyKey: key(1), input: { operationId: "op-4471" } });
    expect(demo).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "QA_FENCE" } });
    const mixed = await driver({ action: "fence.probe", idempotencyKey: key(1, "b"), input: { clockId: QA_CLOCK, to: "qa-x@sim.legajo.demo.craftech.io", operationId: "op-7002" } });
    expect(mixed).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(calls.size).toBe(0);
  });

  it("lets the closed lists through on the two fixed QA worlds", async () => {
    const { handlers, calls } = countingHandlers();
    const { driver } = await driverUnderTest(handlers);
    expect(await driver({ action: "snapshot", idempotencyKey: key(2), input: { operationId: "op-4471-qa" } })).toMatchObject({ ok: true });
    expect(await driver({ action: "clock.advance", idempotencyKey: key(2, "b"), input: { clockId: "GLOBAL#firm-qa", byMinutes: 60 } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await driver({ action: "world.destroy", idempotencyKey: key(2, "c"), input: { clockId: "GLOBAL#firm-qa" } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await driver({ action: "world.destroy", idempotencyKey: key(2, "d"), input: { clockId: "JUDGE#firm-judge-test" } })).toMatchObject({ ok: true });
    expect(await driver({ action: "wa.inbound", idempotencyKey: key(2, "e"), input: { operationId: "op-4471-jt", message: { type: "text", text: "hola" } } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await driver({ action: "platform.get", idempotencyKey: key(2, "f"), input: { firmId: "firm-judge-test", operationNumber: "4471" } })).toMatchObject({ ok: true });
    expect(await driver({ action: "platform.get", idempotencyKey: key(2, "g"), input: { firmId: "firm-delta", operationNumber: "4471" } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await driver({ action: "platform.get", idempotencyKey: key(2, "h"), input: { firmId: "firm-judge-test", operationNumber: "4471", clockId: QA_CLOCK } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect([...calls.keys()].sort()).toEqual(["platform.get", "snapshot", "world.destroy"]);
  });

  it("fences a console call to the world it names and keeps firm-qa operations inside it", async () => {
    const { handlers, calls } = countingHandlers();
    const { driver } = await driverUnderTest(handlers);
    expect(await driver({ action: "console", idempotencyKey: key(3), input: { procedure: "operations.get", input: { operationId: "op-7001" } } })).toMatchObject({ ok: true });
    expect(await driver({ action: "console", idempotencyKey: key(3, "b"), input: { procedure: "operations.list", input: { clockId: QA_CLOCK, statuses: ["OPEN"] } } })).toMatchObject({ ok: true });
    const crossWorld = await driver({ action: "console", idempotencyKey: key(3, "c"), input: { procedure: "operations.get", input: { clockId: QA_CLOCK, operationId: "op-7002" } } });
    expect(crossWorld).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "QA_FENCE" } });
    expect(await driver({ action: "console", idempotencyKey: key(3, "d"), input: { procedure: "operations.list", input: { clockId: "GLOBAL#firm-qa" } } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await driver({ action: "console", idempotencyKey: key(3, "e"), input: { procedure: "account.session" } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(calls.get("console")).toBe(2);
  });

  it("fences memory.inspect by actor to the importers of the world it names (SEC-1)", async () => {
    const { handlers, calls } = countingHandlers();
    const { driver, stores } = await driverUnderTest(handlers);
    const inspect = (label: string, actorId: string, clockId: string) => driver({ action: "memory.inspect", idempotencyKey: key(9, label), input: { actorId, clockId, sessionIds: ["s1"] } });
    const fenced = { ok: false, error: { code: "FORBIDDEN", reason: "QA_FENCE" } };
    expect(await inspect("a", "imp-qa-812-1-sc01-a-e1", QA_CLOCK)).toMatchObject({ ok: true });
    // A demo firm's importer, the synthetic judge's, another scenario's and GLOBAL#firm-qa's, all under a qa-* clock.
    expect(await inspect("b", "imp-norpampa-e1", QA_CLOCK)).toMatchObject(fenced);
    expect(await inspect("c", "imp-jtest-e1", QA_CLOCK)).toMatchObject(fenced);
    expect(await inspect("d", "imp-qa-812-1-sc02-a-e1", QA_CLOCK)).toMatchObject(fenced);
    expect(await inspect("e", "imp-qamin-e1", QA_CLOCK)).toMatchObject(fenced);
    expect(await inspect("f", "imp-norpampa-e1", "GLOBAL#firm-qa")).toMatchObject(fenced);
    expect(await inspect("g", "not-an-actor", QA_CLOCK)).toMatchObject(fenced);
    // SC-20 reads the actor of a past epoch of GLOBAL#firm-qa after its reset, never a future one.
    const clock = await stores.connector.world.getClock("GLOBAL#firm-qa");
    await stores.connector.world.updateClock("GLOBAL#firm-qa", { worldEpoch: 2 }, clock.version);
    expect(await inspect("h", "imp-qamin-e1", "GLOBAL#firm-qa")).toMatchObject({ ok: true });
    expect(await inspect("i", "imp-qamin-e3", "GLOBAL#firm-qa")).toMatchObject(fenced);
    expect(calls.get("memory.inspect")).toBe(2);
  });

  it("fences the importers and suppliers of a console call to the world it names (B2)", async () => {
    const { handlers, calls } = countingHandlers();
    const { driver } = await driverUnderTest(handlers);
    const call = (label: string, procedure: string, input: Record<string, unknown>) => driver({ action: "console", idempotencyKey: key(10, label), input: { procedure, input } });
    const fenced = { ok: false, error: { code: "FORBIDDEN", reason: "QA_FENCE" } };
    expect(await call("a", "registry.consent.revoke", { clockId: QA_CLOCK, importerId: "imp-qa-812-1-sc01-a" })).toMatchObject({ ok: true });
    expect(await call("b", "registry.consent.revoke", { clockId: QA_CLOCK, importerId: "imp-qamin" })).toMatchObject(fenced);
    expect(await call("c", "registry.authorization.set", { clockId: QA_CLOCK, importerId: "imp-qa-812-1-sc01-a", supplierId: "sup-qamin", authorized: true })).toMatchObject(fenced);
    expect(await call("d", "registry.supplierBehaviour.set", { clockId: QA_CLOCK, supplierId: "sup-sc02a", behaviour: "PROMPT" })).toMatchObject(fenced);
    expect(await call("e", "registry.contacts.confirm", { importerId: "imp-qa-812-1-sc02-a", clockId: QA_CLOCK })).toMatchObject(fenced);
    // Without a clock, a QA party names its own world; a party of GLOBAL#firm-qa lands on its closed list.
    expect(await call("f", "registry.consent.revoke", { importerId: "imp-qa-812-1-sc02-a" })).toMatchObject({ ok: true });
    expect(await call("g", "registry.consent.revoke", { importerId: "imp-qamin" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(calls.get("console")).toBe(2);
  });

  it("rejects unknown keys, malformed idempotency keys and a world.create of another run", async () => {
    const { handlers, calls } = countingHandlers();
    const { driver } = await driverUnderTest(handlers);
    expect(await driver({ action: "snapshot", idempotencyKey: key(4), input: { operationId: "op-7001", extra: true } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await driver({ action: "snapshot", idempotencyKey: "not-a-key", input: { operationId: "op-7001" } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    const otherRun = await driver({ action: "world.create", idempotencyKey: key(4, "b"), input: { runId: "999-1", scenario: "sc01", startAtSim: "2026-10-15T09:55:00-03:00", operations: [{ key: "a", model: "op-4471" }] } });
    expect(otherRun).toMatchObject({ ok: false });
    expect(calls.size).toBe(0);
  });
});

describe("QaDriver: a retried step never duplicates an effect (docs/test-plan.md §4.4)", () => {
  it("answers a changing action once per idempotency key and replays its first result", async () => {
    const { handlers, calls } = countingHandlers();
    const { driver } = await driverUnderTest(handlers);
    const request = { action: "supplier.setBehaviour" as QaActionName, idempotencyKey: key(5), input: { operationId: "op-7001", behaviour: "PROMPT" } };
    const first = await driver(request);
    const again = await driver(request);
    expect(first).toEqual({ ok: true, replayed: false, result: { action: "supplier.setBehaviour", call: 1 } });
    expect(again).toEqual({ ok: true, replayed: true, result: { action: "supplier.setBehaviour", call: 1 } });
    expect(calls.get("supplier.setBehaviour")).toBe(1);
    expect(await driver({ ...request, idempotencyKey: key(5, "b") })).toMatchObject({ replayed: false, result: { call: 2 } });
  });

  it("reads again on every call of a read-only action", async () => {
    const { handlers, calls } = countingHandlers();
    const { driver } = await driverUnderTest(handlers);
    const request = { action: "snapshot" as QaActionName, idempotencyKey: key(6), input: { operationId: "op-7001" } };
    await driver(request);
    expect(await driver(request)).toMatchObject({ replayed: false, result: { call: 2 } });
    expect(calls.get("snapshot")).toBe(2);
  });

  it("does not remember a failure: the retry runs the action again", async () => {
    const { handlers } = countingHandlers();
    let attempts = 0;
    const flaky = { ...handlers, "event.poison": async () => (++attempts === 1 ? Promise.reject(new Error("boom")) : { eventId: "qa-1" }) };
    const { driver } = await driverUnderTest(flaky);
    const request = { action: "event.poison" as QaActionName, idempotencyKey: key(7), input: { operationId: "op-7001" } };
    expect(await driver(request)).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(await driver(request)).toEqual({ ok: true, replayed: false, result: { eventId: "qa-1" } });
  });

  it("derives the provider ids from the key: the same key gives the same ids, another key others", async () => {
    const [a, b] = [key(8), key(8, "b")];
    expect(await simulatedWamid(a)).toBe(await simulatedWamid(a));
    expect(await simulatedWamid(a)).toMatch(/^wamid\.SIM\.[0-9a-f]{64}$/);
    expect(await simulatedWamid(a)).not.toBe(await simulatedWamid(b));
    expect(await qaMailId(a)).toMatch(/^qa[0-9a-f]{40}$/);
    expect(await qaMailId(a)).not.toBe(await qaMailId(b));
    expect(await qaMessageId(a, "sim.legajo.demo.craftech.io")).toMatch(/^<qa-[0-9a-f]{40}@sim\.legajo\.demo\.craftech\.io>$/);
    expect(await qaEventId(a)).toBe(await qaEventId(a));
  });
});
