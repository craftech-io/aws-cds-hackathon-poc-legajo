// Keeps the judge's guided tour in one source (docs/design-brief.md §15, docs/architecture.md §18):
// packages/web/src/views/tour/steps.ts drives the console's panel, and this check makes the other two
// readers follow it.
//
//   1. The steps are consistent: numbered in order, every "What to look at" placeholder declared (and
//      every declared time used) in both languages, every expected hour inside the tour window of the
//      `judge` template, the clock moves in simulated order ending at the window's end, and each
//      "go to" button naming the hour it goes to.
//   2. The README's "Test instructions" table between <!-- TOUR:START --> and <!-- TOUR:END --> is
//      exactly the one rendered here from the steps, in English, with the expected hours
//      (`--write` rewrites the block; the markers themselves are the README author's).
//   3. The SC-24 scenario (scripts/scenarios/sc-24-*.ts) imports the steps module and walks `TOUR_STEPS`
//      (or names every step id), so it cannot follow another list.
//
// A README without the markers or an SC-24 not written yet is reported as pending, because they arrive
// in later work packages; `--strict` fails on it.
//
//   npm run tour:check [-- --write] [-- --strict]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AR_ZONE, TOUR_STEPS, TOUR_STEP_IDS, TOUR_WINDOW, type TourMove, type TourStep, formatTourTime, lookText, placeholdersOf } from "../../packages/web/src/views/tour/steps";

export const README_FILE = "README.md";
export const TOUR_START = "<!-- TOUR:START -->";
export const TOUR_END = "<!-- TOUR:END -->";
export const SCENARIOS_DIR = "scripts/scenarios";
export const SC24_PREFIX = "sc-24-";

const HEADER = ["| # | Step | Button / action | What to look at | Expected wait |", "|---|---|---|---|---|"];

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function moveText(move: TourMove): string {
  const lands = move.expect === undefined || move.action.kind === "advanceTo" ? "" : ` (→ ${formatTourTime(move.expect.simNow, AR_ZONE, "en")})`;
  return `“${move.label.en}”${lands}`;
}

/** The README table, in English, with the expected hours of the steps. */
export function renderReadmeSection(steps: readonly TourStep[] = TOUR_STEPS): string {
  const rows = steps.map((step) => `| ${step.number} | ${cell(step.title.en)} | ${cell(step.moves.map(moveText).join(" · "))} | ${cell(lookText(step, "en"))} | ${cell(step.wait.en)} |`);
  return [...HEADER, ...rows].join("\n");
}

function inWindow(instant: string): boolean {
  const at = Date.parse(instant);
  return at >= Date.parse(TOUR_WINDOW.startSim) && at <= Date.parse(TOUR_WINDOW.endSim);
}

/** Problems of the steps themselves; empty when they are consistent. */
export function validateSteps(steps: readonly TourStep[] = TOUR_STEPS): string[] {
  const errors: string[] = [];
  const ids = steps.map((step) => step.id);
  if (ids.join(",") !== TOUR_STEP_IDS.join(",")) errors.push(`steps are ${ids.join(", ")}; expected ${TOUR_STEP_IDS.join(", ")}`);
  let lastMove = Date.parse(TOUR_WINDOW.startSim);
  let lastExpected: string | undefined;
  steps.forEach((step, index) => {
    if (step.number !== index + 1) errors.push(`${step.id}: number ${step.number}, expected ${index + 1}`);
    if (step.moves.length === 0) errors.push(`${step.id}: no button`);
    if (step.waitSec < 0) errors.push(`${step.id}: negative wait`);
    const declared = Object.keys(step.times).sort();
    for (const lang of ["es", "en"] as const) {
      const used = [...new Set(placeholdersOf(step.look[lang]))].sort();
      if (used.join(",") !== declared.join(",")) errors.push(`${step.id}: "${lang}" uses {${used.join(", ")}} but declares {${declared.join(", ")}}`);
    }
    for (const [name, time] of Object.entries(step.times)) if (!inWindow(time.expectedSim)) errors.push(`${step.id}: {${name}} ${time.expectedSim} is outside the tour window`);
    for (const move of step.moves) {
      if (move.action.kind === "advanceTo") {
        for (const lang of ["es", "en"] as const) {
          const hour = formatTourTime(move.action.toSim, AR_ZONE, lang);
          if (!move.label[lang].includes(hour)) errors.push(`${step.id}: the "${lang}" label does not name ${hour}`);
        }
        if (move.expect?.simNow !== move.action.toSim) errors.push(`${step.id}: advanceTo ${move.action.toSim} expects ${move.expect?.simNow ?? "nothing"}`);
      }
      if (move.expect === undefined) continue;
      const at = Date.parse(move.expect.simNow);
      if (!inWindow(move.expect.simNow)) errors.push(`${step.id}: expected hour ${move.expect.simNow} is outside the tour window`);
      if (at < lastMove) errors.push(`${step.id}: expected hour ${move.expect.simNow} goes back in simulated time`);
      lastMove = Math.max(lastMove, at);
      lastExpected = move.expect.simNow;
    }
  });
  if (lastExpected !== undefined && Date.parse(lastExpected) !== Date.parse(TOUR_WINDOW.endSim)) errors.push(`the last clock move lands on ${lastExpected}, not on the end of the tour window ${TOUR_WINDOW.endSim}`);
  return errors;
}

/** The block between the README markers; undefined when the markers are not there. */
export function readmeBlock(readme: string): string | undefined {
  const start = readme.indexOf(TOUR_START);
  const end = readme.indexOf(TOUR_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return readme.slice(start + TOUR_START.length, end).trim();
}

export function withReadmeBlock(readme: string, section: string): string {
  const start = readme.indexOf(TOUR_START);
  const end = readme.indexOf(TOUR_END);
  if (start === -1 || end === -1 || end < start) return readme;
  return `${readme.slice(0, start + TOUR_START.length)}\n${section}\n${readme.slice(end)}`;
}

export type Verdict = { readonly status: "ok" } | { readonly status: "pending"; readonly why: string } | { readonly status: "error"; readonly errors: readonly string[] };

export function checkReadme(readme: string | undefined, section: string = renderReadmeSection()): Verdict {
  if (readme === undefined) return { status: "pending", why: `${README_FILE} does not exist` };
  const block = readmeBlock(readme);
  if (block === undefined) return { status: "pending", why: `${README_FILE} has no ${TOUR_START} … ${TOUR_END} block yet` };
  if (block === section) return { status: "ok" };
  const want = section.split("\n");
  const have = block.split("\n");
  const errors = [`${README_FILE}: the test instructions differ from views/tour/steps.ts (run \`npm run tour:check -- --write\`):`];
  for (let line = 0; line < Math.max(want.length, have.length); line += 1) {
    if (want[line] !== have[line]) errors.push(`  line ${line + 1}: expected ${want[line] ?? "(nothing)"} / found ${have[line] ?? "(nothing)"}`);
  }
  return { status: "error", errors: errors.slice(0, 12) };
}

const STEPS_IMPORT = /from\s+["'][^"']*packages\/web\/src\/views\/tour\/steps(?:\.ts)?["']/;

/** SC-24 must take its steps from steps.ts: import the module and walk `TOUR_STEPS` or name every step. */
export function checkScenario(fileName: string | undefined, source: string | undefined, steps: readonly TourStep[] = TOUR_STEPS): Verdict {
  if (fileName === undefined || source === undefined) return { status: "pending", why: `${SCENARIOS_DIR}/${SC24_PREFIX}*.ts is not in the repository yet` };
  const errors: string[] = [];
  if (!STEPS_IMPORT.test(source)) errors.push(`${fileName}: does not import packages/web/src/views/tour/steps`);
  const walksAll = /\bTOUR_STEPS\b/.test(source);
  const missing = steps.filter((step) => !source.includes(`"${step.id}"`) && !source.includes(`'${step.id}'`)).map((step) => step.id);
  if (!walksAll && missing.length > 0) errors.push(`${fileName}: neither walks TOUR_STEPS nor names the steps ${missing.join(", ")}`);
  return errors.length === 0 ? { status: "ok" } : { status: "error", errors };
}

function scenarioFile(cwd: string): { name: string; source: string } | undefined {
  const dir = join(cwd, SCENARIOS_DIR);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((entry) => entry.startsWith(SC24_PREFIX) && entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
  return name === undefined ? undefined : { name: `${SCENARIOS_DIR}/${name}`, source: readFileSync(join(dir, name), "utf8") };
}

function main(): void {
  const cwd = process.cwd();
  const write = process.argv.includes("--write");
  const strict = process.argv.includes("--strict");
  const errors = validateSteps().map((error) => `views/tour/steps.ts: ${error}`);
  const pending: string[] = [];
  const readmePath = join(cwd, README_FILE);
  const section = renderReadmeSection();
  let readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : undefined;
  if (write && readme !== undefined && readmeBlock(readme) !== undefined && readmeBlock(readme) !== section) {
    readme = withReadmeBlock(readme, section);
    writeFileSync(readmePath, readme);
    console.log(`tour:check: rewrote the test instructions of ${README_FILE}.`);
  }
  const scenario = scenarioFile(cwd);
  for (const verdict of [checkReadme(readme, section), checkScenario(scenario?.name, scenario?.source)]) {
    if (verdict.status === "error") errors.push(...verdict.errors);
    if (verdict.status === "pending") pending.push(verdict.why);
  }
  if (strict) errors.push(...pending.map((why) => `pending: ${why}`));
  if (errors.length > 0) {
    console.error(`tour:check: ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const note = pending.length > 0 ? `; pending: ${pending.join("; ")}` : "";
  console.log(`tour:check: ${TOUR_STEPS.length} step(s) consistent${note}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
