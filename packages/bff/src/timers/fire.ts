// `fire_timer` (docs/tool-catalog.md, handlers of direct invocation): the consumer side of a due timer.
// The worker calls `fireTimer` for every `TIMER` event, `SimMail` calls `runTimer` with its own action
// for a `SIM_REPLY` hand-off, and `ScheduleDispatch` calls `dispatchScheduled` with a schedule's input.
//
// In order, for every firing:
//   1. the timer is claimed: a firing whose version is not the timer's is stale and only audited
//      (`ACTION TIMER_STALE`, FL-064); one of a timer already FIRED, SKIPPED or CANCELLED is a repeat
//      and does nothing; one of a timer that no longer exists (its world was reset) is dropped;
//   2. the action of the timer's kind runs (milestones, follow-ups and contact checks here; deferred
//      sends, reader retries, bounce retries and simulator replies from the modules that own them);
//      every action is idempotent, so a retried event may run it again;
//   3. the decision is audited once per timer version (`recordOnce`): `MILESTONE_FIRED` /
//      `MILESTONE_SKIPPED` for milestones, `TIMER_FIRED` / `TIMER_SKIPPED` for the rest;
//   4. the timer leaves `SCHEDULED` (`FIRED` with its `firedBy`, or `SKIPPED` with the reason).
import type { TimerFiredBy, TimerKind } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import type { Timer } from "../domain/timers";
import { isRunning, simNowOf } from "../lib/clock";
import { type ScheduleInput, type TimerEvent, kindOfTimerKey } from "./events";
import { type TimerDeps, claimTimer, settleTimer } from "./timers";

/** A firing of a timer, however it arrived (queue event, `SimMail` hand-off). */
export interface TimerFiring {
  readonly operationId: string;
  readonly clockId: string;
  readonly firmId: string;
  readonly timerKey: string;
  readonly version: number;
  readonly dueAtSim: string;
  readonly eventAtSim: string;
  readonly firedBy: TimerFiredBy;
  /** The `TIMER` event; a milestone's or follow-up's turn derives its id from it. */
  readonly eventId?: string;
  readonly correlationId?: string;
}

export interface FiredTimer {
  readonly timer: Timer;
  readonly firing: TimerFiring;
}

export type TimerActionResult =
  | { readonly outcome: "FIRED"; readonly detail?: Readonly<Record<string, unknown>> }
  | { readonly outcome: "SKIPPED"; readonly reason: string; readonly detail?: Readonly<Record<string, unknown>> };

/** What a kind of timer does when it fires; idempotent (a retried event may run it twice). */
export type TimerAction = (fired: FiredTimer) => Promise<TimerActionResult>;

/** One action per kind; the worker composes the built-in ones with those of the modules that own the rest. */
export type TimerActions = Readonly<Record<TimerKind, TimerAction>>;

export interface FireDeps {
  readonly data: Pick<Connector, "timers" | "world" | "audit">;
  readonly scheduler: TimerDeps["scheduler"];
  readonly realClock: () => Date;
  readonly log: TimerDeps["log"];
}

export type FireOutcome =
  | { readonly outcome: "FIRED" | "SKIPPED"; readonly timer: Timer }
  | { readonly outcome: "STALE" | "DONE"; readonly timer: Timer }
  | { readonly outcome: "MISSING" };

function auditAction(kind: TimerKind, outcome: "FIRED" | "SKIPPED"): string {
  return `${kind === "MILESTONE" ? "MILESTONE" : "TIMER"}_${outcome}`;
}

async function auditStale(firing: TimerFiring, timer: Timer, deps: FireDeps): Promise<void> {
  await deps.data.audit.recordOnce(`TIMER_STALE#${firing.operationId}#${firing.timerKey}#v${firing.version}#${firing.firedBy}`, {
    firmId: firing.firmId,
    decision: "ACTION",
    action: "TIMER_STALE",
    actor: "SYSTEM",
    refs: { operationId: firing.operationId, timerKey: firing.timerKey, ...(firing.eventId === undefined ? {} : { eventId: firing.eventId }) },
    clockId: firing.clockId,
    operationId: firing.operationId,
    atSim: firing.eventAtSim,
    atReal: deps.realClock().toISOString(),
    reason: `fired at version ${firing.version}; the timer is at version ${timer.version}`,
    detail: { firedBy: firing.firedBy, firingVersion: firing.version, timerVersion: timer.version, status: timer.status },
    ...(firing.correlationId === undefined ? {} : { correlationId: firing.correlationId }),
  });
}

/** Claims, runs `action`, audits and settles one firing (steps 1 to 4 above). */
export async function runTimer(firing: TimerFiring, action: TimerAction, deps: FireDeps): Promise<FireOutcome> {
  const claim = await claimTimer(firing, deps);
  if (claim.status === "MISSING") {
    deps.log.info("timer.missing", { operationId: firing.operationId, timerKey: firing.timerKey, version: firing.version });
    return { outcome: "MISSING" };
  }
  if (claim.status === "STALE") {
    await auditStale(firing, claim.timer, deps);
    deps.log.info("timer.stale", { operationId: firing.operationId, timerKey: firing.timerKey, firingVersion: firing.version, timerVersion: claim.timer.version });
    return { outcome: "STALE", timer: claim.timer };
  }
  if (claim.status === "DONE") return { outcome: "DONE", timer: claim.timer };

  const { timer } = claim;
  const result = await action({ timer, firing });
  const reason = result.outcome === "SKIPPED" ? result.reason : undefined;
  await deps.data.audit.recordOnce(`TIMER#${firing.operationId}#${firing.timerKey}#v${timer.version}`, {
    firmId: firing.firmId,
    decision: "ACTION",
    action: auditAction(timer.kind, result.outcome),
    actor: "SYSTEM",
    refs: { operationId: firing.operationId, timerKey: firing.timerKey, ...(firing.eventId === undefined ? {} : { eventId: firing.eventId }) },
    clockId: firing.clockId,
    operationId: firing.operationId,
    atSim: firing.eventAtSim,
    atReal: deps.realClock().toISOString(),
    ...(reason === undefined ? {} : { reason }),
    detail: { kind: timer.kind, timerId: timer.timerId, firedBy: firing.firedBy, dueAtSim: timer.dueAtSim, ...(result.detail ?? {}) },
    ...(firing.correlationId === undefined ? {} : { correlationId: firing.correlationId }),
  });
  const settled = await settleTimer(timer, { status: result.outcome, firedBy: firing.firedBy, atSim: firing.eventAtSim, ...(reason === undefined ? {} : { reason }) }, deps);
  return { outcome: result.outcome, timer: settled };
}

/** The worker's handling of a `TIMER` event: the action of the kind its key names. */
export async function fireTimer(event: TimerEvent, actions: TimerActions, deps: FireDeps): Promise<FireOutcome> {
  return runTimer(event, actions[kindOfTimerKey(event.timerKey)], deps);
}

export type ScheduledOutcome = "DISPATCHED" | "STALE" | "DONE" | "MISSING" | "NOT_DUE";

/**
 * `ScheduleDispatch`: a schedule fired. Its version must still be the timer's, and its world must
 * still be running (a schedule that fires after the live window closed leaves the timer to the clock);
 * then the timer is dispatched as `firedBy SCHEDULER` at its own `dueAtSim`.
 */
export async function dispatchScheduled(input: ScheduleInput, deps: TimerDeps & Pick<FireDeps, "data">): Promise<ScheduledOutcome> {
  const claim = await claimTimer(input, deps);
  if (claim.status === "MISSING") return "MISSING";
  if (claim.status === "DONE") return "DONE";
  const clock = await deps.data.world.getClock(input.clockId);
  if (claim.status === "STALE") {
    await auditStale({ ...input, firmId: clock.firmId, eventAtSim: input.dueAtSim, firedBy: "SCHEDULER" }, claim.timer, deps);
    return "STALE";
  }
  const now = deps.realClock().getTime();
  if (!isRunning(clock, now) && Date.parse(claim.timer.dueAtSim) > simNowOf(clock, now).getTime()) {
    deps.log.info("timer.schedule_after_pause", { operationId: input.operationId, timerKey: input.timerKey });
    try {
      await deps.data.timers.setScheduleName({ operationId: input.operationId, timerKey: input.timerKey, scheduleName: null, expectedVersion: claim.timer.version });
    } catch {
      // Moved on in between: nothing of this schedule is left to forget.
    }
    return "NOT_DUE";
  }
  await deps.dispatcher.dispatch({ timer: claim.timer, firmId: clock.firmId, firedBy: "SCHEDULER", eventAtSim: claim.timer.dueAtSim });
  return "DISPATCHED";
}
