import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, FIRM, START_SIM } from "../connector/testing";
import { type ConsoleWorld, DIEGO, MARTINA, PABLO, SUBS, consoleWorld, principalOf } from "./testing";

describe("escalations router", () => {
  let world: ConsoleWorld;
  let escalationId: string;

  beforeEach(async () => {
    world = await consoleWorld();
    const opened = await world.stores.connector.operations.openEscalation({ operationId: "op-4471", firmId: FIRM, clockId: CLOCK, reason: "UNRECOGNIZED_DOCUMENT", summary: "Documento no reconocido", openedAtSim: START_SIM, openedBy: "AGENT" });
    escalationId = opened.escalation.escalationId;
  });

  it("lists the open escalations of the world", async () => {
    const list = await world.caller(MARTINA).escalations.list({});
    expect(list.escalations).toMatchObject([{ escalationId, operationNumber: "4471", reason: "UNRECOGNIZED_DOCUMENT", status: "OPEN" }]);
    expect((await world.caller(PABLO).escalations.list({})).escalations).toEqual([]);
  });

  it("resolves one in simulated time, signed by the broker and audited", async () => {
    const { escalation } = await world.caller(DIEGO).escalations.resolve({ operationId: "op-4471", escalationId, resolution: "Clasificado a mano" });
    expect(escalation).toMatchObject({ status: "RESOLVED", resolvedAtSim: "2026-10-14T13:30:00.000Z", resolvedBy: "BROKER:brk-delta-diego", resolution: "Clasificado a mano" });
    const [decision] = await world.stores.connector.audit.listByDecision(FIRM, "ACTION");
    expect(decision).toMatchObject({ action: "ESCALATION_RESOLVED", actor: "BROKER:brk-delta-diego", refs: { escalationId, brokerId: "brk-delta-diego" } });
    expect((await world.caller(MARTINA).escalations.list({})).escalations).toEqual([]);
  });

  it("refuses another firm and an account without a broker row", async () => {
    await expect(world.caller(PABLO).escalations.resolve({ operationId: "op-4471", escalationId, resolution: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const unbound = principalOf(FIRM, "BROKER", SUBS.judge, "brk-delta-diego", { brokerId: undefined });
    await expect(world.caller(unbound).escalations.resolve({ operationId: "op-4471", escalationId, resolution: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
