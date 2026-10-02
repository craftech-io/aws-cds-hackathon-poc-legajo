import { describe, expect, it } from "vitest";
import { TimerKind, ToolError } from "@legajo/shared";
import { CLOCK, OPERATION, REAL_NOW, type TimeWorld, timeWorld } from "../milestones/testing";
import { advanceClock, fireMilestoneNow } from "./advance";
import { WorldBusyError } from "./busy";
import { freeze, setRunning, unfreeze } from "./modes";

const CONSOLE = { actor: "BROKER:brk-delta-diego", gate: { force: false } } as const;
const QA = { actor: "QA" } as const;
const at = (iso: string) => new Date(iso).getTime();

async function rejection(work: Promise<unknown>): Promise<ToolError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function simNow(world: TimeWorld): Promise<number> {
  const clock = await world.connector.world.getClock(CLOCK);
  return clock.mode === "PAUSED" ? at(clock.pausedSimNow) : world.realNow.getTime() + clock.offsetMs;
}

describe("advance_clock [FL-065]", () => {
  it("[FL-065] one case per kind: every due timer leaves FIRED-bound as CLOCK at its own dueAtSim, oldest first; SIM_REPLY to SimMail", async () => {
    const world = await timeWorld();
    const kinds = TimerKind.options;
    for (const [index, kind] of kinds.entries()) {
      const timerId = kind === "MILESTONE" ? "DOCS_REQUEST" : `t${index}`;
      await world.timer(kind, timerId, new Date(at("2026-10-14T11:00:00-03:00") + (kinds.length - index) * 60_000).toISOString());
    }
    const moved = await advanceClock({ clockId: CLOCK, target: { byMinutes: 60 }, caller: CONSOLE }, world.timerDeps());
    expect(at(moved.simNow)).toBe(at("2026-10-14T11:30:00-03:00"));
    expect(moved.fired.map((fired) => fired.kind)).toEqual([...kinds].reverse());
    const queued = world.enqueued.map((event) => event as { timerKey: string; firedBy: string; eventAtSim: string; dueAtSim: string });
    expect(queued).toHaveLength(kinds.length - 1);
    expect(queued.every((event) => event.firedBy === "CLOCK" && event.eventAtSim === event.dueAtSim)).toBe(true);
    expect(queued.some((event) => event.timerKey.startsWith("TIMER#SIM_REPLY#"))).toBe(false);
    expect(world.handoffs).toEqual([expect.objectContaining({ firedBy: "CLOCK" })]);
    expect(world.scheduler.puts).toHaveLength(0);
    const audit = await world.connector.audit.listByMonth("firm-delta", "2026-10");
    expect(audit.find((row) => row.action === "CLOCK_ADVANCED")?.detail).toMatchObject({ move: "ADVANCE", fired: kinds.length });
  });

  it("[FL-065] advanceTo goes forward only and at most 14 days; advanceToNext reaches the next timer of any kind", async () => {
    const world = await timeWorld();
    expect((await rejection(advanceClock({ clockId: CLOCK, target: { to: "2026-10-14T09:00:00-03:00" }, caller: QA }, world.timerDeps()))).reason).toBe("CLOCK_BACKWARDS");
    expect((await rejection(advanceClock({ clockId: CLOCK, target: { to: "2026-10-29T10:31:00-03:00" }, caller: QA }, world.timerDeps()))).reason).toBe("CLOCK_MOVE_TOO_LONG");
    expect((await rejection(advanceClock({ clockId: CLOCK, target: { byMinutes: 0 }, caller: QA }, world.timerDeps()))).reason).toBe("CLOCK_INVALID_MOVE");
    expect((await rejection(advanceClock({ clockId: CLOCK, target: { next: true }, caller: QA }, world.timerDeps()))).reason).toBe("CLOCK_NOTHING_PENDING");
    await world.timer("DEFERRED_SEND", "msg-d1", "2026-10-15T09:00:00-03:00");
    await world.timer("FOLLOWUP_DUE", "fu-1", "2026-10-16T10:00:00-03:00");
    const moved = await advanceClock({ clockId: CLOCK, target: { next: true }, caller: QA }, world.timerDeps());
    expect(at(moved.simNow)).toBe(at("2026-10-15T09:00:00-03:00"));
    expect(moved.fired.map((fired) => fired.timerKey)).toEqual(["TIMER#DEFERRED_SEND#msg-d1"]);
    expect(moved.mode).toBe("PAUSED");
  });

  it("[FL-065] a paused world never moves on its own and has no real schedules", async () => {
    const world = await timeWorld();
    await world.timer("MILESTONE", "DOCS_REQUEST", "2026-10-15T10:00:00-03:00");
    const before = await simNow(world);
    world.realNow = new Date(world.realNow.getTime() + 10 * 60_000);
    expect(await simNow(world)).toBe(before);
    expect(world.scheduler.puts).toHaveLength(0);
  });

  it("[FL-065] in RUNNING a move resynchronizes: the pending schedule moves and the one entering the horizon is created", async () => {
    const world = await timeWorld();
    await world.timer("FOLLOWUP_DUE", "fu-a", "2026-10-15T10:20:00-03:00");
    await world.timer("FOLLOWUP_DUE", "fu-b", "2026-10-15T10:35:00-03:00");
    await world.run("2026-10-15T10:00:00-03:00");
    await setRunning({ clockId: CLOCK, running: true, caller: QA }, world.timerDeps());
    expect(world.scheduler.puts.map((put) => put.input.timerKey)).toEqual(["TIMER#FOLLOWUP_DUE#fu-a"]);
    const firstAt = world.scheduler.puts[0]?.at.getTime() ?? 0;
    await advanceClock({ clockId: CLOCK, target: { byMinutes: 10 }, caller: QA }, world.timerDeps());
    const after = world.scheduler.puts.slice(1);
    expect(after.map((put) => put.input.timerKey).sort()).toEqual(["TIMER#FOLLOWUP_DUE#fu-a", "TIMER#FOLLOWUP_DUE#fu-b"]);
    expect(after.find((put) => put.input.timerKey.endsWith("fu-a"))?.at.getTime()).toBe(firstAt - 10 * 60_000);
    await setRunning({ clockId: CLOCK, running: false, caller: QA }, world.timerDeps());
    expect(world.scheduler.schedules.size).toBe(0);
    expect((await world.connector.world.getClock(CLOCK)).mode).toBe("PAUSED");
  });

  it("[FL-065] a running world goes back to PAUSED after its 30 real minutes", async () => {
    const world = await timeWorld();
    await setRunning({ clockId: CLOCK, running: true, caller: QA }, world.timerDeps());
    world.realNow = new Date(world.realNow.getTime() + 31 * 60_000);
    const moved = await advanceClock({ clockId: CLOCK, target: { byMinutes: 1 }, caller: QA }, world.timerDeps());
    expect(moved.mode).toBe("PAUSED");
  });

  it("[FL-065] unfreeze({leadSec}) leaves the next timer's schedule leadSec real seconds away; freeze deletes it", async () => {
    const world = await timeWorld();
    await world.timer("MILESTONE", "DOCS_REQUEST", "2026-10-15T10:00:00-03:00");
    expect((await rejection(unfreeze({ clockId: CLOCK, leadSec: 60 }, world.timerDeps()))).reason).toBe("CLOCK_INVALID_MOVE");
    const unfrozen = await unfreeze({ clockId: CLOCK, leadSec: 120 }, world.timerDeps());
    expect(at(unfrozen.dueAtReal)).toBe(world.realNow.getTime() + 120_000);
    expect(world.scheduler.puts[0]?.at.getTime()).toBe(world.realNow.getTime() + 120_000);
    await freeze({ clockId: CLOCK }, world.timerDeps());
    expect(world.scheduler.schedules.size).toBe(0);
  });

  it("[FL-065] WORLD_BUSY with an event or a mail pending: nothing moves; force before five minutes is refused, after it is audited", async () => {
    const world = await timeWorld();
    await world.connector.world.markInFlight({ operationId: OPERATION, clockId: CLOCK, eventId: "evt_00000000000000000000000001" });
    await world.connector.world.putMailPending({ clockId: CLOCK, mailId: "mail-00000001", operationId: OPERATION, from: "op-4471-k7p2q9@legajo.demo.craftech.io", to: "supplier-qingdao@sim.legajo.demo.craftech.io", profile: "SYSTEM", awaiting: "SIMMAIL", sentAtReal: REAL_NOW });
    const busy = await rejection(advanceClock({ clockId: CLOCK, target: { byMinutes: 60 }, caller: CONSOLE }, world.timerDeps()));
    expect(busy).toBeInstanceOf(WorldBusyError);
    expect((busy as WorldBusyError).pending.map((item) => item.kind).sort()).toEqual(["EVENT", "MAIL"]);
    expect(await simNow(world)).toBe(at("2026-10-14T10:30:00-03:00"));
    world.realNow = new Date(at(REAL_NOW) + 4 * 60_000);
    expect(await rejection(advanceClock({ clockId: CLOCK, target: { byMinutes: 60 }, caller: { ...CONSOLE, gate: { force: true } } }, world.timerDeps()))).toBeInstanceOf(WorldBusyError);
    world.realNow = new Date(at(REAL_NOW) + 6 * 60_000);
    const forced = await advanceClock({ clockId: CLOCK, target: { byMinutes: 60 }, caller: { ...CONSOLE, gate: { force: true } } }, world.timerDeps());
    expect(forced.forced).toBe(true);
    const audit = await world.connector.audit.listByMonth("firm-delta", "2026-10");
    expect(audit.some((row) => row.action === "CLOCK_FORCED")).toBe(true);
    // The QaDriver never goes through the gate.
    expect((await advanceClock({ clockId: CLOCK, target: { byMinutes: 1 }, caller: QA }, world.timerDeps())).forced).toBe(false);
  });

  it("[FL-065] \"Disparar ahora\" fires the milestone as MANUAL at the world's now without moving the clock", async () => {
    const world = await timeWorld();
    await world.timer("MILESTONE", "FOLLOWUP", "2026-10-17T10:00:00-03:00");
    const fired = await fireMilestoneNow({ operationId: OPERATION, milestone: "FOLLOWUP", caller: CONSOLE }, world.timerDeps());
    expect(at(fired.simNow)).toBe(at("2026-10-14T10:30:00-03:00"));
    expect(world.enqueued).toEqual([expect.objectContaining({ timerKey: "TIMER#MILESTONE#FOLLOWUP", firedBy: "MANUAL", eventAtSim: fired.simNow })]);
    expect((await rejection(fireMilestoneNow({ operationId: OPERATION, milestone: "ARRIVAL", caller: CONSOLE }, world.timerDeps()))).reason).toBe("MILESTONE_NOT_PENDING");
  });
});
