import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./report";
import { CLEANUP_STEP, lanesOf, runSuite } from "./runner";
import { AssertionFailed, type ScenarioDef, defineScenario } from "./steps";
import { fakeDriver, okWith, refusedWith } from "./testing";
import { createWorld } from "./world";

const WORLD = { clockId: "qa-812-1-sc01", firmId: "firm-qa", worldEpoch: 1, created: true, operations: [], firmMailbox: "estudio-qa-812-1-sc01@sim.legajo.demo.craftech.io" };

function scenario(id: string, overrides: Partial<ScenarioDef> = {}): ScenarioDef {
  return defineScenario({ id, slug: `sc${id.slice(3)}`, title: id, suites: ["full"], steps: [{ n: 1, title: "one", flows: ["FL-001"], run: async () => undefined }], ...overrides });
}

const base = { runId: "812-1", suite: "full" as const, maxTurns: 400, now: () => 0 };

describe("runSuite (docs/test-plan.md §4.4)", () => {
  it("skips the steps after a failure, and always cleans up: its own cleanup, the policy audit and world.destroy", async () => {
    const order: string[] = [];
    const failing = scenario("SC-02", {
      steps: [
        { n: 1, title: "world", flows: ["FL-022"], run: async (ctx) => void (await createWorld(ctx, { startAtSim: "2026-10-15T09:55:00-03:00", operations: [{ key: "a", model: "op-4471" }] })) },
        { n: 2, title: "fails", flows: ["FL-022"], run: async () => { throw new AssertionFailed("expected exactly one CORRECTION_REQUEST, found 2"); } },
        { n: 3, title: "skipped", flows: ["FL-023"], run: async () => void order.push("never") },
      ],
      cleanup: async () => void order.push("cleanup"),
    });
    const driver = fakeDriver({ "world.create": okWith(WORLD), "policyAudit.run": okWith({ violations: [] }), "metrics.get": okWith({ usage: { turns: 7, inputTokens: 100, outputTokens: 10 } }) });
    const report = await runSuite({ ...base, scenarios: [failing], driver });
    const result = report.scenarios[0];
    expect(result?.steps.map((step) => step.verdict)).toEqual(["PASS", "FAIL", "SKIPPED"]);
    expect(result?.steps[1]?.error).toContain("exactly one CORRECTION_REQUEST");
    expect(order).toEqual(["cleanup"]);
    expect(driver.calls.filter((call) => call.key.includes(`/${CLEANUP_STEP}/`)).map((call) => call.action)).toEqual(["metrics.get", "policyAudit.run", "world.destroy"]);
    expect(result?.audits).toEqual([{ clockId: "qa-812-1-sc01", violations: 0 }]);
    expect(report.flows).toEqual({ "FL-022": "FAIL", "FL-023": "SKIPPED" });
    expect(report.budget.turns).toBe(7);
  });

  it("reports a module that is not deployed as BLOCKED, never as a pass", async () => {
    const blocked = scenario("SC-03", { steps: [{ n: 1, title: "advance", flows: ["FL-024"], run: async (ctx) => void (await ctx.qa("clock.advanceToNext", { clockId: "qa-812-1-sc03" })) }] });
    const report = await runSuite({ ...base, scenarios: [blocked], driver: fakeDriver({ "clock.advanceToNext": refusedWith("UNAVAILABLE", "NOT_WIRED") }) });
    expect(report.verdict).toBe("BLOCKED");
    expect(report.flows["FL-024"]).toBe("BLOCKED");
  });

  it("fails a scenario whose world has a policy violation", async () => {
    const withWorld = scenario("SC-04", { steps: [{ n: 1, title: "world", flows: ["FL-025"], run: async (ctx) => void (await createWorld(ctx, { startAtSim: "2026-10-19T09:58:00-03:00", operations: [{ key: "a", model: "op-4476" }] })) }] });
    const driver = fakeDriver({ "world.create": okWith(WORLD), "policyAudit.run": okWith({ violations: [{ messageId: "msg-1" }] }), "metrics.get": okWith({ usage: { turns: 0, inputTokens: 0, outputTokens: 0 } }) });
    const report = await runSuite({ ...base, scenarios: [withWorld], driver });
    expect(report.scenarios[0]?.verdict).toBe("FAIL");
    expect(renderMarkdown(report)).toContain("| SC-04 | policy audit | FL-060 | FAIL |");
  });

  it("runs the scenarios of a lane in order, the `last` one alone at the end with the earlier results", async () => {
    const started: string[] = [];
    const track = (id: string, extra: Partial<ScenarioDef> = {}) =>
      scenario(id, { ...extra, steps: [{ n: 1, title: "t", flows: [], run: async (ctx) => void started.push(`${id}:${ctx.previous.map((row) => row.scenario).sort().join(",")}`) }] });
    const scenarios = [track("SC-25", { lane: "guest" }), track("SC-24", { lane: "guest" }), track("SC-26", { alone: true }), track("SC-20", { last: true }), track("SC-01")];
    const { lanes, alone, last } = lanesOf(scenarios);
    expect(lanes.map((lane) => lane.map((row) => row.id))).toEqual([["SC-25", "SC-24"], ["SC-01"]]);
    expect(alone.map((row) => row.id)).toEqual(["SC-26"]);
    expect(last.map((row) => row.id)).toEqual(["SC-20"]);
    await runSuite({ ...base, scenarios, driver: fakeDriver() });
    expect(started.indexOf(started.find((row) => row.startsWith("SC-25")) ?? "")).toBeLessThan(started.indexOf(started.find((row) => row.startsWith("SC-24")) ?? ""));
    expect(started.at(-2)).toBe("SC-26:SC-01,SC-24,SC-25");
    expect(started.at(-1)).toBe("SC-20:SC-01,SC-24,SC-25,SC-26");
  });

  it("stops starting scenarios once the turn budget is spent", async () => {
    const spend = scenario("SC-05", { steps: [{ n: 1, title: "world", flows: [], run: async (ctx) => void (await createWorld(ctx, { startAtSim: "2026-10-20T09:58:00-03:00", operations: [{ key: "a", model: "op-4474" }] })) }] });
    const driver = fakeDriver({ "world.create": okWith(WORLD), "policyAudit.run": okWith({ violations: [] }), "metrics.get": okWith({ usage: { turns: 50, inputTokens: 0, outputTokens: 0 } }) });
    const report = await runSuite({ ...base, maxTurns: 40, parallel: 1, scenarios: [spend, scenario("SC-06")], driver });
    expect(report.scenarios.map((row) => row.verdict)).toEqual(["PASS", "SKIPPED"]);
    expect(report.budget).toMatchObject({ turns: 50, aborted: "turn budget of 40 reached" });
  });

  it("stops once the estimated cost is spent, and says so when a rate is not verified", async () => {
    const spend = scenario("SC-07", { steps: [{ n: 1, title: "world", flows: [], run: async (ctx) => void (await createWorld(ctx, { startAtSim: "2026-10-15T09:58:00-03:00", operations: [{ key: "a", model: "op-4471" }] })) }] });
    const costly = { usage: { turns: 3, inputTokens: 0, outputTokens: 0, dossiers: 2 }, summary: { kpis: [{ key: "costPerDossierUsd", value: 1.5 }] } };
    const driver = fakeDriver({ "world.create": okWith(WORLD), "policyAudit.run": okWith({ violations: [] }), "metrics.get": okWith(costly) });
    const report = await runSuite({ ...base, maxCostUsd: 2, parallel: 1, scenarios: [spend, scenario("SC-08")], driver });
    expect(report.budget).toMatchObject({ costUsd: 3, maxCostUsd: 2, aborted: "cost budget of USD 2 reached" });
    const unverified = { ...costly, summary: { kpis: [{ key: "costPerDossierUsd", value: null }] } };
    const open = await runSuite({ ...base, scenarios: [spend], driver: fakeDriver({ "world.create": okWith(WORLD), "policyAudit.run": okWith({ violations: [] }), "metrics.get": okWith(unverified) }) });
    expect(open.budget.costUsd).toBeNull();
    expect(renderMarkdown(open)).toContain("cost not verified");
    const unverifiedDriver = fakeDriver({ "world.create": okWith(WORLD), "policyAudit.run": okWith({ violations: [] }), "metrics.get": okWith(unverified) });
    const capped = await runSuite({ ...base, maxCostUsd: 2.5, parallel: 1, scenarios: [spend, scenario("SC-08")], driver: unverifiedDriver });
    expect(capped.scenarios.map((row) => row.verdict)).toEqual(["PASS", "SKIPPED"]);
    expect(capped.budget.aborted).toContain("cost of the run is unknown");
  });

  it("never runs more than four scenarios at a time", async () => {
    let running = 0;
    let peak = 0;
    const slow = (id: string) =>
      scenario(id, {
        steps: [
          {
            n: 1,
            title: "slow",
            flows: [],
            run: async () => {
              running += 1;
              peak = Math.max(peak, running);
              await new Promise((resolve) => setTimeout(resolve, 5));
              running -= 1;
            },
          },
        ],
      });
    await runSuite({ ...base, scenarios: ["SC-01", "SC-02", "SC-03", "SC-04", "SC-05", "SC-06", "SC-07"].map(slow), driver: fakeDriver() });
    expect(peak).toBe(4);
  });
});
