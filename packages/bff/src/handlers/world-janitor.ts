// Lambda entry of `WorldJanitor` (docs/architecture.md §8 and §9.3): the asynchronous continuation of
// a Memory purge that "Reiniciar demo" or `world.destroy` started (`MEMORY_PURGE`, invoked with
// `InvocationType Event` by `Bff` and `QaDriver` only, per its resource policy). The event is
// validated with zod before anything runs; the passes are worlds/memory-purge.ts.
import { connector } from "../connector/index";
import { createLogger, newCorrelationId } from "../lib/log";
import { agentCoreMemoryAdmin } from "../worlds/memory-admin";
import { MemoryPurgeEvent, type PurgeDeps, type PurgeOutcome, purgeRemainingPasses } from "../worlds/memory-purge";

export function createWorldJanitorHandler(deps: PurgeDeps) {
  return async (raw: unknown): Promise<PurgeOutcome> => {
    const { kind: _kind, ...target } = MemoryPurgeEvent.parse(raw);
    return purgeRemainingPasses(deps, target);
  };
}

export const handler = async (raw: unknown): Promise<PurgeOutcome> => {
  const log = createLogger({ correlationId: newCorrelationId(), bindings: { service: "world-janitor" } });
  const deps: PurgeDeps = {
    memory: agentCoreMemoryAdmin(),
    data: connector(),
    log,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return createWorldJanitorHandler(deps)(raw);
};
