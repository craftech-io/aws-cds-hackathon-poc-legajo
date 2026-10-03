// The guest-world entries of `WorldJanitor` besides the hourly sweep (ADR-0015 §5):
//
//   GUEST_DESTROY {firmId, reason, sub?}   on request (`leads:delete`, the 24-month retention, the
//                                          operator): the world of that guest firm is destroyed, its
//                                          account's lease marked DESTROYED and its slot released
//   IDLE_GUEST_RESET                       04:00 ART every night: every reserved world (slots 01–30 and
//                                          `guest-test`) without activity in 24 real hours is reset
//                                          ("Reiniciar demo" as `WorldJanitor`, exempt from the console's
//                                          10-minute limit); a public world is never reset, it expires
//
// "Activity" is the world's `lastSession.lastActiveAtReal` (docs/architecture.md §10); a world nobody
// signed in to counts from its creation, and one already reset after its last activity is left alone.
import { z } from "zod";
import { FirmId, guestClockId } from "@legajo/shared";
import { GUEST_SLOTS, RESERVED_WORLD_IDLE_RESET_HOURS } from "@legajo/shared/guest-limits";
import { resetWorld } from "../clock/reset";
import type { Clock } from "../domain/world-state";
import type { WorldsDeps } from "../worlds/deps";
import { destroyGuestWorld } from "../worlds/guest-worlds";
import { resetDepsOf } from "../worlds/rebuild";
import { guestFirmOf } from "../worlds/guest-slots";
import { GUEST_TEST_FIRM } from "../worlds/world-ids";

export const GuestDestroyEvent = z
  .object({
    kind: z.literal("GUEST_DESTROY"),
    firmId: FirmId.refine((firmId) => firmId.startsWith("firm-guest-"), "expected a guest firm"),
    reason: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "expected an UPPER_SNAKE_CASE reason"),
    sub: z.string().min(1).max(128).optional(),
  })
  .strict();
export type GuestDestroyEvent = z.infer<typeof GuestDestroyEvent>;

export const IdleGuestResetEvent = z.object({ kind: z.literal("IDLE_GUEST_RESET") }).strict();

export async function guestDestroy(event: GuestDestroyEvent, deps: WorldsDeps): Promise<{ readonly destroyed: boolean }> {
  return destroyGuestWorld({ firmId: event.firmId, reason: event.reason, ...(event.sub === undefined ? {} : { sub: event.sub }) }, deps);
}

/** The reserved firms: `firm-guest-01` to `-30` and the synthetic account's `firm-guest-test`. */
export function reservedGuestFirms(): string[] {
  const firms: string[] = [];
  for (let nn = GUEST_SLOTS.reserved.first; nn <= GUEST_SLOTS.reserved.last; nn += 1) firms.push(guestFirmOf(nn));
  return [...firms, GUEST_TEST_FIRM];
}

/** Whether a reserved world is due for the nightly reset at `now`. */
export function isIdleForReset(clock: Pick<Clock, "lastSession" | "lastResetAtReal" | "createdAt">, now: Date): boolean {
  const lastActive = Date.parse(clock.lastSession?.lastActiveAtReal ?? clock.createdAt);
  if (clock.lastResetAtReal !== undefined && Date.parse(clock.lastResetAtReal) >= lastActive) return false;
  return now.getTime() - lastActive >= RESERVED_WORLD_IDLE_RESET_HOURS * 3_600_000;
}

export interface IdleResetReport {
  readonly checked: number;
  readonly reset: number;
  readonly failed: number;
}

/** `IDLE_GUEST_RESET`: each world on its own, so one that fails does not stop the others. */
export async function idleGuestReset(deps: WorldsDeps): Promise<IdleResetReport> {
  const now = deps.now();
  let checked = 0;
  let reset = 0;
  let failed = 0;
  for (const firmId of reservedGuestFirms()) {
    const clock = await deps.data.world.findClock(guestClockId(firmId));
    if (clock === undefined) continue;
    checked += 1;
    if (!isIdleForReset(clock, now)) continue;
    try {
      await resetWorld({ clockId: clock.clockId, caller: "JANITOR", actor: "SYSTEM" }, resetDepsOf(deps));
      reset += 1;
    } catch (error) {
      failed += 1;
      deps.log.error("idle_guest_reset.failed", { firmId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  deps.log.info("idle_guest_reset.done", { checked, reset, failed });
  return { checked, reset, failed };
}
