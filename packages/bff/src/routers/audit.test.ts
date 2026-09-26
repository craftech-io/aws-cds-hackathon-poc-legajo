import { beforeEach, describe, expect, it } from "vitest";
import type { AuditDecision, RuleId } from "@legajo/shared";
import { CLOCK, FIRM, REAL_NOW } from "../connector/testing";
import { type ConsoleWorld, DIEGO, MARTINA, PABLO, consoleWorld } from "./testing";

describe("audit router", () => {
  let world: ConsoleWorld;

  async function decide(decision: AuditDecision, atSim: string, ruleIds: RuleId[] = [], clockId = CLOCK, firmId = FIRM): Promise<void> {
    await world.stores.connector.audit.record({
      firmId,
      clockId,
      decision,
      action: decision === "ACTION" ? "TIMER_FIRED" : "SEND_WHATSAPP",
      ruleIds,
      evaluated: ruleIds.map((ruleId) => ({ ruleId, result: decision === "DEFER" ? ("DEFER" as const) : decision === "DENY" ? ("DENY" as const) : ("PASS" as const) })),
      actor: "AGENT",
      refs: { operationId: "op-4471" },
      atSim,
      atReal: REAL_NOW,
    });
  }

  beforeEach(async () => {
    world = await consoleWorld();
    await decide("ALLOW", "2026-10-15T10:00:00-03:00", ["CP-OPTIN"]);
    await decide("DEFER", "2026-10-15T19:00:00-03:00", ["CP-HOURS-AR"]);
    await decide("DENY", "2026-10-15T20:00:00-03:00", ["CP-OPTIN"]);
    await decide("ACTION", "2026-10-16T09:00:00-03:00");
    await decide("VIOLATION", "2026-10-16T10:00:00-03:00", ["CP-OPTOUT"]);
    // Same firm, another world: never mixed into this one.
    await decide("DENY", "2026-10-15T20:00:00-03:00", ["CP-OPTIN"], "qa-812-sc01");
  });

  it("[FL-086] lists the decisions of the world, newest first, by kind or by operation", async () => {
    const all = await world.caller(MARTINA).audit.list({});
    expect(all.decisions.map((decision) => decision.decision)).toEqual(["VIOLATION", "ACTION", "DENY", "DEFER", "ALLOW"]);
    expect((await world.caller(MARTINA).audit.list({ decision: "DENY" })).decisions).toHaveLength(1);
    expect((await world.caller(MARTINA).audit.list({ limit: 2 })).decisions).toHaveLength(2);
    const trail = await world.caller(MARTINA).audit.list({ operationId: "op-4471", decision: "ALLOW" });
    expect(trail.decisions).toMatchObject([{ decision: "ALLOW", ruleIds: ["CP-OPTIN"], evaluated: [{ ruleId: "CP-OPTIN", result: "PASS" }] }]);
  });

  it("[FL-086] shows the violations and the decisions per rule", async () => {
    expect(await world.caller(DIEGO).audit.violations({})).toMatchObject({ count: 1, violations: [{ ruleIds: ["CP-OPTOUT"] }] });
    expect((await world.caller(DIEGO).audit.decisionsByRule({})).byRule).toEqual({ "CP-OPTIN": { deny: 1, defer: 0 }, "CP-HOURS-AR": { deny: 0, defer: 1 } });
  });

  it("[FL-086] keeps each firm to its own log", async () => {
    expect((await world.caller(PABLO).audit.list({})).decisions).toEqual([]);
    await expect(world.caller(PABLO).audit.list({ operationId: "op-4471" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
