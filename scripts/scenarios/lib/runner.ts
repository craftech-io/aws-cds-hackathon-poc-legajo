// Runs a suite of scenarios against `poc` (docs/test-plan.md §4.4):
//
//   - up to 4 scenarios at a time; the scenarios of one lane run one after the other (SC-25 then
//     SC-24 share the judge account) and a `last` scenario (SC-20) runs alone at the end, with the
//     results of every earlier one;
//   - inside a scenario the steps run in order; after a failed step the rest are SKIPPED, never
//     retried (a step that waits for the agent already allows up to two turns);
//   - the cleanup always runs: the scenario's own, then the usage of each world, its policy audit and
//     `world.destroy`;
//   - the turn budget (`--max-turns`) is checked before each scenario: past it the rest are skipped.
import { WaitTimeout } from "./eventually";
import type { DriverClient } from "./driver-client";
import { type RunReport, type ScenarioResult, type StepResult, type Usage, type Verdict, flowVerdicts, worst } from "./report";
import { AssertionFailed, DriverRefusal, ScenarioBug, type ScenarioContext, type ScenarioDef, type StepRecord, type Suite, stepContext } from "./steps";
import { cleanupWorlds, createdWorlds } from "./world";

export interface RunOptions {
  readonly runId: string;
  readonly suite: Suite;
  readonly scenarios: readonly ScenarioDef[];
  readonly driver: DriverClient;
  readonly maxTurns: number;
  /** Estimated cost cap of the run; past it the rest of the scenarios are skipped. */
  readonly maxCostUsd?: number;
  readonly parallel?: number;
  /** Real time in ms (tests inject it). */
  readonly now?: () => number;
  readonly waitOptions?: { readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> };
  readonly log?: (line: string) => void;
}

/** Step number of the cleanup's own calls (keys `<runId>/<scenario>/999/…`). */
export const CLEANUP_STEP = 999;

function verdictOf(error: unknown): Verdict {
  if (error instanceof DriverRefusal && error.reason === "NOT_WIRED") return "BLOCKED";
  return "FAIL";
}

function describe(error: unknown): string {
  if (error instanceof AssertionFailed || error instanceof WaitTimeout || error instanceof DriverRefusal) return error.message;
  if (error instanceof ScenarioBug) return `scenario bug: ${error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

interface Budget {
  turns: number;
  costUsd: number | null;
  aborted?: string;
}

interface WorldMetrics {
  readonly usage: Omit<Usage, "costUsd"> & { readonly dossiers?: number };
  readonly summary?: { readonly kpis?: ReadonlyArray<{ readonly key: string; readonly value: number | null }> };
}

const NO_USAGE: Usage = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** Turns, tokens and the estimated cost of the scenario's worlds (cost per dossier × dossiers). */
async function usageOf(ctx: ScenarioContext): Promise<Usage> {
  let total: { turns: number; inputTokens: number; outputTokens: number; costUsd: number | null } = { ...NO_USAGE };
  for (const clockId of createdWorlds(ctx.state)) {
    const metrics = (await ctx.qa("metrics.get", { clockId })) as WorldMetrics;
    const perDossier = metrics.summary?.kpis?.find((kpi) => kpi.key === "costPerDossierUsd")?.value;
    const dossiers = metrics.usage.dossiers ?? 0;
    const cost = dossiers === 0 ? 0 : (perDossier ?? null);
    total = {
      turns: total.turns + metrics.usage.turns,
      inputTokens: total.inputTokens + metrics.usage.inputTokens,
      outputTokens: total.outputTokens + metrics.usage.outputTokens,
      costUsd: total.costUsd === null || cost === null ? null : total.costUsd + cost * dossiers,
    };
  }
  return total;
}

async function runScenario(options: RunOptions, scenario: ScenarioDef, previous: ScenarioContext["previous"]): Promise<ScenarioResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const state: Record<string, unknown> = {};
  const base = { runId: options.runId, scenario, driver: options.driver, state, previous, ...(options.waitOptions ? { waitOptions: options.waitOptions } : {}) };
  const steps: StepResult[] = [];
  let failed = false;
  for (const step of scenario.steps) {
    const record: StepRecord = { ids: {}, blocks: [], warnings: [] };
    const stepStarted = now();
    let verdict: Verdict = "PASS";
    let error: string | undefined;
    if (failed) verdict = "SKIPPED";
    else {
      try {
        await step.run(stepContext(base, step.n, record));
        if (record.warnings.length > 0) verdict = "WARN";
      } catch (caught) {
        verdict = verdictOf(caught);
        error = describe(caught);
        failed = true;
      }
    }
    steps.push({ step: step.n, title: step.title, flows: step.flows, verdict, durationMs: now() - stepStarted, ids: record.ids, blocks: record.blocks, warnings: record.warnings, ...(error === undefined ? {} : { error }) });
    options.log?.(`${scenario.id}/${step.n} ${verdict}${error ? ` · ${error}` : ""}`);
  }

  const cleanupRecord: StepRecord = { ids: {}, blocks: [], warnings: [] };
  const cleanupCtx = stepContext(base, CLEANUP_STEP, cleanupRecord);
  const errors: string[] = [];
  let usage: Usage = NO_USAGE;
  try {
    await scenario.cleanup?.(cleanupCtx);
  } catch (caught) {
    errors.push(describe(caught));
  }
  try {
    usage = await usageOf(cleanupCtx);
  } catch (caught) {
    errors.push(`usage: ${describe(caught)}`);
  }
  const cleanup = await cleanupWorlds(cleanupCtx);
  errors.push(...cleanup.errors);
  const auditVerdict: Verdict = cleanup.audits.every((audit) => audit.violations === 0) ? "PASS" : "FAIL";
  const verdict = worst([...steps.map((step) => step.verdict), auditVerdict, ...(errors.length > 0 ? (["WARN"] as const) : [])]);
  return { scenario: scenario.id, title: scenario.title, verdict, durationMs: now() - started, steps, audits: cleanup.audits, usage, ...(errors.length > 0 ? { cleanupError: errors.join("; ") } : {}) };
}

function skipped(scenario: ScenarioDef, reason: string): ScenarioResult {
  return {
    scenario: scenario.id,
    title: scenario.title,
    verdict: "SKIPPED",
    durationMs: 0,
    steps: scenario.steps.map((step) => ({ step: step.n, title: step.title, flows: step.flows, verdict: "SKIPPED" as const, durationMs: 0, ids: {}, blocks: [], warnings: [], error: reason })),
    audits: [],
    usage: NO_USAGE,
  };
}

/** Lanes of the parallel part: one per scenario, except the scenarios that share a lane. */
export function lanesOf(scenarios: readonly ScenarioDef[]): { readonly lanes: ScenarioDef[][]; readonly last: ScenarioDef[] } {
  const lanes = new Map<string, ScenarioDef[]>();
  const last: ScenarioDef[] = [];
  for (const scenario of scenarios) {
    if (scenario.last) {
      last.push(scenario);
      continue;
    }
    const lane = scenario.lane ?? scenario.id;
    lanes.set(lane, [...(lanes.get(lane) ?? []), scenario]);
  }
  return { lanes: [...lanes.values()], last };
}

export async function runSuite(options: RunOptions): Promise<RunReport> {
  const now = options.now ?? Date.now;
  const started = now();
  const budget: Budget = { turns: 0, costUsd: 0 };
  const results = new Map<string, ScenarioResult>();
  const previous = () =>
    [...results.values()].map((result) => ({
      scenario: result.scenario,
      violations: result.audits.reduce((sum, audit) => sum + (audit.violations ?? 0), 0),
      unaudited: result.audits.filter((audit) => audit.violations === null).length,
    }));

  async function runOne(scenario: ScenarioDef): Promise<void> {
    const overCost = options.maxCostUsd !== undefined && budget.costUsd !== null && budget.costUsd >= options.maxCostUsd;
    if (budget.turns >= options.maxTurns || overCost) {
      budget.aborted ??= overCost ? `cost budget of USD ${options.maxCostUsd} reached` : `turn budget of ${options.maxTurns} reached`;
      results.set(scenario.id, skipped(scenario, budget.aborted));
      return;
    }
    const result = await runScenario(options, scenario, previous());
    budget.turns += result.usage.turns;
    budget.costUsd = budget.costUsd === null || result.usage.costUsd === null ? null : budget.costUsd + result.usage.costUsd;
    results.set(scenario.id, result);
  }

  const { lanes, last } = lanesOf(options.scenarios);
  const queue = [...lanes];
  const workers = Array.from({ length: Math.max(1, Math.min(options.parallel ?? 4, queue.length)) }, async () => {
    for (let lane = queue.shift(); lane !== undefined; lane = queue.shift()) for (const scenario of lane) await runOne(scenario);
  });
  await Promise.all(workers);
  for (const scenario of last) await runOne(scenario);

  const scenarios = options.scenarios.map((scenario) => results.get(scenario.id)).filter((result) => result !== undefined);
  return {
    runId: options.runId,
    suite: options.suite,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    durationMs: now() - started,
    verdict: worst(scenarios.map((result) => result.verdict)),
    scenarios,
    flows: flowVerdicts(scenarios),
    budget: {
      maxTurns: options.maxTurns,
      turns: budget.turns,
      ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
      costUsd: budget.costUsd === null ? null : Math.round(budget.costUsd * 10_000) / 10_000,
      ...(budget.aborted ? { aborted: budget.aborted } : {}),
    },
  };
}
