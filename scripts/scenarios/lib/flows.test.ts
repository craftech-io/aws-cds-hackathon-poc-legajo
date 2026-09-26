import { describe, expect, it } from "vitest";
import { blockOrigins } from "./asserts";
import { createDriverClient, TransportError } from "./driver-client";
import { deferredThenSent } from "./flows";
import { forbiddenIn, fullSensitiveIn } from "./oracles";
import { worst } from "./report";
import { defineScenario, stepContext } from "./steps";
import { fakeDriver, okWith, refusedWith, snapshotStub } from "./testing";
import { cleanupWorlds, schedulerProbe } from "./world";

const scenario = defineScenario({ id: "SC-01", slug: "sc01", title: "t", suites: ["full"], steps: [] });
const instantTime = { now: (() => { let at = 0; return () => (at += 1_000); })(), sleep: () => Promise.resolve() };
const context = (driver: ReturnType<typeof fakeDriver>, state: Record<string, unknown> = {}) => stepContext({ runId: "812-1", scenario, driver, state, waitOptions: instantTime }, 2, { ids: {}, blocks: [], warnings: [] });

describe("the Scheduler step (SMK/4, SC-01/2)", () => {
  it("unfreezes, waits for the real schedule, and freezes again even when the wait fails", async () => {
    const unfired = snapshotStub({ timers: [{ kind: "MILESTONE", timerId: "DOCS_REQUEST", status: "SCHEDULED" }] as never });
    const driver = fakeDriver({ snapshot: okWith(unfired), "clock.unfreeze": okWith({ timerKey: "TIMER#MILESTONE#DOCS_REQUEST", dueAtSim: "2026-10-15T10:00:00-03:00", dueAtReal: "2026-09-26T15:02:00Z" }) });
    await expect(schedulerProbe(context(driver), "op-7001", "2026-10-15T13:00:00.000Z")).rejects.toThrow(/fired by the Scheduler/);
    expect(driver.calls.map((call) => call.action).filter((action) => action.startsWith("clock."))).toEqual(["clock.unfreeze", "clock.freeze"]);
  });

  it("passes when the timer shows firedBy SCHEDULER", async () => {
    const fired = snapshotStub({ timers: [{ kind: "MILESTONE", timerId: "DOCS_REQUEST", status: "FIRED", firedBy: "SCHEDULER" }] as never });
    const driver = fakeDriver({ snapshot: okWith(fired), "clock.unfreeze": okWith({ timerKey: "TIMER#MILESTONE#DOCS_REQUEST", dueAtSim: "2026-10-15T10:00:00-03:00", dueAtReal: "x" }) });
    await expect(schedulerProbe(context(driver), "op-7001", "2026-10-15T10:00:00-03:00")).resolves.toBeUndefined();
  });
});

describe("a deferred send", () => {
  it("checks the DEFER decision and its timer, advances there and finds the message sent at that hour", async () => {
    const deferred = snapshotStub({
      decisions: [{ decision: "DEFER", ruleIds: ["CP-HOURS-SUPPLIER"], action: "SEND_EMAIL", ts: "2026-10-15T13:05:00.000Z", refs: {} }] as never,
      pendingTimers: [{ timerKey: "TIMER#DEFERRED_SEND#t1", kind: "DEFERRED_SEND", dueAtSim: "2026-10-16T01:00:00.000Z", reason: "CP-HOURS-SUPPLIER" }],
    });
    const sent = snapshotStub({ ...deferred, messages: [{ direction: "OUT", channel: "EMAIL", kind: "DOCS_REQUEST", status: "SENT", sentAtSim: "2026-10-16T01:00:00.000Z", counterpart: "SUPPLIER", buttons: [], refs: {} }] as never });
    let reads = 0;
    const driver = fakeDriver({ snapshot: () => ({ ok: true, replayed: false, result: ++reads < 4 ? deferred : sent }) });
    await deferredThenSent(context(driver), "op-7001", { channel: "EMAIL", kind: "DOCS_REQUEST" }, "CP-HOURS-SUPPLIER", "2026-10-15T22:00:00-03:00");
    expect(driver.calls.find((call) => call.action === "clock.advanceTo")?.input).toEqual({ clockId: "qa-812-1-sc01", to: "2026-10-16T01:00:00.000Z" });
  });
});

describe("cleanup of worlds", () => {
  it("audits and destroys every world, and one failure never skips the rest", async () => {
    const driver = fakeDriver({ "policyAudit.run": (input) => ((input as { clockId: string }).clockId.endsWith("a") ? refusedWith("UNAVAILABLE")(input, "") : okWith({ violations: [] })(input, "")) });
    const outcome = await cleanupWorlds(context(driver, { __worlds: ["qa-812-1-sc01a", "qa-812-1-sc01b"] }));
    expect(outcome.audits).toEqual([{ clockId: "qa-812-1-sc01a", violations: null }, { clockId: "qa-812-1-sc01b", violations: 0 }]);
    expect(outcome.errors).toHaveLength(1);
    expect(driver.calls.filter((call) => call.action === "world.destroy")).toHaveLength(2);
  });
});

describe("oracles (docs/test-plan.md §4.3)", () => {
  it("finds the forbidden patterns, except the upload link", () => {
    expect(forbiddenIn("Te dejo el link: https://legajo.demo.craftech.io/u/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd")).toEqual([]);
    expect(forbiddenIn("Posición 8471.30.12, arancel 35 %, USD 1200, escribí a x@y.com o al +54 9 11 5555 0101, https://docs-upload.example.net/4471")).toEqual(["TARIFF_POSITION", "PERCENTAGE", "USD_AMOUNT", "EMAIL", "PHONE", "URL"]);
    expect(forbiddenIn("Operación 4471: faltan el packing list y el certificado de origen.")).toEqual([]);
    expect(fullSensitiveIn("CUIT [CUIT] y CBU [CBU]")).toEqual([]);
    expect(fullSensitiveIn("CUIT 30-71234567-9, CBU 0000003100012345678901")).toEqual(["CUIT", "CBU"]);
  });

  it("reads where each block came from", () => {
    const snapshot = snapshotStub({
      decisions: [
        { decision: "ACTION", action: "GUARDRAIL_BLOCK", ruleIds: ["G1"], ts: "2026-10-15T14:00:00.000Z", refs: {}, detail: { origin: "PREFILTER", source: "SUPPLIER" } },
        { decision: "DENY", action: "SEND_WHATSAPP", ruleIds: ["CED-NO-APPROVE"], ts: "2026-10-15T14:01:00.000Z", refs: {} },
        { decision: "DENY", action: "GROUNDING_FAIL", ruleIds: ["G2"], ts: "2026-10-15T14:02:00.000Z", refs: {} },
        { decision: "ACTION", action: "GUARDRAIL_BLOCK", ruleIds: ["G1"], ts: "2026-10-15T10:00:00.000Z", refs: {}, detail: { origin: "HARNESS" } },
      ] as never,
    });
    expect(blockOrigins(snapshot, "2026-10-15T13:30:00.000Z").map((block) => block.origin)).toEqual(["PREFILTER", "CEDAR", "OUTBOUND_VERIFY"]);
    expect(worst(["PASS", "WARN", "BLOCKED", "SKIPPED"])).toBe("BLOCKED");
  });
});

describe("the driver client", () => {
  it("retries a Lambda error under the same key, then parses the answer", async () => {
    const payloads: string[] = [];
    let attempt = 0;
    const client = createDriverClient({
      sleep: () => Promise.resolve(),
      invoke: async (payload) => {
        payloads.push(payload);
        attempt += 1;
        return attempt === 1 ? { statusCode: 200, functionError: "Unhandled", payload: "{}" } : { statusCode: 200, payload: JSON.stringify({ ok: true, replayed: true, result: { eventId: "qa-1" } }) };
      },
    });
    expect(await client.call("event.poison", { operationId: "op-7001" }, "812-1/sc19/6/m1")).toEqual({ ok: true, replayed: true, result: { eventId: "qa-1" } });
    expect(new Set(payloads).size).toBe(1);
    expect(JSON.parse(payloads[0] ?? "{}")).toEqual({ action: "event.poison", idempotencyKey: "812-1/sc19/6/m1", input: { operationId: "op-7001" } });
  });

  it("gives up after its attempts and never retries an answer that is not a transport failure", async () => {
    const failing = createDriverClient({ sleep: () => Promise.resolve(), attempts: 2, invoke: async () => ({ statusCode: 500, payload: "" }) });
    await expect(failing.call("snapshot", {}, "812-1/sc01/1/r1")).rejects.toThrow(TransportError);
    let calls = 0;
    const malformed = createDriverClient({ sleep: () => Promise.resolve(), invoke: async () => ((calls += 1), { statusCode: 200, payload: "{\"unexpected\":true}" }) });
    await expect(malformed.call("snapshot", {}, "812-1/sc01/1/r1")).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
