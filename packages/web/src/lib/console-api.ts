// Procedures of the shell whose routers the BFF registers later (docs/build-plan.md WP-33: `clock`
// and `account`), called through tRPC's untyped client and validated with zod, like every edge of
// the console. The shapes below are the contract the shell relies on; the routers may answer more
// fields (the clock view reads the next events), never fewer.
import { IsoInstant } from "@legajo/shared";
import { getUntypedClient } from "@trpc/client";
import { z } from "zod";
import type { ConsoleClient } from "./trpc";
import { type ClockMove, ClockSnapshot, moveRequest } from "./world-clock";

/** `clock.get`: mode, simulated now, `busy` and the pendings of the user's world. */
export async function fetchClock(trpc: ConsoleClient, signal?: AbortSignal): Promise<ClockSnapshot> {
  const raw = await getUntypedClient(trpc).query("clock.get", undefined, signal ? { signal } : undefined);
  return ClockSnapshot.parse(raw);
}

/**
 * Moves the clock. A busy world answers `WORLD_BUSY` (tRPC error `reason`) and changes nothing;
 * `force` is accepted only once the oldest pending is five minutes old. The answer may carry the new
 * snapshot; the shell polls again either way.
 */
export async function moveClock(trpc: ConsoleClient, move: ClockMove, force = false): Promise<ClockSnapshot | undefined> {
  const { path, input } = moveRequest(move, force);
  const raw = await getUntypedClient(trpc).mutation(path, input);
  const parsed = ClockSnapshot.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** `account.session`: the user's firm and, for a judge, another session that used the same world. */
export const AccountSession = z.looseObject({
  firm: z.looseObject({ name: z.string().min(1) }).nullish(),
  /** Another sign-in (another `origin_jti`) acted on this judge world in the last 2 real hours. */
  otherSession: z.looseObject({ lastActiveAtReal: IsoInstant }).nullish(),
});
export type AccountSession = z.infer<typeof AccountSession>;

export async function fetchAccountSession(trpc: ConsoleClient, signal?: AbortSignal): Promise<AccountSession> {
  const raw = await getUntypedClient(trpc).query("account.session", undefined, signal ? { signal } : undefined);
  return AccountSession.parse(raw);
}
