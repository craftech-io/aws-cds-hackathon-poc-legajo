// The scenarios prove exactly the steps the catalog cites (docs/test-plan.md §2.2): every `SC-xx/n` and
// `SMK/n` of a flow's "Prueba" line is step n of that scenario and declares the flow, and no step
// declares a flow the catalog does not cite for it. `npm run flows:check` only looks at the file; this
// looks at the step.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandStepRef } from "@legajo/shared";
import { CATALOG_FILE, parseCatalog } from "../../flows/check";
import { DEFAULT_MAX_TURNS, defaultRunId, parseRunArgs } from "../run";
import { SCENARIOS, namedScenarios, scenariosOf } from "./suites";

const ROOT = join(import.meta.dirname, "../../..");
const flows = parseCatalog(readFileSync(join(ROOT, CATALOG_FILE), "utf8"));

/** `SC-07/2` → ["SC-07", 2]; the smoke's `SMK/3` is step 3 of SC-00. */
function stepOf(ref: string): [string, number] {
  const [scenario = "", step = "0"] = ref.split("/");
  return [scenario === "SMK" ? "SC-00" : scenario, Number(step)];
}

const cited = new Map<string, Set<string>>();
for (const flow of flows) {
  for (const ref of [...flow.tests.SR, ...flow.tests.SMK].flatMap(expandStepRef)) {
    const key = stepOf(ref).join("/");
    cited.set(key, new Set([...(cited.get(key) ?? []), flow.id]));
  }
}

describe("scenarios against the flow catalog", () => {
  it("every cited step exists and declares its flow (SC-23 waits for P-01)", () => {
    const missing: string[] = [];
    for (const [key, ids] of cited) {
      const [scenarioId = "", n = "0"] = key.split("/");
      const step = SCENARIOS.find((scenario) => scenario.id === scenarioId)?.steps.find((candidate) => candidate.n === Number(n));
      for (const id of ids) if (step === undefined || !step.flows.includes(id)) missing.push(`${key} ${id}`);
    }
    expect(missing).toEqual([]);
  });

  it("no step declares a flow the catalog does not cite for it", () => {
    const extra: string[] = [];
    for (const scenario of SCENARIOS) {
      for (const step of scenario.steps) {
        const allowed = cited.get(`${scenario.id}/${step.n}`) ?? new Set<string>();
        for (const id of step.flows) if (!allowed.has(id)) extra.push(`${scenario.id}/${step.n} ${id}`);
      }
    }
    expect(extra).toEqual([]);
  });

  it("the smoke is SC-00; the full suite has every scenario, SC-25 before SC-24 in one lane and SC-20 last", () => {
    expect(scenariosOf("smoke").map((scenario) => scenario.id)).toEqual(["SC-00"]);
    const full = scenariosOf("full").map((scenario) => scenario.id);
    const expected = Array.from({ length: 26 }, (_, index) => `SC-${String(index).padStart(2, "0")}`).filter((id) => id !== "SC-23");
    expect([...full].sort()).toEqual(expected);
    expect(full.indexOf("SC-25")).toBeLessThan(full.indexOf("SC-24"));
    expect(SCENARIOS.filter((scenario) => scenario.last).map((scenario) => scenario.id)).toEqual(["SC-20"]);
    expect(SCENARIOS.filter((scenario) => scenario.lane === "judge").map((scenario) => scenario.id)).toEqual(["SC-25", "SC-24"]);
    expect(new Set(SCENARIOS.map((scenario) => scenario.slug)).size).toBe(SCENARIOS.length);
    expect(namedScenarios(["LOAD"]).map((scenario) => scenario.id)).toEqual(["LOAD"]);
    expect(() => namedScenarios(["SC-99"])).toThrow(RangeError);
  });
});

describe("npm run scenarios arguments", () => {
  it("takes the run id from GitHub Actions, or makes a local one", () => {
    expect(defaultRunId({ GITHUB_RUN_ID: "812", GITHUB_RUN_ATTEMPT: "2" }, 0)).toBe("812-2");
    expect(defaultRunId({}, Date.parse("2026-09-26T15:00:00Z"))).toMatch(/^local-[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it("parses the suite, the scenarios and the budget, and refuses what it does not know", () => {
    expect(parseRunArgs(["--suite", "smoke"], {}, 0)).toMatchObject({ suite: "smoke", maxTurns: DEFAULT_MAX_TURNS.smoke, parallel: 4, allowDkimPending: false });
    expect(parseRunArgs(["--scenario", "SC-09", "--scenario", "SC-20", "--max-turns", "120", "--allow-dkim-pending"], { GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "1" }, 0)).toMatchObject({ suite: "full", scenarios: ["SC-09", "SC-20"], maxTurns: 120, runId: "9-1", allowDkimPending: true });
    expect(parseRunArgs(["--parallel", "9"], {}, 0).parallel).toBe(4);
    expect(() => parseRunArgs(["--suite", "nightly"], {}, 0)).toThrow(RangeError);
    expect(() => parseRunArgs(["--run-id", "../../etc"], {}, 0)).toThrow();
    expect(() => parseRunArgs(["--verbose"], {}, 0)).toThrow(RangeError);
  });
});
