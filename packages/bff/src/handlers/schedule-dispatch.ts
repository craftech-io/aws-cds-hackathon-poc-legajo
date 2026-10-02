// Lambda entry of `ScheduleDispatch` (docs/architecture.md §8), the target of every timer schedule of
// the group infra/scheduler.ts creates, with input `{clockId, operationId, timerKey, dueAtSim, version}`.
// The input is validated with zod (timers/events.ts `ScheduleInput`); timers/fire.ts
// `dispatchScheduled` claims the timer at that version (a stale version is audited and ignored, FL-064),
// leaves a timer of a world that paused in between to its clock, and dispatches the rest: `TIMER` on
// `OperationEvents.fifo` (`inFlight` first, the event id derived from the timer's key, due instant and
// version) or, for `SIM_REPLY`, an asynchronous hand-off to `SimMail` that never enters the queue.
// A malformed input is dropped and logged without its content; a failed dispatch throws, so the
// Scheduler's retry policy delivers the schedule again.
import { type Connector, connector } from "../connector/index";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";
import { ScheduleInput } from "../timers/events";
import { type ScheduledOutcome, dispatchScheduled } from "../timers/fire";
import { eventBridgeScheduler } from "../timers/scheduler-client";
import { stageDispatcher } from "../timers/stage";
import type { TimerDeps } from "../timers/timers";
import { linkedQueueSink } from "../worker/sink";

export type ScheduleDispatchDeps = TimerDeps & { readonly data: Pick<Connector, "timers" | "world" | "audit"> };

export type ScheduleDispatchHandler = (event: unknown) => Promise<{ readonly status: ScheduledOutcome | "INVALID" }>;

export function createScheduleDispatchHandler(depsFor: (log: Logger) => ScheduleDispatchDeps, newLog: () => Logger = () => createLogger({ correlationId: newCorrelationId(), bindings: { service: "schedule-dispatch" } })): ScheduleDispatchHandler {
  return async (event) => {
    const log = newLog();
    const input = ScheduleInput.safeParse(event);
    if (!input.success) {
      log.warn("schedule.invalid_input", { issues: input.error.issues.length });
      return { status: "INVALID" };
    }
    const status = await dispatchScheduled(input.data, depsFor(log));
    log.info("schedule.dispatched", { operationId: input.data.operationId, timerKey: input.data.timerKey, status });
    return { status };
  };
}

function stageDeps(log: Logger): ScheduleDispatchDeps {
  const data = connector();
  return { data, scheduler: eventBridgeScheduler(), dispatcher: stageDispatcher(linkedQueueSink(data.world)), realClock: () => new Date(), log };
}

export const handler: ScheduleDispatchHandler = createScheduleDispatchHandler(stageDeps);
