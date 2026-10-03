// Timers (ADR-0004, docs/architecture.md §8): everything that has to happen at a simulated hour is an
// `Operations/TIMER#<kind>#<timerId>` in `GSI3 CLOCK#<clockId>` while it is `SCHEDULED`, with at most
// one EventBridge Scheduler schedule. This module is the only one that creates, moves, cancels and
// claims them, for every kind and every producer (milestones, the outbound pipeline's deferred sends,
// the agent's follow-ups, the supplier simulator, the reader retry, the contact checks):
//
//   PAUSED world    no schedule: the clock dispatches what falls due when it moves (clock/advance.ts)
//   RUNNING world   a schedule at `dueAtReal = dueAtSim − offsetMs` when that is inside the horizon (one
//                   real hour, and never past `runningUntilReal`); a timer 60 s or less away is
//                   dispatched right away instead (`firedBy SCHEDULER`)
//
// Every change bumps the timer's `version`; the schedule's input carries it, so a schedule left over
// from before a move fires a stale version that the consumer ignores (FL-064). A due timer is
// *dispatched* here and *claimed* by its consumer (timers/fire.ts): the `SCHEDULED → FIRED` transition
// happens once, on the consumer's side, after its effect, so a retried event never loses it.
import { ConnectorError, type TimerFiredBy, type TimerKind } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import type { NewEntity } from "../domain/common";
import { Timer, timerKeyOf } from "../domain/timers";
import type { Clock } from "../domain/world-state";
import { RUNNING_HORIZON_SECONDS } from "../domain/world-state";
import { isRunning } from "../lib/clock";
import type { Logger } from "../lib/log";
import { type OperationEventSink, type SimReplyHandoff, type TimerEvent, timerEventId } from "./events";
import { type SchedulerPort, scheduleNameOf } from "./scheduler-client";

/** A timer 60 real seconds or less away in a RUNNING world is not scheduled: it is dispatched now. */
export const DIRECT_DISPATCH_SECONDS = 60;

/** A due timer and how it fires: what the dispatcher turns into a `TIMER` event or a `SIM_REPLY` hand-off. */
export interface DueTimer {
  readonly timer: Timer;
  readonly firmId: string;
  readonly firedBy: TimerFiredBy;
  /** `dueAtSim`, or the world's now for "Disparar ahora". */
  readonly eventAtSim: string;
  readonly correlationId?: string;
}

export interface TimerDispatcher {
  dispatch(due: DueTimer): Promise<void>;
}

export interface TimerDispatchPorts {
  /** Producer of `OperationEvents.fifo` (`inFlight` first, then `SendMessage`). */
  readonly events: OperationEventSink<TimerEvent>;
  /** `SimMail` (asynchronous invoke): a `SIM_REPLY` never goes through the queue. */
  readonly simReply: (handoff: SimReplyHandoff) => Promise<void>;
}

/** The event a due timer becomes. */
export function timerEventOf(due: DueTimer): TimerEvent {
  const { timer } = due;
  const timerKey = timerKeyOf(timer.kind, timer.timerId);
  return {
    type: "TIMER",
    eventId: timerEventId(timer.operationId, timerKey, timer.dueAtSim, timer.version, timer.worldEpoch),
    operationId: timer.operationId,
    clockId: timer.clockId,
    firmId: due.firmId,
    eventAtSim: due.eventAtSim,
    ...(due.correlationId === undefined ? {} : { correlationId: due.correlationId }),
    timerKey,
    version: timer.version,
    dueAtSim: timer.dueAtSim,
    firedBy: due.firedBy,
  };
}

/** Where due timers go: `SIM_REPLY` to `SimMail`, every other kind to the FIFO as `TIMER`. */
export function timerDispatcher(ports: TimerDispatchPorts): TimerDispatcher {
  return {
    async dispatch(due) {
      const event = timerEventOf(due);
      if (due.timer.kind === "SIM_REPLY") {
        await ports.simReply({ clockId: event.clockId, operationId: event.operationId, timerKey: event.timerKey, dueAtSim: event.dueAtSim, version: event.version, firmId: event.firmId, firedBy: event.firedBy, eventAtSim: event.eventAtSim });
        return;
      }
      await ports.events.enqueue(event);
    },
  };
}

export interface TimerDeps {
  readonly data: Pick<Connector, "timers" | "world">;
  readonly scheduler: SchedulerPort;
  readonly dispatcher: TimerDispatcher;
  /** Real time: the RUNNING mode and the schedules are measured against it. */
  readonly realClock: () => Date;
  readonly log: Logger;
}

export type SchedulePlan = { readonly kind: "NONE" } | { readonly kind: "SCHEDULE"; readonly at: Date } | { readonly kind: "DIRECT" };

/** What a SCHEDULED timer needs in its world right now (docs/architecture.md §8). */
export function schedulePlan(timer: Pick<Timer, "dueAtSim">, clock: Clock, realNow: Date): SchedulePlan {
  const now = realNow.getTime();
  if (!isRunning(clock, now)) return { kind: "NONE" };
  const dueAtReal = Date.parse(timer.dueAtSim) - clock.offsetMs;
  const runningEnd = clock.runningUntilReal === undefined ? Number.POSITIVE_INFINITY : Date.parse(clock.runningUntilReal);
  const horizonEnd = Math.min(now + RUNNING_HORIZON_SECONDS * 1000, runningEnd);
  // Past the end of the live window the world is paused again: the timer waits for the clock.
  if (dueAtReal > horizonEnd) return { kind: "NONE" };
  if (dueAtReal <= now + DIRECT_DISPATCH_SECONDS * 1000) return { kind: "DIRECT" };
  return { kind: "SCHEDULE", at: new Date(dueAtReal) };
}

export type SyncOutcome = "NONE" | "SCHEDULED" | "UNSCHEDULED" | "DISPATCHED";

async function forgetSchedule(timer: Timer, deps: TimerDeps): Promise<void> {
  if (timer.scheduleName === undefined) return;
  await deps.scheduler.delete(timer.scheduleName);
  try {
    await deps.data.timers.setScheduleName({ operationId: timer.operationId, timerKey: timerKeyOf(timer.kind, timer.timerId), scheduleName: null, expectedVersion: timer.version });
  } catch (error) {
    // The timer moved on (fired or rescheduled) in between: its new state already says what it has.
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
  }
}

/**
 * Puts the real schedule of a SCHEDULED timer where its world needs it: created or moved inside the
 * horizon, deleted outside it or in a paused world, or dispatched now when it is 60 s away or less.
 */
export async function syncSchedule(timer: Timer, clock: Clock, deps: TimerDeps): Promise<SyncOutcome> {
  if (timer.status !== "SCHEDULED") return "NONE";
  const plan = schedulePlan(timer, clock, deps.realClock());
  const timerKey = timerKeyOf(timer.kind, timer.timerId);
  if (plan.kind === "NONE") {
    if (timer.scheduleName === undefined) return "NONE";
    await forgetSchedule(timer, deps);
    return "UNSCHEDULED";
  }
  if (plan.kind === "DIRECT") {
    await forgetSchedule(timer, deps);
    await deps.dispatcher.dispatch({ timer, firmId: clock.firmId, firedBy: "SCHEDULER", eventAtSim: timer.dueAtSim });
    return "DISPATCHED";
  }
  const name = scheduleNameOf(timer.clockId, timer.operationId, timerKey);
  await deps.scheduler.put({ name, at: plan.at, input: { clockId: timer.clockId, operationId: timer.operationId, timerKey, dueAtSim: timer.dueAtSim, version: timer.version } });
  if (timer.scheduleName !== name) await deps.data.timers.setScheduleName({ operationId: timer.operationId, timerKey, scheduleName: name, expectedVersion: timer.version });
  return "SCHEDULED";
}

/** What a producer asks for: the timer, its due instant and why. */
export interface TimerSpec {
  readonly operationId: string;
  readonly clockId: string;
  readonly kind: TimerKind;
  readonly timerId: string;
  readonly dueAtSim: string;
  readonly reason?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface ArmedTimer {
  readonly timer: Timer;
  readonly schedule: SyncOutcome;
}

/** Creates a SCHEDULED timer (CONFLICT when the key exists) and gives it its schedule if its world runs. */
export async function armTimer(spec: TimerSpec, deps: TimerDeps): Promise<ArmedTimer> {
  const clock = await deps.data.world.getClock(spec.clockId);
  const fields: NewEntity<typeof Timer> = {
    operationId: spec.operationId,
    clockId: spec.clockId,
    worldEpoch: clock.worldEpoch,
    kind: spec.kind,
    timerId: spec.timerId,
    dueAtSim: spec.dueAtSim,
    status: "SCHEDULED",
    ...(spec.reason === undefined ? {} : { reason: spec.reason }),
    payload: { ...(spec.payload ?? {}) },
  };
  const timer = await deps.data.timers.createTimer(fields);
  return { timer, schedule: await syncSchedule(timer, clock, deps) };
}

/** A new `dueAtSim` (version + 1) and the schedule moved with it. */
export async function rearmTimer(input: { readonly operationId: string; readonly timerKey: string; readonly dueAtSim: string; readonly reason?: string; readonly expectedVersion?: number }, deps: TimerDeps): Promise<ArmedTimer> {
  const timer = await deps.data.timers.rescheduleTimer(input);
  const clock = await deps.data.world.getClock(timer.clockId);
  return { timer, schedule: await syncSchedule(timer, clock, deps) };
}

/** A SCHEDULED timer that will not fire (`CANCELLED`) or was decided against (`SKIPPED`); a no-op otherwise. */
export async function closeTimer(
  input: { readonly operationId: string; readonly timerKey: string; readonly status: "CANCELLED" | "SKIPPED"; readonly atSim: string; readonly reason: string },
  deps: Pick<TimerDeps, "data" | "scheduler">,
): Promise<Timer | undefined> {
  const timer = await deps.data.timers.findTimer(input.operationId, input.timerKey);
  if (timer === undefined || timer.status !== "SCHEDULED") return undefined;
  if (timer.scheduleName !== undefined) await deps.scheduler.delete(timer.scheduleName);
  try {
    return await deps.data.timers.completeTimer({ operationId: input.operationId, timerKey: input.timerKey, status: input.status, atSim: input.atSim, reason: input.reason, expectedVersion: timer.version });
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") return undefined;
    throw error;
  }
}

/** Every SCHEDULED timer of an operation (`LIBERADO`, an approval) closed in one go; returns the keys closed. */
export async function closeOperationTimers(
  input: { readonly operationId: string; readonly atSim: string; readonly reason: string; readonly keep?: (timer: Timer) => boolean },
  deps: Pick<TimerDeps, "data" | "scheduler">,
): Promise<string[]> {
  const scheduled = await deps.data.timers.listTimers(input.operationId, { status: "SCHEDULED" });
  const closed: string[] = [];
  for (const timer of scheduled) {
    if (input.keep?.(timer)) continue;
    const timerKey = timerKeyOf(timer.kind, timer.timerId);
    if (await closeTimer({ operationId: input.operationId, timerKey, status: "CANCELLED", atSim: input.atSim, reason: input.reason }, deps)) closed.push(timerKey);
  }
  return closed;
}

export type Claim =
  | { readonly status: "READY"; readonly timer: Timer }
  /** The firing carries another version: a schedule or event from before the timer moved (FL-064). */
  | { readonly status: "STALE"; readonly timer: Timer }
  /** Already FIRED, SKIPPED or CANCELLED: a repeated firing has nothing left to do. */
  | { readonly status: "DONE"; readonly timer: Timer }
  /** Gone with its world (a reset or a destroyed world). */
  | { readonly status: "MISSING" };

/** Whether a firing of `timerKey` at `version` may run. */
export async function claimTimer(input: { readonly operationId: string; readonly timerKey: string; readonly version: number }, deps: Pick<TimerDeps, "data">): Promise<Claim> {
  const timer = await deps.data.timers.findTimer(input.operationId, input.timerKey);
  if (timer === undefined) return { status: "MISSING" };
  // A timer that already left SCHEDULED is done whatever the firing's version (leaving bumps it too).
  if (timer.status !== "SCHEDULED") return { status: "DONE", timer };
  if (timer.version !== input.version) return { status: "STALE", timer };
  return { status: "READY", timer };
}

/** `SCHEDULED → FIRED | SKIPPED` of a claimed timer, pinned to its version; a lost race keeps the winner's. */
export async function settleTimer(
  timer: Timer,
  outcome: { readonly status: "FIRED" | "SKIPPED"; readonly firedBy: TimerFiredBy; readonly atSim: string; readonly reason?: string },
  deps: Pick<TimerDeps, "data" | "scheduler">,
): Promise<Timer> {
  const timerKey = timerKeyOf(timer.kind, timer.timerId);
  // A schedule that did not fire this timer (the clock, "fire now", an ETA change) is not needed any more.
  if (timer.scheduleName !== undefined && outcome.firedBy !== "SCHEDULER") await deps.scheduler.delete(timer.scheduleName);
  try {
    return await deps.data.timers.completeTimer({
      operationId: timer.operationId,
      timerKey,
      status: outcome.status,
      atSim: outcome.atSim,
      ...(outcome.status === "FIRED" ? { firedBy: outcome.firedBy } : {}),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      expectedVersion: timer.version,
    });
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    return deps.data.timers.getTimer(timer.operationId, timerKey);
  }
}
