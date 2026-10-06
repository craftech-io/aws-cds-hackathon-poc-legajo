// Procedures of the shell (`clock` and `account`), called through the typed `AppRouter` client and
// validated with zod, like every edge of the console. The shapes below are the contract the shell
// relies on; the routers may answer more fields (the clock view reads the next events), never fewer.
import { Language } from "@legajo/shared";
import { z } from "zod";
import type { ConsoleClient } from "./trpc";
import { type ClockMove, ClockSnapshot, moveRequest } from "./world-clock";

/** `clock.get`: mode, simulated now, `busy` and the pendings of the user's world. */
export async function fetchClock(trpc: ConsoleClient, signal?: AbortSignal): Promise<ClockSnapshot> {
  const raw = await trpc.clock.get.query(undefined, signal ? { signal } : undefined);
  return ClockSnapshot.parse(raw);
}

/**
 * Moves the clock. A busy world answers `WORLD_BUSY` (tRPC error `reason`) and changes nothing;
 * `force` is accepted only once the oldest pending is five minutes old. The answer may carry the new
 * snapshot; the shell polls again either way.
 */
export async function moveClock(trpc: ConsoleClient, move: ClockMove, force = false): Promise<ClockSnapshot | undefined> {
  moveRequest(move, force); // refuses a move outside 1 minute to 14 days before anything is sent
  const forced = force ? { force: true } : {};
  const raw = move.kind === "next" ? await trpc.clock.advanceToNext.mutate(forced) : await trpc.clock.advance.mutate({ minutes: move.minutes, ...forced });
  const parsed = ClockSnapshot.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** `account.session`: the user's firm. */
export const AccountSession = z.looseObject({
  firm: z.looseObject({ name: z.string().min(1) }).nullish(),
});
export type AccountSession = z.infer<typeof AccountSession>;

export async function fetchAccountSession(trpc: ConsoleClient, signal?: AbortSignal): Promise<AccountSession> {
  const raw = await trpc.account.session.query(undefined, signal ? { signal } : undefined);
  return AccountSession.parse(raw);
}

/** `account.preferences`: the language the account chose, `null` while it never did. */
export const AccountPreferences = z.looseObject({ language: Language.nullable() });
export type AccountPreferences = z.infer<typeof AccountPreferences>;

export async function fetchAccountPreferences(trpc: ConsoleClient, signal?: AbortSignal): Promise<AccountPreferences> {
  const raw = await trpc.account.preferences.query(undefined, signal ? { signal } : undefined);
  return AccountPreferences.parse(raw);
}

/** `account.setLanguage`: keeps the language with the account, so it follows the user to every device. */
export async function saveAccountLanguage(trpc: ConsoleClient, language: Language): Promise<AccountPreferences> {
  const raw = await trpc.account.setLanguage.mutate({ language });
  return AccountPreferences.parse(raw);
}
