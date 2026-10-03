// `world.create` and `world.destroy` of the `QaDriver` over the world factory (packages/bff/src/worlds,
// docs/test-plan.md §4.1): a QA run's world is `createWorld({ kind: "QA" })` (idempotent by run and
// scenario, phone and number leases, `ADDR#` claims, `world = qa` on every item) and its destruction is
// `destroyWorld` with the conditional deletes of `world = qa`, the schedules, the objects under
// `qa/<runId>/`, Memory pass 1 (passes 2+ go to `WorldJanitor MEMORY_PURGE`) and the tombstone. The
// guard (guard.ts) already fenced the clock to `qa-*` or `GUEST#firm-guest-test`.
import { createWorld } from "../worlds/factory";
import type { WorldsDeps } from "../worlds/deps";
import { destroyWorld } from "../worlds/destroy";
import type { WorldCreated, WorldFactoryPort } from "./ports";

export function worldFactoryPort(deps: () => WorldsDeps): WorldFactoryPort {
  return {
    async create(input) {
      const world = await createWorld(
        {
          kind: "QA",
          runId: input.runId,
          scenario: input.scenario,
          startAtSim: input.startAtSim,
          entries: input.operations,
          ...(input.settings.rateLimitPerHour === undefined ? {} : { rateLimitPerHour: input.settings.rateLimitPerHour }),
        },
        deps(),
      );
      const created: WorldCreated = {
        clockId: world.clockId,
        firmId: world.firmId,
        worldEpoch: world.worldEpoch,
        created: world.created,
        firmMailbox: world.firmMailbox,
        operations: world.operations.map(({ key, operationId, operationNumber, importerId, supplierId, threadAddress, contacts }) => ({
          key,
          operationId,
          operationNumber,
          importerId,
          supplierId,
          threadAddress,
          contacts,
        })),
      };
      return created;
    },
    async destroy(clockId) {
      const destroyed = await destroyWorld({ clockId, reason: "QA_DESTROY" }, deps());
      return { destroyed: destroyed.destroyed, ...(destroyed.worldEpoch === undefined ? {} : { worldEpoch: destroyed.worldEpoch }) };
    },
  };
}
