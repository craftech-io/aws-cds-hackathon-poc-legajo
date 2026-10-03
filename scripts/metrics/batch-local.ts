// The metrics batch with the scripted agent (docs/seed-spec.md §13, docs/design-brief.md §8): the 200
// input entries of the seed (`scripts/seed/data/metrics/batch-inputs.jsonl`: operations, supplier
// behaviour, ETA changes and seeded errors, never results) run one by one through the in-process world
// of the local flows, with the real policy, matrix, milestones and outbound verification and the
// scripted Harness. What the run produced becomes one `LegajoMetrics` row per operation in `firm-sim`,
// `source BATCH`, `agentMode SCRIPTED`, with the run id and the world's `sim-*` clock, which the console
// shows under "Lote · agente guionado" (packages/bff/src/metrics/kpis.ts, no %-correct-responsible for
// it). Violations are `policy_audit` over each world, never a counter the run writes itself.
//
//   tsx scripts/metrics/batch-local.ts [--inputs <file>] [--run-id <id>] [--limit <n>]
//   sst shell --stage poc -- tsx scripts/metrics/batch-local.ts --target stage   (writes the stage's rows)
//
// The entries are the seed's: batch-runner.ts hands each one to the world factory as one clone of its
// model operation and runs it; this script only writes what the runs produced. A re-run with the same run id resumes (rows already written
// are skipped); a row of another run for the same world and operation is refused, because counters
// only ever add up.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connector, createMemoryStores, type Connector, type KpiRef, type MetricsPort } from "@legajo/bff/connector/index";
import { KPI_COUNTERS, type DossierKpi, type KpiCounter } from "@legajo/bff/domain/metrics";
import { ulid } from "@legajo/bff/lib/crypto";
import { createLogger, type Logger } from "@legajo/bff/lib/log";
import { runPolicyAudit } from "@legajo/bff/policy-audit/audit";
import { BATCH_FIRM_ID } from "@legajo/bff/routers/metrics";
import { localBatchRunner } from "./batch-runner";

export const BATCH_INPUTS_FILE = "scripts/seed/data/metrics/batch-inputs.jsonl";
/** Entries of the seed's batch (docs/seed-spec.md §13). */
export const BATCH_SIZE = 200;

/** A world of the batch after its entry ran to the end: its connector, firm and `sim-*` clock. */
export interface BatchWorld {
  readonly clockId: string;
  readonly firmId: string;
  readonly data: Connector;
}

/** Builds the world of one entry (world factory) and runs it to the end with the scripted agent (batch-runner.ts). */
export interface BatchRunner {
  run(entry: unknown, index: number): Promise<BatchWorld>;
}

/** One JSON object per non-empty line; a line that does not parse is reported with its number. */
export function readBatchInputs(text: string): unknown[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line !== "")
    .map(({ line, number }) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${BATCH_INPUTS_FILE}:${number} is not a JSON object`);
      }
    });
}

export interface BatchSummary {
  readonly runId: string;
  readonly worlds: number;
  readonly rows: number;
  readonly skipped: number;
  readonly turns: number;
  readonly violations: number;
}

export interface ScriptedBatchOptions {
  readonly entries: readonly unknown[];
  readonly runner: BatchRunner;
  /** Where the rows go: the stage's `LegajoMetrics`, or memory for a dry run. */
  readonly target: MetricsPort;
  readonly runId: string;
  readonly now: () => Date;
  readonly log: Logger;
}

const COUNTERS: readonly Exclude<KpiCounter, "violations">[] = KPI_COUNTERS.filter((name): name is Exclude<KpiCounter, "violations"> => name !== "violations");

function countersOf(row: DossierKpi | undefined, violations: number): Partial<Record<KpiCounter | "humanMinutes", number>> {
  const deltas: Partial<Record<KpiCounter | "humanMinutes", number>> = { violations };
  for (const name of COUNTERS) deltas[name] = row?.[name] ?? 0;
  deltas.humanMinutes = row?.humanMinutes ?? 0;
  return deltas;
}

/** Runs every entry and writes one `BATCH`/`SCRIPTED` row per operation of each world. */
export async function runScriptedBatch(options: ScriptedBatchOptions): Promise<BatchSummary> {
  let rows = 0;
  let skipped = 0;
  let turns = 0;
  let violations = 0;
  for (const [index, entry] of options.entries.entries()) {
    const world = await options.runner.run(entry, index);
    const audit = await runPolicyAudit({ data: world.data, log: options.log, now: options.now, correlationId: options.runId }, { firmId: world.firmId, clockId: world.clockId });
    const produced = await world.data.metrics.listKpis(world.firmId, { clockId: world.clockId });
    for (const operation of await world.data.operations.listOperations(world.firmId, { clockId: world.clockId })) {
      const ref: KpiRef = { firmId: BATCH_FIRM_ID, source: "BATCH", clockId: world.clockId, operationId: operation.operationId };
      const existing = await options.target.getKpi(ref);
      if (existing !== undefined && (existing.runId !== options.runId || existing.agentMode !== "SCRIPTED")) throw new Error(`${world.clockId}/${operation.operationId} already has a batch row of another run (${existing.runId ?? "no run id"}, ${existing.agentMode})`);
      const row = produced.find((kpi) => kpi.operationId === operation.operationId);
      const status = { dossierStatus: operation.dossierStatus, openedAtSim: operation.openedAtSim, ...(row?.completedAtSim === undefined ? {} : { completedAtSim: row.completedAtSim }) };
      if (existing !== undefined) {
        // A run cut between the two writes left the counters without the status: complete it, never count twice.
        if (existing.dossierStatus === undefined) await options.target.updateKpi(ref, status);
        skipped += 1;
        continue;
      }
      const found = audit.violations.filter((violation) => violation.operationId === operation.operationId).length;
      await options.target.incrementKpi(ref, countersOf(row, found), { agentMode: "SCRIPTED", runId: options.runId });
      await options.target.updateKpi(ref, status);
      rows += 1;
      turns += row?.turns ?? 0;
      violations += found;
    }
  }
  return { runId: options.runId, worlds: options.entries.length, rows, skipped, turns, violations };
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const file = resolve(process.cwd(), argument("--inputs") ?? BATCH_INPUTS_FILE);
  if (!existsSync(file)) throw new Error(`${file} does not exist: generate the seed first (npm run seed:generate)`);
  const all = readBatchInputs(readFileSync(file, "utf8"));
  const limitArgument = argument("--limit");
  const limit = limitArgument === undefined ? undefined : Number(limitArgument);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit takes a whole number of entries, 1 or more");
  if (limit === undefined && all.length !== BATCH_SIZE) throw new Error(`${file} has ${all.length} entries, the seed declares ${BATCH_SIZE}`);
  const now = () => new Date();
  const local = await localBatchRunner();
  const summary = await runScriptedBatch({
    entries: limit === undefined ? all : all.slice(0, limit),
    runner: local.runner,
    // `stage` needs the linked tables of `sst shell`; memory is a dry run that prints the summary.
    target: argument("--target") === "stage" ? connector().metrics : createMemoryStores({ now }).connector.metrics,
    runId: argument("--run-id") ?? `local-${ulid(now().getTime())}`,
    now,
    log: createLogger({ bindings: { component: "metrics-batch-local" } }),
  }).finally(() => local.close());
  console.log(`metrics:batch-local: ${summary.worlds} world(s), ${summary.rows} row(s) written, ${summary.skipped} already there, ${summary.turns} turn(s), ${summary.violations} violation(s) (run ${summary.runId}).`);
  if (summary.violations > 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`metrics:batch-local: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
