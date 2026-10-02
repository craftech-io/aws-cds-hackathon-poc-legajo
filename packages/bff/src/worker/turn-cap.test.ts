// `TURNCAP#` (docs/architecture.md §7 and §13): past its firm's cap per real hour or per real day a
// turn is audited `TURN_CAP`, counted in `TurnCapHits` and the Harness is not invoked.
import { describe, expect, it } from "vitest";
import { FIRM, OPERATION, REAL_NOW, completed, turnEvent, workerWorld } from "./testing";
import { checkTurnBudget, turnCapWindows } from "./turn-cap";

const STAMP = { createdAt: REAL_NOW, updatedAt: REAL_NOW, version: 2, synthetic: true };

async function capFirm(world: Awaited<ReturnType<typeof workerWorld>>, perHour: number, perDay: number): Promise<void> {
  const settings = await world.stores.connector.firms.getSettings(FIRM);
  await world.stores.seed.loadItems("Firms", [{ ...settings, ...STAMP, PK: `FIRM#${FIRM}`, SK: "SETTINGS", entity: "FirmSettings", turnCaps: { perHour, perDay } }]);
}

describe("turn caps of a firm", () => {
  it("names the real UTC hour and day windows", () => {
    expect(turnCapWindows(new Date("2026-09-26T15:42:10.000Z"))).toEqual({ hour: "H2026-09-26T15", day: "D2026-09-26" });
  });

  it("past the hourly cap: TURN_CAP audited once, TurnCapHits, no Harness and no outbound", async () => {
    const world = await workerWorld({ harness: [completed(), completed(), completed()] });
    await capFirm(world, 2, 10);
    for (const key of ["a", "b", "c"]) await world.deliver(turnEvent({ trigger: "FOLLOWUP_DUE", key }));
    expect(world.harness.requests).toHaveLength(2);
    const caps = (await world.stores.connector.audit.listByOperation(OPERATION)).filter((decision) => decision.action === "TURN_CAP");
    expect(caps).toHaveLength(1);
    expect(caps[0]?.detail).toMatchObject({ window: "HOUR", cap: 2, count: 3 });
    expect(world.metrics("TurnCapHits")).toEqual([expect.objectContaining({ window: "HOUR" })]);
    expect(world.sent).toEqual([]);
  });

  it("the hourly cap renews with the next real hour; the daily cap holds across hours", async () => {
    const world = await workerWorld({ harness: Array.from({ length: 5 }, () => completed()) });
    await capFirm(world, 1, 2);
    await world.deliver(turnEvent({ trigger: "FOLLOWUP_DUE", key: "h1" }));
    world.advanceReal(60 * 60_000);
    await world.deliver(turnEvent({ trigger: "FOLLOWUP_DUE", key: "h2" }));
    world.advanceReal(60 * 60_000);
    await world.deliver(turnEvent({ trigger: "FOLLOWUP_DUE", key: "h3" }));
    expect(world.harness.requests).toHaveLength(2);
    const caps = (await world.stores.connector.audit.listByOperation(OPERATION)).filter((decision) => decision.action === "TURN_CAP");
    expect(caps.map((decision) => decision.detail?.["window"])).toEqual(["DAY"]);
  });

  it("a demo world has no guest quota: the budget only counts the firm's caps", async () => {
    const world = await workerWorld();
    const operation = await world.stores.connector.operations.getOperation(OPERATION);
    const budget = await checkTurnBudget({ data: world.stores.connector, consumeTurnQuota: world.deps.turn.consumeTurnQuota, now: world.realNow, log: world.log }, operation);
    expect(budget).toEqual({ allowed: true });
    expect(world.metrics("QuotaHits")).toEqual([]);
  });
});
