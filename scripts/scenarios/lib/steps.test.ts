import { describe, expect, it } from "vitest";
import { WaitTimeout, eventually } from "./eventually";
import { AssertionFailed, DriverRefusal, ScenarioBug, defineScenario, stepContext } from "./steps";
import { fakeDriver, okWith, refusedWith, snapshotStub } from "./testing";

const scenario = defineScenario({ id: "SC-01", slug: "sc01", title: "test", suites: ["full"], steps: [] });
const record = () => ({ ids: {}, blocks: [], warnings: [] });

function contextWith(driver: ReturnType<typeof fakeDriver>, step = 3) {
  return stepContext({ runId: "812-1", scenario, driver, state: {} }, step, record());
}

describe("step context: keys (docs/test-plan.md §4.4)", () => {
  it("labels changing calls m1, m2… and reads r1, r2… under <runId>/<scenario>/<step>", async () => {
    const driver = fakeDriver();
    const ctx = contextWith(driver);
    await ctx.qa("supplier.setBehaviour", { operationId: "op-7001", behaviour: "PROMPT" });
    await ctx.qa("snapshot", { operationId: "op-7001" });
    await ctx.qa("wa.inbound", { operationId: "op-7001", message: { type: "text", text: "hola" } });
    await ctx.qa("console", { procedure: "operations.get", input: { operationId: "op-7001" } });
    expect(driver.calls.map((call) => call.key)).toEqual(["812-1/sc01/3/m1", "812-1/sc01/3/r1", "812-1/sc01/3/m2", "812-1/sc01/3/r2"]);
    expect(ctx.lastKey()).toBe("812-1/sc01/3/r2");
  });

  it("the same step run again produces the same keys, so the driver replays instead of acting twice", async () => {
    const first = fakeDriver();
    const again = fakeDriver();
    for (const driver of [first, again]) {
      const ctx = contextWith(driver);
      await ctx.qa("clock.advance", { clockId: "qa-812-1-sc01", byMinutes: 60 });
      await ctx.qa("event.poison", { operationId: "op-7001" });
    }
    expect(again.calls.map((call) => call.key)).toEqual(first.calls.map((call) => call.key));
  });

  it("turns a refusal into DriverRefusal with its code and reason; attempt returns it as it is", async () => {
    const driver = fakeDriver({ "clock.advance": refusedWith("UNAVAILABLE", "NOT_WIRED") });
    const ctx = contextWith(driver);
    await expect(ctx.qa("clock.advance", { clockId: "qa-812-1-sc01", byMinutes: 1 })).rejects.toMatchObject({ name: "DriverRefusal", code: "UNAVAILABLE", reason: "NOT_WIRED" });
    expect(await ctx.attempt("clock.advance", { clockId: "qa-812-1-sc01", byMinutes: 1 })).toMatchObject({ ok: false, error: { reason: "NOT_WIRED" } });
    expect(new DriverRefusal("snapshot", "NOT_FOUND", undefined, "x").message).toContain("snapshot: NOT_FOUND");
  });
});

describe("step context: negatives only after op.settle (docs/test-plan.md §4.3)", () => {
  it("refuses a negative on a snapshot that did not come from settled()", async () => {
    const driver = fakeDriver({ snapshot: okWith(snapshotStub()) });
    const ctx = contextWith(driver);
    const plain = await ctx.snapshot("op-7001");
    expect(() => ctx.none(plain, "messages", [])).toThrow(ScenarioBug);
    expect(() => ctx.exactly(plain, 0, "messages", [])).toThrow(ScenarioBug);
  });

  it("accepts it on a settled snapshot, and refuses it again after the next change", async () => {
    const driver = fakeDriver({ snapshot: () => ({ ok: true, replayed: false, result: snapshotStub() }) });
    const ctx = contextWith(driver);
    const settled = await ctx.settled("op-7001");
    expect(driver.calls.map((call) => call.action)).toEqual(["op.settle", "snapshot"]);
    expect(() => ctx.none(settled, "messages", [])).not.toThrow();
    expect(ctx.exactly(settled, 1, "escalations", ["one"])).toEqual(["one"]);
    expect(() => ctx.none(settled, "messages", ["x"])).toThrow(AssertionFailed);
    await ctx.qa("wa.inbound", { operationId: "op-7001", message: { type: "text", text: "hola" } });
    expect(() => ctx.none(settled, "messages", [])).toThrow(ScenarioBug);
  });

  it("records ids, blocks and warnings for the report", () => {
    const own = record();
    const ctx = stepContext({ runId: "812-1", scenario, driver: fakeDriver(), state: {} }, 1, own);
    ctx.note("world", "qa-812-1-sc01");
    ctx.blocked("PREFILTER", "GUARDRAIL_BLOCK SUPPLIER");
    ctx.warn("facts completed by quiet time");
    expect(own).toEqual({ ids: { world: "qa-812-1-sc01" }, blocks: [{ origin: "PREFILTER", detail: "GUARDRAIL_BLOCK SUPPLIER" }], warnings: ["facts completed by quiet time"] });
  });

  it("refuses a scenario whose step numbers repeat", () => {
    const step = { n: 1, title: "x", flows: [], run: async () => undefined };
    expect(() => defineScenario({ ...scenario, steps: [step, step] })).toThrow(RangeError);
  });
});

describe("eventually (docs/test-plan.md §4.3)", () => {
  function fakeTime() {
    let now = 0;
    return { now: () => now, sleep: (ms: number) => Promise.resolve(void (now += ms)) };
  }

  it("polls until the probe answers something, retrying a probe that throws", async () => {
    let attempts = 0;
    const found = await eventually("the thing", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("not yet");
      return attempts === 3 ? "done" : undefined;
    }, { timeoutSec: 60, everySec: 5, ...fakeTime() });
    expect(found).toBe("done");
    expect(attempts).toBe(3);
  });

  it("times out naming what it waited for and the last error", async () => {
    await expect(eventually("the reply", async () => { throw new Error("still busy"); }, { timeoutSec: 30, ...fakeTime() })).rejects.toThrow(WaitTimeout);
    await expect(eventually("the reply", async () => false, { timeoutSec: 30, ...fakeTime() })).rejects.toThrow("the reply: not reached within 30 s");
  });
});
