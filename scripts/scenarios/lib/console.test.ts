import { describe, expect, it } from "vitest";
import { type ConsoleAction, checkedConsoleAction } from "./console";
import { defineScenario, stepContext } from "./steps";
import { fakeDriver } from "./testing";

const scenario = defineScenario({ id: "SC-16", slug: "sc16", title: "test", suites: ["full"], steps: [] });

describe("console calls of the scenarios: the shared input of each change procedure", () => {
  it("passes a change in the shape the console sends, and a router procedure as it is", () => {
    const record: ConsoleAction = {
      procedure: "registry.consent.record",
      input: { clockId: "qa-812-1-sc16", importerId: "imp-qa-812-1-sc16-d", medium: "SIGNED_FORM", grantedAt: "2026-10-15T09:58:00-03:00", textVersion: "v1" },
    };
    expect(checkedConsoleAction(record)).toEqual(record);
    const read: ConsoleAction = { procedure: "operations.get", input: { operationId: "op-7001" } };
    expect(checkedConsoleAction(read)).toBe(read);
  });

  it("refuses the drifted shapes before the driver sees them (SC-04/6, SC-16/1, SC-22/7)", async () => {
    const driver = fakeDriver();
    const ctx = stepContext({ runId: "812-1", scenario, driver, state: {} }, 1, { ids: {}, blocks: [], warnings: [] });
    const drifted = [
      { procedure: "dossier.classifyDocument", input: { docVersionId: "dv-7001-CO-1", docType: "CERTIFICATE_OF_ORIGIN" } },
      { procedure: "registry.consent.record", input: { clockId: "qa-812-1-sc16", importerId: "imp-qa-812-1-sc16-d", medium: "SIGNED_FORM", textVersion: "v1" } },
      { procedure: "dossier.waiveObservation", input: { observationId: "obs-7001-CO-MISSING_SIGNATURE", reason: "Presentado en papel." } },
    ] as unknown as ConsoleAction[];
    for (const action of drifted) await expect(ctx.qa("console", action)).rejects.toMatchObject({ name: "ScenarioBug" });
    expect(driver.calls).toHaveLength(0);
  });
});
