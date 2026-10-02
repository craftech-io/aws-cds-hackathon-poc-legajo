import { describe, expect, it } from "vitest";
import { timerKeyOf } from "../domain/timers";
import { CLOCK, OPERATION, timeWorld } from "../milestones/testing";
import { timerEventId } from "./events";
import { dispatchScheduled, runTimer } from "./fire";
import { SCHEDULE_NAME_MAX, atExpression, scheduleNameOf, worldLetter } from "./scheduler-client";
import { armTimer, claimTimer, closeOperationTimers, closeTimer, rearmTimer, schedulePlan, settleTimer } from "./timers";

const DUE = "2026-10-15T10:00:00-03:00";

describe("timers: TIMER#<kind> with GSI3 and at most one schedule", () => {
  it("[FL-005] a timer of a paused world is SCHEDULED in GSI3 with no real schedule", async () => {
    const world = await timeWorld();
    const { timer, schedule } = await armTimer({ operationId: OPERATION, clockId: CLOCK, kind: "MILESTONE", timerId: "DOCS_REQUEST", dueAtSim: DUE }, world.timerDeps());
    expect(schedule).toBe("NONE");
    expect(timer).toMatchObject({ status: "SCHEDULED", version: 1 });
    expect(timer.scheduleName).toBeUndefined();
    expect(world.scheduler.puts).toHaveLength(0);
    expect((await world.connector.timers.listScheduledTimers(CLOCK)).map((t) => t.timerId)).toContain("DOCS_REQUEST");
  });

  it("[FL-065] in a running world a timer inside the one-hour horizon gets one schedule at dueAtSim − offsetMs", async () => {
    const world = await timeWorld();
    await world.run("2026-10-15T09:30:00-03:00");
    const { timer, schedule } = await armTimer({ operationId: OPERATION, clockId: CLOCK, kind: "MILESTONE", timerId: "DOCS_REQUEST", dueAtSim: DUE }, world.timerDeps());
    expect(schedule).toBe("SCHEDULED");
    const [put] = world.scheduler.puts;
    expect(put?.name).toBe(scheduleNameOf(CLOCK, OPERATION, timerKeyOf("MILESTONE", "DOCS_REQUEST")));
    expect(put?.at.getTime()).toBe(world.realNow.getTime() + 30 * 60_000);
    expect(put?.input).toEqual({ clockId: CLOCK, operationId: OPERATION, timerKey: "TIMER#MILESTONE#DOCS_REQUEST", dueAtSim: timer.dueAtSim, version: 1 });
    expect((await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#DOCS_REQUEST")).scheduleName).toBe(put?.name);
  });

  it("[FL-065] past the horizon or the live window nothing is scheduled; 60 s or less away it is dispatched directly", async () => {
    const world = await timeWorld();
    await world.run("2026-10-15T08:00:00-03:00");
    const far = await armTimer({ operationId: OPERATION, clockId: CLOCK, kind: "FOLLOWUP_DUE", timerId: "fu-far", dueAtSim: DUE }, world.timerDeps());
    expect(far.schedule).toBe("NONE");
    const near = await armTimer({ operationId: OPERATION, clockId: CLOCK, kind: "FOLLOWUP_DUE", timerId: "fu-near", dueAtSim: "2026-10-15T08:00:45-03:00" }, world.timerDeps());
    expect(near.schedule).toBe("DISPATCHED");
    expect(world.enqueued).toEqual([expect.objectContaining({ type: "TIMER", timerKey: "TIMER#FOLLOWUP_DUE#fu-near", firedBy: "SCHEDULER", version: 1 })]);
    expect(world.scheduler.puts).toHaveLength(0);
  });

  it("[FL-064] a move bumps the version, moves the schedule and makes another event id", async () => {
    const world = await timeWorld();
    await world.run("2026-10-15T09:30:00-03:00");
    await armTimer({ operationId: OPERATION, clockId: CLOCK, kind: "MILESTONE", timerId: "DOCS_REQUEST", dueAtSim: DUE }, world.timerDeps());
    const moved = await rearmTimer({ operationId: OPERATION, timerKey: "TIMER#MILESTONE#DOCS_REQUEST", dueAtSim: "2026-10-15T09:50:00-03:00" }, world.timerDeps());
    expect(moved.timer.version).toBe(2);
    expect(world.scheduler.puts).toHaveLength(2);
    expect(world.scheduler.puts[1]?.input.version).toBe(2);
    expect(world.scheduler.schedules.size).toBe(1);
    expect(timerEventId(OPERATION, "TIMER#MILESTONE#DOCS_REQUEST", DUE, 1)).not.toBe(timerEventId(OPERATION, "TIMER#MILESTONE#DOCS_REQUEST", DUE, 2));
  });

  it("[FL-064] a firing at another version is stale: audited, no action, the timer unchanged", async () => {
    const world = await timeWorld();
    await world.timer("MILESTONE", "FOLLOWUP", DUE);
    await world.connector.timers.rescheduleTimer({ operationId: OPERATION, timerKey: "TIMER#MILESTONE#FOLLOWUP", dueAtSim: "2026-10-16T10:00:00-03:00" });
    let ran = false;
    const outcome = await runTimer(
      { operationId: OPERATION, clockId: CLOCK, firmId: "firm-delta", timerKey: "TIMER#MILESTONE#FOLLOWUP", version: 1, dueAtSim: DUE, eventAtSim: DUE, firedBy: "SCHEDULER" },
      async () => ((ran = true), { outcome: "FIRED" }),
      { data: world.connector, scheduler: world.scheduler, realClock: world.wallClock, log: world.log },
    );
    expect(outcome.outcome).toBe("STALE");
    expect(ran).toBe(false);
    expect((await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#FOLLOWUP")).status).toBe("SCHEDULED");
    const audit = await world.connector.audit.listByOperation(OPERATION);
    expect(audit.some((row) => row.action === "TIMER_STALE")).toBe(true);
  });

  it("claims once: a fired timer answers DONE, a missing one MISSING; settle is pinned to the version", async () => {
    const world = await timeWorld();
    const timer = await world.timer("READER_RETRY", "dv-4471-pl-1", DUE);
    expect((await claimTimer({ operationId: OPERATION, timerKey: "TIMER#READER_RETRY#dv-4471-pl-1", version: 1 }, world.timerDeps())).status).toBe("READY");
    await settleTimer(timer, { status: "FIRED", firedBy: "CLOCK", atSim: DUE }, world.timerDeps());
    expect((await claimTimer({ operationId: OPERATION, timerKey: "TIMER#READER_RETRY#dv-4471-pl-1", version: 1 }, world.timerDeps())).status).toBe("DONE");
    expect((await claimTimer({ operationId: OPERATION, timerKey: "TIMER#READER_RETRY#none", version: 1 }, world.timerDeps())).status).toBe("MISSING");
    // A second settle of the same version keeps the winner's state.
    expect((await settleTimer(timer, { status: "SKIPPED", firedBy: "CLOCK", atSim: DUE, reason: "late" }, world.timerDeps())).status).toBe("FIRED");
  });

  it("closing cancels and deletes the schedule; an operation's timers close together", async () => {
    const world = await timeWorld();
    await world.timer("MILESTONE", "FOLLOWUP", DUE, { scheduleName: "tm-d-abc" });
    await world.timer("MILESTONE", "ARRIVAL", "2026-10-22T08:00:00-03:00");
    const closed = await closeTimer({ operationId: OPERATION, timerKey: "TIMER#MILESTONE#FOLLOWUP", status: "CANCELLED", atSim: DUE, reason: "LIBERADO" }, world.timerDeps());
    expect(closed?.status).toBe("CANCELLED");
    expect(world.scheduler.deletes).toEqual(["tm-d-abc"]);
    expect(await closeOperationTimers({ operationId: OPERATION, atSim: DUE, reason: "LIBERADO" }, world.timerDeps())).toEqual(["TIMER#MILESTONE#ARRIVAL"]);
    expect(await world.connector.timers.listScheduledTimers(CLOCK)).toHaveLength(0);
  });

  it("a schedule that fires after the live window closed leaves the timer to the clock (NOT_DUE)", async () => {
    const world = await timeWorld();
    await world.timer("MILESTONE", "DOCS_REQUEST", DUE, { scheduleName: "tm-d-abc" });
    const outcome = await dispatchScheduled({ clockId: CLOCK, operationId: OPERATION, timerKey: "TIMER#MILESTONE#DOCS_REQUEST", dueAtSim: DUE, version: 1 }, world.timerDeps());
    expect(outcome).toBe("NOT_DUE");
    expect(world.enqueued).toHaveLength(0);
  });

  it("a due SIM_REPLY goes to SimMail, never to the queue", async () => {
    const world = await timeWorld();
    await world.run("2026-10-15T10:00:30-03:00");
    await world.timer("SIM_REPLY", "r1", DUE);
    const outcome = await dispatchScheduled({ clockId: CLOCK, operationId: OPERATION, timerKey: "TIMER#SIM_REPLY#r1", dueAtSim: DUE, version: 1 }, world.timerDeps());
    expect(outcome).toBe("DISPATCHED");
    expect(world.enqueued).toHaveLength(0);
    expect(world.handoffs).toEqual([expect.objectContaining({ timerKey: "TIMER#SIM_REPLY#r1", version: 1, firedBy: "SCHEDULER" })]);
  });

  it("schedule names: tm-<w>-<32 hex>, at most 64 characters, the world letter readable", () => {
    const name = scheduleNameOf("qa-run1-sc01", "op-4471", "TIMER#MILESTONE#DOCS_REQUEST");
    expect(name).toMatch(/^tm-q-[0-9a-f]{32}$/);
    expect(name.length).toBeLessThanOrEqual(SCHEDULE_NAME_MAX);
    expect(worldLetter("GUEST#firm-guest-41")).toBe("g");
    expect(worldLetter(CLOCK)).toBe("d");
    expect(atExpression(new Date("2026-10-15T13:00:00.200Z"))).toBe("at(2026-10-15T13:00:01)");
  });

  it("schedulePlan never schedules a paused world", async () => {
    const world = await timeWorld();
    const clock = await world.connector.world.getClock(CLOCK);
    expect(schedulePlan({ dueAtSim: DUE }, clock, world.realNow)).toEqual({ kind: "NONE" });
  });
});
