import { describe, expect, it } from "vitest";
import { CLOCK, FIRM, REAL_NOW } from "../connector/testing";
import { DIEGO, consoleWorld } from "./testing";

describe("metrics router", () => {
  it("[FL-085] summarizes this world and the batch tabs without mixing their rows", async () => {
    const world = await consoleWorld();
    const { metrics, audit } = world.stores.connector;
    await metrics.incrementKpi({ firmId: FIRM, source: "WORLD", clockId: CLOCK, operationId: "op-4471" }, { interventions: 2, humanMinutes: 12, emailSent: 1 }, { agentMode: "REAL" });
    await metrics.incrementKpi({ firmId: "firm-sim", source: "BATCH", clockId: "sim-b1", operationId: "op-7001" }, { interventions: 5, violations: 1 }, { agentMode: "SCRIPTED", runId: "b1" });
    await audit.record({ firmId: FIRM, clockId: CLOCK, decision: "DENY", action: "SEND_WHATSAPP", ruleIds: ["CP-OPTIN"], actor: "AGENT", atSim: "2026-10-15T10:00:00-03:00", atReal: REAL_NOW });

    const here = await world.caller(DIEGO).metrics.summary({});
    expect(here).toMatchObject({ clockId: CLOCK, tab: "WORLD", label: "MEASURED", n: 1 });
    expect(here.kpis.find((kpi) => kpi.key === "interventionsPerDossier")).toMatchObject({ value: 2, n: 1 });
    expect(here.kpis.find((kpi) => kpi.key === "policyViolations")).toMatchObject({ value: 0, detail: { decisionsByRule: { "CP-OPTIN": { deny: 1, defer: 0 } } } });
    expect(here.kpis.find((kpi) => kpi.key === "costPerDossierUsd")).toMatchObject({ gap: "UNVERIFIED_RATES", detail: { whatsappPricedAsLive: false } });

    const scripted = await world.caller(DIEGO).metrics.summary({ tab: "BATCH_SCRIPTED" });
    expect(scripted).toMatchObject({ clockId: null, label: "SCRIPTED_AGENT", n: 1 });
    expect(scripted.kpis.find((kpi) => kpi.key === "interventionsPerDossier")).toMatchObject({ value: 5 });
    expect((await world.caller(DIEGO).metrics.summary({ tab: "BATCH_REAL" })).n).toBe(0);
  });

  it("[FL-085] exports the rows of a tab as CSV", async () => {
    const world = await consoleWorld();
    await world.stores.connector.metrics.incrementKpi({ firmId: FIRM, source: "WORLD", clockId: CLOCK, operationId: "op-4471" }, { turns: 3 }, { agentMode: "REAL" });
    const exported = await world.caller(DIEGO).metrics.export({});
    expect(exported.filename).toBe("legajo-metrics-world.csv");
    expect(exported.csv.split("\n")[1]).toMatch(/^op-4471,GLOBAL#firm-delta,WORLD,REAL,,3,/);
  });
});
