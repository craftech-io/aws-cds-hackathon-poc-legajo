// `scenario-report.json` and `scenario-report.md` (docs/test-plan.md §4.4): per step its flows,
// verdict, ids, duration and where every block came from; per scenario the policy audit of its worlds
// and the turns it used; per flow one verdict over every step that declares it. Artifacts of the CI
// run, never committed (they land under `test-results/`, which git ignores). No PII: ids, codes and
// counts only.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlockOrigin, Suite } from "./steps";

/** `BLOCKED`: the step could not run because a module it drives is not deployed (`NOT_WIRED`); never a pass. */
export type Verdict = "PASS" | "WARN" | "FAIL" | "BLOCKED" | "SKIPPED";

export interface StepResult {
  readonly step: number;
  readonly title: string;
  readonly flows: readonly string[];
  readonly verdict: Verdict;
  readonly durationMs: number;
  readonly ids: Readonly<Record<string, string>>;
  readonly blocks: ReadonlyArray<{ readonly origin: BlockOrigin; readonly detail: string }>;
  readonly warnings: readonly string[];
  readonly error?: string;
}

export interface Usage {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Estimated with the verified rates of `RateCard`; `null` while a rate is provisional. */
  readonly costUsd: number | null;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly title: string;
  readonly verdict: Verdict;
  readonly durationMs: number;
  readonly steps: readonly StepResult[];
  /** Policy audit of each world the scenario created (`policyAudit.run` before `world.destroy`). */
  readonly audits: ReadonlyArray<{ readonly clockId: string; readonly violations: number | null }>;
  readonly usage: Usage;
  readonly cleanupError?: string;
}

export interface RunReport {
  readonly runId: string;
  readonly suite: Suite;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly verdict: Verdict;
  readonly scenarios: readonly ScenarioResult[];
  readonly flows: Readonly<Record<string, Verdict>>;
  readonly budget: { readonly maxTurns: number; readonly turns: number; readonly maxCostUsd?: number; readonly costUsd: number | null; readonly aborted?: string };
}

const SEVERITY: readonly Verdict[] = ["FAIL", "BLOCKED", "SKIPPED", "WARN", "PASS"];

/** The worst of several verdicts (FAIL over BLOCKED over SKIPPED over WARN over PASS). */
export function worst(verdicts: readonly Verdict[]): Verdict {
  for (const verdict of SEVERITY) if (verdicts.includes(verdict)) return verdict;
  return "SKIPPED";
}

/** One verdict per flow over every step that declares it. */
export function flowVerdicts(scenarios: readonly ScenarioResult[]): Record<string, Verdict> {
  const byFlow = new Map<string, Verdict[]>();
  for (const scenario of scenarios) for (const step of scenario.steps) for (const flow of step.flows) byFlow.set(flow, [...(byFlow.get(flow) ?? []), step.verdict]);
  return Object.fromEntries([...byFlow.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([flow, verdicts]) => [flow, worst(verdicts)]));
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderMarkdown(report: RunReport): string {
  const lines = [
    `# Scenario run ${report.runId} · ${report.suite}`,
    "",
    `Verdict **${report.verdict}** · ${report.scenarios.length} scenario(s) · ${Math.round(report.durationMs / 1_000)} s · ${report.budget.turns}/${report.budget.maxTurns} turns · cost ${report.budget.costUsd === null ? "not verified" : `USD ${report.budget.costUsd}`}${report.budget.aborted ? ` · aborted: ${report.budget.aborted}` : ""}`,
    "",
    "| Scenario | Step | Flows | Verdict | Seconds | Blocks | Detail |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const scenario of report.scenarios) {
    for (const step of scenario.steps) {
      const blocks = step.blocks.map((block) => `${block.origin}: ${block.detail}`).join("; ");
      const detail = [step.error, ...step.warnings].filter((item) => item !== undefined).join("; ");
      lines.push(`| ${scenario.scenario} | ${step.step} ${cell(step.title)} | ${step.flows.join(", ")} | ${step.verdict} | ${Math.round(step.durationMs / 1_000)} | ${cell(blocks)} | ${cell(detail)} |`);
    }
    const audits = scenario.audits.map((audit) => `${audit.clockId}: ${audit.violations ?? "not run"}`).join(", ");
    lines.push(`| ${scenario.scenario} | policy audit | FL-060 | ${scenario.audits.every((audit) => audit.violations === 0) ? "PASS" : "FAIL"} | — | — | ${cell(audits)}${scenario.cleanupError ? ` · cleanup: ${cell(scenario.cleanupError)}` : ""} |`);
  }
  lines.push("", "| Flow | Verdict |", "|---|---|", ...Object.entries(report.flows).map(([flow, verdict]) => `| ${flow} | ${verdict} |`));
  return `${lines.join("\n")}\n`;
}

export async function writeReport(directory: string, report: RunReport): Promise<{ readonly json: string; readonly markdown: string }> {
  await mkdir(directory, { recursive: true });
  const json = join(directory, "scenario-report.json");
  const markdown = join(directory, "scenario-report.md");
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdown, renderMarkdown(report));
  return { json, markdown };
}
