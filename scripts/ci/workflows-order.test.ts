// ADR-0014 §6 and docs/build-plan.md WP-47: where the neutral-surfaces guard runs in the workflows.
// In ci.yml and deploy.yml the source pass runs right after the forbidden terms of the tree, the build
// pass right after the web build, and both before `sst deploy`; names are neutral and the synthetic
// account's password comes only from the GUEST_TEST_PASSWORD secret.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findNeutralHits } from "../lint/neutral-words";

const WORKFLOWS_DIR = resolve(import.meta.dirname, "../../.github/workflows");

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface Job {
  readonly name?: string;
  readonly environment?: unknown;
  readonly steps: readonly Step[];
}

interface Workflow {
  readonly name: string;
  readonly jobs: Readonly<Record<string, Job>>;
}

function load(file: string): Workflow {
  return parse(readFileSync(resolve(WORKFLOWS_DIR, file), "utf8")) as Workflow;
}

const RUN_IF = /^run_if\s+\S+\s+(\S+)$/;

/** The npm and npx commands of a script, in order; `run_if <file> <script>` counts as `npm run <script>`. */
function commandsOf(run: string): string[] {
  return run
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const guarded = RUN_IF.exec(line);
      if (guarded) return [`npm run ${guarded[1] ?? ""}`];
      return /^(?:npm|npx)\s/.test(line) ? [line] : [];
    });
}

const steps = (workflow: Workflow): Step[] => Object.values(workflow.jobs).flatMap((job) => [...job.steps]);
const commands = (workflow: Workflow): string[] => steps(workflow).flatMap((step) => commandsOf(step.run ?? ""));

const FORBIDDEN = "npm run lint:forbidden";
const GUARD = "npm run lint:neutral-surfaces";
const DIST_GUARD = "npm run lint:neutral-surfaces -- --dist";
const BUILD = "npm run build -w packages/web";
const DEPLOY = "npx sst deploy --stage poc";
const SECRET_ENV = "GUEST_TEST_PASSWORD";

function onlyIndex(list: readonly string[], command: string): number {
  expect(list.filter((entry) => entry === command), command).toHaveLength(1);
  return list.indexOf(command);
}

describe.each(["ci.yml", "deploy.yml"])("[FL-125] %s", (file) => {
  const workflow = load(file);
  const sequence = commands(workflow);

  it("runs the source guard immediately after the forbidden terms of the tree", () => {
    expect(onlyIndex(sequence, GUARD)).toBe(onlyIndex(sequence, FORBIDDEN) + 1);
  });

  it("runs the build guard immediately after the web build, and the landing checks after it", () => {
    const build = onlyIndex(sequence, BUILD);
    expect(onlyIndex(sequence, DIST_GUARD)).toBe(build + 1);
    expect(onlyIndex(sequence, "npm run lint:forbidden -- --dist")).toBeGreaterThan(build);
    expect(onlyIndex(sequence, "npm run landing:check")).toBeGreaterThan(build);
    expect(onlyIndex(sequence, "npm run landing:budget")).toBeGreaterThan(build);
  });

  it("gives the guard no secret and keeps the forbidden-terms list on its own steps", () => {
    for (const step of steps(workflow)) {
      const runs = commandsOf(step.run ?? "");
      const env = Object.values(step.env ?? {}).join(" ");
      if (runs.includes(GUARD) || runs.includes(DIST_GUARD)) expect(env, step.name).not.toMatch(/secrets\./);
      if (runs.some((command) => command.startsWith(FORBIDDEN))) expect(step.env?.FORBIDDEN_TERMS, step.name).toBe("${{ secrets.FORBIDDEN_TERMS }}");
    }
  });

  it("names the workflow, its jobs, its steps and its secrets without a listed word", () => {
    const names = [workflow.name, ...Object.values(workflow.jobs).map((job) => job.name ?? ""), ...steps(workflow).map((step) => step.name ?? "")];
    const secrets = [...readFileSync(resolve(WORKFLOWS_DIR, file), "utf8").matchAll(/secrets\.(\w+)/g)].map((match) => match[1] ?? "");
    expect(findNeutralHits([...names, ...secrets].join("\n"))).toEqual([]);
  });
});

describe("[FL-125] deploy and checks", () => {
  it("runs both guard passes before sst deploy in deploy.yml", () => {
    const sequence = commands(load("deploy.yml"));
    const deploy = onlyIndex(sequence, DEPLOY);
    expect(onlyIndex(sequence, GUARD)).toBeLessThan(deploy);
    expect(onlyIndex(sequence, DIST_GUARD)).toBeLessThan(deploy);
  });

  it("never deploys from ci.yml and names the tour step neutrally", () => {
    const ci = load("ci.yml");
    expect(commands(ci).some((command) => command.includes("sst deploy"))).toBe(false);
    expect(steps(ci).map((step) => step.name)).toContain("Guided tour matches the README (tour:check)");
  });
});

describe.each(["deploy.yml", "scenarios.yml"])("[FL-125] %s and the synthetic account", (file) => {
  const workflow = load(file);

  it(`reads ${SECRET_ENV} only from its secret, never prints it and declares no environment`, () => {
    const withSecret = steps(workflow).filter((step) => step.env?.[SECRET_ENV] !== undefined);
    expect(withSecret.length).toBeGreaterThan(0);
    for (const step of withSecret) expect(step.env?.[SECRET_ENV], step.name).toBe(`\${{ secrets.${SECRET_ENV} }}`);
    for (const step of steps(workflow)) expect(step.run ?? "", step.name).not.toContain(SECRET_ENV);
    for (const job of Object.values(workflow.jobs)) expect(job.environment).toBeUndefined();
  });
});
