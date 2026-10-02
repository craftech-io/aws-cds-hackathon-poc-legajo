// Lambda entry of `WorldJanitor` (docs/architecture.md §8 and §9.3, ADR-0015 §5). The event is
// validated with zod before anything runs:
//
//   MEMORY_PURGE  the asynchronous continuation of a Memory purge that "Reiniciar demo" or
//                 `world.destroy` started (invoked with `InvocationType Event` by `Bff` and `QaDriver`
//                 only, per its resource policy); the passes are worlds/memory-purge.ts
//   GUEST_SWEEP   the hourly schedule: the sign-up and lead part of janitor/guest-sweep.ts
//
// `GUEST_CREATE`, `GUEST_DESTROY`, `IDLE_GUEST_RESET` and the world part of `GUEST_SWEEP` arrive with
// the world factory (WP-31); until then those events fail the parse instead of doing half the work.
import { z } from "zod";
import { connector } from "../connector/index";
import { createLogger, newCorrelationId } from "../lib/log";
import { type SweepDeps, type SweepReport, sweepSignupsAndLeads } from "../janitor/guest-sweep";
import { defaultAccessDeps } from "../signup/deps";
import { agentCoreMemoryAdmin } from "../worlds/memory-admin";
import { MemoryPurgeEvent, type PurgeDeps, type PurgeOutcome, purgeRemainingPasses } from "../worlds/memory-purge";

export const GuestSweepEvent = z.object({ kind: z.literal("GUEST_SWEEP") }).strict();

export const WorldJanitorEvent = z.discriminatedUnion("kind", [MemoryPurgeEvent, GuestSweepEvent]);

/** `purge`: the Memory passes (their log is the handler's); `sweep`: the stores of `GUEST_SWEEP`, built on first use. */
export function createWorldJanitorHandler(purge: PurgeDeps, sweep: () => SweepDeps = defaultAccessDeps) {
  return async (raw: unknown): Promise<PurgeOutcome | SweepReport> => {
    const event = WorldJanitorEvent.parse(raw);
    if (event.kind === "GUEST_SWEEP") return sweepSignupsAndLeads(sweep(), purge.log);
    const { kind: _kind, startedAtReal, ...target } = event;
    return purgeRemainingPasses(purge, { ...target, startedAtReal: startedAtReal ?? purge.now().toISOString() });
  };
}

export const handler = async (raw: unknown): Promise<PurgeOutcome | SweepReport> => {
  const log = createLogger({ correlationId: newCorrelationId(), bindings: { service: "world-janitor" } });
  const purge: PurgeDeps = {
    memory: agentCoreMemoryAdmin(),
    data: connector(),
    log,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return createWorldJanitorHandler(purge)(raw);
};
