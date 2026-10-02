import { describe, expect, it } from "vitest";
import { TOUR_STEPS, type TourStep } from "../../packages/web/src/views/tour/steps";
import { TOUR_END, TOUR_START, checkReadme, checkScenario, readmeBlock, renderReadmeSection, validateSteps, withReadmeBlock } from "./check";

function replaceStep(id: TourStep["id"], change: (step: TourStep) => TourStep): TourStep[] {
  return TOUR_STEPS.map((step) => (step.id === id ? change(step) : step));
}

describe("the steps of the tour", () => {
  it("are consistent: in order, placeholders declared, hours inside the window, moves forward in simulated time", () => {
    expect(validateSteps()).toEqual([]);
  });

  it("fail when a placeholder of 'What to look at' is not declared in one language", () => {
    const broken = replaceStep("reply", (step) => ({ ...step, look: { ...step.look, en: `${step.look.en} {other}` } }));
    expect(validateSteps(broken)).toContainEqual(expect.stringContaining('reply: "en" uses {deferredSend, other}'));
  });

  it("fail when an expected hour falls outside the tour window of the guest template", () => {
    const broken = replaceStep("delegate", (step) => ({ ...step, times: { ...step.times, deferredSend: { timer: "DEFERRED_SEND", expectedSim: "2026-10-17T10:00:00-03:00", zone: "America/Argentina/Buenos_Aires" } } }));
    expect(validateSteps(broken)).toContainEqual(expect.stringContaining("outside the tour window"));
  });

  it("fail when a clock move goes back in simulated time or the last one misses the window's end", () => {
    const backwards = replaceStep("reply", (step) => ({ ...step, moves: [{ ...step.moves[0]!, expect: { simNow: "2026-10-15T21:00:00-03:00", timer: "SIM_REPLY" } }] }));
    expect(validateSteps(backwards)).toContainEqual(expect.stringContaining("goes back in simulated time"));
    const short = replaceStep("correction", (step) => ({ ...step, moves: step.moves.slice(0, 1) }));
    expect(validateSteps(short)).toContainEqual(expect.stringContaining("not on the end of the tour window"));
  });

  it("fail when the 'go to' button does not name the hour it goes to, or the order of the steps changes", () => {
    const unnamed = replaceStep("first-request", (step) => ({ ...step, moves: [{ ...step.moves[0]!, label: { es: "Ir al pedido", en: "Go to the request" } }] }));
    expect(validateSteps(unnamed)).toEqual(expect.arrayContaining([expect.stringContaining('the "es" label does not name 15/10 10:00'), expect.stringContaining('the "en" label does not name Oct 15 10:00')]));
    expect(validateSteps([...TOUR_STEPS].reverse())).toContainEqual(expect.stringContaining("expected sign-in, first-request"));
  });
});

describe("the README's test instructions", () => {
  const section = renderReadmeSection();

  it("render one row per step in English, with the expected hours and no placeholder left", () => {
    const rows = section.split("\n").slice(2);
    expect(rows).toHaveLength(10);
    expect(rows[3]).toBe(
      "| 4 | Email in English | “Advance to the next event” (→ Oct 15 22:00) | Demo mailbox: the email in English to the supplier, from the address of operation 4471. | ~1-2 min (turn + real email through SES to the simulated mailbox) |",
    );
    expect(section).toContain("deferred by Qingdao business hours until Oct 15 22:00 (Oct 16 09:00 in Qingdao)");
    expect(section).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("match when the README carries the same block, and say what differs when it does not", () => {
    const readme = `# Legajo listo\n\n## Test instructions\n\n${TOUR_START}\n${section}\n${TOUR_END}\n`;
    expect(readmeBlock(readme)).toBe(section);
    expect(checkReadme(readme, section)).toEqual({ status: "ok" });
    const edited = readme.replace("Oct 15 22:00", "Oct 15 23:00");
    const verdict = checkReadme(edited, section);
    expect(verdict.status).toBe("error");
    expect(verdict.status === "error" && verdict.errors.join("\n")).toContain("line 5: expected");
  });

  it("are pending while the README has no markers, and --write fills the block between them", () => {
    expect(checkReadme("# Legajo listo\n", section)).toMatchObject({ status: "pending" });
    expect(checkReadme(undefined, section)).toMatchObject({ status: "pending" });
    const empty = `intro\n${TOUR_START}\nold\n${TOUR_END}\noutro\n`;
    const written = withReadmeBlock(empty, section);
    expect(readmeBlock(written)).toBe(section);
    expect(written.startsWith("intro\n")).toBe(true);
    expect(written.endsWith(`${TOUR_END}\noutro\n`)).toBe(true);
    expect(withReadmeBlock("no markers", section)).toBe("no markers");
  });
});

describe("the SC-24 scenario", () => {
  const importLine = 'import { TOUR_STEPS } from "../../packages/web/src/views/tour/steps";';

  it("passes when it imports the steps module and walks TOUR_STEPS", () => {
    expect(checkScenario("scripts/scenarios/sc-24-guest.ts", `${importLine}\nfor (const step of TOUR_STEPS) run(step);`)).toEqual({ status: "ok" });
  });

  it("passes when it imports the module and names every step", () => {
    const named = `import { lookText } from "../../packages/web/src/views/tour/steps.ts";\n${TOUR_STEPS.map((step) => `step("${step.id}");`).join("\n")}`;
    expect(checkScenario("scripts/scenarios/sc-24-guest.ts", named)).toEqual({ status: "ok" });
  });

  it("fails when it keeps its own list of steps", () => {
    const verdict = checkScenario("scripts/scenarios/sc-24-guest.ts", 'const steps = ["sign-in", "first-request"];');
    expect(verdict.status).toBe("error");
    expect(verdict.status === "error" && verdict.errors.join("\n")).toMatch(/does not import[\s\S]*names the steps delegate/);
  });

  it("is pending while the scenario is not written", () => {
    expect(checkScenario(undefined, undefined)).toMatchObject({ status: "pending" });
  });
});
