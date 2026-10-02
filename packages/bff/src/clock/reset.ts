// `reset_demo_world` (docs/architecture.md §8, docs/tool-catalog.md, ADR-0007), per world:
//
//   1. the console resets a world at most once every 10 real minutes (`lastResetAtReal`, written
//      first and pinned to the clock's version, so two concurrent resets cannot both run); the `QaDriver`,
//      `WorldJanitor` and `seed:load` are exempt. The 12-a-day quota of guest worlds is the console's
//      quota middleware (`QUOTA_EXCEEDED`, FL-111), before this runs;
//   2. the epoch goes up by one from `COUNTER#EPOCH#<clockId>` (`ADD`: never back to 1, never reused)
//      and `TOMB#<clockId>#<previous epoch>` is written, so late mail to the old world is discarded;
//   3. the schedules and the `TIMER#` of the world go, then every item of the world except `CLOCK#` and
//      `COUNTER#EPOCH#` (clock/world-items.ts);
//   4. the clock is PAUSED at the start of the world with the new epoch;
//   5. the world is written again from its template with the new epoch (`rebuild.reload`, the world
//      factory of WP-31: new thread tags, actors and sessions, and the `Platform` rows rewritten, so the
//      platform's ETA goes back to the template's), and the Memory of the previous epoch's actors is
//      purged in repeated passes (`rebuild.purgeMemory`, docs/architecture.md §9.3);
//   6. `ACTION WORLD_RESET`. No other world changes.
import { ToolError, type WorldTemplateName } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import type { TableClient } from "../connector/table-client";
import type { Actor } from "../domain/common";
import type { ClockDeps } from "./advance";
import { type DeletedCounts, purgeWorldItems } from "./world-items";

/** "Reiniciar demo" from the console: at most once every 10 real minutes per world. */
export const CONSOLE_RESET_INTERVAL_MS = 10 * 60_000;

/** Seeded history goes back this far before the start of a world (its `AuditLog` months are purged too). */
const SEEDED_HISTORY_MS = 31 * 24 * 60 * 60_000;

/** A counter behind its world catches up at most this many steps. */
const MAX_EPOCH_CATCH_UP = 1_000;

/** Who resets: only the console is limited in frequency. */
export type ResetCaller = "CONSOLE" | "QA" | "JANITOR" | "SEED";

/** A reset asked for too soon from the console: nothing changed. */
export class ResetTooSoonError extends ToolError {
  constructor(readonly nextAllowedAtReal: string) {
    super("CONFLICT", "this world was reset less than 10 minutes ago", "RESET_TOO_SOON");
  }
}

/** The part of a reset that belongs to the world factory (WP-31). */
export interface WorldRebuild {
  /** Writes the world again from its template with the new epoch, `Platform` rows included; answers where it starts. */
  reload(input: { readonly clockId: string; readonly firmId: string; readonly template?: WorldTemplateName; readonly worldEpoch: number; readonly previousEpoch: number }): Promise<{ readonly startAtSim: string }>;
  /** First pass of the Memory purge of the previous epoch's actors, and the asynchronous rest (`WorldJanitor`). */
  purgeMemory(input: { readonly clockId: string; readonly firmId: string; readonly previousEpoch: number; readonly importerIds: readonly string[] }): Promise<void>;
}

export interface ResetDeps extends ClockDeps {
  readonly data: Pick<Connector, "timers" | "world" | "audit" | "operations" | "parties" | "firms">;
  readonly client: TableClient;
  /** Keyed hash of an address (`email-hash` subkey): the claims of the world's thread addresses and mailboxes. */
  readonly addressHash: (address: string) => string;
  readonly rebuild: WorldRebuild;
}

export interface WorldReset {
  readonly clockId: string;
  readonly previousEpoch: number;
  readonly worldEpoch: number;
  readonly startAtSim: string;
  readonly deleted: DeletedCounts;
}

/** When the console may reset the world again; `undefined` when it may now. */
export function nextConsoleResetAtReal(lastResetAtReal: string | undefined, realNow: Date): string | undefined {
  if (lastResetAtReal === undefined) return undefined;
  const next = Date.parse(lastResetAtReal) + CONSOLE_RESET_INTERVAL_MS;
  return next > realNow.getTime() ? new Date(next).toISOString() : undefined;
}

/**
 * `ADD 1` on `COUNTER#EPOCH#<clockId>` until it passes the epoch the world had: a world written before
 * its counter existed (or with a counter behind it) never gets an epoch back.
 */
async function nextWorldEpoch(clockId: string, previousEpoch: number, deps: ResetDeps): Promise<number> {
  let epoch = await deps.data.world.nextEpoch(clockId);
  for (let tries = 0; epoch <= previousEpoch && tries < MAX_EPOCH_CATCH_UP; tries += 1) epoch = await deps.data.world.nextEpoch(clockId);
  if (epoch <= previousEpoch) throw new ToolError("CONFLICT", `the epoch counter of ${clockId} is behind its world`, "EPOCH_BEHIND");
  return epoch;
}

async function unscheduleWorld(clockId: string, firmId: string, deps: ResetDeps): Promise<void> {
  for (const operation of await deps.data.operations.listOperations(firmId, { clockId })) {
    for (const timer of await deps.data.timers.listTimers(operation.operationId, { status: "SCHEDULED" })) {
      if (timer.scheduleName !== undefined) await deps.scheduler.delete(timer.scheduleName);
    }
  }
}

export async function resetWorld(input: { readonly clockId: string; readonly caller: ResetCaller; readonly actor: Actor; readonly correlationId?: string }, deps: ResetDeps): Promise<WorldReset> {
  const realNow = deps.realClock();
  const stored = await deps.data.world.getClock(input.clockId);
  if (input.caller === "CONSOLE") {
    const nextAllowedAtReal = nextConsoleResetAtReal(stored.lastResetAtReal, realNow);
    if (nextAllowedAtReal !== undefined) throw new ResetTooSoonError(nextAllowedAtReal);
  }
  const claimed = await deps.data.world.updateClock(input.clockId, { lastResetAtReal: realNow.toISOString() }, stored.version);
  const previousEpoch = claimed.worldEpoch;
  const worldEpoch = await nextWorldEpoch(input.clockId, previousEpoch, deps);
  await deps.data.world.putTombstone({ clockId: input.clockId, worldEpoch: previousEpoch, atReal: realNow.toISOString() });

  const importerIds = (await deps.data.parties.listImporters(claimed.firmId, { clockId: input.clockId })).map((importer) => importer.importerId);
  await unscheduleWorld(input.clockId, claimed.firmId, deps);
  const simNow = claimed.mode === "PAUSED" ? claimed.pausedSimNow : new Date(realNow.getTime() + claimed.offsetMs).toISOString();
  const deleted = await purgeWorldItems(
    { clockId: input.clockId, firmId: claimed.firmId, fromSim: new Date(Date.parse(claimed.startAtSim) - SEEDED_HISTORY_MS).toISOString(), toSim: simNow },
    { client: deps.client, data: deps.data, addressHash: deps.addressHash },
  );

  const paused = await deps.data.world.updateClock(input.clockId, { worldEpoch, mode: "PAUSED", pausedSimNow: claimed.startAtSim, offsetMs: 0, runningUntilReal: null }, claimed.version);
  const { startAtSim } = await deps.rebuild.reload({ clockId: input.clockId, firmId: claimed.firmId, ...(claimed.template === undefined ? {} : { template: claimed.template }), worldEpoch, previousEpoch });
  if (startAtSim !== paused.startAtSim) await deps.data.world.updateClock(input.clockId, { startAtSim, pausedSimNow: startAtSim }, paused.version);
  await deps.rebuild.purgeMemory({ clockId: input.clockId, firmId: claimed.firmId, previousEpoch, importerIds });

  await deps.data.audit.record({
    firmId: claimed.firmId,
    decision: "ACTION",
    action: "WORLD_RESET",
    actor: input.actor,
    clockId: input.clockId,
    atSim: startAtSim,
    atReal: realNow.toISOString(),
    detail: { previousEpoch, worldEpoch, caller: input.caller, deleted: { ...deleted } },
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });
  return { clockId: input.clockId, previousEpoch, worldEpoch, startAtSim, deleted };
}
