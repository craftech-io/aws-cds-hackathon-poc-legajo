// The product tour (FL-126, docs/landing-spec.md §1.4): eight steps over operation 4471 in the order of
// the story, one array for the three shapes, each with its text in both languages, its render and the
// console capture that replaces it; the carousel's buttons stop at both ends and the route line fills
// by eighths.
import { describe, expect, it } from "vitest";
import { LANDING_COPY } from "./copy";
import { CONSOLE_CAPTURE_IDS, RENDER_IDS } from "./manifest";
import { TOUR_STEPS, TOUR_STEP_IDS, clampStep, routeProgress, stepAnchor } from "./tour-steps";

describe("tour steps [FL-126]", () => {
  it("tells the story of 4471 in eight steps, in order, each with its text in both languages", () => {
    expect(TOUR_STEPS.map((step) => step.id)).toEqual(["request", "delegate", "supplier", "reader", "owner", "eta", "escalation", "approval"]);
    expect(TOUR_STEP_IDS).toHaveLength(8);
    for (const step of TOUR_STEPS) {
      for (const lang of ["es", "en"] as const) {
        const text = LANDING_COPY[lang].tour.steps[step.id];
        expect(text.title.length * text.channel.length, `${lang} ${step.id}`).toBeGreaterThan(0);
        expect(text.text.length, `${lang} ${step.id}`).toBeGreaterThan(60);
      }
      expect(step.when).toMatch(/^\d{2}\/10 \d{2}:\d{2}$/);
    }
  });

  it("draws each step with its own render and names the console capture of the same moment", () => {
    expect(new Set(TOUR_STEPS.map((step) => step.render)).size).toBe(8);
    for (const step of TOUR_STEPS) {
      expect(RENDER_IDS).toContain(step.render);
      expect(CONSOLE_CAPTURE_IDS).toContain(step.capture);
    }
    expect(TOUR_STEPS.find((step) => step.id === "escalation")?.alsoCapture).toBe("console-mailbox-firm");
  });

  it("keeps the carousel inside the tour and fills the route line by eighths", () => {
    expect(clampStep(0, -1)).toBe(0);
    expect(clampStep(7, 1)).toBe(7);
    expect(clampStep(3, 1)).toBe(4);
    expect(routeProgress(0)).toBe(1 / 8);
    expect(routeProgress(7)).toBe(1);
    expect(stepAnchor("eta")).toBe("tour-step-eta");
  });

  it("says the simulated time and labels the agent's sample texts in both languages", () => {
    expect(LANDING_COPY.es.tour.stepLabel(3, 8)).toBe("Paso 3 de 8");
    expect(LANDING_COPY.en.tour.stepLabel(3, 8)).toBe("Step 3 of 8");
    expect(LANDING_COPY.es.tour.renderBadge).toBe(LANDING_COPY.es.gallery.renderNote);
    expect(LANDING_COPY.en.tour.renderBadge).toBe(LANDING_COPY.en.gallery.renderNote);
  });
});
