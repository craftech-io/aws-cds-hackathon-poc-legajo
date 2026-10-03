import { describe, expect, it } from "vitest";
import { CLOCK, FIRM, OPERATION } from "../services/operations-admin/testing";
import { consoleServiceWorld } from "./console-testing";
import { MARTINA, PABLO } from "./testing";

describe("activity router", () => {
  it("adds the heartbeat's observed seconds to the dossier's KPI row, without an audit row per beat", async () => {
    const world = await consoleServiceWorld();
    expect(await world.caller(MARTINA).activity.heartbeat({ operationId: OPERATION })).toEqual({ operationId: OPERATION, seconds: 30 });
    await world.caller(MARTINA).activity.heartbeat({ operationId: OPERATION, seconds: 60 });
    const kpi = await world.stores.connector.metrics.getKpi({ firmId: FIRM, source: "WORLD", clockId: CLOCK, operationId: OPERATION });
    expect(kpi).toMatchObject({ consoleSeconds: 90 });
    expect(await world.stores.connector.audit.listByOperation(OPERATION)).toEqual([]);
  });

  it("never counts more than a minute per beat, nor another firm's dossier", async () => {
    const world = await consoleServiceWorld();
    await expect(world.caller(MARTINA).activity.heartbeat({ operationId: OPERATION, seconds: 3_600 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(world.caller(PABLO).activity.heartbeat({ operationId: OPERATION })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
