import type { TimerKind, WaButtonAction } from "@legajo/shared";
import { describe, expect, it } from "vitest";
import { TOUR_WINDOW, type TourAction } from "../../packages/web/src/views/tour/steps";
import { walkTour, type TourTimer, type TourWindowDeclaration, type TourWorld } from "./timeline";

// A table-driven stand-in of a world: pending timers, a paused clock and, per fired timer or tapped
// button, the timers the world would create next. It exercises the walk's checks; the hours of the
// real `judge` template come from the todo at the end, once the world can run the tour.
type Reaction = (world: StoryWorld) => void;

interface Story {
  readonly timers: TourTimer[];
  readonly afterFire: Record<string, Reaction>;
  readonly afterTap: Partial<Record<WaButtonAction, Reaction>>;
  readonly afterAction: Partial<Record<TourAction["kind"], Reaction>>;
  readonly window: TourWindowDeclaration;
}

const t = (operationNumber: string, kind: TimerKind, dueAtSim: string): TourTimer => ({ operationNumber, kind, dueAtSim });
const key = (timer: TourTimer) => `${timer.operationNumber}:${timer.kind}@${Date.parse(timer.dueAtSim)}`;
const at = (iso: string) => Date.parse(iso);

class StoryWorld implements TourWorld {
  simNow: string = TOUR_WINDOW.startSim;
  pending: TourTimer[];
  constructor(readonly story: Story) {
    this.pending = [...story.timers];
  }

  get window() {
    return this.story.window;
  }

  add(...timers: TourTimer[]) {
    this.pending.push(...timers);
  }

  cancel(operationNumber: string) {
    this.pending = this.pending.filter((timer) => timer.operationNumber !== operationNumber);
  }

  clock() {
    return Promise.resolve({ simNow: this.simNow, startAtSim: TOUR_WINDOW.startSim, pending: [...this.pending] });
  }

  private fireUntil(target: string): TourTimer[] {
    const fired: TourTimer[] = [];
    for (;;) {
      const due = this.pending.filter((timer) => at(timer.dueAtSim) <= at(target)).sort((a, b) => at(a.dueAtSim) - at(b.dueAtSim))[0];
      if (due === undefined) break;
      this.pending = this.pending.filter((timer) => timer !== due);
      this.simNow = due.dueAtSim;
      fired.push(due);
      this.story.afterFire[key(due)]?.(this);
    }
    this.simNow = target;
    return fired;
  }

  perform(action: TourAction) {
    let fired: TourTimer[] = [];
    if (action.kind === "advanceTo") fired = this.fireUntil(action.toSim);
    if (action.kind === "advanceToNext") {
      const next = [...this.pending].sort((a, b) => at(a.dueAtSim) - at(b.dueAtSim))[0];
      if (next !== undefined) fired = this.fireUntil(next.dueAtSim);
    }
    this.story.afterAction[action.kind]?.(this);
    return Promise.resolve(fired);
  }

  tap(action: WaButtonAction) {
    this.story.afterTap[action]?.(this);
    return Promise.resolve([]);
  }
}

const EMAIL = "2026-10-15T22:00:00-03:00";
const REPLY = "2026-10-15T22:10:00-03:00";
const CORRECTED = "2026-10-15T22:20:00-03:00";
const NOTICES = "2026-10-16T09:00:00-03:00";

/** The story of 4471 as the design tells it (docs/design-brief.md §15), with 4474's first milestone after the window. */
function documentedStory(overrides: { email?: string; window?: Partial<TourWindowDeclaration>; extra?: TourTimer[]; noNotices?: boolean } = {}): Story {
  const email = overrides.email ?? EMAIL;
  return {
    timers: [
      t("4471", "MILESTONE", "2026-10-15T10:00:00-03:00"),
      t("4471", "MILESTONE", "2026-10-17T10:00:00-03:00"),
      t("4471", "MILESTONE", "2026-10-22T08:00:00-03:00"),
      t("4474", "MILESTONE", "2026-10-17T10:00:00-03:00"),
      ...(overrides.extra ?? []),
    ],
    afterTap: { CONFIRM_CONTACT: (world) => world.add(t("4471", "DEFERRED_SEND", email)) },
    afterFire: {
      [key(t("4471", "DEFERRED_SEND", email))]: (world) => world.add(t("4471", "SIM_REPLY", REPLY)),
      [key(t("4471", "SIM_REPLY", REPLY))]: (world) => world.add(t("4471", "SIM_REPLY", CORRECTED), ...(overrides.noNotices ? [] : [t("4471", "DEFERRED_SEND", NOTICES)])),
      [key(t("4471", "SIM_REPLY", CORRECTED))]: (world) => (overrides.noNotices ? undefined : world.add(t("4471", "DEFERRED_SEND", NOTICES))),
    },
    afterAction: { emitDispatchStatus: (world) => world.cancel("4471") },
    window: { operationNumber: "4471", windowStartSim: TOUR_WINDOW.startSim, windowEndSim: TOUR_WINDOW.endSim, ...overrides.window },
  };
}

describe("walk of the guided tour", () => {
  it("accepts a world whose events fall where the tour says, ending on the window's last event of 4471", async () => {
    const report = await walkTour(new StoryWorld(documentedStory()));
    expect(report.problems).toEqual([]);
    expect(report.lastEventSim).toBe(NOTICES);
    expect(report.landings.map((landing) => [landing.step, Date.parse(landing.simNow)])).toEqual([
      ["first-request", at("2026-10-15T10:00:00-03:00")],
      ["email", at(EMAIL)],
      ["reply", at(REPLY)],
      ["correction", at(CORRECTED)],
      ["correction", at(NOTICES)],
    ]);
  });

  it("reports an email deferred to another hour, in the step that promises it and where the clock lands", async () => {
    const report = await walkTour(new StoryWorld(documentedStory({ email: "2026-10-15T22:05:00-03:00" })));
    expect(report.problems.some((problem) => problem.startsWith("delegate: {deferredSend}"))).toBe(true);
    expect(report.problems.some((problem) => problem.startsWith("email move 1: the clock landed at"))).toBe(true);
  });

  it('reports "Avanzar al próximo evento" landing on an event of another operation inside the window', async () => {
    const report = await walkTour(new StoryWorld(documentedStory({ extra: [t("4474", "MILESTONE", "2026-10-15T15:00:00-03:00")] })));
    expect(report.problems).toContain('email move 1: "Avanzar al próximo evento" landed on events of 4474');
  });

  it("reports a template whose tour window does not end where steps.ts says", async () => {
    const report = await walkTour(new StoryWorld(documentedStory({ window: { windowEndSim: "2026-10-16T10:00:00-03:00" } })));
    expect(report.problems).toContain(`the template's tour ends at 2026-10-16T10:00:00-03:00, steps.ts at ${TOUR_WINDOW.endSim}`);
    expect(report.problems.some((problem) => problem.startsWith("the last event of 4471 the tour reaches is"))).toBe(true);
  });

  it("reports a last move that finds no event of 4471 at the end of the window", async () => {
    const report = await walkTour(new StoryWorld(documentedStory({ noNotices: true })));
    expect(report.problems.some((problem) => problem.startsWith("correction move 2:"))).toBe(true);
    expect(report.problems.some((problem) => problem.startsWith("correction: {deferredSend}"))).toBe(true);
  });

  it.todo(
    "walks TOUR_STEPS over the in-process world loaded with the `judge` template and the scripted Harness (tests/flows/support/world.ts) with no problem — pending: the loader and world factory over the judge template (scripts/seed/data/worlds/judge.json, WP-31), the clock, timers and milestones (WP-27), the worker (WP-28), the channel entries (WP-29), the supplier simulator (WP-30), the outbound pipeline (WP-25) and the console's clock, dossier and simulator procedures (WP-33)",
  );
});
