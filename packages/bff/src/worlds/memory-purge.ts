// Purge of AgentCore Memory for the actors of a world's past epoch (docs/architecture.md §9.3): the
// second layer after new epochs give a reset world new actors and sessions. The three strategies
// extract asynchronously and at their own pace, so a record of the last turn can appear after a first
// deletion; the purge therefore runs in passes, one module for its three callers ("Reiniciar demo",
// `WorldJanitor` and `world.destroy`):
//
//   pass 1       in the call itself (`purgeFirstPass`)
//   pass 2       60 real seconds later
//   listings     every 15 s over the events of the sessions and the records of the actors, deleting
//                what they find, until two listings in a row find nothing
//   cap          10 minutes from the start: audit `MEMORY_PURGE_INCOMPLETE` and one log line the
//                `MemoryPurgeIncomplete` metric filter counts
//
// From the console and the `QaDriver` passes 2+ run in `WorldJanitor` (asynchronous invocation with
// `MEMORY_PURGE`); `seed:load` and the nightly job run every pass in the same process.
import { z } from "zod";
import { ClockId, QA_GLOBAL_CLOCK_ID, parseClockId } from "@legajo/shared";
import { firmOfClockId } from "../auth/scope";
import type { Connector } from "../connector/index";
import type { Logger } from "../lib/log";
import { QA_MIN_IMPORTER_PREFIX, guestTagOf } from "./world-ids";

/** What the purge needs from Memory; the adapter pages through every listing (memory-admin.ts). */
export interface MemoryAdmin {
  /** Every session the actor has in Memory (`ListSessions`): a session the caller did not name is purged too. */
  listSessionIds(actorId: string): Promise<string[]>;
  listEventIds(actorId: string, sessionId: string): Promise<string[]>;
  deleteEvent(actorId: string, sessionId: string, eventId: string): Promise<void>;
  /** Records in every namespace under the prefix (`/importers/<actorId>/`: preferences, facts and summaries). */
  listRecordIds(namespacePrefix: string): Promise<string[]>;
  deleteRecord(recordId: string): Promise<void>;
}

/** Namespace root of an actor's three strategies (docs/architecture.md §9.3). */
export function actorNamespace(actorId: string): string {
  return `/importers/${actorId}/`;
}

const ActorId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,254}$/, "expected an actor id");
const SessionId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/, "expected a session id");

/** The actors of the past epoch and the Harness sessions each one had. */
export const PurgeTarget = z
  .object({
    clockId: ClockId,
    /** The epoch the actors belonged to (the one the reset or destroy left behind). */
    epoch: z.number().int().min(1),
    actorIds: z.array(ActorId).max(500),
    sessions: z.array(z.object({ actorId: ActorId, sessionId: SessionId }).strict()).max(2_000),
    /** Real instant pass 1 ran: the 10-minute cap counts from here. */
    startedAtReal: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PurgeTarget = z.infer<typeof PurgeTarget>;

/**
 * Event of the asynchronous invocation of `WorldJanitor` (docs/architecture.md §9.3). Every session
 * travels with its actor, because Memory lists a session's events by actor and session; without
 * `startedAtReal` the cap counts from the moment `WorldJanitor` receives it.
 */
export const MemoryPurgeEvent = PurgeTarget.extend({ kind: z.literal("MEMORY_PURGE"), startedAtReal: PurgeTarget.shape.startedAtReal.optional() }).strict();
export type MemoryPurgeEvent = z.input<typeof MemoryPurgeEvent>;

export const PURGE_TIMING = {
  secondPassAfterMs: 60_000,
  listingEveryMs: 15_000,
  emptyListingsToStop: 2,
  capMs: 10 * 60_000,
} as const;

export const MEMORY_PURGE_INCOMPLETE_METRIC = "MemoryPurgeIncomplete";
export const MEMORY_PURGE_INCOMPLETE_LOG = "worlds.memory_purge_incomplete";

export interface PurgeDeps {
  readonly memory: MemoryAdmin;
  readonly data: Pick<Connector, "audit">;
  readonly log: Logger;
  /** Real time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Whether `actorId` is an actor of the world of `clockId` in `epoch` (docs/architecture.md §9.1,
 * turns/identity.ts): `<importerId>-e<epoch>`, and in a QA run an importer of that run and scenario.
 * `WorldJanitor` purges nothing else, whatever the event lists.
 */
export function actorBelongsTo(clockId: string, epoch: number, actorId: string): boolean {
  const suffix = `-e${epoch}`;
  if (!actorId.startsWith("imp-") || !actorId.endsWith(suffix)) return false;
  const importerId = actorId.slice(0, -suffix.length);
  const parsed = parseClockId(clockId);
  if (parsed?.scope === "QA") return importerId.startsWith(`imp-${clockId}-`);
  if (parsed?.scope === "GUEST") return importerId.endsWith(`-${guestTagOf(parsed.firmId ?? "")}`);
  if (clockId === QA_GLOBAL_CLOCK_ID) return importerId.startsWith(QA_MIN_IMPORTER_PREFIX);
  return !importerId.startsWith("imp-qa-");
}

/** Sessions of the target plus every other session Memory lists for its actors. */
async function sessionsOf(memory: MemoryAdmin, target: Pick<PurgeTarget, "actorIds" | "sessions">): Promise<Array<{ actorId: string; sessionId: string }>> {
  const seen = new Map(target.sessions.map((session) => [`${session.actorId}/${session.sessionId}`, session]));
  for (const actorId of target.actorIds) {
    for (const sessionId of await memory.listSessionIds(actorId)) seen.set(`${actorId}/${sessionId}`, { actorId, sessionId });
  }
  return [...seen.values()];
}

/** Lists and deletes everything of the target once; how many items it found. */
export async function purgePass(memory: MemoryAdmin, target: Pick<PurgeTarget, "actorIds" | "sessions">): Promise<number> {
  let found = 0;
  for (const { actorId, sessionId } of await sessionsOf(memory, target)) {
    const events = await memory.listEventIds(actorId, sessionId);
    found += events.length;
    for (const eventId of events) await memory.deleteEvent(actorId, sessionId, eventId);
  }
  for (const actorId of target.actorIds) {
    const records = await memory.listRecordIds(actorNamespace(actorId));
    found += records.length;
    for (const recordId of records) await memory.deleteRecord(recordId);
  }
  return found;
}

/** Pass 1, in the reset or destroy call itself; returns the target `WorldJanitor` continues with. */
export async function purgeFirstPass(deps: Pick<PurgeDeps, "memory" | "now">, target: Omit<PurgeTarget, "startedAtReal">): Promise<{ readonly target: PurgeTarget; readonly deleted: number }> {
  const startedAtReal = deps.now().toISOString();
  const deleted = await purgePass(deps.memory, target);
  return { target: PurgeTarget.parse({ ...target, startedAtReal }), deleted };
}

export interface PurgeOutcome {
  readonly complete: boolean;
  /** Passes run by this call (pass 2 and the listings). */
  readonly passes: number;
  readonly deleted: number;
}

async function recordIncomplete(deps: PurgeDeps, target: PurgeTarget, outcome: Omit<PurgeOutcome, "complete">): Promise<void> {
  deps.log.error(MEMORY_PURGE_INCOMPLETE_LOG, { metric: MEMORY_PURGE_INCOMPLETE_METRIC, clockId: target.clockId, epoch: target.epoch, passes: outcome.passes });
  const firmId = firmOfClockId(target.clockId);
  if (firmId === undefined) return;
  await deps.data.audit.record({
    firmId,
    clockId: target.clockId,
    decision: "ACTION",
    action: "MEMORY_PURGE_INCOMPLETE",
    actor: "SYSTEM",
    trigger: "MEMORY_PURGE",
    reason: "memory still had records of the past epoch after 10 minutes of passes",
    atReal: deps.now().toISOString(),
    detail: { epoch: target.epoch, actors: target.actorIds.length, sessions: target.sessions.length, passes: outcome.passes, deleted: outcome.deleted },
  });
}

/** Pass 2 and the listings until two in a row are empty, within the cap. */
export async function purgeRemainingPasses(deps: PurgeDeps, raw: PurgeTarget): Promise<PurgeOutcome> {
  const target = PurgeTarget.parse(raw);
  const foreign = [...target.actorIds, ...target.sessions.map((session) => session.actorId)].filter((actorId) => !actorBelongsTo(target.clockId, target.epoch, actorId));
  if (foreign.length > 0) throw new RangeError(`${foreign.length} actor(s) of the purge do not belong to ${target.clockId} in epoch ${target.epoch}`);
  const deadline = Date.parse(target.startedAtReal) + PURGE_TIMING.capMs;
  let passes = 0;
  let deleted = 0;
  let emptyInARow = 0;
  let wait: number = PURGE_TIMING.secondPassAfterMs;
  while (emptyInARow < PURGE_TIMING.emptyListingsToStop) {
    const wakeAt = deps.now().getTime() + wait;
    if (wakeAt > deadline) {
      // One last listing right away: the previous one may have deleted the last of it.
      const last = await purgePass(deps.memory, target);
      passes += 1;
      deleted += last;
      if (last === 0) break;
      await recordIncomplete(deps, target, { passes, deleted });
      return { complete: false, passes, deleted };
    }
    await deps.sleep(wait);
    const found = await purgePass(deps.memory, target);
    passes += 1;
    deleted += found;
    // Pass 2 deletes what arrived after pass 1 but does not count as a listing.
    if (passes > 1) emptyInARow = found === 0 ? emptyInARow + 1 : 0;
    wait = PURGE_TIMING.listingEveryMs;
  }
  deps.log.info("worlds.memory_purge_done", { clockId: target.clockId, epoch: target.epoch, passes, deleted });
  return { complete: true, passes, deleted };
}
