// What a due timer travels as (ADR-0004, docs/architecture.md §7-§8):
//
//   - the input of every EventBridge Scheduler schedule (`ScheduleInput`, infra/scheduler.ts), which
//     `ScheduleDispatch` receives;
//   - the `TIMER` event of `OperationEvents.fifo` (worker/events.ts `TimerEvent`, the queue's one
//     schema), whose id is derived from `<operationId>#<timerKey>#<dueAtSim>#v<version>`: the schedule,
//     "Avanzar" and "Disparar ahora" of the same timer at the same version are one event, and a
//     rescheduled timer is always another (even when an ETA that moved twice brings it back to an
//     instant it already had);
//   - the `AGENT_TURN` a milestone or a follow-up opens (worker/events.ts `TurnEvent` with its
//     `milestone` and `timerKey`), derived from the `TIMER` event's id;
//   - the hand-off of a `SIM_REPLY` to `SimMail`, which never goes through the queue.
//
// The producer side is worker/sink.ts: `ADD` of the event to `OPSTATE#`/`WORLDSTATE#` first, then
// `SendMessage` (`MessageGroupId = operationId`, `MessageDeduplicationId = eventId`).
import { z } from "zod";
import { ClockId, FirmId, type MilestoneName, OperationId, TimerFiredBy, type TimerKind } from "@legajo/shared";
import { type EventId, derivedEventId, turnEventId } from "../channels/adapter";
import { ZonedInstant, utcInstant } from "../domain/common";
import { parseTimerKey } from "../domain/timers";
import type { TimerEvent, TurnEvent } from "../worker/events";

export type { TimerEvent } from "../worker/events";

/** `TIMER#<kind>#<timerId>`. */
export const TimerKey = z.string().refine((value) => parseTimerKey(value) !== undefined, "expected TIMER#<kind>#<timerId>");

/** Input of every timer schedule: what `ScheduleDispatch` receives (infra/scheduler.ts). */
export const ScheduleInput = z
  .object({
    clockId: ClockId,
    operationId: OperationId,
    timerKey: TimerKey,
    dueAtSim: ZonedInstant,
    version: z.number().int().min(1),
  })
  .strict();
export type ScheduleInput = z.infer<typeof ScheduleInput>;

/** `SIM_REPLY` never enters the queue: `ScheduleDispatch` and the clock hand it to `SimMail`. */
export const SimReplyHandoff = ScheduleInput.extend({
  firmId: FirmId,
  firedBy: TimerFiredBy,
  eventAtSim: ZonedInstant,
}).strict();
export type SimReplyHandoff = z.infer<typeof SimReplyHandoff>;

/** Producer of `OperationEvents.fifo` (worker/sink.ts implements it for every producer). */
export interface OperationEventSink<E> {
  enqueue(event: E): Promise<void>;
}

/** The kind of a `TIMER#<kind>#<timerId>` key; a key that is not one is a bug upstream. */
export function kindOfTimerKey(timerKey: string): TimerKind {
  const parsed = parseTimerKey(timerKey);
  if (parsed === undefined) throw new RangeError(`not a timer key: ${timerKey}`);
  return parsed.kind;
}

/** Id of the `TIMER` event of a timer at one version and due instant (docs/architecture.md §7). */
export function timerEventId(operationId: string, timerKey: string, dueAtSim: string, version: number, world: { readonly clockId: string; readonly worldEpoch: number }): EventId {
  // Worlds reuse operation ids (QA and guest worlds lease the same numbers) and a reset rewrites the same
  // timers (same key, due time and version 1): without the clock and its epoch the new TIMER would be
  // deduplicated against the previous world's (SQS FIFO and IDEMP#) and never fire.
  return derivedEventId("TIMER", `${world.clockId}#e${world.worldEpoch}#${operationId}#${timerKey}#${utcInstant(dueAtSim)}#v${version}`);
}

/** The two turns a timer opens. */
export type TimerTurnTrigger = "MILESTONE" | "FOLLOWUP_DUE";

/** Id of the turn a fired milestone or follow-up opens: derived from the `TIMER` event's id. */
export function timerTurnEventId(trigger: TimerTurnTrigger, timerEvent: string): EventId {
  return turnEventId(trigger, timerEvent);
}

/** The `AGENT_TURN` of a milestone or a follow-up, with the timer that opened it. */
export function timerTurnEvent(input: {
  readonly event: Pick<TimerEvent, "eventId" | "operationId" | "clockId" | "firmId" | "eventAtSim" | "correlationId" | "timerKey">;
  readonly trigger: TimerTurnTrigger;
  readonly milestone?: MilestoneName;
}): TurnEvent {
  const { event } = input;
  return {
    type: "AGENT_TURN",
    eventId: timerTurnEventId(input.trigger, event.eventId),
    operationId: event.operationId,
    clockId: event.clockId,
    firmId: event.firmId,
    eventAtSim: event.eventAtSim,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    trigger: input.trigger,
    intakeEventIds: [],
    docVersionIds: [],
    ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
    timerKey: event.timerKey,
  };
}
