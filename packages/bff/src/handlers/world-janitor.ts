// Lambda entry of `WorldJanitor` (docs/architecture.md §8 and §9.3, ADR-0015 §5). The event is
// validated with zod before anything runs:
//
//   MEMORY_PURGE      passes 2+ of a Memory purge that "Reiniciar demo" or `world.destroy` started in
//                     `Bff` or `QaDriver` (worlds/memory-purge.ts); only actors of that world and epoch
//   GUEST_CREATE      from `account.ensureWorld`: the guest's world, its broker row, the lease READY
//   GUEST_SWEEP       every hour: the sign-up and lead part, then the world part (stale creations,
//                     public worlds past their TTL) of janitor/guest-sweep.ts
//   GUEST_DESTROY     on request (`leads:delete`, the operator): the world of a guest firm
//   IDLE_GUEST_RESET  04:00 ART: reserved worlds idle for 24 real hours are reset
//
// Every Memory purge this function starts (a destroy, a reset) runs its passes 2+ here, in process: the
// targets are collected while the event is handled and purged together at the end, so many worlds in
// one sweep cost one purge's time (≤ 10 minutes of the 12-minute timeout). The lead retention of the
// sweep destroys a leased world in process too: `WorldJanitor` never invokes itself.
import { z } from "zod";
import { FirmId } from "@legajo/shared";
import { connector } from "../connector/index";
import { createLogger, newCorrelationId } from "../lib/log";
import { GuestDestroyEvent, IdleGuestResetEvent, guestDestroy, idleGuestReset } from "../janitor/guest-destroy";
import { type SweepDeps, sweepGuestWorlds, sweepSignupsAndLeads } from "../janitor/guest-sweep";
import { defaultAccessDeps } from "../signup/deps";
import type { AsyncInvoker } from "../signup/invoke";
import { type WorldsDeps, stageWorldsDeps } from "../worlds/deps";
import { createGuestWorld, destroyGuestWorld } from "../worlds/guest-worlds";
import { agentCoreMemoryAdmin } from "../worlds/memory-admin";
import { MemoryPurgeEvent, type PurgeDeps, type PurgeTarget, purgeRemainingPasses } from "../worlds/memory-purge";

export const GuestSweepEvent = z.object({ kind: z.literal("GUEST_SWEEP") }).strict();

export const GuestCreateEvent = z
  .object({
    kind: z.literal("GUEST_CREATE"),
    sub: z.string().min(1).max(128),
    leaseId: z.string().min(1).max(64),
    firmId: FirmId.refine((firmId) => firmId.startsWith("firm-guest-"), "expected a guest firm"),
    nn: z.number().int().min(1).max(99).optional(),
  })
  .strict();

export const WorldJanitorEvent = z.discriminatedUnion("kind", [MemoryPurgeEvent, GuestSweepEvent, GuestCreateEvent, GuestDestroyEvent, IdleGuestResetEvent]);
export type WorldJanitorEvent = z.infer<typeof WorldJanitorEvent>;

export interface WorldJanitorDeps {
  readonly purge: PurgeDeps;
  /** The factory's dependencies; `continuePurge` is the handler's own (in process). */
  readonly worlds: (continuePurge: WorldsDeps["continuePurge"]) => WorldsDeps;
  /** The stores of the sign-up part of `GUEST_SWEEP`, built on first use. */
  readonly sweep: () => SweepDeps;
}

/** The sweep's invoker with `WorldJanitor` itself handled in process (the lead retention's `GUEST_DESTROY`). */
function selfInProcess(invoker: AsyncInvoker, worlds: WorldsDeps): AsyncInvoker {
  return {
    async invoke(target, payload) {
      if (target !== "WorldJanitor") return invoker.invoke(target, payload);
      const event = GuestDestroyEvent.parse(payload);
      await destroyGuestWorld({ firmId: event.firmId, reason: event.reason, ...(event.sub === undefined ? {} : { sub: event.sub }) }, worlds);
    },
  };
}

export function createWorldJanitorHandler(deps: WorldJanitorDeps) {
  return async (raw: unknown): Promise<unknown> => {
    const event = WorldJanitorEvent.parse(raw);
    if (event.kind === "MEMORY_PURGE") {
      const { kind: _kind, startedAtReal, ...target } = event;
      return purgeRemainingPasses(deps.purge, { ...target, startedAtReal: startedAtReal ?? deps.purge.now().toISOString() });
    }
    const pending: PurgeTarget[] = [];
    const worlds = deps.worlds(async (target) => void pending.push(target));
    const result = await handleWorldEvent(event, worlds, deps);
    const purged = await Promise.all(pending.map((target) => purgeRemainingPasses(deps.purge, target)));
    return { ...result, purges: purged.length, purgesIncomplete: purged.filter((outcome) => !outcome.complete).length };
  };
}

async function handleWorldEvent(event: Exclude<WorldJanitorEvent, { kind: "MEMORY_PURGE" }>, worlds: WorldsDeps, deps: WorldJanitorDeps): Promise<Record<string, unknown>> {
  switch (event.kind) {
    case "GUEST_CREATE":
      return { outcome: await createGuestWorld({ sub: event.sub, leaseId: event.leaseId, firmId: event.firmId, ...(event.nn === undefined ? {} : { nn: event.nn }) }, worlds) };
    case "GUEST_DESTROY":
      return guestDestroy(event, worlds);
    case "IDLE_GUEST_RESET":
      return { ...(await idleGuestReset(worlds)) };
    case "GUEST_SWEEP": {
      const access = deps.sweep();
      const signups = await sweepSignupsAndLeads({ ...access, invoker: selfInProcess(access.invoker, worlds) }, worlds.log);
      return { ...signups, ...(await sweepGuestWorlds(worlds)) };
    }
  }
}

export const handler = async (raw: unknown): Promise<unknown> => {
  const log = createLogger({ correlationId: newCorrelationId(), bindings: { service: "world-janitor" } });
  const purge: PurgeDeps = {
    memory: agentCoreMemoryAdmin(),
    data: connector(),
    log,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return createWorldJanitorHandler({ purge, worlds: (continuePurge) => stageWorldsDeps({ log, continuePurge }), sweep: defaultAccessDeps })(raw);
};
