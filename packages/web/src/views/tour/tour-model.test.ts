import { BUTTON_LABELS } from "@legajo/bff/copy/buttons";
import { describe, expect, it } from "vitest";
import type { SimThread } from "../simulator/simulator-api";
import { TOUR_STEPS, TOUR_WINDOW, type TourStep, formatTourTime, lookText, placeholdersOf } from "./steps";
import { type TourClock, currentStepIndex, glossFor, isStepDone, moveGate, moveKey, nextEventAt, parseProgress, progressKey, resolveTourTime } from "./tour-model";

const step = (id: TourStep["id"]): TourStep => {
  const found = TOUR_STEPS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
};

/** The world right after "Sí, escribile": the email to Qingdao waits for 15/10 22:00 (16/10 09:00 there). */
const AFTER_CONFIRMATION: TourClock = {
  simNow: "2026-10-15T10:07:00-03:00",
  startAtSim: TOUR_WINDOW.startSim,
  nextEvents: [
    { operationNumber: "4471", kind: "DEFERRED_SEND", dueAtSim: "2026-10-15T22:00:00-03:00" },
    { operationNumber: "4471", kind: "MILESTONE", dueAtSim: "2026-10-17T10:00:00-03:00" },
    { operationNumber: "4474", kind: "MILESTONE", dueAtSim: "2026-10-17T10:00:00-03:00" },
  ],
};

describe("the steps as the panel and the README read them", () => {
  it("are ten, in the order of the story, each with a button, a wait and a view", () => {
    expect(TOUR_STEPS.map((candidate) => candidate.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const candidate of TOUR_STEPS) {
      expect(candidate.moves.length).toBeGreaterThan(0);
      expect(candidate.wait.es).not.toBe("");
      expect(candidate.wait.en).not.toBe("");
    }
    expect(step("first-request").moves[0]?.action).toEqual({ kind: "advanceTo", toSim: "2026-10-15T10:00:00-03:00" });
    expect(step("eta").moves[0]?.action).toEqual({ kind: "moveEta", shiftDays: -2 });
  });

  it("write the hours in each language and each zone", () => {
    expect(formatTourTime("2026-10-15T22:00:00-03:00", "America/Argentina/Buenos_Aires", "es")).toBe("15/10 22:00");
    expect(formatTourTime("2026-10-15T22:00:00-03:00", "Asia/Shanghai", "en")).toBe("Oct 16 09:00");
    expect(placeholdersOf(step("delegate").look.es)).toEqual(["deferredSend", "deferredSendQingdao"]);
  });

  it("name the importer's buttons exactly as the BFF's copy writes them", () => {
    for (const lang of ["es", "en"] as const) {
      expect(step("delegate").look[lang]).toContain(`“${BUTTON_LABELS.SUPPLIER_SENDS.template}”`);
      expect(step("delegate").look[lang]).toContain(`“${BUTTON_LABELS.CONFIRM_CONTACT.template}”`);
    }
  });

  it("fill 'Qué mirar' with the expected hours for the README", () => {
    expect(lookText(step("delegate"), "es")).toContain("hasta las 15/10 22:00 (16/10 09:00 en Qingdao)");
    expect(lookText(step("sign-in"), "en")).toContain("paused at Oct 14 10:30");
  });
});

describe("hours read from the world (clock.get), never written by hand", () => {
  it("fills a placeholder with the next pending timer of 4471 of its kind", () => {
    const resolved = lookText(step("delegate"), "es", (_name, time) => resolveTourTime({ ...AFTER_CONFIRMATION, nextEvents: [{ operationNumber: "4471", kind: "DEFERRED_SEND", dueAtSim: "2026-10-15T21:00:00-03:00" }] }, time));
    expect(resolved).toContain("hasta las 15/10 21:00 (16/10 08:00 en Qingdao)");
  });

  it("ignores other operations and timers already past, and falls back to the expected hour", () => {
    const time = step("reply").times.deferredSend!;
    expect(resolveTourTime(AFTER_CONFIRMATION, time)).toBe("2026-10-15T22:00:00-03:00");
    expect(resolveTourTime({ ...AFTER_CONFIRMATION, nextEvents: AFTER_CONFIRMATION.nextEvents.filter((event) => event.operationNumber !== "4471") }, time)).toBeUndefined();
    expect(resolveTourTime(undefined, time)).toBeUndefined();
    expect(resolveTourTime(AFTER_CONFIRMATION, step("sign-in").times.start!)).toBe(TOUR_WINDOW.startSim);
  });

  it("says where 'Avanzar al próximo evento' lands: the world's next event", () => {
    expect(nextEventAt(AFTER_CONFIRMATION)).toBe("2026-10-15T22:00:00-03:00");
    expect(nextEventAt({ simNow: TOUR_WINDOW.startSim, nextEvents: [] })).toBeUndefined();
  });
});

describe("progress of the tour", () => {
  const done = (...keys: string[]) => new Set(keys);

  it("makes the first step with a move still to do the current one", () => {
    expect(currentStepIndex(done())).toBe(0);
    expect(currentStepIndex(done(moveKey(step("sign-in"), 0), moveKey(step("first-request"), 0)))).toBe(2);
    expect(currentStepIndex(new Set(TOUR_STEPS.flatMap((candidate) => candidate.moves.map((_, index) => moveKey(candidate, index)))))).toBe(TOUR_STEPS.length - 1);
  });

  it("keeps the moves of a step in order and closes the ones that change the world while it is busy", () => {
    const correction = step("correction");
    expect(moveGate(correction, 0, done(), false)).toBe("open");
    expect(moveGate(correction, 1, done(), false)).toBe("blocked");
    expect(moveGate(correction, 0, done(), true)).toBe("busy");
    expect(moveGate(correction, 1, done(moveKey(correction, 0)), false)).toBe("open");
    expect(moveGate(correction, 0, done(moveKey(correction, 0)), false)).toBe("done");
    expect(isStepDone(correction, done(moveKey(correction, 0)))).toBe(false);
    // Opening a view changes nothing: it stays open while the world is busy.
    expect(moveGate(step("delegate"), 0, done(), true)).toBe("open");
  });

  it("keeps progress per world and epoch, and survives a malformed stored value", () => {
    expect(progressKey("JUDGE#firm-judge-01", 2)).toBe("legajo.tour.JUDGE#firm-judge-01#2");
    expect(parseProgress('["sign-in#0", 3]')).toEqual(new Set(["sign-in#0"]));
    expect(parseProgress("{broken")).toEqual(new Set());
    expect(parseProgress(null)).toEqual(new Set());
  });
});

describe("the English gloss of the step's message", () => {
  const threads = [
    {
      importerId: "imp-norpampa",
      messages: [
        { messageId: "m1", direction: "OUT", kind: "DOCS_REQUEST", operationNumber: "4471", sentAtSim: "2026-10-15T10:00:30-03:00", glossEn: "Hi, we are writing from the firm…" },
        { messageId: "m2", direction: "OUT", kind: "DOCS_REQUEST", operationNumber: "4474", sentAtSim: "2026-10-17T10:00:30-03:00", glossEn: "Other operation" },
        { messageId: "m3", direction: "IN", kind: "DOCS_REQUEST", operationNumber: "4471", sentAtSim: "2026-10-15T10:01:00-03:00", glossEn: "Inbound" },
      ],
    },
  ] as unknown as SimThread[];

  it("reads the latest message of that kind the firm sent on 4471's thread", () => {
    expect(glossFor(threads, "DOCS_REQUEST")).toBe("Hi, we are writing from the firm…");
    expect(glossFor(threads, "ETA_CHANGE")).toBeUndefined();
    expect(glossFor(undefined, "DOCS_REQUEST")).toBeUndefined();
  });
});
