// The two modes of a world's clock (ADR-0007, docs/architecture.md §8):
//
//   setRunning(true)   "Reloj en vivo": RUNNING for 30 real minutes from the instant the world had;
//                      the schedules of the horizon are created in the same call
//   setRunning(false)  back to PAUSED at the instant reached; every schedule is deleted
//   unfreeze(leadSec)  the `QaDriver`'s test of the real Scheduler, atomic: with the world still
//                      paused, its time goes to `next timer − leadSec` (120 by default, at least 90 to stay
//                      clear of the 60-second direct dispatch), then RUNNING, then the schedules, so the
//                      next timer's schedule sits `leadSec` real seconds away
//   freeze()           PAUSED again and no schedule left
import { ToolError } from "@legajo/shared";
import { timerKeyOf } from "../domain/timers";
import { RUNNING_WINDOW_MS, pauseAt, startRunning } from "../lib/clock";
import type { ClockCaller, ClockDeps, ClockMoved } from "./advance";
import { currentClock, resyncWorld, viewOf, writeClock } from "./state";

export const UNFREEZE_DEFAULT_LEAD_SEC = 120;
export const UNFREEZE_MIN_LEAD_SEC = 90;

/** Every timer of the world, whatever its due instant. */
const ALL = new Date(0);

/** "Reloj en vivo" on or off. */
export async function setRunning(input: { readonly clockId: string; readonly running: boolean; readonly caller: Pick<ClockCaller, "actor" | "correlationId"> }, deps: ClockDeps): Promise<ClockMoved> {
  const stored = await currentClock(input.clockId, deps);
  const realNow = deps.realClock();
  const wasRunning = viewOf(stored, realNow).running;
  const clock = input.running || wasRunning ? await writeClock(stored, input.running ? startRunning(stored, realNow.getTime()) : pauseAt(stored, realNow.getTime()), deps) : stored;
  await resyncWorld(clock, ALL, deps);
  const view = viewOf(clock, realNow);
  await deps.data.audit.record({
    firmId: clock.firmId,
    decision: "ACTION",
    action: input.running ? "CLOCK_RUNNING" : "CLOCK_PAUSED",
    actor: input.caller.actor,
    clockId: clock.clockId,
    atSim: view.simNow.toISOString(),
    atReal: realNow.toISOString(),
    detail: { runningUntilReal: clock.runningUntilReal ?? null, wasRunning },
    ...(input.caller.correlationId === undefined ? {} : { correlationId: input.caller.correlationId }),
  });
  return { clockId: clock.clockId, mode: view.running ? "RUNNING" : "PAUSED", simNow: view.simNow.toISOString(), worldEpoch: clock.worldEpoch, fired: [], forced: false };
}

export interface Unfrozen {
  readonly timerKey: string;
  readonly operationId: string;
  readonly dueAtSim: string;
  readonly dueAtReal: string;
}

/** `clock.unfreeze({leadSec})` of the `QaDriver`. */
export async function unfreeze(input: { readonly clockId: string; readonly leadSec?: number }, deps: ClockDeps): Promise<Unfrozen> {
  const leadSec = input.leadSec ?? UNFREEZE_DEFAULT_LEAD_SEC;
  if (!Number.isInteger(leadSec) || leadSec < UNFREEZE_MIN_LEAD_SEC) throw new ToolError("INVALID", `leadSec is at least ${UNFREEZE_MIN_LEAD_SEC}`, "CLOCK_INVALID_MOVE");
  const stored = await currentClock(input.clockId, deps);
  const realNow = deps.realClock();
  const view = viewOf(stored, realNow);
  if (view.running) throw new ToolError("CONFLICT", "the world is already running", "CLOCK_RUNNING");
  const next = await deps.data.timers.nextScheduledTimer(input.clockId);
  if (next === undefined) throw new ToolError("INVALID", "nothing is pending in this world", "CLOCK_NOTHING_PENDING");
  const atSim = Date.parse(next.dueAtSim) - leadSec * 1000;
  if (atSim < view.simNow.getTime()) throw new ToolError("INVALID", `the next timer is less than ${leadSec} s away: the clock never goes back`, "CLOCK_BACKWARDS");
  const now = realNow.getTime();
  const clock = await writeClock(stored, { mode: "RUNNING", pausedSimNow: new Date(atSim).toISOString(), offsetMs: atSim - now, runningUntilReal: new Date(now + RUNNING_WINDOW_MS).toISOString() }, deps);
  await resyncWorld(clock, ALL, deps);
  return { timerKey: timerKeyOf(next.kind, next.timerId), operationId: next.operationId, dueAtSim: next.dueAtSim, dueAtReal: new Date(Date.parse(next.dueAtSim) - clock.offsetMs).toISOString() };
}

/** `clock.freeze` of the `QaDriver`: paused at the instant reached, every schedule deleted. */
export async function freeze(input: { readonly clockId: string }, deps: ClockDeps): Promise<{ readonly simNow: string }> {
  const stored = await currentClock(input.clockId, deps);
  const realNow = deps.realClock();
  const clock = viewOf(stored, realNow).running ? await writeClock(stored, pauseAt(stored, realNow.getTime()), deps) : stored;
  await resyncWorld(clock, ALL, deps);
  return { simNow: viewOf(clock, realNow).simNow.toISOString() };
}
