// `reschedule_on_eta_change` (docs/architecture.md §7-§8, FL-061 to FL-064): the worker's handling of an
// `ETA_CHANGED` event, deterministic. In order:
//
//   1. the ETA and its history (`changeEta`, with the feed's event id; an event already in the history
//      is a repeat and changes nothing);
//   2. the five milestones recomputed from the new ETA: every one still SCHEDULED gets its new
//      `dueAtSim` (version + 1, so a schedule or event of the old version is ignored when it fires,
//      FL-064) and its schedule moved; the ones already FIRED, SKIPPED or CANCELLED stay as they are;
//   3. the ones that fall at or before the event's simulated instant are dispatched once, in `dueAtSim`
//      order, as `firedBy ETA_CHANGE` at that instant (FL-063); `CP-ONE-PER-DAY` keeps two reminders of
//      the same day apart;
//   4. `ACTION ETA_RESCHEDULED`, once per feed event;
//   5. the `AGENT_TURN(ETA_CHANGED)` that tells the parties (its id derives from the feed's event id).
//
// The agent's own follow-ups do not move with the ETA: they are re-evaluated when they fall due (FL-062).
import { MilestoneName } from "@legajo/shared";
import { turnEventId } from "../channels/adapter";
import type { Connector } from "../connector/connector";
import type { Timer } from "../domain/timers";
import { timerKeyOf } from "../domain/timers";
import type { OperationEventSink } from "../timers/events";
import { type TimerDeps, armTimer, rearmTimer } from "../timers/timers";
import type { EtaChangedEvent, TurnEvent } from "../worker/events";
import { milestoneDueTimes } from "./schedule";

export interface RescheduleDeps extends TimerDeps {
  readonly data: Pick<Connector, "timers" | "world" | "audit" | "operations">;
  readonly sink: OperationEventSink<TurnEvent>;
}

export interface Rescheduled {
  readonly repeated: boolean;
  /** Milestones whose `dueAtSim` moved. */
  readonly moved: readonly MilestoneName[];
  /** Milestones that fell in the past and were dispatched once (`ETA_CHANGE`). */
  readonly fired: readonly MilestoneName[];
  /** Milestones left as they were (already FIRED, SKIPPED or CANCELLED). */
  readonly kept: readonly MilestoneName[];
  readonly turnEventId?: string;
}

async function moveMilestone(timer: Timer, dueAtSim: string, simNow: number, deps: RescheduleDeps): Promise<{ readonly timer: Timer; readonly due: boolean }> {
  const timerKey = timerKeyOf(timer.kind, timer.timerId);
  if (Date.parse(dueAtSim) > simNow) {
    const armed = await rearmTimer({ operationId: timer.operationId, timerKey, dueAtSim, reason: "ETA_CHANGE", expectedVersion: timer.version }, deps);
    return { timer: armed.timer, due: false };
  }
  // Due already: no schedule of its own; it leaves below, once, as an ETA change.
  const moved = await deps.data.timers.rescheduleTimer({ operationId: timer.operationId, timerKey, dueAtSim, reason: "ETA_CHANGE", expectedVersion: timer.version });
  if (moved.scheduleName !== undefined) {
    await deps.scheduler.delete(moved.scheduleName);
    await deps.data.timers.setScheduleName({ operationId: timer.operationId, timerKey, scheduleName: null, expectedVersion: moved.version });
    return { timer: await deps.data.timers.getTimer(timer.operationId, timerKey), due: true };
  }
  return { timer: moved, due: true };
}

export async function rescheduleOnEtaChange(event: EtaChangedEvent, deps: RescheduleDeps): Promise<Rescheduled> {
  const current = await deps.data.operations.getOperation(event.operationId);
  const repeated = current.etaHistory.some((entry) => entry.eventId === event.eventId);
  const realNow = deps.realClock().toISOString();
  const operation = repeated
    ? current
    : await deps.data.operations.changeEta({ operationId: event.operationId, eta: event.eta, atSim: event.eventAtSim, atReal: realNow, source: "CARRIER", eventId: event.eventId });
  const due = milestoneDueTimes(operation.eta);
  const simNow = Date.parse(event.eventAtSim);
  const moved: MilestoneName[] = [];
  const kept: MilestoneName[] = [];
  const toFire: Timer[] = [];
  for (const name of MilestoneName.options) {
    const timerKey = timerKeyOf("MILESTONE", name);
    const timer = await deps.data.timers.findTimer(operation.operationId, timerKey);
    if (timer === undefined) {
      const armed = await armTimer({ operationId: operation.operationId, clockId: operation.clockId, kind: "MILESTONE", timerId: name, dueAtSim: due[name], reason: "MILESTONE" }, deps);
      if (Date.parse(armed.timer.dueAtSim) <= simNow && armed.schedule !== "DISPATCHED") toFire.push(armed.timer);
      moved.push(name);
      continue;
    }
    if (timer.status !== "SCHEDULED") {
      kept.push(name);
      continue;
    }
    if (Date.parse(timer.dueAtSim) === Date.parse(due[name])) {
      if (Date.parse(timer.dueAtSim) <= simNow) toFire.push(timer);
      continue;
    }
    const result = await moveMilestone(timer, due[name], simNow, deps);
    moved.push(name);
    if (result.due) toFire.push(result.timer);
  }
  toFire.sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim));
  for (const timer of toFire) await deps.dispatcher.dispatch({ timer, firmId: operation.firmId, firedBy: "ETA_CHANGE", eventAtSim: event.eventAtSim, ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }) });
  const fired = toFire.map((timer) => MilestoneName.parse(timer.timerId));

  await deps.data.audit.recordOnce(`ETA_RESCHEDULED#${operation.operationId}#${event.eventId}`, {
    firmId: operation.firmId,
    decision: "ACTION",
    action: "ETA_RESCHEDULED",
    actor: "SYSTEM",
    clockId: operation.clockId,
    operationId: operation.operationId,
    refs: { operationId: operation.operationId, eventId: event.eventId },
    atSim: event.eventAtSim,
    atReal: realNow,
    detail: { eta: operation.eta, ...(event.previousEta === undefined ? {} : { previousEta: event.previousEta }), dueAtSim: { ...due }, moved, fired, kept, repeated },
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
  });

  if (operation.dispatch.status === "LIBERADO") return { repeated, moved, fired, kept };
  const turn: TurnEvent = {
    type: "AGENT_TURN",
    eventId: turnEventId("ETA_CHANGED", event.eventId),
    operationId: operation.operationId,
    clockId: operation.clockId,
    firmId: operation.firmId,
    eventAtSim: event.eventAtSim,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    trigger: "ETA_CHANGED",
    intakeEventIds: [],
    docVersionIds: [],
  };
  await deps.sink.enqueue(turn);
  return { repeated, moved, fired, kept, turnEventId: turn.eventId };
}
