// FL-098 and quiescence (docs/architecture.md §7): an operation with a dead-lettered event is quiet
// for `op.settle` and its world for the `WORLD_BUSY` gate, while an event that may still be retried
// keeps both busy.
import { describe, expect, it } from "vitest";
import { worldPending } from "../clock/busy";
import { quietCheck } from "../qa-driver/settle";
import { CLOCK, OPERATION, turnEvent, workerWorld } from "./testing";

async function quiet(world: Awaited<ReturnType<typeof workerWorld>>) {
  const settle = await quietCheck({ data: world.stores.connector, now: world.realNow, sleep: async () => undefined }, OPERATION);
  const busy = await worldPending(world.stores.connector, CLOCK, world.realNow());
  return { operation: settle.pending, world: busy };
}

describe("quiescence after the worker", () => {
  it("a processed event leaves the operation and its world quiet", async () => {
    const world = await workerWorld();
    const event = turnEvent();
    await world.sink.enqueue(event);
    expect((await quiet(world)).operation.map((pending) => pending.kind)).toEqual(["EVENT"]);
    expect((await quiet(world)).world).toHaveLength(1);
    await world.deliver(event);
    expect(await quiet(world)).toEqual({ operation: [], world: [] });
  });

  it("an event that failed and will be retried keeps both busy", async () => {
    const world = await workerWorld({ fail: { fireTimer: new Error("down") } });
    const event = { type: "TIMER", eventId: "evt_01JAAAAAAAAAAAAAAAAAAAAAAD", operationId: OPERATION, clockId: CLOCK, firmId: "firm-delta", eventAtSim: "2026-10-14T10:30:00-03:00", timerKey: "TIMER#FOLLOWUP#fu-1", version: 1, dueAtSim: "2026-10-14T10:30:00-03:00", firedBy: "SCHEDULER" } as const;
    await world.sink.enqueue(event);
    await expect(world.deliver(event, 1)).rejects.toThrow("down");
    const state = await quiet(world);
    expect(state.operation).toEqual([{ kind: "EVENT", detail: event.eventId }]);
    expect(state.world).toHaveLength(1);
  });

  it("a dead-lettered event leaves the operation and its world quiet, with processError to show [FL-098]", async () => {
    const world = await workerWorld({ fail: { fireTimer: new Error("down") } });
    const event = { type: "TIMER", eventId: "evt_01JAAAAAAAAAAAAAAAAAAAAAAE", operationId: OPERATION, clockId: CLOCK, firmId: "firm-delta", eventAtSim: "2026-10-14T10:30:00-03:00", timerKey: "TIMER#FOLLOWUP#fu-2", version: 1, dueAtSim: "2026-10-14T10:30:00-03:00", firedBy: "SCHEDULER" } as const;
    await world.sink.enqueue(event);
    await expect(world.deliver(event, 1)).rejects.toThrow("down");
    await expect(world.deliver(event, 2)).rejects.toThrow("down");
    expect(await quiet(world)).toEqual({ operation: [], world: [] });
    expect((await world.stores.connector.world.getOpState(OPERATION))?.processError?.eventId).toBe(event.eventId);
  });
});
