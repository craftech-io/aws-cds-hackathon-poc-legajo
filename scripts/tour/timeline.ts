// Walks the guest's guided tour (packages/web/src/views/tour/steps.ts) over a world and checks that
// the hours the tour promises are the ones the world produces (docs/test-plan.md §3, "línea de tiempo
// del recorrido"; docs/seed-spec.md §3, invariant 21):
//
//   1. every clock move lands where its step says: `advanceTo` on its hour and "Avanzar al próximo
//      evento" on the event of 4471 the step names (kind and simulated hour), never on an event of
//      another operation;
//   2. every hour of "Qué mirar" is real: the world's start, or a timer of 4471 of that kind that the
//      world had pending (or fired) at that hour while the step ran;
//   3. the last event of 4471 the tour reaches is `tour.windowEndSim` of the template, which is also
//      the end of the window steps.ts declares, and no timer of 4471 is left inside the window.
//
// The world is a port: scripts/tour/timeline.test.ts runs the walk over the in-process world of the
// local flows (tests/flows/support/world.ts) loaded with the `guest` template and the scripted Harness.
// Button taps inside the phone simulator are not moves of the panel; the tour asks for them in "Qué
// mirar" and SC-24 taps them, so the walk taps them too (TOUR_TAPS).
import type { TimerKind, WaButtonAction } from "@legajo/shared";
import { TOUR_OPERATION_NUMBER, TOUR_STEPS, TOUR_WINDOW, type TourAction, type TourStep, type TourStepId } from "../../packages/web/src/views/tour/steps";

export interface TourTimer {
  readonly operationNumber: string;
  readonly kind: TimerKind;
  readonly dueAtSim: string;
}

/** What `clock.get` answers, with every pending timer of the world (not only the next five). */
export interface TourClockView {
  readonly simNow: string;
  readonly startAtSim: string;
  readonly pending: readonly TourTimer[];
}

/** `tour` of the `guest` template (docs/seed-spec.md §3). */
export interface TourWindowDeclaration {
  readonly operationNumber: string;
  readonly windowStartSim: string;
  readonly windowEndSim: string;
}

export interface TourWorld {
  readonly window: TourWindowDeclaration;
  clock(): Promise<TourClockView>;
  /** Runs a move the way its button does and returns once the world is quiet, with the timers it fired. */
  perform(action: TourAction): Promise<readonly TourTimer[]>;
  /** Taps a button of the last message of 4471 in the phone simulator; returns once the world is quiet. */
  tap(action: WaButtonAction): Promise<readonly TourTimer[]>;
}

/** Phone buttons each step asks the guest to tap after its moves ("Qué mirar" of steps.ts, SC-24). */
export const TOUR_TAPS: Readonly<Partial<Record<TourStepId, readonly WaButtonAction[]>>> = {
  delegate: ["SUPPLIER_SENDS", "CONFIRM_CONTACT"],
};

export interface TourLanding {
  readonly step: TourStepId;
  readonly move: number;
  readonly simNow: string;
  readonly fired: readonly TourTimer[];
}

export interface TimelineReport {
  readonly problems: readonly string[];
  readonly landings: readonly TourLanding[];
  /** Last simulated hour at which a move fired an event of 4471. */
  readonly lastEventSim?: string;
}

const same = (a: string, b: string) => Date.parse(a) === Date.parse(b);
const ofTour = (timer: TourTimer) => timer.operationNumber === TOUR_OPERATION_NUMBER;

function landingProblems(step: TourStep, index: number, action: TourAction, simNow: string, fired: readonly TourTimer[]): string[] {
  const move = step.moves[index];
  if (move?.expect === undefined) return [];
  const where = `${step.id} move ${index + 1}`;
  const expected = move.expect;
  const problems: string[] = [];
  if (!same(simNow, expected.simNow)) problems.push(`${where}: the clock landed at ${simNow}, the tour says ${expected.simNow}`);
  const firedHere = fired.filter((timer) => same(timer.dueAtSim, simNow));
  if (!firedHere.some((timer) => ofTour(timer) && timer.kind === expected.timer)) problems.push(`${where}: no ${expected.timer} of ${TOUR_OPERATION_NUMBER} fired at ${simNow}`);
  if (action.kind === "advanceToNext") {
    const others = firedHere.filter((timer) => !ofTour(timer));
    if (others.length > 0) problems.push(`${where}: "Avanzar al próximo evento" landed on events of ${[...new Set(others.map((timer) => timer.operationNumber))].join(", ")}`);
  }
  return problems;
}

function lookProblems(step: TourStep, seen: readonly TourTimer[], startAtSim: string): string[] {
  const problems: string[] = [];
  for (const [name, time] of Object.entries(step.times)) {
    if (time.timer === "WORLD_START") {
      if (!same(startAtSim, time.expectedSim)) problems.push(`${step.id}: {${name}} says the world starts at ${time.expectedSim}, it starts at ${startAtSim}`);
      continue;
    }
    const kind = time.timer;
    const candidates = seen.filter((timer) => ofTour(timer) && timer.kind === kind);
    if (!candidates.some((timer) => same(timer.dueAtSim, time.expectedSim))) {
      const found = [...new Set(candidates.map((timer) => timer.dueAtSim))].join(", ") || "none";
      problems.push(`${step.id}: {${name}} expects a ${kind} of ${TOUR_OPERATION_NUMBER} at ${time.expectedSim}; the world had ${found}`);
    }
  }
  return problems;
}

function windowProblems(declared: TourWindowDeclaration): string[] {
  const problems: string[] = [];
  if (declared.operationNumber !== TOUR_OPERATION_NUMBER) problems.push(`the template's tour follows ${declared.operationNumber}, steps.ts follows ${TOUR_OPERATION_NUMBER}`);
  if (!same(declared.windowStartSim, TOUR_WINDOW.startSim)) problems.push(`the template's tour starts at ${declared.windowStartSim}, steps.ts at ${TOUR_WINDOW.startSim}`);
  if (!same(declared.windowEndSim, TOUR_WINDOW.endSim)) problems.push(`the template's tour ends at ${declared.windowEndSim}, steps.ts at ${TOUR_WINDOW.endSim}`);
  return problems;
}

/** Walks the steps over `world` and reports every hour that is not the one the tour promises. */
export async function walkTour(world: TourWorld, steps: readonly TourStep[] = TOUR_STEPS): Promise<TimelineReport> {
  const problems = windowProblems(world.window);
  const landings: TourLanding[] = [];
  let lastEventSim: string | undefined;
  const start = await world.clock();
  if (!same(start.simNow, world.window.windowStartSim)) problems.push(`the world starts at ${start.simNow}, its template's tour at ${world.window.windowStartSim}`);

  for (const step of steps) {
    const seen: TourTimer[] = [...(await world.clock()).pending];
    for (const [index, move] of step.moves.entries()) {
      const fired = await world.perform(move.action);
      const after = await world.clock();
      seen.push(...fired, ...after.pending);
      if (move.expect === undefined) continue;
      landings.push({ step: step.id, move: index, simNow: after.simNow, fired });
      problems.push(...landingProblems(step, index, move.action, after.simNow, fired));
      const tourEvents = fired.filter((timer) => ofTour(timer) && same(timer.dueAtSim, after.simNow));
      if (tourEvents.length > 0 && (lastEventSim === undefined || Date.parse(after.simNow) > Date.parse(lastEventSim))) lastEventSim = after.simNow;
    }
    for (const tap of TOUR_TAPS[step.id] ?? []) {
      seen.push(...(await world.tap(tap)), ...(await world.clock()).pending);
    }
    problems.push(...lookProblems(step, seen, start.startAtSim));
  }

  if (lastEventSim === undefined || !same(lastEventSim, world.window.windowEndSim)) problems.push(`the last event of ${TOUR_OPERATION_NUMBER} the tour reaches is ${lastEventSim ?? "none"}, the template's window ends at ${world.window.windowEndSim}`);
  const left = (await world.clock()).pending.filter((timer) => ofTour(timer) && Date.parse(timer.dueAtSim) <= Date.parse(world.window.windowEndSim));
  if (left.length > 0) problems.push(`timers of ${TOUR_OPERATION_NUMBER} left inside the window: ${left.map((timer) => `${timer.kind}@${timer.dueAtSim}`).join(", ")}`);
  return { problems, landings, ...(lastEventSim === undefined ? {} : { lastEventSim }) };
}
