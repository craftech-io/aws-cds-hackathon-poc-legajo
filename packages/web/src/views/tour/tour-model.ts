// Pure rules of the "Recorrido guiado" panel: the hours of "Qué mirar" read from the pending timers
// of operation 4471 that `clock.get` returns (the expected value of steps.ts only while there is no
// such timer), the progress of the tour (which moves are done, which step is current, which button is
// open: the moves of a step go in order, and a move that changes the world waits for a quiet one),
// and the English gloss of the step's message from the simulator's thread of 4471. No React here:
// tour-model.test.ts covers it together with steps.ts.
import type { NextEvent } from "../clock/clock-api";
import type { SimThread } from "../simulator/simulator-api";
import { TOUR_OPERATION_NUMBER, TOUR_STEPS, type TourMove, type TourStep, type TourTime } from "./steps";

/** What the panel reads of `clock.get`. */
export interface TourClock {
  readonly simNow: string;
  readonly startAtSim?: string | null;
  readonly nextEvents: readonly Pick<NextEvent, "operationNumber" | "kind" | "dueAtSim">[];
}

/** The instant of a placeholder: the world's start, or the next pending timer of 4471 of its kind. */
export function resolveTourTime(clock: TourClock | undefined, time: TourTime): string | undefined {
  if (clock === undefined) return undefined;
  if (time.timer === "WORLD_START") return clock.startAtSim ?? undefined;
  const now = Date.parse(clock.simNow);
  return [...clock.nextEvents]
    .filter((event) => event.operationNumber === TOUR_OPERATION_NUMBER && event.kind === time.timer && Date.parse(event.dueAtSim) >= now)
    .sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim))[0]?.dueAtSim;
}

/** The world's next event, whatever operation it belongs to (what "Avanzar al próximo evento" reaches). */
export function nextEventAt(clock: TourClock | undefined): string | undefined {
  if (clock === undefined) return undefined;
  return [...clock.nextEvents].sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim))[0]?.dueAtSim;
}

/** `sign-in#0`: one key per move of the tour. */
export function moveKey(step: Pick<TourStep, "id">, index: number): string {
  return `${step.id}#${index}`;
}

export type TourProgress = ReadonlySet<string>;

export function isStepDone(step: TourStep, progress: TourProgress): boolean {
  return step.moves.every((_, index) => progress.has(moveKey(step, index)));
}

/** Index of the first step with a move still to do; the last step once every move is done. */
export function currentStepIndex(progress: TourProgress, steps: readonly TourStep[] = TOUR_STEPS): number {
  const index = steps.findIndex((step) => !isStepDone(step, progress));
  return index === -1 ? steps.length - 1 : index;
}

/** A move that changes the world (every one but opening a view) waits for a quiet world. */
export function changesWorld(move: TourMove): boolean {
  return move.action.kind !== "open";
}

export type MoveGate = "open" | "done" | "busy" | "blocked";

/** Whether a move's button is open: in order inside its step, and never while the world is busy. */
export function moveGate(step: TourStep, index: number, progress: TourProgress, busy: boolean): MoveGate {
  if (progress.has(moveKey(step, index))) return "done";
  const earlier = step.moves.slice(0, index).every((_, before) => progress.has(moveKey(step, before)));
  if (!earlier) return "blocked";
  const move = step.moves[index];
  return move !== undefined && changesWorld(move) && busy ? "busy" : "open";
}

/** Storage key of the progress: per world and epoch, so "Reiniciar demo" starts the tour again. */
export function progressKey(clockId: string, worldEpoch: number | null | undefined): string {
  return `legajo.tour.${clockId}#${worldEpoch ?? 0}`;
}

export function parseProgress(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

/** The English gloss of the latest message of `kind` the firm sent on 4471's thread, if it has one. */
export function glossFor(threads: readonly SimThread[] | undefined, kind: TourStep["glossOf"]): string | undefined {
  if (threads === undefined || kind === undefined) return undefined;
  const messages = threads
    .flatMap((thread) => thread.messages)
    .filter((message) => message.direction === "OUT" && message.kind === kind && message.operationNumber === TOUR_OPERATION_NUMBER && message.glossEn);
  return messages.sort((a, b) => Date.parse(b.sentAtSim) - Date.parse(a.sentAtSim))[0]?.glossEn ?? undefined;
}
