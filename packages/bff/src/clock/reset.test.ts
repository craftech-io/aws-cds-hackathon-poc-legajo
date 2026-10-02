import { describe, expect, it } from "vitest";
import { ToolError } from "@legajo/shared";
import { hashOf, operationFixture } from "../connector/testing";
import { CLOCK, FIRM, OPERATION, REAL_NOW, type TimeWorld, timeWorld } from "../milestones/testing";
import { CONSOLE_RESET_INTERVAL_MS, ResetTooSoonError, type ResetDeps, type WorldRebuild, resetWorld } from "./reset";

interface RebuildCalls {
  readonly reloads: Parameters<WorldRebuild["reload"]>[0][];
  readonly purges: Parameters<WorldRebuild["purgeMemory"]>[0][];
}

function resetDeps(world: TimeWorld): ResetDeps & { readonly calls: RebuildCalls } {
  const calls: RebuildCalls = { reloads: [], purges: [] };
  return {
    ...world.timerDeps(),
    client: world.stores.client,
    addressHash: hashOf,
    calls,
    rebuild: {
      async reload(input) {
        calls.reloads.push(input);
        return { startAtSim: "2026-10-14T10:30:00-03:00" };
      },
      async purgeMemory(input) {
        calls.purges.push(input);
      },
    },
  };
}

describe("reset_demo_world [FL-087]", () => {
  it("[FL-087] the epoch goes up by ADD, the old one is tombstoned, the world's items and schedules go, the clock pauses at the start", async () => {
    const world = await timeWorld();
    await world.connector.operations.createOperation(operationFixture({ operationNumber: "5501", firmId: "firm-norte", clockId: "GLOBAL#firm-norte", threadTag: "z9y8x7" }));
    await world.timer("MILESTONE", "DOCS_REQUEST", "2026-10-15T10:00:00-03:00", { scheduleName: "tm-d-0123456789abcdef0123456789abcdef" });
    await world.run("2026-10-16T09:00:00-03:00");
    const deps = resetDeps(world);
    const reset = await resetWorld({ clockId: CLOCK, caller: "CONSOLE", actor: "BROKER:brk-delta-diego" }, deps);

    expect(reset).toMatchObject({ previousEpoch: 1, worldEpoch: 2 });
    expect(await world.connector.world.isTombstoned(CLOCK, 1)).toBe(true);
    expect(await world.connector.world.currentEpoch(CLOCK)).toBe(2);
    expect(world.scheduler.deletes).toEqual(["tm-d-0123456789abcdef0123456789abcdef"]);
    expect(await world.connector.operations.findOperation(OPERATION)).toBeUndefined();
    expect(await world.connector.timers.listScheduledTimers(CLOCK)).toHaveLength(0);
    expect(await world.connector.parties.findImporter("imp-norpampa")).toBeUndefined();
    // Another world stays as it was.
    expect(await world.connector.operations.findOperation("op-5501")).toBeDefined();

    const clock = await world.connector.world.getClock(CLOCK);
    expect(clock).toMatchObject({ mode: "PAUSED", worldEpoch: 2, offsetMs: 0 });
    expect(new Date(clock.pausedSimNow).getTime()).toBe(new Date("2026-10-14T10:30:00-03:00").getTime());
    expect(clock.runningUntilReal).toBeUndefined();
    expect(deps.calls.reloads).toEqual([{ clockId: CLOCK, firmId: FIRM, worldEpoch: 2, previousEpoch: 1 }]);
    expect(deps.calls.purges).toEqual([{ clockId: CLOCK, firmId: FIRM, previousEpoch: 1, importerIds: ["imp-norpampa"] }]);
    const audit = await world.connector.audit.listByMonth(FIRM, "2026-10");
    expect(audit.find((row) => row.action === "WORLD_RESET")?.detail).toMatchObject({ previousEpoch: 1, worldEpoch: 2, caller: "CONSOLE" });
  });

  it("[FL-087] never back to 1: a second reset is epoch 3", async () => {
    const world = await timeWorld();
    const deps = resetDeps(world);
    await resetWorld({ clockId: CLOCK, caller: "QA", actor: "QA" }, deps);
    const second = await resetWorld({ clockId: CLOCK, caller: "QA", actor: "QA" }, deps);
    expect(second).toMatchObject({ previousEpoch: 2, worldEpoch: 3 });
    expect(await world.connector.world.isTombstoned(CLOCK, 2)).toBe(true);
  });

  it("[FL-087] the console resets a world once every 10 minutes; QA and the janitor are exempt", async () => {
    const world = await timeWorld();
    const deps = resetDeps(world);
    await resetWorld({ clockId: CLOCK, caller: "CONSOLE", actor: "BROKER:brk-delta-diego" }, deps);
    world.realNow = new Date(new Date(REAL_NOW).getTime() + 5 * 60_000);
    let refused: unknown;
    try {
      await resetWorld({ clockId: CLOCK, caller: "CONSOLE", actor: "BROKER:brk-delta-diego" }, deps);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ResetTooSoonError);
    expect((refused as ToolError).reason).toBe("RESET_TOO_SOON");
    expect((refused as ResetTooSoonError).nextAllowedAtReal).toBe(new Date(new Date(REAL_NOW).getTime() + CONSOLE_RESET_INTERVAL_MS).toISOString());
    expect((await resetWorld({ clockId: CLOCK, caller: "QA", actor: "QA" }, deps)).worldEpoch).toBe(3);
    expect((await resetWorld({ clockId: CLOCK, caller: "JANITOR", actor: "SYSTEM" }, deps)).worldEpoch).toBe(4);
  });
});
