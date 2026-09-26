// The last session that acted on a judge world (docs/architecture.md §10): `account.session` reads
// it once per sign-in to warn about another session, and every later call of the same session keeps
// it fresh, so a session still working two hours after its sign-in is still "the other session" for
// a new one. The write is pinned to the version it read and never moves `lastActiveAtReal` back.
import { ConnectorError, judgeClockId } from "@legajo/shared";
import type { Principal } from "../auth/principal";
import type { Connector } from "../connector/index";
import type { Clock, PreviousSession } from "../domain/world-state";
import type { Logger } from "../lib/log";

/** Calls of the session that already owns `lastSession` refresh it at most this often. */
export const JUDGE_ACTIVITY_REFRESH_MS = 60_000;

/** Two writers racing on one clock: read again and retry once. */
const WRITE_ATTEMPTS = 2;

/** `origin_jti` when the token carries it; otherwise the sign-in instant of the same user. */
export function sessionIdOf(principal: Pick<Principal, "originJti" | "sub" | "authTime">): string {
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

/** The other session `sessionId` takes over from (or keeps, when it already owns `lastSession`). */
function previousOf(clock: Pick<Clock, "lastSession">, sessionId: string): { previous?: PreviousSession } {
  const last = clock.lastSession;
  if (last === undefined) return {};
  if (last.originJti !== sessionId) return { previous: { originJti: last.originJti, lastActiveAtReal: last.lastActiveAtReal } };
  return last.previous === undefined ? {} : { previous: last.previous };
}

/**
 * Records the principal's session as the last one of `clock`. `refreshMs` 0 always writes (the
 * sign-in itself); a newer `lastSession` than `realNow` is never overwritten.
 */
export async function markJudgeActivity(data: Connector, clock: Clock, principal: Principal, realNow: Date, refreshMs: number): Promise<void> {
  const sessionId = sessionIdOf(principal);
  let current = clock;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    if (!needsRefresh(current, sessionId, realNow, refreshMs)) return;
    try {
      const lastSession = { originJti: sessionId, authTime: principal.authTime, lastActiveAtReal: realNow.toISOString(), ...previousOf(current, sessionId) };
      await data.world.updateClock(current.clockId, { lastSession }, current.version);
      return;
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT") || attempt === WRITE_ATTEMPTS) throw error;
      current = await data.world.getClock(current.clockId);
    }
  }
}

/**
 * Any console call of a judge (other than the sign-in check, which compares before it writes) keeps
 * the world's `lastSession` fresh. A failure is logged and never fails the call it rides on.
 */
export async function refreshJudgeActivity(data: Connector, principal: Principal, realNow: Date, log: Logger): Promise<void> {
  if (!principal.isJudge) return;
  try {
    const clock = await data.world.findClock(judgeClockId(principal.firmId));
    if (clock !== undefined) await markJudgeActivity(data, clock, principal, realNow, JUDGE_ACTIVITY_REFRESH_MS);
  } catch (error) {
    log.warn("console.judge_activity.failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}
