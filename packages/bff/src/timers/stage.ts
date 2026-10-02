// The timers' ports in a Lambda of the stage, built from its links (never `process.env`): the one
// Scheduler client (`Resource.Scheduler`), and the dispatcher of due timers, which enqueues `TIMER` on
// `OperationEvents.fifo` (`Resource.OperationEvents`, worker/sink.ts) and hands `SIM_REPLY` to
// `SimMail` (`Resource.SimMail`, sim-mail/invoke.ts). Every client is created on first use, so building
// the ports costs nothing in a world that never runs (a paused world needs no schedule at all).
import type { WorldPort } from "../connector/index";
import { lambdaSimMailInvoker } from "../sim-mail/invoke";
import { type OperationEventSink as QueueSink, linkedQueueSink } from "../worker/sink";
import { type SchedulerPort, eventBridgeScheduler } from "./scheduler-client";
import { type TimerDispatcher, timerDispatcher } from "./timers";

export interface TimerPorts {
  readonly scheduler: SchedulerPort;
  readonly dispatcher: TimerDispatcher;
}

/** The dispatcher over a queue producer (the worker passes its own `ctx.sink`). */
export function stageDispatcher(sink: QueueSink): TimerDispatcher {
  const simMail = lambdaSimMailInvoker();
  return timerDispatcher({ events: sink, simReply: (handoff) => simMail.handOff(handoff) });
}

/** Scheduler and dispatcher of a Lambda that links `Scheduler`, `OperationEvents` and `SimMail`. */
export function stageTimerPorts(world: Pick<WorldPort, "markInFlight">, sink: QueueSink = linkedQueueSink(world)): TimerPorts {
  return { scheduler: eventBridgeScheduler(), dispatcher: stageDispatcher(sink) };
}
