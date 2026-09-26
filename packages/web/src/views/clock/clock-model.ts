// Pure rules of the clock view (docs/architecture.md §8, docs/design-brief.md §6): what each upcoming
// timer means, whether the controls are open (a busy world closes them until it is quiet, or until
// "Avanzar igual" after five real minutes), who may reset the world and when, and the ETA and
// dispatch choices of an operation. No React here: clock-model.test.ts covers it.
import type { ConsoleRole, CustomsChannel, MilestoneName } from "@legajo/shared";
import { MilestoneName as MilestoneNames } from "@legajo/shared";
import { formatSimDateTime, formatTime } from "../../lib/format";
import { isoWithOffset } from "../../lib/local-datetime";
import { type ClockSnapshot, canForce, isBusy, waitText } from "../../lib/world-clock";
import type { ClockDetail, EmittedStatus, NextEvent } from "./clock-api";
import { DISPATCH_LABELS, type EmittableDispatch, MILESTONE_LABELS, TIMER_LABELS, clockCopy } from "./copy";

/** Largest single move of the clock (docs/flows-catalog.md FL-065: Δ ≤ 14 days). */
export const MAX_ADVANCE_MS = 14 * 24 * 3_600_000;

const DAY_MS = 24 * 3_600_000;

/** "Hito · Primer pedido (ETA − 7 días)", "Envío diferido", … */
export function timerLabel(event: Pick<NextEvent, "kind" | "timerId">): string {
  if (event.kind === "MILESTONE") {
    const milestone = MilestoneNames.safeParse(event.timerId);
    return milestone.success ? `${TIMER_LABELS.MILESTONE} · ${MILESTONE_LABELS[milestone.data]}` : TIMER_LABELS.MILESTONE;
  }
  return TIMER_LABELS[event.kind];
}

export interface EventRow {
  readonly key: string;
  readonly operationNumber: string;
  readonly dueAtSim: string;
  readonly whenText: string;
  readonly label: string;
  readonly reason: string | undefined;
}

/** The world's next events in the order they fall. */
export function eventRows(detail: Pick<ClockDetail, "nextEvents">): EventRow[] {
  return [...detail.nextEvents]
    .sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim))
    .map((event) => ({
      key: `${event.operationId}#${event.kind}#${event.timerId}`,
      operationNumber: event.operationNumber,
      dueAtSim: event.dueAtSim,
      whenText: formatSimDateTime(event.dueAtSim),
      label: timerLabel(event),
      reason: event.reason ?? undefined,
    }));
}

export interface ControlGate {
  /** Controls that move time or inject events are closed. */
  readonly disabled: boolean;
  /** Open again only because the world has been busy for five minutes: the moves go with `force`. */
  readonly force: boolean;
  /** What the world waits for, shown next to the closed controls. */
  readonly reason: string | undefined;
}

/** Whether the gated controls are open now (the BFF checks the same with `WORLD_BUSY`). */
export function controlGate(snapshot: ClockSnapshot | undefined, nowMs: number): ControlGate {
  if (snapshot === undefined) return { disabled: true, force: false, reason: undefined };
  if (!isBusy(snapshot)) return { disabled: false, force: false, reason: undefined };
  if (canForce(snapshot, nowMs)) return { disabled: false, force: true, reason: clockCopy.gate.force };
  return { disabled: true, force: false, reason: waitText(snapshot) ?? clockCopy.gate.busy };
}

export type ResetGate = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** "Reiniciar demo": broker or judge only, once every 10 real minutes per world. */
export function resetGate(detail: Pick<ClockDetail, "reset"> | undefined, role: ConsoleRole | undefined): ResetGate {
  if (role !== "BROKER" && role !== "JUDGE") return { allowed: false, reason: clockCopy.reset.onlyApprovers };
  const window = detail?.reset;
  if (window && !window.allowed) {
    return { allowed: false, reason: window.nextAllowedAtReal ? clockCopy.reset.wait(formatTime(window.nextAllowedAtReal)) : clockCopy.reset.onlyApprovers };
  }
  return { allowed: true };
}

/** "En pausa" or "En vivo hasta las 11:02" (real time of the fall back to pause). */
export function modeText(snapshot: Pick<ClockSnapshot, "mode" | "runningUntilReal">): string {
  if (snapshot.mode === "PAUSED") return clockCopy.now.paused;
  return clockCopy.now.running(snapshot.runningUntilReal ? formatTime(snapshot.runningUntilReal) : undefined);
}

/** Whether `toSim` is a valid target of "Avanzar hasta": after the simulated now, at most 14 days ahead. */
export function isValidAdvanceTarget(simNow: string, toSim: string | undefined): toSim is string {
  if (toSim === undefined) return false;
  const delta = Date.parse(toSim) - Date.parse(simNow);
  return Number.isFinite(delta) && delta > 0 && delta <= MAX_ADVANCE_MS;
}

/** The ETA moved by whole days, written in Argentina's offset (`2026-10-20T08:00:00-03:00`). */
export function shiftEta(eta: string, days: number): string {
  const instant = Date.parse(eta);
  if (!Number.isFinite(instant)) throw new RangeError(`not an ETA: ${eta}`);
  return isoWithOffset(new Date(instant + days * DAY_MS));
}

export interface MilestoneOption {
  readonly value: MilestoneName;
  readonly label: string;
}

export const MILESTONE_OPTIONS: readonly MilestoneOption[] = MilestoneNames.options.map((value) => ({ value, label: MILESTONE_LABELS[value] }));

export interface DispatchChoice {
  readonly status: EmittedStatus;
  readonly channel?: CustomsChannel;
}

/** `CANAL_ASIGNADO#NARANJA` → the status and channel the platform publishes. */
export function dispatchChoice(value: EmittableDispatch): DispatchChoice {
  const [status, channel] = value.split("#") as [EmittedStatus, CustomsChannel | undefined];
  return channel === undefined ? { status } : { status, channel };
}

export const DISPATCH_OPTIONS: readonly { readonly value: EmittableDispatch; readonly label: string }[] = (Object.keys(DISPATCH_LABELS) as EmittableDispatch[]).map((value) => ({
  value,
  label: DISPATCH_LABELS[value],
}));
