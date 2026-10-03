// The `tour` router (docs/tool-catalog.md; docs/design-brief.md §15): `steps` finds operation 4471 of the
// caller's world with every pending timer of it, and `run` turns each move of the panel into the
// console's own procedure, with the same gates (recent sign-in for approving, the guest quota of clock
// moves, the firm fence).
import { describe, expect, it } from "vitest";
import { CLOCK } from "../connector/testing";
import { FIRM, OPERATION, readyForReview } from "../services/operations-admin/testing";
import { GUEST, GUEST_CLOCK, consoleServiceWorld } from "./console-testing";
import { DIEGO, MARTINA, SUBS, principalOf } from "./testing";
import { shiftDays } from "./tour";

describe("tour router", () => {
  it("answers operation 4471 of the world and all of its pending timers, in order", async () => {
    const world = await consoleServiceWorld();
    const { timers } = world.stores.connector;
    for (let day = 15; day <= 21; day += 1) {
      await timers.createTimer({ operationId: OPERATION, clockId: CLOCK, kind: "DEFERRED_SEND", timerId: `ds-${day}`, dueAtSim: `2026-10-${day}T22:00:00-03:00`, status: "SCHEDULED" });
    }
    const steps = await world.caller(DIEGO).tour.steps({});
    expect(steps).toMatchObject({ clockId: CLOCK, worldEpoch: 1, startAtSim: expect.any(String), operation: { operationId: OPERATION, operationNumber: "4471", eta: "2026-10-22T08:00:00-03:00" } });
    // Seven timers of 4471: more than the five next events clock.get lists for the whole world.
    expect(steps.nextEvents.map((event) => Date.parse(event.dueAtSim))).toEqual([15, 16, 17, 18, 19, 20, 21].map((day) => Date.parse(`2026-10-${day}T22:00:00-03:00`)));
    expect(steps.nextEvents.every((event) => event.operationNumber === "4471" && event.kind === "DEFERRED_SEND")).toBe(true);
  });

  it("answers no operation in a world without 4471, and refuses a move that needs it", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    expect((await world.caller(GUEST).tour.steps({})).operation).toBeNull();
    await expect(world.caller(GUEST).tour.run({ action: { kind: "moveEta", shiftDays: -2 } })).rejects.toMatchObject({ code: "NOT_FOUND", cause: { reason: "TOUR_OPERATION_MISSING" } });
    expect(world.feeds).toEqual([]);
  });

  it("goes to 15/10 10:00 and to the next event through the clock's own moves", async () => {
    const world = await consoleServiceWorld();
    await world.caller(DIEGO).tour.run({ action: { kind: "advanceTo", toSim: "2026-10-15T10:00:00-03:00" } });
    expect((await world.caller(DIEGO).clock.get({})).simNow).toBe("2026-10-15T13:00:00.000Z");
    await world.stores.connector.timers.createTimer({ operationId: OPERATION, clockId: CLOCK, kind: "DEFERRED_SEND", timerId: "ds-1", dueAtSim: "2026-10-15T22:00:00-03:00", status: "SCHEDULED" });
    expect(await world.caller(DIEGO).tour.run({ action: { kind: "advanceToNext" } })).toEqual({ kind: "advanceToNext", done: true });
    expect((await world.caller(DIEGO).clock.get({})).simNow).toBe("2026-10-16T01:00:00.000Z");
  });

  it("moves the ETA of 4471 two days earlier from the ETA it has now, through the platform's feed", async () => {
    const world = await consoleServiceWorld();
    await world.caller(DIEGO).tour.run({ action: { kind: "moveEta", shiftDays: -2 } });
    expect(world.feeds).toMatchObject([{ kind: "ETA", input: { firmId: FIRM, operationNumber: "4471", newEta: "2026-10-20T08:00:00-03:00" } }]);
  });

  it("approves 4471 only as dossier.approve does: a recent sign-in of a broker", async () => {
    const world = await consoleServiceWorld();
    await readyForReview(world);
    await expect(world.caller(MARTINA).tour.run({ action: { kind: "approve" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const stale = principalOf(FIRM, "BROKER", SUBS.diego, "brk-delta-diego", { authTime: Date.parse("2026-09-26T14:00:00.000Z") / 1000 });
    await expect(world.caller(stale).tour.run({ action: { kind: "approve" } })).rejects.toMatchObject({ code: "FORBIDDEN", cause: { reason: "LOGIN_NOT_RECENT" } });
    await world.caller(DIEGO).tour.run({ action: { kind: "approve" } });
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dossierStatus).toBe("APPROVED");
  });

  it("[FL-111] spends a clock move of a guest world like the clock does, and refuses past its quota", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    await world.exhaust(GUEST_CLOCK, "CLOCK_MOVES");
    await expect(world.caller(GUEST).tour.run({ action: { kind: "advanceToNext" } })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("refuses a channel without CANAL_ASIGNADO and a move of zero days", async () => {
    const world = await consoleServiceWorld();
    await expect(world.caller(DIEGO).tour.run({ action: { kind: "emitDispatchStatus", status: "OFICIALIZADO", channel: "VERDE" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(world.caller(DIEGO).tour.run({ action: { kind: "moveEta", shiftDays: 0 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("shifts an ETA by whole days in the offset it already has", () => {
    expect(shiftDays("2026-10-22T08:00:00-03:00", -2)).toBe("2026-10-20T08:00:00-03:00");
    expect(shiftDays("2026-10-22T08:00:00+08:00", 4)).toBe("2026-10-26T08:00:00+08:00");
    expect(shiftDays("2026-10-22T11:00:00.000Z", 1)).toBe("2026-10-23T11:00:00.000Z");
  });
});
