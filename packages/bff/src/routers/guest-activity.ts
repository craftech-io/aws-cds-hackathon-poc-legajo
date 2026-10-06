// The last session that acted on a guest world (docs/architecture.md §10): `account.session` records
// it at every sign-in and every later call of the same session keeps it fresh, so the janitor sees a
// world still worked on (idle reset, public-world expiry). The write is pinned to the version it
// read and never moves `lastActiveAtReal` back.
import { ConnectorError, guestClockId } from "@legajo/shared";
import type { Principal } from "../auth/principal";
import type { Connector } from "../connector/index";
import type { Clock } from "../domain/world-state";
import type { Logger } from "../lib/log";

/** Calls of the session that already owns `lastSession` refresh it at most this often. */
export const GUEST_ACTIVITY_REFRESH_MS = 60_000;

/** Two writers racing on one clock: read again and retry once. */
const WRITE_ATTEMPTS = 2;

/** `origin_jti` when the token carries it; otherwise the sign-in instant of the same user. */
function sessionIdOf(principal: Pick<Principal, "originJti" | "sub" | "authTime">): string {
  return principal.originJti ?? `${principal.sub}#${principal.authTime}`;
}

/** Whether `sessionId` acting at `realNow` should be written over the clock's `lastSession`. */
export function needsRefresh(clock: Pick<Clock, "lastSession">, sessionId: string, realNow: Date, refreshMs: number): boolean {
  const last = clock.lastSession;
  if (last === undefined) return true;
  const elapsed = realNow.getTime() - Date.parse(last.lastActiveAtReal);
  if (elapsed < 0) return false;
  return last.originJti !== sessionId || elapsed >= refreshMs;
}

/**
 * Records the principal's session as the last one of `clock`. `refreshMs` 0 always writes (the
 * sign-in itself); a newer `lastSession` than `realNow` is never overwritten.
 */
export async function markGuestActivity(data: Connector, clock: Clock, principal: Principal, realNow: Date, refreshMs: number): Promise<void> {
  const sessionId = sessionIdOf(principal);
  let current = clock;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    if (!needsRefresh(current, sessionId, realNow, refreshMs)) return;
    try {
      const lastSession = { originJti: sessionId, authTime: principal.authTime, lastActiveAtReal: realNow.toISOString() };
      await data.world.updateClock(current.clockId, { lastSession }, current.version);
      return;
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT") || attempt === WRITE_ATTEMPTS) throw error;
      current = await data.world.getClock(current.clockId);
    }
  }
}

/**
 * Any console call of a guest keeps the world's `lastSession` fresh. A failure is logged and never fails the call it rides on.
 */
export async function refreshGuestActivity(data: Connector, principal: Principal, realNow: Date, log: Logger): Promise<void> {
  if (!principal.isGuest) return;
  try {
    const clock = await data.world.findClock(guestClockId(principal.firmId));
    if (clock !== undefined) await markGuestActivity(data, clock, principal, realNow, GUEST_ACTIVITY_REFRESH_MS);
  } catch (error) {
    log.warn("console.guest_activity.failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}
