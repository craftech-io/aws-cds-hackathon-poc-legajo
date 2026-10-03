// Scenario runner against the deployed stage `poc` (docs/test-plan.md §4-§5, ADR-0005). It talks to the
// stage only through the `QaDriver` Lambda with the credentials of the environment: the `qa-runner`
// role through OIDC in CI (deploy.yml runs the smoke, scenarios.yml the full suite), or the operator's
// `craftech-demos` profile from a laptop. Never human console credentials.
//
//   npm run scenarios -- --suite smoke|full [--scenario SC-xx]… [--run-id <id>] [--max-turns <n>]
//                        [--max-cost-usd <n>] [--parallel <n>] [--report-dir <dir>] [--allow-dkim-pending]
//
// Writes `scenario-report.json` and `scenario-report.md` (under test-results/, never committed) and
// exits 1 unless every scenario passed (a WARN passes; BLOCKED, SKIPPED and FAIL do not).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "@legajo/bff/lib/crypto";
import { RunId } from "@legajo/bff/qa-driver/contract";
import { parseFlags } from "../channels/cli-args";
import { createDriverClient } from "./lib/driver-client";
import { writeReport } from "./lib/report";
import { runSuite } from "./lib/runner";
import type { Suite } from "./lib/steps";
import { namedScenarios, scenariosOf } from "./lib/suites";
import { SMOKE_OPTIONS } from "./sc-00-smoke";

export interface RunArgs {
  readonly suite: Suite;
  readonly scenarios: readonly string[];
  readonly runId: string;
  readonly maxTurns: number;
  readonly maxCostUsd?: number;
  readonly parallel: number;
  readonly reportDir: string;
  readonly allowDkimPending: boolean;
}

/** Turn budget per run when none is given (docs/test-plan.md §4.4). */
export const DEFAULT_MAX_TURNS: Readonly<Record<Suite, number>> = { smoke: 40, full: 400 };

/** `<github run id>-<attempt>` in CI, `local-<ulid>` elsewhere. */
export function defaultRunId(env: Readonly<Record<string, string | undefined>>, now: number): string {
  const run = env.GITHUB_RUN_ID;
  if (run !== undefined && /^\d+$/.test(run)) return `${run}-${env.GITHUB_RUN_ATTEMPT ?? "1"}`;
  return `local-${ulid(now).toLowerCase()}`;
}

function positive(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new RangeError(`${name} needs a positive integer`);
  return parsed;
}

export function parseRunArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, now: number): RunArgs {
  let suite: Suite | undefined;
  const scenarios: string[] = [];
  let runId = defaultRunId(env, now);
  let maxTurns: number | undefined;
  let maxCostUsd: number | undefined;
  let parallel = 4;
  let reportDir = "test-results/scenarios";
  let allowDkimPending = false;
  parseFlags(argv, {
    "--suite": (value) => {
      const name = value();
      if (name !== "smoke" && name !== "full") throw new RangeError("--suite is smoke or full");
      suite = name;
    },
    "--scenario": (value) => void scenarios.push(value()),
    "--run-id": (value) => {
      runId = RunId.parse(value());
    },
    "--max-turns": (value) => {
      maxTurns = positive("--max-turns", value());
    },
    "--max-cost-usd": (value) => {
      const usd = Number(value());
      if (!Number.isFinite(usd) || usd <= 0) throw new RangeError("--max-cost-usd needs a positive amount");
      maxCostUsd = usd;
    },
    "--parallel": (value) => {
      parallel = Math.min(4, positive("--parallel", value()));
    },
    "--report-dir": (value) => {
      reportDir = value();
    },
    "--allow-dkim-pending": () => {
      allowDkimPending = true;
    },
  });
  const chosen: Suite = suite ?? (scenarios.length > 0 ? "full" : "smoke");
  return { suite: chosen, scenarios, runId, maxTurns: maxTurns ?? DEFAULT_MAX_TURNS[chosen], ...(maxCostUsd === undefined ? {} : { maxCostUsd }), parallel, reportDir, allowDkimPending };
}

async function main(): Promise<void> {
  const args = parseRunArgs(process.argv.slice(2), process.env, Date.now());
  SMOKE_OPTIONS.allowDkimPending = args.allowDkimPending;
  const scenarios = args.scenarios.length > 0 ? namedScenarios(args.scenarios) : scenariosOf(args.suite);
  console.log(`scenarios: run ${args.runId} · ${args.suite} · ${scenarios.map((scenario) => scenario.id).join(", ")} · max ${args.maxTurns} turns`);
  const report = await runSuite({ runId: args.runId, suite: args.suite, scenarios, driver: createDriverClient(), maxTurns: args.maxTurns, ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }), parallel: args.parallel, log: (line) => console.log(`  ${line}`) });
  const written = await writeReport(args.reportDir, report);
  console.log(`scenarios: ${report.verdict} in ${Math.round(report.durationMs / 1_000)} s · ${report.budget.turns} turn(s) · ${written.markdown}`);
  if (report.verdict !== "PASS" && report.verdict !== "WARN") process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    // Only the message: an SDK error may carry request details, never printed whole.
    console.error(`scenarios: ${error instanceof Error ? `${error.name}: ${error.message}` : "failed"}`);
    process.exit(2);
  }
}
