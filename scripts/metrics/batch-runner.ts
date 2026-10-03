// The runner of the scripted batch (docs/seed-spec.md §13, "Agente guionado"): every entry of the seed
// becomes one world `sim-<nnnn>` of `firm-sim` made by the world factory (`kind: BATCH`, paused at the
// entry's start) inside one in-process world of the local flows (tests/flows/support/world.ts), and runs to
// the end with the scripted agent (tests/flows/support/scripted-agent.ts): settle the queue and the mail,
// apply the entry's scheduled ETA changes through the platform mock when the clock reaches them, move to
// the next due timer, again, until nothing is pending or every dossier waits for a person. Each world
// starts 12 real minutes after the previous one (REAL_MS_PER_WORLD).
import { z } from "zod";
import { ToolError } from "@legajo/shared";
import type { CloneEntry } from "@legajo/bff/worlds/clones";
import { createWorld } from "@legajo/bff/worlds/factory";
import { MAX_MOVE_MS } from "@legajo/bff/clock/advance";
import { platformPaths } from "@legajo/platform-mock/api";
import { scriptedAgent } from "../../tests/flows/support/scripted-agent";
import { createFlowWorld, type FlowWorld } from "../../tests/flows/support/world";
import type { BatchRunner } from "./batch-local";

/** Moves of one world at most: a world that never settles is reported, not run forever. */
export const MAX_MOVES_PER_WORLD = 80;
/**
 * Real time each world takes. The firm's turn caps (`Firms/SETTINGS.turnCaps` of `firm-sim`, per real
 * hour and day) apply to the batch as they would in the stage, and the factory's phone and number leases
 * last 48 real hours while the worlds keep their addresses: 12 minutes a world keeps the 200 under both.
 */
export const REAL_MS_PER_WORLD = 12 * 60_000;

const IsoZoned = z.iso.datetime({ offset: true });

/** What the runner reads of an entry (docs/seed-spec.md §13); the rest of the line is the seed's business. */
const BatchEntry = z
  .object({
    entryId: z.string().regex(/^sim-\d{4}$/),
    startAtSim: IsoZoned,
    etaChanges: z.array(z.object({ atSim: IsoZoned, newEta: IsoZoned }).loose()).default([]),
    operation: z
      .object({
        key: z.string().regex(/^[a-z][a-z0-9]{0,7}$/),
        model: z.string().regex(/^op-\d{4}$/),
        consent: z.enum(["GRANTED", "NONE"]).default("GRANTED"),
        authorizations: z.boolean().default(false),
        supplierOverride: z.object({ delayHours: z.number().int().optional(), behaviour: z.string().optional() }).optional(),
        etaOverride: IsoZoned.optional(),
      })
      .loose(),
  })
  .loose();
type BatchEntry = z.output<typeof BatchEntry>;

/** One clone of the entry's model operation with its own parties (`own`), as the factory takes it. */
function cloneOf({ operation: { key, model, consent, authorizations, supplierOverride, etaOverride } }: BatchEntry): CloneEntry {
  const overrides = { ...(etaOverride === undefined ? {} : { etaOverride }), ...(supplierOverride === undefined ? {} : { supplierOverride }) };
  return { key, model, consent, authorizations, importer: "own", supplier: "own", altContacts: false, ...overrides };
}

/** The earliest pending timer of the world, or undefined when nothing is pending. */
async function nextDue(flow: FlowWorld, clockId: string, firmId: string): Promise<number | undefined> {
  let next: number | undefined;
  for (const operation of await flow.data.operations.listOperations(firmId, { clockId })) {
    for (const timer of await flow.data.timers.listTimers(operation.operationId, { status: "SCHEDULED" })) {
      const due = Date.parse(timer.dueAtSim);
      if (next === undefined || due < next) next = due;
    }
  }
  return next;
}

async function runToEnd(flow: FlowWorld, entry: BatchEntry, clockId: string, firmId: string): Promise<void> {
  const etaChanges = [...entry.etaChanges].sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim));
  for (let move = 0; move < MAX_MOVES_PER_WORLD; move += 1) {
    await flow.entries.settle();
    const operations = await flow.data.operations.listOperations(firmId, { clockId });
    if (operations.every((operation) => operation.dossierStatus !== "OPEN" && operation.dossierStatus !== "REOPENED")) return;
    const due = await nextDue(flow, clockId, firmId);
    const change = etaChanges[0];
    if (change !== undefined && (due === undefined || Date.parse(change.atSim) <= due)) {
      etaChanges.shift();
      await flow.advance({ to: change.atSim }, clockId);
      for (const operation of operations) {
        await flow.platform.feed(platformPaths.eta(firmId, operation.operationNumber), `batch:${clockId}:${change.atSim}`, { newEta: change.newEta, occurredAtSim: change.atSim });
      }
      continue;
    }
    if (due === undefined) return;
    // One move goes at most 14 days ahead (FL-065): a far event is reached in steps.
    const now = (await flow.simNow(clockId)).getTime();
    await flow.advance(due - now > MAX_MOVE_MS ? { to: new Date(now + MAX_MOVE_MS).toISOString() } : { next: true }, clockId);
  }
  throw new ToolError("UNAVAILABLE", `${clockId} did not finish in ${MAX_MOVES_PER_WORLD} moves`, "BATCH_WORLD_STUCK");
}

export interface LocalBatch {
  readonly runner: BatchRunner;
  readonly world: FlowWorld;
  close(): void;
}

/** One in-process world with the scripted agent, and the runner that builds and runs each entry in it. */
export async function localBatchRunner(): Promise<LocalBatch> {
  const flow = await createFlowWorld({ plans: scriptedAgent });
  return {
    world: flow,
    close: () => flow.close(),
    runner: {
      async run(raw) {
        const entry = BatchEntry.parse(raw);
        flow.advanceReal(REAL_MS_PER_WORLD);
        const created = await createWorld({ kind: "BATCH", batchId: entry.entryId.slice("sim-".length), startAtSim: entry.startAtSim, entries: [cloneOf(entry)] }, flow.worlds);
        flow.platform.sync();
        await runToEnd(flow, entry, created.clockId, created.firmId);
        return { clockId: created.clockId, firmId: created.firmId, data: flow.data };
      },
    },
  };
}
