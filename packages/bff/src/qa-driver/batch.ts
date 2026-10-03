// `batch.run` of the `QaDriver` (docs/tool-catalog.md, docs/seed-spec.md §13): the metrics batch with the
// real agent in `firm-sim`. The seed's entries (`Seed/metrics/batch-inputs.jsonl`: operation, supplier
// behaviour, ETA override; never results) each become one world `sim-<batchId>-<nnnn>` made by the world
// factory (`kind: BATCH`, paused at the entry's start), which the driver then runs to the end with the
// clock module: settle every operation, move to the next due timer, again, until nothing is pending or
// every dossier is ready for review (approving is always human). The worker writes the `LegajoMetrics`
// rows (`source BATCH`, `agentMode REAL`, turns/record.ts); the driver only reads them for the caps.
//
// One call stops before the Lambda's deadline, at the turn cap or at the cost cap (which fails closed:
// with unverified rates no new world starts after the first), and says why; the next call with the same
// batch id resumes, because the factory answers an existing world as it is and a finished entry is
// remembered in `Runtime/IDEMP#QABATCH#<world>`.
import { z } from "zod";
import { ToolError } from "@legajo/shared";
import { type ClockDeps, advanceClock } from "../clock/advance";
import type { Connector } from "../connector/index";
import { costOf, pricingRows } from "../metrics/kpis";
import type { CloneEntry } from "../worlds/clones";
import type { WorldsDeps } from "../worlds/deps";
import { createWorld } from "../worlds/factory";
import type { QaParsedInput } from "./contract-inputs";
import type { ActionContext, BatchPort, BatchProgress } from "./ports";
import { settleOperation } from "./settle";

/** Source of the marks of finished entries. */
export const BATCH_DONE_SOURCE = "QABATCH";
/** A call starts no new move after this long: a settle (up to 300 s) still ends inside the Lambda's 900 s. */
export const BATCH_CALL_BUDGET_MS = 8 * 60_000;
/** Moves of one world at most: a world that never settles is reported, not run forever. */
export const MAX_MOVES_PER_WORLD = 80;
const SETTLE_SEC = 300;

const BatchEntry = z
  .object({
    entryId: z.string().min(1).max(40),
    startAtSim: z.iso.datetime({ offset: true }),
    operation: z
      .object({
        key: z.string().regex(/^[a-z][a-z0-9]{0,7}$/),
        model: z.string().regex(/^op-\d{4}$/),
        etaOverride: z.iso.datetime({ offset: true }).optional(),
        authorizations: z.boolean().default(false),
        consent: z.enum(["GRANTED", "NONE"]).default("GRANTED"),
        supplierOverride: z.object({ behaviour: z.string().optional(), delayHours: z.number().int().optional() }).optional(),
      })
      .loose(),
  })
  .loose();
export type BatchEntry = z.output<typeof BatchEntry>;

export interface BatchDeps {
  readonly data: Connector;
  readonly worlds: () => WorldsDeps;
  readonly clock: () => ClockDeps & { readonly data: Connector };
  /** The seed's entries in order (`Seed/metrics/batch-inputs.jsonl`). */
  readonly inputs: () => Promise<readonly unknown[]>;
  readonly whatsappSimulated: () => boolean;
}

/** The lines of a JSONL file: one JSON value per non-empty line. */
export function parseJsonl(text: string): unknown[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
}

function cloneEntryOf(entry: BatchEntry): CloneEntry {
  const { operation } = entry;
  return {
    key: operation.key,
    model: operation.model,
    importer: "own",
    supplier: "own",
    authorizations: operation.authorizations,
    consent: operation.consent,
    altContacts: false,
    ...(operation.etaOverride === undefined ? {} : { etaOverride: operation.etaOverride }),
    ...(operation.supplierOverride === undefined ? {} : { supplierOverride: operation.supplierOverride }),
  };
}

export function worldBatchId(batchId: string, index: number): string {
  return `${batchId}-${String(index + 1).padStart(4, "0")}`;
}

/** Runs one world until nothing is pending or every dossier waits for a person; true when it got there. */
async function runWorld(deps: BatchDeps, clockId: string, deadline: number, ctx: ActionContext): Promise<boolean> {
  const clock = deps.clock();
  for (let move = 0; move < MAX_MOVES_PER_WORLD; move += 1) {
    if (ctx.now().getTime() >= deadline) return false;
    const operations = await deps.data.operations.listOperations("firm-sim", { clockId });
    for (const operation of operations) await settleOperation({ data: deps.data, now: ctx.now, sleep: ctx.sleep }, { operationId: operation.operationId, timeoutSec: SETTLE_SEC });
    const settled = await deps.data.operations.listOperations("firm-sim", { clockId });
    if (settled.every((operation) => operation.dossierStatus !== "OPEN" && operation.dossierStatus !== "REOPENED")) return true;
    try {
      await advanceClock({ clockId, target: { next: true }, caller: { actor: "QA", correlationId: ctx.log.correlationId } }, clock);
    } catch (error) {
      if (error instanceof ToolError && error.reason === "CLOCK_NOTHING_PENDING") return true;
      throw error;
    }
  }
  throw new ToolError("UNAVAILABLE", `${clockId} did not finish in ${MAX_MOVES_PER_WORLD} moves`, "BATCH_WORLD_STUCK");
}

/** Turns and estimated cost of the batch's worlds so far (`costUsd` absent when a rate is unverified). */
async function usageOf(deps: BatchDeps, clockIds: readonly string[]): Promise<{ readonly turns: number; readonly costUsd?: number }> {
  const rates = pricingRows(await deps.data.reference.listRateCard());
  let turns = 0;
  let costUsd: number | undefined = 0;
  for (const clockId of clockIds) {
    for (const row of await deps.data.metrics.listKpis("firm-sim", { source: "BATCH", clockId })) {
      turns += row.turns;
      const cost = costOf(row, rates, deps.whatsappSimulated());
      costUsd = cost.status === "VERIFIED" && costUsd !== undefined ? costUsd + cost.usd : undefined;
    }
  }
  return costUsd === undefined ? { turns } : { turns, costUsd: Math.round(costUsd * 10_000) / 10_000 };
}

async function runBatch(deps: BatchDeps, input: QaParsedInput<"batch.run">, ctx: ActionContext): Promise<BatchProgress> {
  const deadline = ctx.now().getTime() + BATCH_CALL_BUDGET_MS;
  const rows = await deps.inputs();
  if (rows.length < input.entries) throw new ToolError("INVALID", `the seed has ${rows.length} batch entries, fewer than ${input.entries}`);
  const clockIds: string[] = [];
  let finished = 0;
  let stopped: BatchProgress["stopped"];
  for (let index = 0; index < input.entries; index += 1) {
    const usage = await usageOf(deps, clockIds);
    if (usage.turns >= input.maxTurns) stopped = "MAX_TURNS";
    else if (usage.costUsd === undefined ? clockIds.length > 0 : usage.costUsd >= input.maxCostUsd) stopped = "MAX_COST";
    else if (ctx.now().getTime() >= deadline) stopped = "DEADLINE";
    if (stopped !== undefined) break;
    const entry = BatchEntry.parse(rows[index]);
    const world = await createWorld({ kind: "BATCH", batchId: worldBatchId(input.batchId, index), startAtSim: entry.startAtSim, entries: [cloneEntryOf(entry)] }, deps.worlds());
    clockIds.push(world.clockId);
    if ((await ctx.data.runtime.getIdempotency(BATCH_DONE_SOURCE, world.clockId)) === undefined) {
      if (!(await runWorld(deps, world.clockId, deadline, ctx))) {
        stopped = "DEADLINE";
        break;
      }
      await ctx.data.runtime.claimIdempotency({ source: BATCH_DONE_SOURCE, id: world.clockId, atReal: ctx.now().toISOString() });
    }
    finished += 1;
  }
  const usage = await usageOf(deps, clockIds);
  ctx.log.info("qa_driver.batch", { batchId: input.batchId, finished, turns: usage.turns, stopped: stopped ?? null });
  return { batchId: input.batchId, entries: input.entries, finished, ...usage, ...(stopped === undefined ? {} : { stopped }) };
}

export function batchPort(deps: BatchDeps): BatchPort {
  return { run: (input, ctx) => runBatch(deps, input, ctx) };
}
