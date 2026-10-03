// `clock` router (docs/tool-catalog.md, docs/architecture.md §8 and §10, ADR-0007, ADR-0015 §4): the
// simulated-time bar of the console (world.ts `clockSnapshot`) and the commands that move a world
// (clock-moves.ts):
//
//   get                 the snapshot of the world
//   advance, advanceTo, advanceToNext, fireMilestone, moveEta, emitDispatchStatus
//                       only in a quiet world (`WORLD_BUSY`; `force` once the oldest pending waited five
//                       minutes), one `CLOCK_MOVES` of a guest world each
//   setRunning          "Reloj en vivo" (30 real minutes); turning it on spends one `LIVE_CLOCK`
//   reset               BROKER or GUEST, the user's own world, once every 10 real minutes from the console
//                       (`RESET_TOO_SOON`) and one `WORLD_RESETS` of a guest world
import { clockMoves } from "./clock-moves";
import { firmProcedure, router } from "./trpc";
import { WorldInput, clockSnapshot, worldOf } from "./world";

export { WorldFields, WorldInput, worldOf } from "./world";

export const clockRouter = router({
  get: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => clockSnapshot(ctx, await worldOf(ctx, input.clockId))),
  ...clockMoves,
});
