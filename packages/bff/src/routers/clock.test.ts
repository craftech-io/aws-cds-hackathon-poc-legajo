import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, REAL_NOW } from "../connector/testing";
import { type ConsoleWorld, DIEGO, PABLO, SUBS, consoleWorld, principalOf } from "./testing";

describe("clock router", () => {
  let world: ConsoleWorld;

  beforeEach(async () => {
    world = await consoleWorld();
  });

  it("reads the world's mode, simulated now, epoch and next events", async () => {
    const { timers } = world.stores.connector;
    await timers.createTimer({ operationId: "op-4471", clockId: CLOCK, kind: "MILESTONE", timerId: "FOLLOWUP", dueAtSim: "2026-10-17T10:00:00-03:00", status: "SCHEDULED" });
    await timers.createTimer({ operationId: "op-4471", clockId: CLOCK, kind: "MILESTONE", timerId: "DOCS_REQUEST", dueAtSim: "2026-10-15T10:00:00-03:00", status: "SCHEDULED" });
    const clock = await world.caller(DIEGO).clock.get({});
    expect(clock).toMatchObject({ clockId: CLOCK, mode: "PAUSED", simNow: "2026-10-14T13:30:00.000Z", runningUntilReal: null, worldEpoch: 1, busy: false, pending: [], stale: [], reset: { allowed: true } });
    // The shell asks with no input at all.
    expect((await world.caller(DIEGO).clock.get()).clockId).toBe(CLOCK);
    expect(clock.nextEvents.map((event) => [event.operationNumber, event.timerId])).toEqual([
      ["4471", "DOCS_REQUEST"],
      ["4471", "FOLLOWUP"],
    ]);
  });

  it("is busy while an event is in flight or a mail is in transit, and not for a stale one", async () => {
    const { world: state } = world.stores.connector;
    await state.markInFlight({ operationId: "op-4471", clockId: CLOCK, eventId: "evt-1" });
    await state.putMailPending({ clockId: CLOCK, mailId: "mail-00000001", operationId: "op-4471", from: "op-4471-k7p2q9@legajo.demo.craftech.io", to: "supplier-qingdao@sim.legajo.demo.craftech.io", profile: "SYSTEM", awaiting: "SIMMAIL", sentAtReal: REAL_NOW, staleAtReal: "2026-09-26T14:00:00.000Z", expiresAt: 1 });
    const clock = await world.caller(DIEGO).clock.get({});
    expect(clock.busy).toBe(true);
    expect(clock.pending).toEqual([{ kind: "EVENT", operationNumber: "4471", detail: "evt-1", sinceReal: REAL_NOW, stale: false }]);
    expect(clock.stale).toEqual([{ kind: "MAIL", operationNumber: "4471", detail: "SIMMAIL", sinceReal: REAL_NOW, stale: true }]);
    await state.settleInFlight({ operationId: "op-4471", clockId: CLOCK, eventId: "evt-1" });
    expect((await world.caller(DIEGO).clock.get({})).busy).toBe(false);
  });

  it("closes the console's reset for ten minutes after the last one", async () => {
    await world.stores.connector.world.updateClock(CLOCK, { lastResetAtReal: "2026-09-26T14:55:00.000Z" });
    expect((await world.caller(DIEGO).clock.get({})).reset).toEqual({ allowed: false, nextAllowedAtReal: "2026-09-26T15:05:00.000Z" });
  });

  it("asks a firm with several worlds to name one, and fences the one it names", async () => {
    const qa = principalOf("firm-qa", "BROKER", SUBS.diego, "brk-qa-runner");
    await expect(world.caller(qa).clock.get({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(world.caller(PABLO).clock.get({ clockId: CLOCK })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
