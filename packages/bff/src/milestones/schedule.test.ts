import { describe, expect, it } from "vitest";
import { MilestoneName } from "@legajo/shared";
import { CLOCK, ETA, OPERATION, timeWorld } from "./testing";
import { milestoneDueTimes, scheduleMilestones } from "./schedule";

const instant = (iso: string) => new Date(iso).getTime();

describe("schedule_milestones [FL-005]", () => {
  it("[FL-005] the five instants from the ETA in Argentina's zone", () => {
    const due = milestoneDueTimes(ETA);
    expect(instant(due.DOCS_REQUEST)).toBe(instant("2026-10-15T10:00:00-03:00"));
    expect(instant(due.FOLLOWUP)).toBe(instant("2026-10-17T10:00:00-03:00"));
    expect(instant(due.FOLLOWUP_FINAL)).toBe(instant("2026-10-19T10:00:00-03:00"));
    expect(instant(due.ESCALATION)).toBe(instant("2026-10-20T08:00:00-03:00"));
    expect(instant(due.ARRIVAL)).toBe(instant(ETA));
  });

  it("[FL-005] a paused world: five SCHEDULED milestones in GSI3 and no real schedule", async () => {
    const world = await timeWorld();
    const operation = await world.connector.operations.getOperation(OPERATION);
    const result = await scheduleMilestones({ operation }, { ...world.timerDeps() });
    expect(result.scheduled).toEqual([...MilestoneName.options]);
    const timers = await world.connector.timers.listScheduledTimers(CLOCK);
    expect(timers.filter((timer) => timer.kind === "MILESTONE")).toHaveLength(5);
    expect(timers.every((timer) => timer.scheduleName === undefined)).toBe(true);
    expect(world.scheduler.puts).toHaveLength(0);
    const audit = await world.connector.audit.listByOperation(OPERATION);
    expect(audit.some((row) => row.action === "MILESTONES_SCHEDULED")).toBe(true);
  });

  it("[FL-005] a running world: a schedule only for the milestone inside the horizon", async () => {
    const world = await timeWorld();
    await world.run("2026-10-15T09:45:00-03:00");
    const operation = await world.connector.operations.getOperation(OPERATION);
    await scheduleMilestones({ operation }, world.timerDeps());
    expect(world.scheduler.puts.map((put) => put.input.timerKey)).toEqual(["TIMER#MILESTONE#DOCS_REQUEST"]);
  });

  it("[FL-005] a milestone already in the past is never left SCHEDULED: it is dispatched once, in order", async () => {
    const world = await timeWorld();
    const clock = await world.connector.world.getClock(CLOCK);
    await world.connector.world.updateClock(CLOCK, { pausedSimNow: "2026-10-18T12:00:00-03:00" }, clock.version);
    const operation = await world.connector.operations.getOperation(OPERATION);
    const result = await scheduleMilestones({ operation }, world.timerDeps());
    expect(result.dispatched).toEqual(["DOCS_REQUEST", "FOLLOWUP"]);
    expect(world.enqueued.map((event) => (event as { timerKey?: string }).timerKey)).toEqual(["TIMER#MILESTONE#DOCS_REQUEST", "TIMER#MILESTONE#FOLLOWUP"]);
    expect(world.enqueued.every((event) => (event as { firedBy?: string }).firedBy === "CLOCK")).toBe(true);
  });

  it("[FL-005] idempotent: a second call leaves the five as they are", async () => {
    const world = await timeWorld();
    const operation = await world.connector.operations.getOperation(OPERATION);
    await scheduleMilestones({ operation }, world.timerDeps());
    const again = await scheduleMilestones({ operation }, world.timerDeps());
    expect(again.existing).toEqual([...MilestoneName.options]);
    expect((await world.connector.timers.listScheduledTimers(CLOCK)).every((timer) => timer.version === 1)).toBe(true);
  });
});
