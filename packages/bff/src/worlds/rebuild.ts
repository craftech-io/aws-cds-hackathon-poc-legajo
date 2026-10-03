// The world factory's side of "Reiniciar demo" (`reset_demo_world`, clock/reset.ts and
// docs/architecture.md §8): `reload` writes the world again from its template at the new epoch (new
// thread tags, actors and sessions; `Platform` rows rewritten, so the platform's ETA is the template's
// again) and, in a reserved guest world, deletes the S3 prefix of the epoch it left behind; `purgeMemory`
// runs pass 1 of the Memory purge of the previous epoch's actors and hands the rest on
// (`continuePurge`: in process in `WorldJanitor` and `seed:load`, `MEMORY_PURGE` elsewhere).
// `resetDepsOf` builds what `resetWorld` needs from the factory's dependencies, so the console, the
// `QaDriver`, `WorldJanitor` and `seed:load` reset a world the same way.
import { ToolError, parseClockId } from "@legajo/shared";
import { guestWorldPrefix } from "@legajo/shared/document-keys";
import type { ResetDeps, WorldRebuild } from "../clock/reset";
import type { TimerDispatcher } from "../timers/timers";
import type { WorldsDeps } from "./deps";
import { purgeTargetOf } from "./destroy";
import { rebuildRequest, reloadWorld } from "./factory";
import { isPublicGuestFirm } from "./guest-slots";
import { addressHashOf } from "./instantiate";
import { purgeFirstPass } from "./memory-purge";

/** `importerPhones`: the operator's overrides (`SeedOverrides`) a demo world is rebuilt with. */
export interface RebuildOptions {
  readonly importerPhones?: Readonly<Record<string, string>>;
}

export function worldRebuild(deps: WorldsDeps, options: RebuildOptions = {}): WorldRebuild {
  return {
    async reload(input) {
      if (parseClockId(input.clockId)?.scope === "GUEST" && input.previousEpoch >= 1) {
        const prefix = guestWorldPrefix({ guestKind: isPublicGuestFirm(input.firmId) ? "PUBLIC" : "RESERVED", firmId: input.firmId, epoch: input.previousEpoch });
        for (const bucket of ["Documents", "Media"] as const) await deps.objects.deletePrefix(bucket, prefix);
      }
      const request = rebuildRequest(input.clockId, input.firmId, options.importerPhones);
      const { startAtSim } = await reloadWorld({ clockId: input.clockId, firmId: input.firmId, worldEpoch: input.worldEpoch, request }, deps);
      return { startAtSim };
    },

    async purgeMemory(input) {
      const operations = await deps.data.operations.listOperations(input.firmId, { clockId: input.clockId });
      const { target } = await purgeFirstPass(deps, purgeTargetOf(input.clockId, input.previousEpoch, operations, input.importerIds, deps));
      await deps.continuePurge(target);
    },
  };
}

/** A reset moves no timer forward: anything that would dispatch one is a bug, not a silent no-op. */
const NO_DISPATCH: TimerDispatcher = {
  dispatch: () => Promise.reject(new ToolError("CONFLICT", "a world reset never dispatches a timer", "RESET_DISPATCH")),
};

/** `resetWorld`'s dependencies over the factory's (the clock of the reset is real time). */
export function resetDepsOf(deps: WorldsDeps, options: RebuildOptions = {}): ResetDeps {
  return {
    data: deps.data,
    client: deps.client,
    scheduler: deps.scheduler,
    dispatcher: NO_DISPATCH,
    realClock: deps.now,
    log: deps.log,
    addressHash: (address) => addressHashOf(deps.keys, address),
    rebuild: worldRebuild(deps, options),
  };
}
