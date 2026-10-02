// What every move of a world's demo clock shares (ADR-0007, docs/architecture.md §8): reading the
// stored `Runtime/CLOCK#<clockId>` (a RUNNING world past its live window reads as PAUSED at the instant
// it reached), writing a mode or time change pinned to the version it read, dispatching the timers
// that fell due in `dueAtSim` order, and resynchronizing the real schedules of a RUNNING world so no
// schedule keeps a `dueAtReal` computed with an old `offsetMs`.
import { timerKeyOf } from "../domain/timers";
import type { Clock } from "../domain/world-state";
import { type ClockPatch, isRunning, pauseAt, simNowOf } from "../lib/clock";
import { type TimerDeps, syncSchedule } from "../timers/timers";

/** A timer the clock dispatched. */
export interface FiredRef {
  readonly operationId: string;
  readonly timerKey: string;
  readonly kind: string;
  readonly dueAtSim: string;
}

export interface ClockView {
  readonly clock: Clock;
  /** Simulated now at `realNow`. */
  readonly simNow: Date;
  readonly running: boolean;
}

export function viewOf(clock: Clock, realNow: Date): ClockView {
  const now = realNow.getTime();
  return { clock, simNow: simNowOf(clock, now), running: isRunning(clock, now) };
}

/** The stored patch of a transition: `undefined` clears `runningUntilReal`. */
function storedPatch(patch: ClockPatch) {
  return { mode: patch.mode, pausedSimNow: patch.pausedSimNow, offsetMs: patch.offsetMs, runningUntilReal: patch.runningUntilReal ?? null };
}

/** Writes a transition pinned to the version of `clock`; CONFLICT when someone moved it in between. */
export async function writeClock(clock: Clock, patch: ClockPatch, deps: Pick<TimerDeps, "data">): Promise<Clock> {
  return deps.data.world.updateClock(clock.clockId, storedPatch(patch), clock.version);
}

/** The clock as it is now: a RUNNING world past `runningUntilReal` is written back as PAUSED first. */
export async function currentClock(clockId: string, deps: Pick<TimerDeps, "data" | "realClock">): Promise<Clock> {
  const clock = await deps.data.world.getClock(clockId);
  const now = deps.realClock().getTime();
  if (clock.mode !== "RUNNING" || isRunning(clock, now)) return clock;
  return writeClock(clock, pauseAt(clock, now), deps);
}

/**
 * Dispatches every SCHEDULED timer of the world due at or before `untilSim`, oldest first: its schedule
 * (if any) is deleted first, then it leaves as `firedBy CLOCK` at its own `dueAtSim`.
 */
export async function dispatchDue(clock: Clock, untilSim: Date, deps: TimerDeps): Promise<FiredRef[]> {
  const due = await deps.data.timers.listDueTimers(clock.clockId, untilSim.toISOString());
  const ordered = [...due].sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim) || (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
  const fired: FiredRef[] = [];
  for (const timer of ordered) {
    if (timer.scheduleName !== undefined) await deps.scheduler.delete(timer.scheduleName);
    await deps.dispatcher.dispatch({ timer, firmId: clock.firmId, firedBy: "CLOCK", eventAtSim: timer.dueAtSim });
    fired.push({ operationId: timer.operationId, timerKey: timerKeyOf(timer.kind, timer.timerId), kind: timer.kind, dueAtSim: timer.dueAtSim });
  }
  return fired;
}

/**
 * Every SCHEDULED timer after `afterSim` gets the schedule its world needs now: moved, created, deleted
 * or dispatched directly (RUNNING), or none at all (PAUSED). Timers at or before `afterSim` were just
 * dispatched by the clock and are left alone.
 */
export async function resyncWorld(clock: Clock, afterSim: Date, deps: TimerDeps): Promise<number> {
  const scheduled = await deps.data.timers.listScheduledTimers(clock.clockId);
  let changed = 0;
  for (const timer of scheduled) {
    if (Date.parse(timer.dueAtSim) <= afterSim.getTime()) continue;
    const outcome = await syncSchedule(timer, clock, deps);
    if (outcome !== "NONE") changed += 1;
  }
  return changed;
}
