// `advance_clock` (docs/architecture.md §8, docs/tool-catalog.md): the console's and the `QaDriver`'s
// way to move a world's simulated time, and "Disparar ahora".
//
//   advance(Δ)       Δ from 1 minute to 14 days
//   advanceTo(iso)   forward only, at most 14 days ahead
//   advanceToNext()  to the `dueAtSim` of the next SCHEDULED timer of any kind
//
// Every move keeps the mode (a paused world gets a new `pausedSimNow`, a running one a new `offsetMs`)
// with a write pinned to the clock's version, then dispatches every timer that fell due, oldest first,
// as `firedBy CLOCK` at its own `dueAtSim` (so the policy decides at that simulated hour), and in a
// RUNNING world resynchronizes the schedules of the rest in the same call. The clock never goes back;
// only "Reiniciar demo" reloads a world (clock/reset.ts). From the console a move needs a quiet world
// (clock/busy.ts); the `QaDriver` passes no gate and waits with `op.settle` instead.
import { type MilestoneName, ToolError } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import type { Actor } from "../domain/common";
import { timerKeyOf } from "../domain/timers";
import { moveTo } from "../lib/clock";
import type { TimerDeps } from "../timers/timers";
import { assertWorldQuiet } from "./busy";
import { type FiredRef, currentClock, dispatchDue, resyncWorld, viewOf, writeClock } from "./state";

/** No single move goes further than this (FL-065). */
export const MAX_MOVE_MS = 14 * 24 * 60 * 60_000;

export type ClockTarget = { readonly byMinutes: number } | { readonly to: string } | { readonly next: true };

export interface ClockDeps extends TimerDeps {
  readonly data: Pick<Connector, "timers" | "world" | "audit">;
}

/** Who moves the clock; `gate` is the console's (`WORLD_BUSY`), absent for the `QaDriver`. */
export interface ClockCaller {
  readonly actor: Actor;
  readonly gate?: { readonly force: boolean };
  readonly correlationId?: string;
}

export interface ClockMoved {
  readonly clockId: string;
  readonly mode: "PAUSED" | "RUNNING";
  readonly simNow: string;
  readonly worldEpoch: number;
  readonly fired: readonly FiredRef[];
  /** "Avanzar igual" was accepted for a busy world. */
  readonly forced: boolean;
}

function invalid(message: string, reason: string): ToolError {
  return new ToolError("INVALID", message, reason);
}

async function targetOf(clockId: string, target: ClockTarget, simNow: Date, deps: ClockDeps): Promise<Date> {
  const from = simNow.getTime();
  let to: number;
  if ("byMinutes" in target) {
    if (!Number.isInteger(target.byMinutes) || target.byMinutes <= 0) throw invalid("a move is a whole, positive number of minutes", "CLOCK_INVALID_MOVE");
    to = from + target.byMinutes * 60_000;
  } else if ("to" in target) {
    to = Date.parse(target.to);
    if (Number.isNaN(to)) throw invalid("the target is not an instant", "CLOCK_INVALID_MOVE");
    if (to < from) throw invalid("the clock never goes back", "CLOCK_BACKWARDS");
  } else {
    const next = await deps.data.timers.nextScheduledTimer(clockId);
    if (next === undefined) throw invalid("nothing is pending in this world", "CLOCK_NOTHING_PENDING");
    to = Math.max(from, Date.parse(next.dueAtSim));
  }
  if (to - from > MAX_MOVE_MS) throw invalid("a move goes at most 14 days ahead", "CLOCK_MOVE_TOO_LONG");
  return new Date(to);
}

async function gate(clockId: string, firmId: string, caller: ClockCaller, deps: ClockDeps): Promise<boolean> {
  if (caller.gate === undefined) return false;
  const { forced } = await assertWorldQuiet({ clockId, firmId, force: caller.gate.force, actor: caller.actor, ...(caller.correlationId === undefined ? {} : { correlationId: caller.correlationId }) }, deps);
  return forced;
}

async function audit(
  deps: ClockDeps,
  entry: { readonly firmId: string; readonly clockId: string; readonly action: string; readonly actor: Actor; readonly atSim: string; readonly detail: Readonly<Record<string, unknown>>; readonly operationId?: string; readonly timerKey?: string; readonly correlationId?: string },
): Promise<void> {
  await deps.data.audit.record({
    firmId: entry.firmId,
    decision: "ACTION",
    action: entry.action,
    actor: entry.actor,
    clockId: entry.clockId,
    atSim: entry.atSim,
    atReal: deps.realClock().toISOString(),
    detail: { ...entry.detail },
    ...(entry.operationId === undefined ? {} : { operationId: entry.operationId, refs: { operationId: entry.operationId, ...(entry.timerKey === undefined ? {} : { timerKey: entry.timerKey }) } }),
    ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
  });
}

/** `advance`, `advanceTo` or `advanceToNext` of one world. */
export async function advanceClock(input: { readonly clockId: string; readonly target: ClockTarget; readonly caller: ClockCaller }, deps: ClockDeps): Promise<ClockMoved> {
  const stored = await currentClock(input.clockId, deps);
  const forced = await gate(input.clockId, stored.firmId, input.caller, deps);
  const realNow = deps.realClock();
  const before = viewOf(stored, realNow);
  const to = await targetOf(input.clockId, input.target, before.simNow, deps);
  const clock = to.getTime() === before.simNow.getTime() ? stored : await writeClock(stored, moveTo(stored, to, realNow.getTime()), deps);
  const fired = await dispatchDue(clock, to, deps);
  const after = viewOf(clock, realNow);
  if (after.running) await resyncWorld(clock, to, deps);
  await audit(deps, {
    firmId: clock.firmId,
    clockId: clock.clockId,
    action: "CLOCK_ADVANCED",
    actor: input.caller.actor,
    atSim: to.toISOString(),
    detail: { fromSim: before.simNow.toISOString(), toSim: to.toISOString(), move: "byMinutes" in input.target ? "ADVANCE" : "to" in input.target ? "ADVANCE_TO" : "ADVANCE_TO_NEXT", fired: fired.length, forced },
    ...(input.caller.correlationId === undefined ? {} : { correlationId: input.caller.correlationId }),
  });
  return { clockId: clock.clockId, mode: after.running ? "RUNNING" : "PAUSED", simNow: to.toISOString(), worldEpoch: clock.worldEpoch, fired, forced };
}

/**
 * "Disparar ahora": the milestone fires at the world's simulated now (`firedBy MANUAL`,
 * `eventAtSim = simNow`) without moving the clock.
 */
export async function fireMilestoneNow(
  input: { readonly operationId: string; readonly milestone: MilestoneName; readonly caller: ClockCaller },
  deps: ClockDeps & { readonly data: Pick<Connector, "operations"> },
): Promise<ClockMoved> {
  const operation = await deps.data.operations.getOperation(input.operationId);
  const timerKey = timerKeyOf("MILESTONE", input.milestone);
  const stored = await currentClock(operation.clockId, deps);
  const forced = await gate(operation.clockId, stored.firmId, input.caller, deps);
  const timer = await deps.data.timers.findTimer(operation.operationId, timerKey);
  if (timer === undefined || timer.status !== "SCHEDULED") throw invalid(`milestone ${input.milestone} of ${operation.operationNumber} is not pending`, "MILESTONE_NOT_PENDING");
  const view = viewOf(stored, deps.realClock());
  const simNow = view.simNow.toISOString();
  await deps.dispatcher.dispatch({ timer, firmId: stored.firmId, firedBy: "MANUAL", eventAtSim: simNow });
  if (view.running) await resyncWorld(stored, view.simNow, deps);
  await audit(deps, {
    firmId: stored.firmId,
    clockId: stored.clockId,
    action: "MILESTONE_FIRE_NOW",
    actor: input.caller.actor,
    atSim: simNow,
    operationId: operation.operationId,
    timerKey,
    detail: { milestone: input.milestone, dueAtSim: timer.dueAtSim, forced },
    ...(input.caller.correlationId === undefined ? {} : { correlationId: input.caller.correlationId }),
  });
  return {
    clockId: stored.clockId,
    mode: view.running ? "RUNNING" : "PAUSED",
    simNow,
    worldEpoch: stored.worldEpoch,
    fired: [{ operationId: operation.operationId, timerKey, kind: "MILESTONE", dueAtSim: timer.dueAtSim }],
    forced,
  };
}
