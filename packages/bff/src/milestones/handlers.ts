// The worker's handlers of the time events (worker/ports.ts `EventHandlers`, docs/architecture.md §7):
//
//   fireTimer               `TIMER`: `fire_timer` with the action of the timer's kind
//   rescheduleOnEtaChange   `ETA_CHANGED`: reschedule.ts
//   milestoneFallback       a failed `MILESTONE DOCS_REQUEST` turn: fallback.ts (FL-097)
//
// The actions of `MILESTONE`, `FOLLOWUP_DUE` and `CONTACT_CHECK` are this package's; `DEFERRED_SEND`
// (the outbound pipeline's `deferred_send`), `READER_RETRY` (the intake) and `BOUNCE_RETRY`
// (`apply_email_event`) come from the modules that own them. A `SIM_REPLY` never belongs in the queue:
// one that arrives is handed to `SimMail` unclaimed, as `ScheduleDispatch` would have done. Whatever a
// handler enqueues goes through the event's `ctx.sink`, so it is in flight before the event leaves.
import type { Connector } from "../connector/connector";
import type { OutboundSender } from "../escalations/ports";
import { contactCheckAction } from "../escalations/contact-check";
import { followupDueAction } from "../agent-tools/followups/due";
import type { TimerKind } from "@legajo/shared";
import { type TimerAction, type TimerActions, fireTimer } from "../timers/fire";
import { kindOfTimerKey } from "../timers/events";
import type { SchedulerPort } from "../timers/scheduler-client";
import { type TimerDeps, type TimerDispatcher, claimTimer } from "../timers/timers";
import type { EventHandlers, WorkerContext } from "../worker/ports";
import type { OperationEventSink } from "../worker/sink";
import { type AtRiskMarker, type MilestoneDeps, markAtRisk } from "./deps";
import { milestoneFallback } from "./fallback";
import { milestoneAction } from "./fire";
import { rescheduleOnEtaChange } from "./reschedule";

/** The actions other modules own. */
export type ExternalTimerKind = Extract<TimerKind, "DEFERRED_SEND" | "READER_RETRY" | "BOUNCE_RETRY">;

export interface TimeHandlerDeps {
  readonly data: Connector;
  readonly scheduler: SchedulerPort;
  /** The dispatcher of due timers over the event's sink (timers/stage.ts `stageDispatcher`). */
  readonly dispatcherFor: (sink: OperationEventSink) => TimerDispatcher;
  readonly send: OutboundSender;
  readonly external: (ctx: WorkerContext) => Readonly<Record<ExternalTimerKind, TimerAction>>;
  readonly markAtRisk?: AtRiskMarker;
}

export type TimeHandlers = Pick<EventHandlers, "fireTimer" | "rescheduleOnEtaChange" | "milestoneFallback">;

function timerDepsOf(deps: TimeHandlerDeps, ctx: WorkerContext): TimerDeps & { readonly data: Connector } {
  return { data: deps.data, scheduler: deps.scheduler, dispatcher: deps.dispatcherFor(ctx.sink), realClock: ctx.now, log: ctx.log };
}

function milestoneDepsOf(deps: TimeHandlerDeps, ctx: WorkerContext): MilestoneDeps {
  return { data: deps.data, send: deps.send, wallClock: ctx.now, log: ctx.log, sink: ctx.sink, markAtRisk: deps.markAtRisk ?? markAtRisk(deps.data, ctx.now) };
}

/** Every action of the worker for one event. */
export function timerActions(deps: TimeHandlerDeps, ctx: WorkerContext): TimerActions {
  const milestones = milestoneDepsOf(deps, ctx);
  return {
    ...deps.external(ctx),
    MILESTONE: milestoneAction(milestones),
    FOLLOWUP_DUE: followupDueAction({ data: deps.data, sink: ctx.sink }),
    CONTACT_CHECK: (fired) => contactCheckAction(fired, milestones),
    SIM_REPLY: async () => {
      throw new RangeError("a SIM_REPLY is SimMail's: it is handed off, never run by the worker");
    },
  };
}

export function timeHandlers(deps: TimeHandlerDeps): TimeHandlers {
  return {
    async fireTimer(event, ctx) {
      const timerDeps = timerDepsOf(deps, ctx);
      if (kindOfTimerKey(event.timerKey) === "SIM_REPLY") {
        const claim = await claimTimer(event, timerDeps);
        if (claim.status === "READY") await timerDeps.dispatcher.dispatch({ timer: claim.timer, firmId: event.firmId, firedBy: event.firedBy, eventAtSim: event.eventAtSim });
        return;
      }
      const outcome = await fireTimer(event, timerActions(deps, ctx), timerDeps);
      ctx.log.info("timer.fired", { timerKey: event.timerKey, outcome: outcome.outcome });
    },

    async rescheduleOnEtaChange(event, ctx) {
      const result = await rescheduleOnEtaChange(event, { ...timerDepsOf(deps, ctx), sink: ctx.sink });
      ctx.log.info("eta.rescheduled", { moved: result.moved.length, fired: result.fired.length, repeated: result.repeated });
    },

    async milestoneFallback(input, ctx) {
      const outcome = await milestoneFallback(input, { data: deps.data, send: deps.send, wallClock: ctx.now, log: ctx.log });
      ctx.log.info("milestone.fallback", { status: outcome.status });
    },
  };
}
